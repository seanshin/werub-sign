// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnrollCertificateService } from './enroll-certificate.service';
import { SignatureRequestService } from './signature-request.service';
import { PatientTokenService } from './patient-token.service';

export interface FacadeSigner {
  signerType: string;
  channel: 'STAFF' | 'PORTAL' | 'DIRECT';
  displayName: string;
  signOrder: number;
  signerRole?: string;
  externalSignerRef?: string;
  requiredIdentityLevel?: string;
  certSerial?: string;
  relationship?: string;
  onBehalfOf?: string;
}

export interface FacadeInput {
  documentType: string;
  documentHash: string;
  channel?: 'DIRECT' | 'PORTAL' | 'STAFF' | 'PROXY';
  signers?: FacadeSigner[]; // 다중봉투 순차(있으면 단일 channel 무시)
  externalDocId?: string; // 봉투 ref(erpcontract:medical:<id> 등)
  issueNo: string;
  requiredIdentityLevel?: string;
  externalSignerRef?: string;
  certSerial?: string;
  signerRole?: string;
  relationship?: string; // PROXY 대리인↔환자 관계
  onBehalfOf?: string; // PROXY 대리 대상(환자)
  callbackUrl?: string; // 완료 webhook URL(미지정 시 HIS_WEBHOOK_URL 기본)
  patientSigner?: { name?: string; ci?: string; phone?: string; ciSource?: string };
  supersedesRequestId?: string; // C-2: 지정 시 해당 요청을 개정 재동의로 대체(새 버전)
  createdBy?: string; // 생성 소비자명(가드 주입) — 소비자별 webhook 시크릿 분리
}

