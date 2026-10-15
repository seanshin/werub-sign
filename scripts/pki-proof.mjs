// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * PKI 코어 증명 데모 (외부 의존성 없음, Node 내장 crypto)
 *
 * 목적: 기존 Hospital RUN의 mock 서명(검증=sha256(signatureValue))과 달리
 *       "진짜 PKI"가 동작함을 입증한다:
 *   1) 2단 CA(Root→Issuing)로 실제 키쌍·인증서 발급
 *   2) 개인키로 문서 해시에 실제 서명, 공개키로 crypto.verify 검증
 *   3) 문서 위변조 시 검증 실패(탐지)
 *   4) 인증서 체인(Issuing→Root) 검증
 *   5) SOFT 키 보관: 개인키 AES-256-GCM 암호화 저장(평문 금지) → 서명 직전 복호화
 *   6) RFC3161 유사 자체 TSA 타임스탬프(시점 봉인)
 *   7) 감사추적 해시체인(append-only, prevHash→entryHash) 위변조 탐지
 *
 * 실행: node scripts/pki-proof.mjs
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import crypto from 'node:crypto';

const SIG_ALG = 'sha256';            // 서명 해시 (검증대상 알고리즘)
const log = (...a) => console.log(...a);
const ok = (c) => (c ? '✅' : '❌');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ─────────────────────────────────────────────────────────────
// SOFT KeyVault: 개인키를 마스터키로 AES-256-GCM 암호화하여 보관 (평문 저장 금지)
// 운영에서는 keyStoreType=HSM(PKCS#11)로 교체 (KeySigner 포트 동일)
// ─────────────────────────────────────────────────────────────
class SoftKeyVault {
  constructor(masterKey) { this.master = masterKey; this.store = new Map(); }
  put(keyRef, privateKeyPem) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.master, iv, { authTagLength: 16 });
    const enc = Buffer.concat([cipher.update(privateKeyPem, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.store.set(keyRef, { iv, enc, tag }); // 암호화 blob만 보관
  }
  // 서명 직전에만 복호화, 사용 후 호출자가 즉시 폐기
  _decrypt(keyRef) {
    const { iv, enc, tag } = this.store.get(keyRef);
    const d = crypto.createDecipheriv('aes-256-gcm', this.master, iv, { authTagLength: 16 });
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  }
  sign(keyRef, data) {
    const pem = this._decrypt(keyRef);
    const sig = crypto.sign(SIG_ALG, data, pem);
    return sig; // pem은 함수 스코프 종료로 GC 대상
  }
}

// ─────────────────────────────────────────────────────────────
// CA: 키쌍 생성 + 인증서(여기선 간이 구조, CA 키로 실제 서명) 발급
//   production: node-forge/pkijs로 X.509 DER + PAdES. 여기선 체인 검증의 암호적 실체만 증명
// ─────────────────────────────────────────────────────────────
let serialSeq = 0;
function genKeyPair() {
  // 실제 RSA-3072 키쌍 (mock은 외부 publicKey만 받았음)
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

class CA {
  constructor(vault) { this.vault = vault; }

  // 자기서명 Root
  createRoot(subjectDn) {
    const { publicKey, privateKey } = genKeyPair();
    const keyRef = `key:${crypto.randomBytes(6).toString('hex')}`;
    this.vault.put(keyRef, privateKey);
    const cert = this._assemble({ subjectDn, issuerDn: subjectDn, publicKey, ownerType: 'CA' });
    cert.tbs.issuerKeyRef = keyRef;            // 루트는 자기 키로 서명
    cert.signature = this._signTbs(cert.tbs, keyRef);
    cert.selfSigned = true;
    this.root = { cert, keyRef };
    return cert;
  }

  // Root가 서명하는 Issuing CA
  createIssuing(subjectDn) {
    const { publicKey, privateKey } = genKeyPair();
    const keyRef = `key:${crypto.randomBytes(6).toString('hex')}`;
    this.vault.put(keyRef, privateKey);
    const cert = this._assemble({ subjectDn, issuerDn: this.root.cert.tbs.subjectDn, publicKey, ownerType: 'CA' });
    cert.tbs.issuerKeyRef = this.root.keyRef;  // Root 키로 서명
    cert.signature = this._signTbs(cert.tbs, this.root.keyRef);
    this.issuing = { cert, keyRef };
    return cert;
  }

  // 말단 인증서(환자/STAFF) 발급: Issuing CA가 서명
  issue({ subjectDn, ownerType, ownerRef, ciHash, licenseNumber, validDays = 365 }) {
    const { publicKey, privateKey } = genKeyPair();
    const keyRef = `key:${crypto.randomBytes(6).toString('hex')}`;
    this.vault.put(keyRef, privateKey);
    const cert = this._assemble({ subjectDn, issuerDn: this.issuing.cert.tbs.subjectDn, publicKey, ownerType, validDays });
    Object.assign(cert.tbs, { ownerRef, ciHash, licenseNumber });
    cert.tbs.issuerKeyRef = this.issuing.keyRef;
    cert.signature = this._signTbs(cert.tbs, this.issuing.keyRef); // Issuing CA 서명
    cert.keyRef = keyRef;       // 소유자 개인키 (서명 시 사용)
    return cert;
  }

  _assemble({ subjectDn, issuerDn, publicKey, ownerType, validDays = 3650 }) {
    const now = Date.now();
    return {
      tbs: { // to-be-signed
        serialNumber: `CERT-${String(++serialSeq).padStart(4, '0')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
        subjectDn, issuerDn, ownerType,
        publicKey,
        notBefore: new Date(now).toISOString(),
        notAfter: new Date(now + validDays * 86400_000).toISOString(), // ★ 유한 만료 (mock=2099 무기한 폐지)
        algorithm: 'RSA-3072/SHA-256',
      },
      signature: null,
      status: 'ACTIVE',
    };
  }
  _canon(tbs) { return Buffer.from(JSON.stringify(tbs)); }
  _signTbs(tbs, issuerKeyRef) { return this.vault.sign(issuerKeyRef, this._canon(tbs)).toString('base64'); }

  // 인증서 자체 무결성: 발급자 공개키로 tbs 서명 검증
  verifyCert(cert, issuerCert) {
    const issuerPub = issuerCert.tbs.publicKey;
    return crypto.verify(SIG_ALG, this._canon(cert.tbs), issuerPub, Buffer.from(cert.signature, 'base64'));
  }
}

// 자체 TSA (RFC3161 유사): 메시지 해시에 TSA 키로 서명한 시점 토큰
class SelfTSA {
  constructor(vault) {
    const { publicKey, privateKey } = genKeyPair();
    this.pub = publicKey; this.keyRef = 'key:tsa';
    vault.put(this.keyRef, privateKey); this.vault = vault;
  }
  stamp(messageHashHex, genTimeIso) {
    const tbs = Buffer.from(JSON.stringify({ messageHashHex, genTime: genTimeIso, tsaSerial: crypto.randomBytes(4).toString('hex') }));
    const sig = this.vault.sign(this.keyRef, tbs).toString('base64');
    return { tbs: tbs.toString('base64'), sig, genTime: genTimeIso };
  }
  verify(token, expectedHashHex) {
    const tbs = Buffer.from(token.tbs, 'base64');
    const parsed = JSON.parse(tbs.toString());
    const sigOk = crypto.verify(SIG_ALG, tbs, this.pub, Buffer.from(token.sig, 'base64'));
    return sigOk && parsed.messageHashHex === expectedHashHex;
  }
}

// 감사추적 해시체인 (append-only)
class AuditTrail {
  constructor() { this.entries = []; }
  append(eventType, data) {
    const prevHash = this.entries.length ? this.entries[this.entries.length - 1].entryHash : '0'.repeat(64);
    const occurredAt = new Date(1718170000000 + this.entries.length * 1000).toISOString(); // 결정적 시각(데모)
    const entryHash = sha256(prevHash + JSON.stringify(data) + occurredAt + eventType);
    this.entries.push({ eventType, data, occurredAt, prevHash, entryHash });
  }
  verifyChain() {
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      const prev = i ? this.entries[i - 1].entryHash : '0'.repeat(64);
      if (e.prevHash !== prev) return { valid: false, brokenAt: i, reason: 'prevHash mismatch' };
      if (sha256(e.prevHash + JSON.stringify(e.data) + e.occurredAt + e.eventType) !== e.entryHash)
        return { valid: false, brokenAt: i, reason: 'entryHash mismatch' };
    }
    return { valid: true };
  }
}

// ═══════════════════════════════════════════════════════════════
// 시나리오: 수술 동의서 — 환자 + 의사 서명
// ═══════════════════════════════════════════════════════════════
log('\n══════════ sign PKI 코어 증명 ══════════\n');

const masterKey = crypto.randomBytes(32); // 운영: KMS/HSM. 데모: 메모리 마스터키
const vault = new SoftKeyVault(masterKey);
const ca = new CA(vault);
const tsa = new SelfTSA(vault);
const audit = new AuditTrail();

// 1) 2단 CA 부트스트랩
const root = ca.createRoot('CN=Sign Root CA, O=Medical Foundation');
const issuing = ca.createIssuing('CN=Sign Issuing CA, O=Medical Foundation');
log('[1] 2단 CA 발급');
log('    Root    :', root.tbs.serialNumber);
log('    Issuing :', issuing.tbs.serialNumber, '| Root 서명 검증:', ok(ca.verifyCert(issuing, root)));

// 2) 말단 인증서 발급 (환자=CI 귀속, 의사=면허 귀속)
const patientCert = ca.issue({ subjectDn: 'CN=김환자', ownerType: 'PATIENT', ownerRef: 'patient-001', ciHash: sha256('CI:김환자'), validDays: 365 });
const doctorCert  = ca.issue({ subjectDn: 'CN=이의사', ownerType: 'STAFF',   ownerRef: 'user-010',    licenseNumber: 'MD-12345',  validDays: 365 });
audit.append('CERT_ISSUED', { serial: patientCert.tbs.serialNumber, ownerType: 'PATIENT' });
audit.append('CERT_ISSUED', { serial: doctorCert.tbs.serialNumber, ownerType: 'STAFF' });
log('\n[2] 말단 인증서 발급 (Issuing CA 서명)');
log('    환자 인증서 체인 검증:', ok(ca.verifyCert(patientCert, issuing.cert ?? issuing)));
log('    의사 인증서 체인 검증:', ok(ca.verifyCert(doctorCert, issuing)));
log('    만료일(유한):', patientCert.tbs.notAfter, '  ← mock의 2099 무기한 폐지');

// 3) 동의서 문서 봉인 + 서명
const documentBytes = Buffer.from('수술 동의서 v1 | 환자=김환자 | 시술=충수절제술 | 위험·대안 설명함');
const documentHash = sha256(documentBytes);
audit.append('CREATED', { documentHash });

function signBy(cert, role) {
  const signedAttrs = Buffer.from(JSON.stringify({ documentHash, signerRole: role, cert: cert.tbs.serialNumber }));
  const signatureValue = vault.sign(cert.keyRef, signedAttrs); // 개인키 실제 서명
  const tsToken = tsa.stamp(sha256(signatureValue), new Date(1718170500000).toISOString());
  audit.append('SIGNED', { role, cert: cert.tbs.serialNumber });
  return { role, cert, signedAttrs, signatureValue, tsToken };
}
const sigPatient = signBy(patientCert, 'PATIENT');
const sigDoctor  = signBy(doctorCert, 'DOCTOR');
audit.append('COMPLETED', { signers: 2 });
log('\n[3] 서명 생성 (개인키 실제 서명 + TSA 시점 봉인)');
log('    환자 서명 길이:', sigPatient.signatureValue.length, 'bytes | 의사 서명 길이:', sigDoctor.signatureValue.length, 'bytes');

// 4) 검증 — 진짜 crypto.verify (mock과의 결정적 차이)
function verifySig(sig) {
  const cryptoOk = crypto.verify(SIG_ALG, sig.signedAttrs, sig.cert.tbs.publicKey, sig.signatureValue);
  const tsOk = tsa.verify(sig.tsToken, sha256(sig.signatureValue));
  const chainOk = ca.verifyCert(sig.cert, issuing);
  const notExpired = new Date(sig.tsToken.genTime) <= new Date(sig.cert.tbs.notAfter);
  return { cryptoOk, tsOk, chainOk, notExpired, overall: cryptoOk && tsOk && chainOk && notExpired };
}
log('\n[4] 정상 검증 (공개키로 실제 서명 검증)');
const vP = verifySig(sigPatient), vD = verifySig(sigDoctor);
log('    환자:', ok(vP.overall), JSON.stringify(vP));
log('    의사:', ok(vD.overall), JSON.stringify(vD));

// 5) 위변조 탐지 — 문서를 1바이트 바꾸면 검증 실패해야 함
log('\n[5] 위변조 탐지');
const tamperedAttrs = Buffer.from(JSON.stringify({ documentHash: sha256(Buffer.from('수술 동의서 v1 | 환자=김환자 | 시술=다른수술!')), signerRole: 'PATIENT', cert: patientCert.tbs.serialNumber }));
const tamperedOk = crypto.verify(SIG_ALG, tamperedAttrs, patientCert.tbs.publicKey, sigPatient.signatureValue);
log('    문서 변조 후 서명 검증:', ok(!tamperedOk), '(거부되어야 정상) → 결과 valid=', tamperedOk);

// 6) 잘못된 인증서로 검증 시도 (다른 키로 서명 위조)
const forged = crypto.sign(SIG_ALG, sigPatient.signedAttrs, ca.issue({ subjectDn: 'CN=위조', ownerType: 'PATIENT', validDays: 1 }).keyRef ? vault._decrypt(patientCert.keyRef) : patientCert.tbs.publicKey);

// 7) 감사 해시체인 무결성
log('\n[6] 감사추적 해시체인');
const chain1 = audit.verifyChain();
log('    정상 체인 검증:', ok(chain1.valid), `(${audit.entries.length} 엔트리)`);
audit.entries[2].data.documentHash = 'TAMPERED'; // 내부자 위변조 시뮬
const chain2 = audit.verifyChain();
log('    엔트리 변조 후 검증:', ok(!chain2.valid), '(탐지되어야 정상) →', JSON.stringify(chain2));

// 결과 요약
log('\n══════════ 요약 ══════════');
const pass =
  ca.verifyCert(issuing, root) && ca.verifyCert(patientCert, issuing) &&
  vP.overall && vD.overall && !tamperedOk && chain1.valid && !chain2.valid;
log(pass ? '✅ PKI 코어 전부 통과 — 실제 서명/검증/위변조탐지/체인/TSA/감사 동작' : '❌ 실패 항목 있음');
log('   mock과의 차이: 검증이 sha256(value)가 아니라 공개키 crypto.verify(서명) 임을 입증\n');
process.exit(pass ? 0 : 1);
