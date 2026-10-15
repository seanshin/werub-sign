// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * REST 요청 DTO 모음 — 컨트롤러 전 계층의 입력 검증이 여기 선언으로 결정된다.
 *
 * 동작 원리(main.ts 의 전역 ValidationPipe 와 한 쌍):
 *  - `whitelist: true` — 여기 선언되지 않은 필드는 **조용히 제거**된다. 새 입력 필드를 받으려면
 *    반드시 이 파일에 추가해야 한다(안 하면 컨트롤러에서 undefined — 흔한 실수 지점).
 *  - `transform: true` — 쿼리 문자열이 선언 타입으로 변환된다(@Type(() => Number) 등).
 *  - 상한(@Length/@ArrayMaxSize/@Min)은 입만 다물면 뚫리는 자원 소모 방어이기도 하다
 *    (예: 참가자 20·라벨 20·fillValues 50 — 감사 라운드 v1.15 에서 상향 조정된 값들).
 *
 * 검증 실패는 400 + {error:{code:'VALIDATION',…}} 로 표준화된다(all-exceptions.filter).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { Type } from 'class-transformer';
import { FIELD_VALUE_TYPES, FieldValueType } from '../application/contract-template.service';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

const OWNER_TYPES = ['PATIENT', 'STAFF', 'WITNESS', 'PROXY'] as const;
const ID_METHODS = ['PASS', 'MOBILE_NAME', 'STAFF_SSO', 'INPERSON'] as const;
const NOTIFY_CHANNELS = ['ALIMTALK', 'SMS', 'EMAIL'] as const;

export class IdentityDto {
  @IsIn(ID_METHODS) method!: (typeof ID_METHODS)[number];
  @IsOptional() @IsString() ci?: string;
  @IsOptional() @IsString() phone?: string;
}

export class EnrollDto {
  @IsIn(OWNER_TYPES) ownerType!: (typeof OWNER_TYPES)[number];
  @IsString() @Length(2, 200) subjectDn!: string;
  @IsOptional() @IsString() ownerRef?: string;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => IdentityDto) identity?: IdentityDto;
  @IsOptional() @IsString() licenseNumber?: string;
  @IsOptional() @IsInt() @Min(1) validDays?: number;
}

export class ParticipantDto {
  @IsString() signerRole!: string;
  @IsString() signerType!: string;
  @IsOptional() @IsString() externalSignerRef?: string;
  @IsString() displayName!: string;
  @IsInt() @Min(1) signOrder!: number;
  @IsString() certSerial!: string;
  @IsOptional() @IsString() requiredIdentityLevel?: string; // NONE/INPERSON/MOBILE_NAME/PASS/APP_STEPUP/STAFF_SSO
  @IsOptional() @IsString() relationship?: string; // PROXY 대리인↔환자 관계
  @IsOptional() @IsString() onBehalfOf?: string; // PROXY 대리 대상(환자)
}

export class SubmitDto {
  @IsOptional() @ValidateNested() @Type(() => IdentityDto) identity?: IdentityDto;
}

export class PortalSignDto {
  @IsOptional() @ValidateNested() @Type(() => IdentityDto) identity?: IdentityDto;
  @IsOptional() @IsString() @Length(1, 3_000_000) signatureImage?: string; // 손글씨 서명 PNG data URL(계약 트랙, 행위 증거)
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => FillValueDto) fillValues?: FillValueDto[]; // fill-at-signing 기재값(A4)
}

export class WithdrawDto {
  @IsOptional() @IsString() reason?: string;
}

/** C-2 문서 개정 재동의(supersede) — 개정 문서로 새 버전 생성, 원본 대체 */
export class SupersedeDto {
  @IsString() @Length(1, 64) idempotencyKey!: string;
  @IsString() @Length(64, 64) documentHash!: string; // 개정 문서 sha256 hex
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() externalDocId?: string;
  @IsOptional() @IsString() signMode?: string;
  @IsOptional() @IsString() callbackUrl?: string;
  @IsOptional() @IsNumber() @Min(0) ttlDays?: number;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ParticipantDto) participants?: ParticipantDto[]; // 미지정 시 원본 참가자 재사용
}

export class RotateKeyDto {
  @IsOptional() @IsString() newApiKey?: string; // 미지정 시 서버가 강한 키 생성·1회 반환
}