/**
 * HIS-친화 단일호출 제출 facade (HIS 제안 계약 → 내부 /v1/requests 매핑).
 * channel: DIRECT(의료진/환자 앱 직접)·PORTAL(환자 deep-link)·STAFF(의료진 SSO).
 * - certSerial 없으면: PATIENT는 자동 enroll(patientSigner 기반), STAFF는 필수(staff-token sign_cert_serial).
 * - PORTAL이면 토큰 발급해 portalUrl 반환.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class SignRequestFacadeService {
  constructor(
    private readonly enroll: EnrollCertificateService,
    private readonly svc: SignatureRequestService,
    private readonly tokens: PatientTokenService,
    private readonly config: ConfigService,
  ) {}

  async submit(
    input: FacadeInput,
  ): Promise<
    | { signatureRequestId: string; participantId: string; portalUrl?: string }
    | { signatureRequestId: string; signers: Array<{ participantId: string; signOrder: number; signerRole: string; channel: string; externalSignerRef?: string; portalUrl?: string }> }
  > {
    if (input.signers?.length) return this.submitMulti(input); // 다중봉투 순차
    const isStaff = input.channel === 'STAFF';
    const isProxy = input.channel === 'PROXY';
    const level = input.requiredIdentityLevel ?? (isStaff ? 'STAFF_SSO' : 'PASS');
    const signerType = isStaff ? 'STAFF' : isProxy ? 'PROXY' : 'PATIENT';

    let certSerial = input.certSerial;
    if (!certSerial) {
      if (isStaff) throw new BadRequestException('STAFF는 certSerial 필요(staff-token sign_cert_serial 또는 사전 발급 serial)');
      // PATIENT/PROXY(대리인) 자동 발급 — patientSigner = 서명 당사자(환자 또는 대리인)
      const idMethod = level === 'INPERSON' ? 'INPERSON' : 'PASS';
      const enrolled = await this.enroll.enroll({
        ownerType: isProxy ? 'PROXY' : 'PATIENT',
        subjectDn: `CN=${input.patientSigner?.name ?? (isProxy ? '대리인' : '환자')}`,
        identity: { method: idMethod as 'PASS' | 'INPERSON', ci: input.patientSigner?.ci, phone: input.patientSigner?.phone },
      });
      certSerial = enrolled.serialNumber;
    }

    const participant = {
      signerRole: input.signerRole ?? signerType,
      signerType,
      displayName: input.patientSigner?.name ?? input.externalSignerRef ?? 'signer',
      signOrder: 1,
      certSerial,
      requiredIdentityLevel: level,
      externalSignerRef: input.externalSignerRef,
      relationship: input.relationship,
      onBehalfOf: input.onBehalfOf,
    };
    const signMode = input.channel === 'PORTAL' ? 'PORTAL' : 'APP';
    // C-2: supersedesRequestId 지정 시 개정 재동의(원본 대체), 아니면 신규 생성
    const req = input.supersedesRequestId
      ? await this.svc.supersede(input.supersedesRequestId, {
          idempotencyKey: input.issueNo,
          documentHash: input.documentHash,
          title: input.documentType,
          externalDocId: input.issueNo,
          signMode,
          callbackUrl: input.callbackUrl,
          createdBy: input.createdBy,
          participants: [participant],
        })
      : await this.svc.createRequest({
          idempotencyKey: input.issueNo,
          externalDocId: input.issueNo,
          title: input.documentType,
          documentHash: input.documentHash,
          signMode,
          callbackUrl: input.callbackUrl, // 없으면 createRequest가 HIS_WEBHOOK_URL 기본 적용
          createdBy: input.createdBy,
          participants: [participant],
        });
    const participantId = req.participants[0].participantId;

    let portalUrl: string | undefined;
    if (input.channel === 'PORTAL') {
      const base = (this.config.get<string>('PUBLIC_BASE_URL') ?? 'https://sign.example.org').replace(/\/$/, '');
      const t = await this.tokens.issueForParticipant(req.requestId, participantId);
      portalUrl = base + t.url;
    }
    return { signatureRequestId: req.requestId, participantId, portalUrl };
  }

  /**
   * 다중봉투 순차 서명 — ERP 계약 다자(거래처·의료진·신규입사 등). 단일 SignatureRequest 봉투에
   * 다수 서명자를 signOrder 순서로 게이팅. 채널별 신원경로: STAFF(SSO)·PORTAL(deep-link)·DIRECT(키 submit).
   * 신규입사 의료진(HIS 미등록)은 channel=PORTAL + 자동 임시 인증서(WITNESS)로 이메일 라우팅 서명.
   * 전 봉투 완료 시 단일 request.completed webhook(signatures[].externalSignerRef·certSerial·tsaToken +
   * assuranceLevel·auditCertUri echo — 코어 기존 동작).
   */
  private async submitMulti(input: FacadeInput): Promise<{ signatureRequestId: string; signers: Array<{ participantId: string; signOrder: number; signerRole: string; channel: string; externalSignerRef?: string; portalUrl?: string }> }> {
    const signers = [...(input.signers ?? [])].sort((a, b) => a.signOrder - b.signOrder);
    if (!signers.length) throw new BadRequestException('signers[] 비어있음');

    const participants = [];
    for (const s of signers) {
      const isStaff = s.channel === 'STAFF' || s.signerType === 'STAFF';
      const isProxy = s.signerType === 'PROXY';
      const level = s.requiredIdentityLevel ?? (isStaff ? 'STAFF_SSO' : s.channel === 'PORTAL' ? 'NONE' : 'PASS');
      let certSerial = s.certSerial;
      if (!certSerial) {
        if (isStaff) throw new BadRequestException(`STAFF 서명자(${s.displayName})는 certSerial 필요(staff-token sign_cert_serial)`);
        // 거래처·신규입사 등 — 임시 인증서 자동 발급(HIS 미등록도 서명 가능)
        const enrolled = await this.enroll.enroll({ ownerType: isProxy ? 'PROXY' : 'WITNESS', subjectDn: `CN=${s.displayName}` });
        certSerial = enrolled.serialNumber;
      }
      participants.push({
        signerRole: s.signerRole ?? s.signerType,
        signerType: s.signerType,
        displayName: s.displayName,
        signOrder: s.signOrder,
        certSerial,
        requiredIdentityLevel: level,
        externalSignerRef: s.externalSignerRef,
        relationship: s.relationship,
        onBehalfOf: s.onBehalfOf,
      });
    }

    const req = await this.svc.createRequest({
      idempotencyKey: input.issueNo,
      externalDocId: input.externalDocId ?? input.externalSignerRef ?? input.issueNo,
      title: input.documentType,
      documentHash: input.documentHash,
      signMode: 'MULTI',
      callbackUrl: input.callbackUrl,
      createdBy: input.createdBy,
      participants,
    });

    // 정렬 동일(둘 다 signOrder 오름차순) → 인덱스 정합. PORTAL 서명자는 deep-link 토큰 발급.
    const base = (this.config.get<string>('PUBLIC_BASE_URL') ?? 'https://sign.example.org').replace(/\/$/, '');
    const out = [];
    for (let i = 0; i < req.participants.length; i++) {
      const p = req.participants[i];
      const s = signers[i];
      let portalUrl: string | undefined;
      if (s.channel === 'PORTAL') {
        const t = await this.tokens.issueForParticipant(req.requestId, p.participantId);
        portalUrl = base + t.url;
      }
      out.push({ participantId: p.participantId, signOrder: p.signOrder, signerRole: p.signerRole, channel: s.channel, externalSignerRef: s.externalSignerRef, portalUrl });
    }
    return { signatureRequestId: req.requestId, signers: out };
  }
}
