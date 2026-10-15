// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Injectable, NotFoundException, ConflictException, Inject } from '@nestjs/common';
import { CaService } from '../infrastructure/pki/ca.service';
import { AuditChainService } from '../infrastructure/audit/audit-chain.service';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';

export type OcspStatus = 'GOOD' | 'REVOKED' | 'SUSPENDED' | 'UNKNOWN';

/**
 * 인증서 폐기 — CRL/OCSP — design §11 / FR-19.
 * 서명 시점(TSA genTime) 기준 폐기여부 판단을 위해 revokedAt을 보존. CERT_REVOKED 감사기록.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class RevocationService {
  constructor(
    @Inject(SIGN_STORE) private readonly store: SignStore,
    private readonly ca: CaService,
    private readonly audit: AuditChainService,
  ) {}

  async revoke(serialNumber: string, reason = 'unspecified', actor = 'system') {
    const cert = await this.store.getCertBySerial(serialNumber);
    if (!cert) throw new NotFoundException('certificate not found');
    const revokedAt = new Date().toISOString();
    const crlNumber = await this.store.nextCrlNumber();
    await this.store.saveRevocation({ serialNumber, revokedAt, reason, crlNumber });
    cert.cert.status = 'REVOKED';
    await this.store.saveCert(cert);
    // 관리 행위자 감사 — 누가 폐기했는지 감사체인에 봉인(책임추적)
    await this.recordCertAudit(serialNumber, 'CERT_REVOKED', { reason, actor });
    return { serialNumber, status: 'REVOKED', revokedAt, reason, crlNumber };
  }

  /** 인증서 중단(suspend) — 일시정지(가역). 서명 차단·상태 SUSPENDED. */
  async suspend(serialNumber: string, actor = 'system') {
    const cert = await this.store.getCertBySerial(serialNumber);
    if (!cert) throw new NotFoundException('certificate not found');
    if (cert.cert.status === 'REVOKED') throw new ConflictException('이미 폐기된 인증서');
    cert.cert.status = 'SUSPENDED';
    await this.store.saveCert(cert);
    await this.recordCertAudit(serialNumber, 'CERT_SUSPENDED', { actor });
    return { serialNumber, status: 'SUSPENDED' };
  }

  /** 중단 해제(resume) — SUSPENDED → ACTIVE. */
  async resume(serialNumber: string, actor = 'system') {
    const cert = await this.store.getCertBySerial(serialNumber);
    if (!cert) throw new NotFoundException('certificate not found');
    if (cert.cert.status !== 'SUSPENDED') throw new ConflictException('중단 상태가 아님');
    cert.cert.status = 'ACTIVE';
    await this.store.saveCert(cert);
    await this.recordCertAudit(serialNumber, 'CERT_RESUMED', { actor });
    return { serialNumber, status: 'ACTIVE' };
  }

  async ocsp(serialNumber: string): Promise<{ serialNumber: string; status: OcspStatus; revokedAt?: string; reason?: string }> {
    const cert = await this.store.getCertBySerial(serialNumber);
    if (!cert) return { serialNumber, status: 'UNKNOWN' };
    const r = await this.store.getRevocation(serialNumber);
    if (r) return { serialNumber, status: 'REVOKED', revokedAt: r.revokedAt, reason: r.reason };
    if (cert.cert.status === 'SUSPENDED') return { serialNumber, status: 'SUSPENDED', reason: 'certificateHold' };
    return { serialNumber, status: 'GOOD' };
  }

  async crl() {
    return {
      crlNumber: await this.store.currentCrlNumber(),
      issuer: this.ca.issuingCert?.tbs.subjectDn,
      producedAt: new Date().toISOString(),
      revoked: await this.store.allRevocations(),
    };
  }

  /** 서명 시점 기준 유효성: 미폐기이거나 서명 시각이 폐기 이전이면 GOOD */
  async notRevokedAt(serialNumber: string, atIso: string): Promise<boolean> {
    const r = await this.store.getRevocation(serialNumber);
    if (!r) return true;
    return new Date(atIso) < new Date(r.revokedAt);
  }

  private async recordCertAudit(serial: string, eventType: string, data: unknown): Promise<void> {
    const key = `cert:${serial}`;
    // enroll-certificate.service 와 **같은 스트림**(cert:<serial>) — 공용 직렬화 + 충돌 재시도(R16)
    await this.audit.appendSerialized(key, async () => {
      const prev = await this.store.lastAudit(key);
      const entry = this.audit.next(prev, eventType, { serial, ...((data as object) ?? {}) }, new Date().toISOString());
      await this.store.appendAudit(key, entry);
    });
  }
}