/** 의료진 중요 행위 — 블록체인 인증 로그(해시체인+TSA 봉인) */
export class AuditEventDto {
  @IsString() @Length(1, 64) action!: string; // 행위 유형(예: PRESCRIPTION_ISSUED·REPORT_APPROVED·CONSENT_OBTAINED)
  @IsString() @Length(1, 128) actor!: string; // 의료진 식별자(직원번호/user.id/면허)
  @IsOptional() @IsString() actorRole?: string; // DOCTOR·NURSE 등
  @IsOptional() @IsString() targetType?: string; // 대상 유형(PATIENT·STUDY·CONSENT 등)
  @IsOptional() @IsString() targetRef?: string; // 대상 식별자(환자ID·검사ID 등)
  @IsOptional() @IsString() @Length(1, 64) stream?: string; // 로그 스트림(기본 clinical-events)
  @IsOptional() @IsObject() data?: Record<string, unknown>; // 추가 메타(비밀·PHI 원본 금지)
  @IsOptional() @IsString() occurredAt?: string; // 미지정 시 서버시각
  @IsOptional() @IsBoolean() anchor?: boolean; // true면 TSA로 즉시 시점봉인
}

export class CommitKeyDto {
  @IsString() keepApiKey!: string; // 유지할 키(나머지 구키 폐기)
}

/** 소비자(기계 연동) 등록 — UI. 키는 서버 생성·1회 반환. */
export class CreateConsumerDto {
  @IsString() @Length(2, 31) name!: string;
  @IsArray() @IsString({ each: true }) scopes!: string[]; // 부여 스코프(ASSIGNABLE 검증은 서비스)
}

/** 소비자 수정 — 스코프 편집·상태(일시중지/재개). 동적 소비자만. */
export class UpdateConsumerDto {
  @IsOptional() @IsArray() @IsString({ each: true }) scopes?: string[];
  @IsOptional() @IsIn(['ACTIVE', 'SUSPENDED']) status?: 'ACTIVE' | 'SUSPENDED';
}

class PatientSignerDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() ci?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() ciSource?: string;
}

/** 다중봉투 순차 서명 — 서명자 1인(신원·순서·채널). ERP 계약 다자 서명. */
export class FacadeSignerDto {
  @IsString() signerType!: string; // STAFF | WITNESS_EXTERNAL | PATIENT | PROXY
  @IsIn(['STAFF', 'PORTAL', 'DIRECT']) channel!: 'STAFF' | 'PORTAL' | 'DIRECT'; // 서명 채널(신원경로)
  @IsString() displayName!: string;
  @IsInt() @Min(1) signOrder!: number; // 순차 게이팅(작은 순서부터)
  @IsOptional() @IsString() signerRole?: string;
  @IsOptional() @IsString() externalSignerRef?: string; // 사람 ref(staff sub / 거래처 식별자)
  @IsOptional() @IsString() requiredIdentityLevel?: string; // STAFF→STAFF_SSO, PORTAL→NONE/PASS
  @IsOptional() @IsString() certSerial?: string; // STAFF=staff-token sign_cert_serial 필수, 그 외 미지정 시 자동발급
  @IsOptional() @IsString() relationship?: string; // PROXY
  @IsOptional() @IsString() onBehalfOf?: string; // PROXY
}

/** HIS-친화 단일호출 제출 facade (POST /v1/sign-requests) */
export class SignRequestFacadeDto {
  @IsString() documentType!: string;
  @IsString() @Length(64, 64) documentHash!: string;
  @IsOptional() @IsIn(['DIRECT', 'PORTAL', 'STAFF', 'PROXY']) channel?: 'DIRECT' | 'PORTAL' | 'STAFF' | 'PROXY'; // 단일 서명자(레거시) — signers 미사용 시 필수
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => FacadeSignerDto) signers?: FacadeSignerDto[]; // 다중봉투 순차(있으면 channel 무시)
  @IsOptional() @IsString() externalDocId?: string; // 봉투 ref(예: erpcontract:medical:<id>). 미지정 시 issueNo
  @IsString() issueNo!: string;
  @IsOptional() @IsString() requiredIdentityLevel?: string;
  @IsOptional() @IsString() externalSignerRef?: string;
  @IsOptional() @IsString() relationship?: string; // PROXY
  @IsOptional() @IsString() onBehalfOf?: string; // PROXY
  @IsOptional() @IsString() certSerial?: string; // STAFF: staff-token sign_cert_serial
  @IsOptional() @IsString() signerRole?: string;
  @IsOptional() @IsString() callbackUrl?: string; // 완료 webhook URL(미지정 시 HIS_WEBHOOK_URL 기본)
  @IsOptional() @ValidateNested() @Type(() => PatientSignerDto) patientSigner?: PatientSignerDto;
  @IsOptional() @IsString() supersedesRequestId?: string; // C-2: 지정 시 해당 요청 개정 재동의(새 버전)
}

