// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { KeySigner } from '../../domain/ports/key-signer.port';
import { SIGN_STORE, SignStore } from '../../domain/ports/sign-store.port';
import { CertificateTbs, IssuedCertificate, OwnerType } from '../../domain/types/pki.types';
import { canonicalBuffer } from '../../domain/canonical-json';

interface CaHolder {
  cert: IssuedCertificate;
  keyRef: string;
}

/**
 * 영속 CA 번들 — 재기동 시 동일 키/인증서 복원(미복원 시 기존 발급분 체인 검증 파손).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
interface CaBundle {
  root: CaHolder;
  issuing: CaHolder;
  issuingHistory: CaHolder[]; // 회전된 구 Issuing(구 leaf 검증용)
  serialSeq: number;
}

const CA_BUNDLE_KEY = 'ca:bundle';

/**
 * 2단 CA (오프라인 Root + 온라인 Issuing) — design §13.
 * Root는 Issuing 발급에만, 말단 인증서는 Issuing이 서명.
 * 인증서 무결성/체인 검증은 발급자 공개키로 TBS 서명을 실제 검증한다(mock 아님).
 *
 * production note: 본 구현은 CA 키로 TBS(JSON)에 실제 서명하여 체인의 암호적 실체를 보장한다.
 * 표준 X.509 DER/PAdES가 필요하면 node-forge/pkijs로 교체(포트 동일).
 */
@Injectable()
export class CaService {
  private readonly logger = new Logger('CaService');
  private root?: CaHolder;
  private issuing?: CaHolder;
  private issuingHistory: CaHolder[] = [];
  private serialSeq = 0;
  private orgDn = 'O=Medical Foundation';

  constructor(
    private readonly signer: KeySigner,
    @Inject(SIGN_STORE) private readonly store: SignStore,
  ) {}

  /**
   * 부트스트랩 — 스토어에 CA 번들이 있으면 복원(재기동 영속), 없으면 생성·영속.
   * 개인키는 keyRef 뒤(SOFT Vault/HSM)에 상주하므로, 영속 Vault(프록시/HSM)와 함께 쓰면
   * 재기동·재배포 후에도 기존 발급 인증서의 체인 검증이 유지된다.
   */
  async bootstrap(orgDn = 'O=Medical Foundation'): Promise<{ root: IssuedCertificate; issuing: IssuedCertificate }> {
    this.orgDn = orgDn;
    const saved = await this.store.getMeta<CaBundle>(CA_BUNDLE_KEY);
    if (saved?.root && saved?.issuing) {
      this.root = saved.root;
      this.issuing = saved.issuing;
      this.issuingHistory = saved.issuingHistory ?? [];
      this.serialSeq = saved.serialSeq ?? 0;
      this.logger.log(`CA 번들 복원 — Root=${saved.root.cert.tbs.serialNumber}, Issuing=${saved.issuing.cert.tbs.serialNumber}, 구Issuing=${this.issuingHistory.length}`);
      return { root: saved.root.cert, issuing: saved.issuing.cert };
    }
    const root = await this.createRoot(`CN=Sign Root CA, ${orgDn}`);
    const issuing = await this.createIssuing(`CN=Sign Issuing CA, ${orgDn}`);
    await this.persistBundle();
    this.logger.log('CA 번들 신규 생성·영속');
    return { root, issuing };
  }

  /**
   * Issuing CA 회전 — 신규 Issuing 발급, 구 Issuing은 이력 보존(구 leaf 계속 검증).
   * Root는 오프라인 유지(회전 드뭄). 키는 keyClass=HSM(트러스트 앵커).
   */
  async rotateIssuing(): Promise<IssuedCertificate> {
    this.assertBootstrapped(this.root, 'Root CA');
    if (this.issuing) this.issuingHistory.unshift(this.issuing);
    const issuing = await this.createIssuing(`CN=Sign Issuing CA, ${this.orgDn}`);
    await this.persistBundle();
    this.logger.log(`Issuing CA 회전 완료 — 신규=${issuing.tbs.serialNumber}, 이력=${this.issuingHistory.length}`);
    return issuing;
  }

