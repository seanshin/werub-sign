// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 실제 src/ 클래스 구동 스모크 테스트
 * 실행: npx ts-node test/core.smoke.ts
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { SoftKeySigner } from '../src/infrastructure/crypto/soft-key-signer';
import { CaService } from '../src/infrastructure/pki/ca.service';
import { SelfTsaProvider } from '../src/infrastructure/tsa/self-tsa.provider';
import { InMemorySignStore } from '../src/infrastructure/store/in-memory-store';
import { SignatureService } from '../src/application/signature.service';
import { AuditChainService, AuditEntry } from '../src/infrastructure/audit/audit-chain.service';

const ok = (c: boolean) => (c ? '✅' : '❌');
const assert = (c: boolean, msg: string) => {
  if (!c) {
    console.error('❌ FAIL:', msg);
    process.exit(1);
  }
};

async function main() {
  console.log('\n══════ src/ 코어 스모크 테스트 ══════\n');

  const signer = new SoftKeySigner(randomBytes(32).toString('base64'));
  const store = new InMemorySignStore();
  const ca = new CaService(signer, store);
  const tsa = new SelfTsaProvider(signer, store);
  const sigSvc = new SignatureService(signer, tsa, ca);
  const audit = new AuditChainService();

  // 1) CA 부트스트랩
  const { root, issuing } = await ca.bootstrap('O=Medical Foundation');
  console.log('[1] CA bootstrap:', root.tbs.serialNumber, '/', issuing.tbs.serialNumber);
  assert(ca.verifyCertSignature(issuing, root), 'issuing signed by root');

  // 2) 인증서 발급 (환자=CI, 의사=면허)
  const patient = await ca.issue({ subjectDn: 'CN=김환자', ownerType: 'PATIENT', ownerRef: 'p-001', ciHash: signer.hash(Buffer.from('CI:김환자')) });
  const doctor = await ca.issue({ subjectDn: 'CN=이의사', ownerType: 'STAFF', ownerRef: 'u-010', licenseNumber: 'MD-12345' });
  console.log('[2] 발급 + 체인검증: 환자', ok(ca.verifyChain(patient)), '/ 의사', ok(ca.verifyChain(doctor)));
  assert(ca.verifyChain(patient) && ca.verifyChain(doctor), 'cert chain valid');
  assert(new Date(patient.tbs.notAfter).getFullYear() < 2099, 'finite expiry (no 2099)');

  // 3) 서명 + 검증
  const documentHash = signer.hash(Buffer.from('수술 동의서 v1 | 환자=김환자 | 충수절제술'));
  const rP = await sigSvc.sign({ documentHash, signerRole: 'PATIENT', cert: patient });
  const rD = await sigSvc.sign({ documentHash, signerRole: 'DOCTOR', cert: doctor });
  const vP = sigSvc.verify({ documentHash, signerRole: 'PATIENT', cert: patient }, rP);
  const vD = sigSvc.verify({ documentHash, signerRole: 'DOCTOR', cert: doctor }, rD);
  console.log('[3] 서명/검증: 환자', ok(vP.overall), '/ 의사', ok(vD.overall));
  assert(vP.overall && vD.overall, 'signatures verify');

  // 4) 위변조 탐지
  const vTamper = sigSvc.verify({ documentHash: signer.hash(Buffer.from('다른 문서!')), signerRole: 'PATIENT', cert: patient }, rP);
  console.log('[4] 위변조 탐지:', ok(!vTamper.overall), '(거부되어야 정상)');
  assert(!vTamper.cryptoOk, 'tampered document rejected');

  // 5) 감사 해시체인
  const entries: AuditEntry[] = [];
  let prev: AuditEntry | null = null;
  for (const ev of ['CERT_ISSUED', 'CREATED', 'SIGNED', 'SIGNED', 'COMPLETED']) {
    prev = audit.next(prev, ev, { at: ev }, new Date(1718170000000 + entries.length * 1000).toISOString());
    entries.push(prev);
  }
  console.log('[5] 감사체인 정상:', ok(audit.verify(entries).valid));
  assert(audit.verify(entries).valid, 'audit chain valid');
  entries[2].data = { tampered: true };
  console.log('    변조 후 탐지:', ok(!audit.verify(entries).valid), JSON.stringify(audit.verify(entries)));
  assert(!audit.verify(entries).valid, 'audit tamper detected');

  console.log('\n✅ src/ 코어 전체 통과 — 실제 NestJS 클래스가 동작함\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