export class NotifyRecipientDto {
  @IsString() participantId!: string;
  @IsString() to!: string;
  @IsOptional() @IsIn(NOTIFY_CHANNELS) channel?: (typeof NOTIFY_CHANNELS)[number];
}

export class NotifyDto {
  @IsString() baseUrl!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => NotifyRecipientDto) recipients!: NotifyRecipientDto[];
}

export class CreateRequestDto {
  @IsString() @Length(1, 64) idempotencyKey!: string;
  @IsString() externalDocId!: string;
  @IsString() title!: string;
  @IsString() @Length(64, 64) documentHash!: string; // sha256 hex
  @IsString() signMode!: string;
  @IsOptional() @IsString() callbackUrl?: string;
  @IsOptional() @IsNumber() @Min(0) ttlDays?: number; // 기본 30(일). 분수 허용(짧은 만료).
  @IsArray() @ValidateNested({ each: true }) @Type(() => ParticipantDto) participants!: ParticipantDto[];
}

export class RevokeDto {
  @IsOptional() @IsString() reason?: string;
}

export class UpdateSettingsDto {
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsObject() fields?: Record<string, string>; // 비밀 아닌 설정(endpoint·templateId 등)
  @IsOptional() @IsObject() secrets?: Record<string, string>; // 평문 입력(빈=기존 유지, __CLEAR__=삭제). 봉인 저장
}

export class StaffSignDto {
  @IsString() participantId!: string;
}

const ADMIN_ROLES = ['admin', 'operator', 'viewer'] as const;

/** C-4 RBAC — 관리자 로그인 */
export class LoginDto {
  @IsString() @Length(3, 40) username!: string;
  @IsString() @Length(1, 200) password!: string;
}

/** 관리자 계정 생성(users:admin) */
export class CreateAdminUserDto {
  @IsString() @Length(3, 40) username!: string;
  @IsString() @Length(8, 200) password!: string;
  @IsIn(ADMIN_ROLES) role!: (typeof ADMIN_ROLES)[number];
  @IsOptional() @IsEmail() email?: string; // 내부 계정 이메일(계약 내부 서명자 식별·알림)
}

/** 관리자 계정 역할/상태/이메일 변경(users:admin) */
export class UpdateAdminUserDto {
  @IsOptional() @IsIn(ADMIN_ROLES) role?: (typeof ADMIN_ROLES)[number];
  @IsOptional() @IsIn(['active', 'disabled']) status?: 'active' | 'disabled';
  @IsOptional() @IsString() @Length(0, 200) email?: string; // 빈 문자열=이메일 제거
}

/** 본인 알림 이메일 설정(세션) — 빈 문자열=제거 */
export class SelfEmailDto {
  @IsOptional() @IsString() @Length(0, 200) email?: string;
}

/** 관리자 비밀번호 재설정(users:admin) */
export class ResetPasswordDto {
  @IsString() @Length(8, 200) newPassword!: string;
}

/** 본인 비밀번호 변경(세션) */
export class ChangePasswordDto {
  @IsString() @Length(1, 200) currentPassword!: string;
  @IsString() @Length(8, 200) newPassword!: string;
}

/** 2차 인증 검증(로그인 챌린지 + 코드) */
export class Mfa2faVerifyDto {
  @IsString() @Length(10, 512) mfaToken!: string;
  @IsString() @Length(6, 20) code!: string; // TOTP 6자리 또는 복구코드
}

/** 2차 인증 코드(활성화/해제) */
export class MfaCodeDto {
  @IsString() @Length(6, 20) code!: string;
}

// ── 전자결재(상신→결재) — electronic-approval.design.md ──

