// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Injectable, BadRequestException, Inject } from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import { CaService } from '../infrastructure/pki/ca.service';
import { AuditChainService } from '../infrastructure/audit/audit-chain.service';
import { PadesSignerService } from '../infrastructure/pades/pades-signer.service';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { CertQuery } from '../domain/cert-query';
import { toCsv } from '../domain/csv';
import { OwnerType } from '../domain/types/pki.types';

export interface EnrollInput {
  ownerType: OwnerType;
  subjectDn: string;
  ownerRef?: string;
  // 본인확인 증빙 (mock — 운영: PASS/명의 사업자 또는 STAFF SSO 검증)
  identity?: { method: 'PASS' | 'MOBILE_NAME' | 'STAFF_SSO' | 'INPERSON'; ci?: string; phone?: string };
  licenseNumber?: string; // STAFF
  validDays?: number;
}

/**
 * 인증서 발급(enroll) — design §19.1 / FR-18.
 * 환자: PASS/명의+CI. STAFF: 면허. 외부입회: 단기 임시. CERT_ISSUED 감사기록(conventions §4).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class EnrollCertificateService {
  constructor(
    private readonly ca: CaService,
    @Inject(SIGN_STORE) private readonly store: SignStore,
    private readonly audit: AuditChainService,
    private readonly pades: PadesSignerService,
  ) {}

  async enroll(input: EnrollInput) {
    // identity 미지정 시 유형별 기본 — STAFF=SSO, WITNESS=대면. PATIENT/PROXY는 본인확인 필수(아래 검증).
    const method =
      input.identity?.method ??
      (input.ownerType === 'STAFF' ? 'STAFF_SSO' : input.ownerType === 'WITNESS' ? 'INPERSON' : undefined);

    // PATIENT·PROXY(대리인)는 비대면/대면 본인인증으로 발급 — identity.method 필수
    if (['PATIENT', 'PROXY'].includes(input.ownerType) && !['PASS', 'MOBILE_NAME', 'INPERSON'].includes(method as string)) {
      throw new BadRequestException(`${input.ownerType}는 identity.method(PASS/MOBILE_NAME/INPERSON)가 필요합니다`);
    }
    if (input.ownerType === 'STAFF' && method !== 'STAFF_SSO') {
      throw new BadRequestException('STAFF requires identity.method=STAFF_SSO');
    }

    const ciHash = input.identity?.ci ? this.hash(`ci:${input.identity.ci}`) : undefined;
    const cert = await this.ca.issue({
      subjectDn: input.subjectDn,
      ownerType: input.ownerType,
      ownerRef: input.ownerRef,
      ciHash,
      licenseNumber: input.licenseNumber,
      validDays: input.validDays ?? (input.ownerType === 'WITNESS' ? 1 : 365),
    });

    const certId = randomUUID();
    // 표준 X.509 말단 인증서 동시 발급 (PAdES/CMS 표준화 — 서명코어 일원화 단계)
    const x509 = this.pades.issueEndEntity(input.subjectDn, input.validDays ?? (input.ownerType === 'WITNESS' ? 1 : 365));
    await this.store.saveCert({ certId, cert, x509Pem: x509.certPem, x509ChainPem: x509.chainPem, x509Serial: x509.x509Serial });
    await this.recordCertAudit(cert.tbs.serialNumber, 'CERT_ISSUED', {
      ownerType: input.ownerType,
      method,
      ownerRef: input.ownerRef,
    });

    // A1: 키 수탁(custody) attestation — HIS가 봉인 기록(additive).
    // keyCustody=말단(서명)키(최소화 정책상 SOFT), caKeyCustody=CA 앵커(HSM 시 HSM_ANCHORED).
    const keyCustody = cert.keyRef?.startsWith('hsm:') ? 'HSM' : 'SOFT';
    const ca = this.ca.attestation();
    return {
      certId,
      serialNumber: cert.tbs.serialNumber,
      ownerType: cert.tbs.ownerType,
      subjectDn: cert.tbs.subjectDn,
      notBefore: cert.tbs.notBefore,
      notAfter: cert.tbs.notAfter,
      chainValid: this.ca.verifyChain(cert),
      x509Serial: x509.x509Serial, // 실 X.509 인증서 (표준)
      keyCustody, // 말단(서명)키 수탁: SOFT | HSM
      keyAttestation: keyCustody === 'HSM' ? { type: 'HSM', handle: cert.keyRef } : { type: 'SOFT' },
      ...ca, // caKeyCustody·caKeyCustodyProvider·assuranceLevel — HSM 보호 트러스트 근거
    };
  }

  /**
   * 발급 인증서 목록 페이지 — 관리 콘솔(목록·상태·중단/폐기).
   * 저장소(queryCerts)가 DB 레벨로 검색(시리얼·주체·유형·면허)·CA 제외·정렬(notBefore desc)·페이지·카운트.
   * 상태(EXPIRED)는 표시값이라 페이지 항목에서 계산(서버 필터 아님). 유형 탭·초성은 콘솔 클라이언트 정제.
   */
  async listPage(query: CertQuery): Promise<{ data: Array<{ serialNumber: string; ownerType: string; subjectDn: string; status: string; notBefore: string; notAfter: string; keyCustody: string; licenseNumber?: string }>; page: { total: number; limit: number; offset: number } }> {
    const { items, total } = await this.store.queryCerts(query);
    const now = Date.now();
    const data = items.map((c) => {
      const expired = new Date(c.cert.tbs.notAfter).getTime() < now;
      const status = c.cert.status === 'ACTIVE' && expired ? 'EXPIRED' : c.cert.status;
      return {
        serialNumber: c.cert.tbs.serialNumber,
        ownerType: c.cert.tbs.ownerType,
        subjectDn: c.cert.tbs.subjectDn,
        status,
        notBefore: c.cert.tbs.notBefore,
        notAfter: c.cert.tbs.notAfter,
        keyCustody: c.cert.keyRef?.startsWith('hsm:') ? 'HSM' : 'SOFT',
        licenseNumber: c.cert.tbs.licenseNumber,
      };
    });
    return { data, page: { total, limit: query.limit ?? total, offset: Math.min(query.offset, total) } };
  }

  /** 인증서 목록 CSV(심사·보존) — 동일 필터 전체, 배치 페이징. CI·연락처 미포함. */
  async exportCsv(filter: Omit<CertQuery, 'limit' | 'offset'>): Promise<string> {
    const headers = ['시리얼', '유형', '주체', '상태', '발급일', '만료일', '키수탁', '면허번호'];
    const rows: Array<Array<unknown>> = [];
    const now = Date.now();
    const BATCH = 500;
    let offset = 0;
    for (;;) {
      const { items, total } = await this.store.queryCerts({ ...filter, limit: BATCH, offset });
      for (const c of items) {
        const expired = new Date(c.cert.tbs.notAfter).getTime() < now;
        const status = c.cert.status === 'ACTIVE' && expired ? 'EXPIRED' : c.cert.status;
        rows.push([c.cert.tbs.serialNumber, c.cert.tbs.ownerType, c.cert.tbs.subjectDn, status, c.cert.tbs.notBefore, c.cert.tbs.notAfter, c.cert.keyRef?.startsWith('hsm:') ? 'HSM' : 'SOFT', c.cert.tbs.licenseNumber ?? '']);
      }
      offset += items.length;
      if (items.length < BATCH || offset >= total) break;
    }
    return toCsv(headers, rows);
  }

  /** 실 X.509 인증서(PEM) 조회 — 표준 검증/PAdES용 */
  async x509(serial: string) {
    const stored = await this.store.getCertBySerial(serial);
    if (!stored) return null;
    return { serialNumber: serial, x509Serial: stored.x509Serial, certPem: stored.x509Pem, chainPem: stored.x509ChainPem };
  }

  /** 인증서 감사 체인 조회 */
  async certAudit(serial: string) {
    return this.store.auditEntries(`cert:${serial}`);
  }

  /** 인증서 이벤트 감사 (key=cert:serial 체인) */
  private async recordCertAudit(serial: string, eventType: string, data: unknown): Promise<void> {
    const key = `cert:${serial}`;
    // 동시 append 로 prevHash 가 겹쳐 체인이 끊기지 않도록 스트림 단위 직렬화
    await this.audit.appendSerialized(key, async () => {
      const prev = await this.store.lastAudit(key);
      const entry = this.audit.next(prev, eventType, { serial, ...((data as object) ?? {}) }, new Date().toISOString());
      await this.store.appendAudit(key, entry);
    });
  }

  private hash(s: string): string {
    return createHash('sha256').update(s).digest('hex');
  }
}