  private async persistBundle(): Promise<void> {
    if (!this.root || !this.issuing) return;
    const bundle: CaBundle = {
      root: this.root,
      issuing: this.issuing,
      issuingHistory: this.issuingHistory,
      serialSeq: this.serialSeq,
    };
    await this.store.saveMeta(CA_BUNDLE_KEY, bundle);
  }

  async createRoot(subjectDn: string): Promise<IssuedCertificate> {
    // 트러스트 앵커 — HSM 표면 최소화 정책상 HSM 클래스(운영은 클라우드 HSM 상주)
    const { keyRef, publicKey } = await this.signer.generate('RSA-3072', { keyClass: 'HSM' });
    const tbs = this.assembleTbs({ subjectDn, issuerDn: subjectDn, publicKey, ownerType: 'CA', validDays: 3650 });
    const cert = await this.finalize(tbs, keyRef, true);
    this.root = { cert, keyRef };
    return cert;
  }

  async createIssuing(subjectDn: string): Promise<IssuedCertificate> {
    this.assertBootstrapped(this.root, 'Root CA');
    // 온라인 발급 CA — 트러스트 앵커, HSM 클래스
    const { keyRef, publicKey } = await this.signer.generate('RSA-3072', { keyClass: 'HSM' });
    const tbs = this.assembleTbs({
      subjectDn,
      issuerDn: this.root!.cert.tbs.subjectDn,
      publicKey,
      ownerType: 'CA',
      validDays: 1825,
    });
    const cert = await this.finalize(tbs, this.root!.keyRef, false);
    this.issuing = { cert, keyRef };
    return cert;
  }

  /** 말단 인증서 발급 (환자/STAFF/외부입회) — Issuing CA가 서명. FR-18 */
  async issue(params: {
    subjectDn: string;
    ownerType: OwnerType;
    ownerRef?: string;
    ciHash?: string;
    licenseNumber?: string;
    validDays?: number;
  }): Promise<IssuedCertificate> {
    this.assertBootstrapped(this.issuing, 'Issuing CA');
    const { keyRef, publicKey } = await this.signer.generate('RSA-3072');
    const tbs = this.assembleTbs({
      subjectDn: params.subjectDn,
      issuerDn: this.issuing!.cert.tbs.subjectDn,
      publicKey,
      ownerType: params.ownerType,
      ownerRef: params.ownerRef,
      ciHash: params.ciHash,
      licenseNumber: params.licenseNumber,
      validDays: params.validDays ?? 365,
    });
    const cert = await this.finalize(tbs, this.issuing!.keyRef, false);
    cert.keyRef = keyRef; // 소유자 개인키 참조 (서명 시 사용)
    // serialSeq 영속 — 미영속 시 재기동마다 접두 카운터 리셋(CERT-0001…)되어 접두 중복·
    // "저장소가 초기화된다"는 외부 연동팀 오인을 유발(유일성은 랜덤 접미가 보장했음)
    await this.persistBundle();
    return cert;
  }

  /** 인증서 무결성: 발급자 공개키로 TBS 서명 검증 */
  verifyCertSignature(cert: IssuedCertificate, issuerCert: IssuedCertificate): boolean {
    return this.signer.verify(issuerCert.tbs.publicKey, this.canon(cert.tbs), Buffer.from(cert.signature, 'base64'));
  }

  /** 체인 검증 (말단 → Issuing → Root). 회전 이력의 구 Issuing으로 서명된 leaf도 검증. */
  verifyChain(cert: IssuedCertificate): boolean {
    if (!this.root || !this.issuing) return false;
    const candidates = [this.issuing, ...this.issuingHistory];
    return candidates.some(
      (h) => this.verifyCertSignature(cert, h.cert) && this.verifyCertSignature(h.cert, this.root!.cert),
    );
  }

  get issuingCert(): IssuedCertificate | undefined {
    return this.issuing?.cert;
  }
  get rootCert(): IssuedCertificate | undefined {
    return this.root?.cert;
  }