/** 결재선 1인(지정 결재자·순서·서명 인증서) */
export class ApprovalLineDto {
  @IsString() @Length(1, 128) approverId!: string; // 결재자 식별자(콘솔 username) — 바인딩
  @IsString() displayName!: string;
  @IsInt() @Min(1) order!: number; // 결재 순서
  @IsOptional() @IsString() certSerial?: string; // 결재자 서명 인증서 — 미지정 시 서버 자동발급(STAFF)
  @IsOptional() @IsString() role?: string;
}

/** 상신 — 결재선 지정 + 결재 봉투 생성 */
export class CreateApprovalDto {
  @IsString() @Length(1, 64) idempotencyKey!: string;
  @IsString() externalDocId!: string;
  @IsString() title!: string;
  @IsString() @Matches(/^[0-9a-fA-F]{64}$/) documentHash!: string; // sha256 hex(64) — 형식 검증
  @IsOptional() @IsString() docType?: string; // 위험 판정 근거(고위험이면 step-up)
  @IsOptional() @IsBoolean() highRisk?: boolean;
  @IsOptional() @IsString() callbackUrl?: string;
  @IsOptional() @IsNumber() @Min(0) ttlDays?: number;
  @IsOptional() @IsString() @Length(1, 128) submittedBy?: string; // 기계키 상신 시 상신자(caller 표기, 정보성)
  @IsArray() @ValidateNested({ each: true }) @Type(() => ApprovalLineDto) line!: ApprovalLineDto[];
}

/** 고위험/최종 결재 step-up 본인확인 자격 — 콘솔은 MFA(TOTP) 재확인 우선, 그 외 IdentityProvider(PASS) */
export class ApprovalStepUpDto {
  @IsOptional() @IsString() mfaCode?: string; // 콘솔 결재자 인증앱 코드(또는 복구코드) — MFA 재확인
  @IsOptional() @IsString() method?: string; // PASS(기본)·MOBILE_NAME 등(폴백)
  @IsOptional() @IsString() ci?: string;
  @IsOptional() @IsString() phone?: string;
}

/** 결재 액션(승인/반려) */
export class ApprovalActDto {
  @IsIn(['APPROVE', 'REJECT']) decision!: 'APPROVE' | 'REJECT';
  @IsOptional() @IsString() opinion?: string; // 결재 의견/반려 사유
  @IsOptional() @ValidateNested() @Type(() => ApprovalStepUpDto) stepUp?: ApprovalStepUpDto;
}

// ── 일반 전자계약(행정·일반 계약) — general-contracts.design.md ──

const CONTRACT_SIGNER_KINDS = ['INTERNAL', 'EXTERNAL'] as const;

/** 계약 서명자 1인 — 내부(콘솔 계정 바인딩) 또는 외부(이메일 발송+접근암호) */
export class ContractSignerDto {
  @IsIn(CONTRACT_SIGNER_KINDS) kind!: (typeof CONTRACT_SIGNER_KINDS)[number];
  @IsString() @Length(1, 128) displayName!: string;
  @IsInt() @Min(1) order!: number; // 서명 순서(순차 게이팅)
  @IsOptional() @IsString() signerRole?: string;
  @IsOptional() @IsString() @Length(1, 128) username?: string; // INTERNAL — 콘솔 계정(서명 시 세션 바인딩)
  @IsOptional() @IsEmail() email?: string; // EXTERNAL — 발송 수신
  @IsOptional() @IsString() certSerial?: string; // 미지정 시 서버 자동발급
}

/** 계약 생성 — 서명자 구성 + 계약 봉투 생성(문서 업로드·발송은 별도 EP) */
export class CreateContractDto {
  @IsString() @Length(1, 64) idempotencyKey!: string;
  @IsString() externalDocId!: string;
  @IsString() title!: string;
  @IsString() @Matches(/^[0-9a-fA-F]{64}$/) documentHash!: string; // sha256 hex(64)
  @IsOptional() @IsString() callbackUrl?: string;
  @IsOptional() @IsNumber() @Min(0) ttlDays?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @Length(1, 40, { each: true }) @Matches(/^[^|]+$/, { each: true, message: '라벨에 | 문자를 쓸 수 없습니다' }) labels?: string[];
  @IsOptional() @IsString() @Length(1, 40) category?: string; // 계약 분류(근로·용역·구매 등) — 완료 계약 카테고리별 관리
  @IsOptional() @IsString() @Length(4, 64) accessCode?: string; // 외부 포털 접근암호(선택, 해시만 보관)
  @IsOptional() @IsIn(['SEQUENTIAL', 'PARALLEL']) signingMode?: 'SEQUENTIAL' | 'PARALLEL'; // 순차(기본)|동시
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PlacedMarkDto) signMarks?: PlacedMarkDto[]; // 서명란 좌표(서명자별) — 서명 후 손글씨 이미지 합성 위치
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => ContractSignerDto) signers!: ContractSignerDto[];
}

/** 계약 발송/재발송 — 콘솔/HIS caller 가 포털 링크 prefix 제공(NotifyDto.baseUrl 동형) */
export class ContractSendDto {
  @IsString() baseUrl!: string;
}

/** 새 계약 프리셋 서명자 구성(U5) — 요청 구성만(인증서·문서 무관) */
export class PresetSignerDto {
  @IsIn(['INTERNAL', 'EXTERNAL']) kind!: 'INTERNAL' | 'EXTERNAL';
  @IsString() @Length(1, 100) displayName!: string;
  @IsNumber() @Min(1) order!: number;
  @IsOptional() @IsString() @Length(1, 100) username?: string;
  @IsOptional() @IsEmail() email?: string;
}

/** 새 계약 프리셋 저장(U5) — 접근암호 값은 저장하지 않음(useAccessCode 여부만) */
export class ContractPresetDto {
  @IsString() @Length(1, 60) name!: string;
  @IsOptional() @IsString() @Length(1, 200) title?: string;
  @IsOptional() @IsString() @Length(1, 40) category?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @Length(1, 40, { each: true }) @Matches(/^[^|]+$/, { each: true, message: '라벨에 | 문자를 쓸 수 없습니다' }) labels?: string[];
  @IsOptional() @IsIn(['SEQUENTIAL', 'PARALLEL']) signingMode?: 'SEQUENTIAL' | 'PARALLEL';
  @IsOptional() @IsBoolean() useAccessCode?: boolean;
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => PresetSignerDto) signers!: PresetSignerDto[];
}

/** 계약 보관(계약함 제거) — 사유(선택) */
export class ContractArchiveDto {
  @IsOptional() @IsString() @Length(1, 200) reason?: string;
}

/** 계약 카테고리 변경(재분류) */
export class ContractCategoryDto {
  @IsString() @Length(1, 40) category!: string;
}

/** fill-at-signing 기재값(A4) — 배정 입력란 라벨별 값(서명과 한 트랜잭션, fail-closed) */
export class FillValueDto {
  @IsString() @Length(1, 100) label!: string;
  @IsString() @Length(1, 200) value!: string;
}

/** 계약 내부 서명 — 손글씨 서명 이미지(선택, 행위 증거) + 기재값(배정 입력란 있으면 필수) */
export class ContractSignDto {
  @IsOptional() @IsString() @Length(1, 3_000_000) signatureImage?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => FillValueDto) fillValues?: FillValueDto[];
}

/** 주소록 추가 */
export class AddressbookAddDto {
  @IsEmail() email!: string;
  @IsString() @Length(1, 100) name!: string;
  @IsOptional() @IsString() @Length(1, 100) org?: string;
  @IsOptional() @IsString() @Length(1, 300) memo?: string;
}

/** 주소록 수정(부분) */
export class AddressbookUpdateDto {
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @Length(1, 100) name?: string;
  @IsOptional() @IsString() @Length(0, 100) org?: string;
  @IsOptional() @IsString() @Length(0, 300) memo?: string;
}

/** 포털 접근암호 확인(unlock) — 일반 전자계약 외부 서명자 */
export class PortalUnlockDto {
  @IsString() @Length(1, 64) code!: string;
}

/** 조판 마커 라벨용 서명자(순번·표시명) */
export class ComposeSignerDto {
  @IsInt() @Min(1) order!: number;
  @IsString() @Length(1, 128) displayName!: string;
}

/** 리치 본문 런(run) — 텍스트 조각+굵기 */
export class ComposeRunDto {
  @IsString() @Length(0, 10_000) text!: string;
  @IsOptional() @IsBoolean() bold?: boolean;
}