  /** Issuing CA 회전 이력 요약(키 제외) — 관리/감사용. 현재 + 구 Issuing */
  issuingHistorySummary(): Array<{ serialNumber: string; notBefore: string; notAfter: string; active: boolean }> {
    const rows: Array<{ serialNumber: string; notBefore: string; notAfter: string; active: boolean }> = [];
    if (this.issuing) rows.push({ serialNumber: this.issuing.cert.tbs.serialNumber, notBefore: this.issuing.cert.tbs.notBefore, notAfter: this.issuing.cert.tbs.notAfter, active: true });
    for (const h of this.issuingHistory) rows.push({ serialNumber: h.cert.tbs.serialNumber, notBefore: h.cert.tbs.notBefore, notAfter: h.cert.tbs.notAfter, active: false });
    return rows;
  }

  /**
   * CA 트러스트 앵커 키 수탁 attestation — 서명 부인방지의 HSM 근거.
   * 최소화 정책상 말단(서명)키는 SOFT, **CA 앵커키만 HSM**이므로 "HSM 보호"의 정확한 의미는
   * "HSM 앵커 CA가 발급한 인증서"(HSM_ANCHORED)다. 말단키까지 HSM이면 HSM_RESIDENT.
   */
  attestation(): { caKeyCustody: 'HSM' | 'SOFT'; caKeyCustodyProvider: string; assuranceLevel: 'HSM_ANCHORED' | 'SOFTWARE' } {
    const hsm = this.issuing?.keyRef?.startsWith('hsm:') ?? false;
    const p = (process.env.HSM_PROVIDER ?? '').toLowerCase();
    const provider = !hsm ? 'SOFT' : p === 'aws-kms' ? 'AWS_KMS' : p === 'aws-cloudhsm' ? 'AWS_CLOUDHSM' : p === 'pkcs11' ? 'PKCS11' : 'HSM';
    return { caKeyCustody: hsm ? 'HSM' : 'SOFT', caKeyCustodyProvider: provider, assuranceLevel: hsm ? 'HSM_ANCHORED' : 'SOFTWARE' };
  }

  // ── 내부 ──
  private assembleTbs(p: {
    subjectDn: string;
    issuerDn: string;
    publicKey: string;
    ownerType: OwnerType;
    ownerRef?: string;
    ciHash?: string;
    licenseNumber?: string;
    validDays: number;
  }): CertificateTbs {
    const now = Date.now();
    return {
      serialNumber: `CERT-${String(++this.serialSeq).padStart(4, '0')}-${randomBytes(3).toString('hex').toUpperCase()}`,
      subjectDn: p.subjectDn,
      issuerDn: p.issuerDn,
      ownerType: p.ownerType,
      ownerRef: p.ownerRef,
      publicKey: p.publicKey,
      notBefore: new Date(now).toISOString(),
      notAfter: new Date(now + p.validDays * 86_400_000).toISOString(),
      algorithm: 'RSA-3072/SHA-256',
      ciHash: p.ciHash,
      licenseNumber: p.licenseNumber,
    };
  }

  private async finalize(tbs: CertificateTbs, issuerKeyRef: string, selfSigned: boolean): Promise<IssuedCertificate> {
    const signature = (await this.signer.sign(issuerKeyRef, this.canon(tbs))).toString('base64');
    const fingerprint = this.signer.hash(Buffer.from(`${tbs.serialNumber}:${tbs.publicKey}`));
    return { tbs, signature, issuerKeyRef, fingerprint, status: 'ACTIVE', selfSigned };
  }

  private canon(tbs: CertificateTbs): Buffer {
    // canonical(키정렬) — JSONB 등 키순서 미보존 저장소에서도 체인 서명 검증이 안정.
    return canonicalBuffer(tbs);
  }

  private assertBootstrapped(holder: CaHolder | undefined, name: string): void {
    if (!holder) throw new Error(`${name} not initialized — call bootstrap() first`);
  }
}