/** 리치 본문 블록 — 문서제목(h1)/조항제목(h2)/문단/목록(listItem)/표 행(tableRow) (A5: 정렬·목록·표) */
export class ComposeBlockDto {
  @IsIn(['heading', 'paragraph', 'listItem', 'tableRow']) type!: 'heading' | 'paragraph' | 'listItem' | 'tableRow';
  @IsOptional() @IsInt() @Min(1) level?: number; // heading 1|2 · listItem 깊이
  @IsOptional() @IsIn(['left', 'center', 'right']) align?: 'left' | 'center' | 'right';
  @IsOptional() @IsBoolean() ordered?: boolean; // listItem 번호 목록
  @IsOptional() @IsInt() @Min(1) index?: number; // listItem 번호
  @IsOptional() @IsBoolean() header?: boolean; // tableRow 헤더
  // cells 는 2차원/유니온 구조라 class-validator 중첩 한계 → 서비스에서 형식·길이 검증(composePdf)
  // R11 — 셀은 런 배열(레거시) 또는 { runs, colspan, rowspan, align } 객체
  @IsOptional() @IsArray() cells?: Array<Array<{ text: string; bold?: boolean }> | { runs: Array<{ text: string; bold?: boolean }>; colspan?: number; rowspan?: number; align?: 'left' | 'center' | 'right' }>;
  // R9 — 열 폭 비율(표 첫 행 값을 표 전체에 적용). 값 검증은 서비스에서 수행
  @IsOptional() @IsArray() @ArrayMaxSize(12) widths?: number[];
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => ComposeRunDto) runs!: ComposeRunDto[];
}

/** 자유 배치 마크 — 배치 편집기 좌표(페이지 상대 0..1, y=상단 기준) */
export class PlacedMarkDto {
  @IsInt() @Min(1) page!: number;
  @IsNumber() @Min(0) x!: number;
  @IsNumber() @Min(0) y!: number;
  @IsNumber() @Min(0) w!: number;
  @IsNumber() @Min(0) h!: number;
  @IsInt() @Min(1) signer!: number;
  @IsIn(['SIGN', 'FIELD']) type!: 'SIGN' | 'FIELD';
  @IsOptional() @IsString() @Length(1, 64) label?: string;
  // 입력란 값 타입(A4 고도화) — 미지정=text(기존 마크 하위호환)
  @IsOptional() @IsIn(FIELD_VALUE_TYPES) fieldType?: FieldValueType;
}

/** Webhook DEAD 재발송 필터 — 미지정 시 DEAD 전건(최대 limit). */
export class WebhookRedriveDto {
  @IsOptional() @IsString() @Length(1, 64) requestId?: string;
  @IsOptional() @IsString() @Length(1, 200) targetUrl?: string; // 부분일치(수신 호스트/경로)
  @IsOptional() @IsInt() @Min(1) limit?: number; // 기본 100·최대 1000
  // 수신 경로가 변경된 경우 재지정(저장된 옛 주소로는 계속 실패) — http(s) 절대 URL
  @IsOptional() @IsString() @Length(8, 500) @Matches(/^https?:\/\//, { message: 'newTargetUrl 은 http(s) 절대 URL' }) newTargetUrl?: string;
}

/** 백업 성공 하트비트(S9) — 호스트 백업 크론이 성공 시 남기는 생존 신호. note 는 파일명 등 식별 정보. */
export class BackupHeartbeatDto {
  @IsOptional() @IsString() @Length(1, 200) note?: string;
}

/** DEAD 통지 폐기 — 수신처 폐지 등으로 재발송이 무의미한 건을 적체·경고에서 제외(이력 보존) */
export class WebhookDiscardDto {
  @IsOptional() @IsString() @Length(1, 64) requestId?: string;
  @IsOptional() @IsString() @Length(1, 200) targetUrl?: string; // 부분일치(수신 호스트/경로)
  @IsOptional() @IsInt() @Min(1) limit?: number; // 기본 100·최대 1000
  // 왜 폐기했는지 — 감사에 그대로 남으므로 필수(사후에 "왜 안 갔지"를 설명할 수 있어야 한다)
  @IsString() @Length(2, 200) reason!: string;
}

/**
 * 저장된 요청의 `callbackUrl` 재지정 — 연동처가 수신 경로를 바꿨을 때 **아직 발화하지 않은 통지**를 구제한다.
 * 웹훅 재발송(WebhookRedriveDto.newTargetUrl)과 같은 발상이되 대상이 통지가 아니라 **요청**이다.
 * 기본은 `dryRun` — 실제 적용은 `dryRun:false` 를 명시해야 한다(대상을 먼저 세어 보고 실행).
 */
export class CallbackRetargetDto {
  // 옛 주소(부분일치) — 너무 짧으면 무관한 요청까지 걸리므로 최소 길이를 둔다
  @IsString() @Length(8, 500) fromUrl!: string;
  // 새 주소 — 요청 생성 때와 동일한 SSRF 검증(hardening.validateCallbackUrl)을 통과해야 한다
  @IsString() @Length(8, 500) @Matches(/^https?:\/\//, { message: 'toUrl 은 http(s) 절대 URL' }) toUrl!: string;
  // 대상 상태 — 기본 CREATED·IN_PROGRESS(아직 통지가 남은 요청). 종결 요청은 통지가 이미 끝났다.
  @IsOptional() @IsArray() @IsIn(['CREATED', 'IN_PROGRESS', 'COMPLETED', 'EXPIRED', 'WITHDRAWN', 'SUPERSEDED'], { each: true }) statuses?: string[];
  @IsOptional() @IsBoolean() dryRun?: boolean; // 미지정=true(안전 기본값)
  @IsOptional() @IsInt() @Min(1) limit?: number; // 실제 적용 상한. 기본 500·최대 5000
}

/** 미서명 외부 서명자 수신 이메일 정정(R4) */
export class ContractParticipantEmailDto {
  @IsEmail() @Length(3, 254) email!: string;
}

/** 서명란 좌표 재지정(기존 계약 손글씨 합성 위치) */
export class UpdateSignMarksDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => PlacedMarkDto) signMarks!: PlacedMarkDto[];
}

/** 커스텀 서식 필드 정의 */
export class TemplateFieldDto {
  @IsString() @Length(1, 40) key!: string;
  @IsString() @Length(1, 100) label!: string;
  @IsIn(['text', 'date', 'money', 'textarea']) type!: 'text' | 'date' | 'money' | 'textarea';
  @IsOptional() @IsString() @Length(0, 200) placeholder?: string;
  @IsOptional() @IsBoolean() required?: boolean;
}

/** 커스텀 서식 생성 */
export class CustomTemplateDto {
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsString() @Length(0, 40) category?: string;
  @IsOptional() @IsString() @Length(0, 500) description?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TemplateFieldDto) fields?: TemplateFieldDto[];
  @IsString() @Length(10, 100_000) body!: string;
}

/** 커스텀 서식 수정(부분) */
export class CustomTemplateUpdateDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsString() @Length(0, 40) category?: string;
  @IsOptional() @IsString() @Length(0, 500) description?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TemplateFieldDto) fields?: TemplateFieldDto[];
  @IsOptional() @IsString() @Length(10, 100_000) body?: string;
}

/** 계약 서식 조판 — 최종 본문 텍스트 → 한글 PDF(저장 안 함, 클라가 해시 후 생성 플로우) */
export class ComposeContractDto {
  @IsString() @Length(1, 200) title!: string;
  @IsString() @Length(1, 100_000) body!: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ComposeSignerDto) signers?: ComposeSignerDto[]; // [서명란#N]·[입력란#N:라벨] 마커 라벨링
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PlacedMarkDto) marks?: PlacedMarkDto[]; // 배치 편집기 자유 좌표 마크
  @IsOptional() @IsArray() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => ComposeBlockDto) doc?: ComposeBlockDto[]; // 리치 에디터 블록(있으면 body 대신 사용, body=플레인 폴백)
}

/** 업로드 PDF 마크 스탬프 — 배치 편집기 좌표를 기존 PDF 에 렌더(저장 안 함) */
export class StampContractDto {
  @IsString() @Length(1, 30_000_000) pdfBase64!: string; // ~20MB PDF
  @IsArray() @ValidateNested({ each: true }) @Type(() => PlacedMarkDto) marks!: PlacedMarkDto[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ComposeSignerDto) signers?: ComposeSignerDto[];
}
