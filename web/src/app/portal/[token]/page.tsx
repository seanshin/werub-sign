'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

/**
 * 서명자 포털 — 토큰 링크로 진입하는 외부 서명자 화면(로그인 없음).
 * 흐름: (접근암호 unlock →) 문서 열람(해시 배지·동의 게이트) → 기재(fill-at-signing) →
 * 손글씨 서명 → 제출. 모바일 뷰포트 대응(터치 서명).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React, { useEffect, useState, useCallback } from 'react';
import { portalApi } from '@/lib/api';
import { ApiError, ContractAttachment, PortalInfo, IdentityLevel } from '@/types/api';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Alert } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';
import { StatusPill } from '@/components/ui/StatusPill';
import { PortalA11y } from './PortalA11y';
import styles from './page.module.css';
import { SignaturePad } from '@/components/contracts/SignaturePad';
import { FIELD_TYPE_LABEL, fieldInputProps, validateFieldValue } from '@/lib/field-type';

type Step = 'loading' | 'locked' | 'info' | 'identity' | 'submitting' | 'done' | 'error';

function formatExpiry(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type ResultState =
  | { type: 'done'; requestStatus: string }
  | { type: 'error'; code: string; message: string };

interface PageProps {
  params: { token: string };
}

/* ============================================================
   본인인증 단계별 컴포넌트
   ============================================================ */

interface IdentityCardProps {
  level: IdentityLevel;
  demo: boolean;
  ci: string;
  phone: string;
  name: string;
  passExpanded: boolean;
  formError: string;
  onCiChange: (v: string) => void;
  onPhoneChange: (v: string) => void;
  onNameChange: (v: string) => void;
  onPassMock: () => void;
  onSign: () => void;
  onBack: () => void;
  expiresAt: string;
  signatureSlot?: React.ReactNode; // 손글씨 서명 패드(계약 트랙)
  signatureRequired?: boolean; // 손글씨 미입력 시 서명 버튼 비활성
  signatureReady?: boolean;
}

function IdentityCard({
  level,
  demo,
  ci,
  phone,
  name,
  passExpanded,
  formError,
  onCiChange,
  onPhoneChange,
  onNameChange,
  onPassMock,
  onSign,
  onBack,
  expiresAt,
  signatureSlot,
  signatureRequired,
  signatureReady,
}: IdentityCardProps) {
  const isPassReady = level === 'PASS' && passExpanded && ci.trim().length > 0;
  const isMobileReady = level === 'MOBILE_NAME' && (ci.trim().length > 0 || phone.trim().length > 0);
  const isInpersonReady = level === 'INPERSON';
  const isNoneReady = level === 'NONE';
  const isAppStepupReady = level === 'APP_STEPUP' && ci.trim().length > 0;

  // demo(실서비스 전·idv mock)면 본인확인 정보 없이도 서명 허용
  const identityReady = demo || isPassReady || isMobileReady || isInpersonReady || isNoneReady || isAppStepupReady;
  const canSign = identityReady && (!signatureRequired || signatureReady);
  const showDemoSkip = demo && (level === 'PASS' || level === 'MOBILE_NAME' || level === 'APP_STEPUP');

  return (
    <Card>
      <CardBody>
        {showDemoSkip && (
          <div style={{ marginBottom: 'var(--space-3)' }}>
            <Alert type="info" message="실서비스(PASS 본인인증) 연동 전입니다 — 본인확인 정보 없이 '동의하고 서명'으로 진행할 수 있습니다." />
          </div>
        )}
        {level === 'PASS' && (
          <div className={styles.formSection}>
            <h2 className={styles.formTitle}>PASS 본인인증</h2>
            <p className={styles.identityDesc}>
              PASS 앱으로 본인확인을 진행합니다.
            </p>

            {!passExpanded ? (
              <>
                {/* -------------------------------------------------------
                    실제 연동 시: 이 버튼 클릭 시 통신사 PASS 표준창을 팝업하거나
                    앱 딥링크(kakao://, naver:// 등)를 호출합니다.
                    PASS 콜백(비동기 앱푸시→서버 콜백→웹훅)으로 CI를 수신한 뒤
                    아래 CI 입력 영역 없이 직접 서명 엔드포인트를 호출해야 합니다.
                    현재는 mock 단계로, 버튼 클릭 시 CI 입력 영역을 펼쳐 직접 입력합니다.
                    ------------------------------------------------------- */}
                <Button
                  fullWidth
                  onClick={onPassMock}
                  className={styles.passButton}
                >
                  PASS로 본인확인
                </Button>
                <p className={styles.identityHint}>
                  [개발/mock] PASS 버튼 클릭 시 CI 직접 입력 영역이 열립니다.
                  실제 서비스에서는 PASS 표준창/앱 콜백으로 자동 처리됩니다.
                </p>
              </>
            ) : (
              <div className={styles.formFields}>
                <div className={styles.mockBanner}>
                  [Mock] 실제 PASS 연동 전 임시 CI 직접 입력
                </div>
                <Field
                  label="CI (연계정보)"
                  htmlFor="pass-ci"
                  hint="PASS 인증 후 발급되는 연계정보 식별값"
                >
                  <Input
                    id="pass-ci"
                    type="text"
                    placeholder="PASS CI 값 입력"
                    value={ci}
                    onChange={(e) => onCiChange(e.target.value)}
                    autoComplete="off"
                  />
                </Field>
                {formError && <Alert type="error" message={formError} />}
              </div>
            )}
          </div>
        )}

        {level === 'MOBILE_NAME' && (
          <div className={styles.formSection}>
            <h2 className={styles.formTitle}>휴대폰 명의 인증</h2>
            <p className={styles.identityDesc}>
              이름과 연계정보(CI) 또는 휴대폰 번호로 본인확인을 진행합니다.
            </p>
            <div className={styles.formFields}>
              <Field label="이름" htmlFor="mobile-name">
                <Input
                  id="mobile-name"
                  type="text"
                  placeholder="홍길동"
                  value={name}
                  onChange={(e) => onNameChange(e.target.value)}
                  autoComplete="name"
                />
              </Field>
              <Field
                label="CI (연계정보)"
                htmlFor="mobile-ci"
                hint="통신사 본인확인 CI 값 (CI 또는 휴대폰 번호 중 하나 필수)"
              >
                <Input
                  id="mobile-ci"
                  type="text"
                  placeholder="CI 값 입력"
                  value={ci}
                  onChange={(e) => onCiChange(e.target.value)}
                />
              </Field>
              <Field
                label="휴대폰 번호"
                htmlFor="mobile-phone"
                hint="CI 또는 휴대폰 번호 중 하나 필수"
              >
                <Input
                  id="mobile-phone"
                  type="tel"
                  placeholder="01012345678"
                  value={phone}
                  onChange={(e) => onPhoneChange(e.target.value)}
                  autoComplete="tel"
                />
              </Field>
              {formError && <Alert type="error" message={formError} />}
            </div>
          </div>
        )}

        {level === 'INPERSON' && (
          <div className={styles.formSection}>
            <h2 className={styles.formTitle}>대면 본인확인</h2>
            <div className={styles.inpersonNotice}>
              대면(INPERSON) 본인확인 방식입니다.<br />
              의료진이 현장에서 신분증으로 본인 확인 후 아래 서명 버튼을 눌러 서명을 완료합니다.
            </div>
          </div>
        )}

        {level === 'NONE' && (
          <div className={styles.formSection}>
            <h2 className={styles.formTitle}>서명 진행</h2>
            <p className={styles.identityDesc}>
              본인인증 없이 서명을 진행합니다.
            </p>
          </div>
        )}

        {level === 'APP_STEPUP' && (
          <div className={styles.formSection}>
            <h2 className={styles.formTitle}>앱 추가인증</h2>
            <p className={styles.identityDesc}>
              병원 앱의 추가 인증(APP_STEPUP)을 통해 발급된 CI 값을 입력합니다.
            </p>
            <div className={styles.formFields}>
              <Field
                label="CI (연계정보)"
                htmlFor="stepup-ci"
                hint="앱 추가인증 후 발급된 CI 값"
              >
                <Input
                  id="stepup-ci"
                  type="text"
                  placeholder="CI 값 입력"
                  value={ci}
                  onChange={(e) => onCiChange(e.target.value)}
                  autoComplete="off"
                />
              </Field>
              {formError && <Alert type="error" message={formError} />}
            </div>
          </div>
        )}

        {signatureSlot && <div className={styles.formSection}>{signatureSlot}</div>}

        <div className={styles.actions}>
          <Button fullWidth onClick={onSign} disabled={!canSign}>
            동의하고 서명
          </Button>
          <Button fullWidth variant="ghost" onClick={onBack}>
            뒤로
          </Button>
        </div>
        <p className={styles.expiresNote}>만료 시각: {formatExpiry(expiresAt)}</p>
      </CardBody>
    </Card>
  );
}

/* ============================================================
   메인 페이지
   ============================================================ */

export default function PortalPage({ params }: PageProps) {
  const { token } = params;
  const [step, setStep] = useState<Step>('loading');
  const [info, setInfo] = useState<PortalInfo | null>(null);
  const [result, setResult] = useState<ResultState | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');

  // 본인인증 입력 상태
  const [name, setName] = useState('');
  const [ci, setCi] = useState('');
  const [phone, setPhone] = useState('');
  const [formError, setFormError] = useState<string>('');
  // PASS mock: 버튼 클릭 시 CI 입력 영역 펼침
  const [passExpanded, setPassExpanded] = useState(false);
  // 문서 미리보기 — 서명 전 열람 확인(동의 게이트). documentAvailable 일 때만 강제.
  const [docReviewed, setDocReviewed] = useState(false);
  const [signatureImage, setSignatureImage] = useState<string | null>(null); // 손글씨 서명(계약 트랙)
  const [fillValues, setFillValues] = useState<Record<string, string>>({}); // fill-at-signing 기재값(A4, 라벨→값)
  // 계약 첨부(열람용 부속 문서, 설계 §11) — unlock 통과 후 조회
  const [attachments, setAttachments] = useState<ContractAttachment[]>([]);
  // 일반 전자계약 접근암호(unlock) — locked 응답 시 입력 후 통과해야 열람·서명.
  const [accessCode, setAccessCode] = useState('');
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockError, setUnlockError] = useState('');

  const load = useCallback(async () => {
    setStep('loading');
    try {
      const data = await portalApi.getInfo(token);
      setInfo(data);
      if (data.locked) {
        setStep('locked'); // 접근암호 확인 전 — 제목 외 내용 비노출
        return;
      }
      // 계약 첨부(열람용) — 계약 트랙만, 실패는 무시(첨부 없음 취급)
      if (data.request.signMode === 'CONTRACT') portalApi.attachments(token).then(setAttachments).catch(() => setAttachments([]));
      if (data.signer.status === 'SIGNED') {
        setResult({ type: 'done', requestStatus: 'SIGNED' });
        setStep('done');
        return;
      }
      setStep('info');
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : '서명 링크를 불러오지 못했습니다.';
      setErrorMsg(msg);
      setStep('error');
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const handleProceed = () => {
    if (!info || !info.canSignNow) return;
    // fill-at-signing(A4) — 배정 입력란 전량 기재 후 진행(서버도 fail-closed 검증)
    const missing = (info.inputFields ?? []).filter((f) => !(fillValues[f.label] ?? '').trim());
    if (missing.length) { setFormError(`입력란을 기재해 주세요: ${missing.map((f) => f.label).join(', ')}`); return; }
    // 타입 선검증(날짜·금액·숫자) — 서버가 최종 판정하되, 본인확인 단계 진입 전에 잡는다
    const bad = (info.inputFields ?? []).map((f) => validateFieldValue(f.fieldType, f.label, fillValues[f.label] ?? '')).find(Boolean);
    if (bad) { setFormError(bad); return; }
    setFormError('');
    setCi('');
    setPhone('');
    setName('');
    setPassExpanded(false);
    setStep('identity');
  };

  const handleSign = async () => {
    if (!info) return;
    const level = info.signer.requiredIdentityLevel;
    const demo = !!info.identityDemo; // 실서비스 전 — 본인인증 생략 가능(idv mock)

    // 입력 검증 — demo(실서비스 전)면 생략 허용
    if (!demo) {
      if (level === 'PASS' || level === 'APP_STEPUP') {
        if (!ci.trim()) {
          setFormError('CI 값을 입력해 주세요.');
          return;
        }
      } else if (level === 'MOBILE_NAME') {
        if (!ci.trim() && !phone.trim()) {
          setFormError('CI 또는 휴대폰 번호 중 하나를 입력해 주세요.');
          return;
        }
      }
    }

    setFormError('');
    setStep('submitting');

    try {
      // body.identity.method 는 백엔드 검증 enum(PASS·MOBILE_NAME·STAFF_SSO·INPERSON)에 맞춤.
      // 레벨(NONE·APP_STEPUP)은 method 가 아니므로 매핑. demo 면 본인확인 정보 없이 시연 값으로 통과(mock).
      const demoCi = demo ? 'DEMO-SKIP' : undefined;
      let body: Parameters<typeof portalApi.sign>[1];
      if (level === 'NONE') {
        body = {}; // 본인확인 불요 — identity 미전송
      } else if (level === 'INPERSON') {
        body = { identity: { method: 'INPERSON' } };
      } else if (level === 'MOBILE_NAME') {
        body = {
          identity: {
            method: 'MOBILE_NAME',
            ci: ci.trim() || demoCi,
            phone: phone.trim() || undefined,
            name: name.trim() || undefined,
          },
        };
      } else if (level === 'PASS' || level === 'APP_STEPUP') {
        // APP_STEPUP 도 실제 검증 method 는 PASS(레벨≠method)
        body = { identity: { method: 'PASS', ci: ci.trim() || demoCi } };
      } else {
        body = {}; // 알 수 없는 레벨 — 백엔드 판단(본인확인 불요)
      }

      if (signatureImage) body = { ...body, signatureImage }; // 손글씨 서명 증거(계약)
      // fill-at-signing(A4) — 배정 입력란 기재값 동봉(서명과 한 트랜잭션, 값은 서버에서 암호화 봉인)
      if ((info.inputFields ?? []).length) {
        body = { ...body, fillValues: (info.inputFields ?? []).map((f) => ({ label: f.label, value: (fillValues[f.label] ?? '').trim() })) };
      }
      const res = await portalApi.sign(token, body);
      setResult({ type: 'done', requestStatus: res.requestStatus });
      setStep('done');
    } catch (e) {
      // 기재값 거부는 종료 화면 대신 기재 단계로 되돌려 수정 가능하게(A4 고도화)
      // — 형식 오류는 400, **필수 미기재는 409**(서버가 ConflictException). 409 를 그대로 두면
      //   "이미 서명되었습니다"로 오표시되고 입력값이 통째로 사라진다.
      const fillReject = e instanceof ApiError && (e.code === 'HTTP_400' || (e.code === 'HTTP_409' && /입력란/.test(e.message)));
      if (fillReject && (info.inputFields ?? []).length) {
        setFormError(e.message);
        setStep('info');
        return;
      }
      if (e instanceof ApiError) {
        const code = e.code;
        const msg =
          code === 'HTTP_403'
            ? '본인확인 정보가 유효하지 않거나 이미 사용되었습니다.'
            : code === 'HTTP_409'
            ? '이미 서명되었거나 서명할 수 없는 상태입니다.'
            : code === 'HTTP_404'
            ? '서명 링크를 찾을 수 없습니다.'
            : e.message;
        setResult({ type: 'error', code, message: msg });
      } else {
        setResult({
          type: 'error',
          code: 'UNKNOWN',
          message: '서명 처리 중 오류가 발생했습니다.',
        });
      }
      setStep('done');
    }
  };

  // ── 로딩 ──
  if (step === 'loading') {
    return (
      <div className={styles.page}>
        <div className={styles.container}>
          <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-16)' }}>
            <Spinner size={40} />
          </div>
        </div>
      </div>
    );
  }

  // ── 접근암호 확인(일반 전자계약) ──
  if (step === 'locked' && info) {
    const handleUnlock = async () => {
      if (!accessCode.trim()) { setUnlockError('접근암호를 입력해 주세요.'); return; }
      setUnlockBusy(true); setUnlockError('');
      try {
        await portalApi.unlock(token, accessCode.trim());
        setAccessCode('');
        await load(); // 통과 — 전체 정보 재조회 후 기존 열람·서명 흐름
      } catch (e) {
        setUnlockError(e instanceof ApiError && e.status === 403 ? '접근암호가 일치하지 않습니다.' : '확인 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
      } finally { setUnlockBusy(false); }
    };
    return (
      <div className={styles.page}>
        <div className={styles.container}>
          <PortalA11y />
          <div className={styles.header}>
            <div className={styles.brandMark}>
              <span aria-hidden="true">&#9670;</span>
              전자계약 서명 포털
            </div>
            <h1 className={styles.title}>{info.request.title}</h1>
          </div>
          <Card>
            <CardBody>
              <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
                <p style={{ fontSize: 15, lineHeight: 1.6 }}>
                  이 계약 문서는 <strong>접근암호</strong>로 보호되어 있습니다.<br />
                  발송자에게 별도로 안내받은 접근암호를 입력하면 문서 확인과 서명을 진행할 수 있습니다.
                </p>
                {unlockError && <div role="alert" style={{ color: 'var(--color-danger,#dc2626)', fontSize: 14 }}>{unlockError}</div>}
                <Field label="접근암호" required htmlFor="ct-unlock">
                  <Input id="ct-unlock" type="password" value={accessCode} onChange={(e) => setAccessCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void handleUnlock(); }} autoComplete="off" placeholder="접근암호 입력" />
                </Field>
                <Button fullWidth onClick={handleUnlock} loading={unlockBusy}>확인</Button>
                <p className={styles.expiresNote}>만료 시각: {formatExpiry(info.expiresAt)}</p>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    );
  }

  // ── 링크 오류 ──
  if (step === 'error') {
    return (
      <div className={styles.page}>
        <div className={styles.container}>
          <div className={styles.header}>
            <div className={styles.brandMark}>의료/IT 전자서명</div>
          </div>
          <Card>
            <CardBody>
              <div className={styles.resultCard}>
                <div className={styles.resultIcon}>⚠️</div>
                <h2 className={styles.resultTitle}>링크 오류</h2>
                <p className={styles.resultDesc}>{errorMsg}</p>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    );
  }

  // ── 완료·실패 결과 ──
  if (step === 'done' && result) {
    const isSuccess = result.type === 'done';
    return (
      <div className={styles.page}>
        <div className={styles.container}>
          <div className={styles.header}>
            <div className={styles.brandMark}>의료/IT 전자서명</div>
          </div>
          <Card>
            <CardBody>
              <div className={styles.resultCard}>
                <div className={styles.resultIcon}>{isSuccess ? '✅' : '❌'}</div>
                <h2 className={styles.resultTitle}>
                  {isSuccess ? '서명이 완료되었습니다' : '서명 실패'}
                </h2>
                <p className={styles.resultDesc}>
                  {isSuccess ? (
                    <>
                      동의서 서명이 정상적으로 처리되었습니다.<br />
                      {result.type === 'done' && result.requestStatus === 'COMPLETED' && (
                        <>모든 참가자의 서명이 완료되어 요청이 최종 완료되었습니다.</>
                      )}
                      {result.type === 'done' && result.requestStatus === 'IN_PROGRESS' && (
                        <>다음 서명자의 서명을 기다리고 있습니다.</>
                      )}
                    </>
                  ) : (
                    result.message
                  )}
                </p>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    );
  }

  if (!info) return null;

  const level = info.signer.requiredIdentityLevel;
  const isContract = info.request.signMode === 'CONTRACT';

  return (
    <div className={styles.page}>
      <div className={`${styles.container}${isContract ? ` ${styles.wide}` : ''}`}>
        {/* 접근성: 글씨 크기·고대비(고령자) */}
        <PortalA11y />
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.brandMark}>
            <span aria-hidden="true">&#9670;</span>
            의료/IT 전자서명 포털
          </div>
          <h1 className={styles.title}>{info.request.title}</h1>
        </div>

        {/* 문서 정보 카드 */}
        <Card className={styles.docCard}>
          <CardBody>
            <div className={styles.docRow}>
              <span className={styles.docLabel}>문서 ID</span>
              <span className={styles.docValue}>{info.request.externalDocId}</span>
            </div>
            <div className={styles.docRow}>
              <span className={styles.docLabel}>서명 모드</span>
              <span className={styles.docValue}>{info.request.signMode}</span>
            </div>
            <div className={styles.docRow}>
              <span className={styles.docLabel}>문서 해시(앞 12자)</span>
              <span
                className={styles.docValue}
                style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}
              >
                {info.request.documentHashPrefix}...
              </span>
            </div>
          </CardBody>
        </Card>

        {/* 서명자 정보 */}
        <div className={styles.signerInfo}>
          <div className={styles.signerName}>{info.signer.displayName}</div>
          <div className={styles.signerRole}>
            {info.signer.role} · 서명순서 {info.signer.signOrder}번
          </div>
          <div style={{ marginTop: 'var(--space-2)' }}>
            <StatusPill status={info.signer.status} />
          </div>
        </div>

        {/* 순서 미도래 안내 */}
        {!info.canSignNow && info.signer.status !== 'SIGNED' && (
          <Alert
            type="info"
            message="현재 서명 순서가 아닙니다. 이전 참가자의 서명 완료 후 진행됩니다."
          />
        )}

        {/* ── 서명 대상 문서 미리보기(뷰어) ── */}
        {step === 'info' && info.canSignNow && info.documentAvailable && (
          <Card className={styles.docViewerCard}>
            <CardBody>
              <div className={styles.docViewerHead}>
                <h2 className={styles.formTitle}>서명 대상 문서</h2>
                <span className={styles.hashBadge} title="업로드 시 SHA-256 == 서명 대상 해시 검증됨">
                  <span aria-hidden="true">&#10003;</span> 표시 문서 = 서명 대상 (SHA-256 확인)
                </span>
              </div>
              <p className={styles.identityDesc}>
                서명하기 전에 아래 문서 내용을 확인해 주세요.
                {isContract && ' 앞 순서 서명자가 기재·서명한 내용이 함께 표시됩니다(원본 문서와 서명 대상 해시는 변하지 않습니다).'}
              </p>
              <iframe
                title="서명 대상 동의서 문서"
                src={portalApi.documentUrl(token)}
                className={styles.docFrame}
              />
              <div className={styles.docViewerFoot}>
                <a
                  href={portalApi.documentUrl(token)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.docOpenLink}
                >
                  새 탭에서 열기 / 다운로드
                </a>
              </div>
              <label className={styles.docConsent}>
                <input
                  type="checkbox"
                  checked={docReviewed}
                  onChange={(e) => setDocReviewed(e.target.checked)}
                />
                <span>위 문서 내용을 확인했습니다</span>
              </label>
            </CardBody>
          </Card>
        )}

        {/* ── fill-at-signing(A4) — 본인 배정 입력란 기재(필수) ── */}
        {step === 'info' && info.canSignNow && (info.inputFields ?? []).length > 0 && (
          <Card>
            <CardBody>
              <h2 className={styles.formTitle}>입력란 기재 ({(info.inputFields ?? []).length})</h2>
              <p className={styles.identityDesc}>
                본인에게 배정된 입력란입니다. 기재한 값은 암호화 보관되고 SHA-256 해시가 감사 이력에 봉인되며, 서명 완료 후 문서 표시본의 해당 위치에 표시됩니다.
              </p>
              <div style={{ display: 'grid', gap: 12 }}>
                {(info.inputFields ?? []).map((f) => (
                  <Field
                    key={f.label}
                    label={f.fieldType && f.fieldType !== 'text' ? `${f.label} (${FIELD_TYPE_LABEL[f.fieldType]})` : f.label}
                    required
                    htmlFor={`fill-${f.label}`}
                  >
                    <Input
                      id={`fill-${f.label}`}
                      value={fillValues[f.label] ?? ''}
                      onChange={(e) => setFillValues((v) => ({ ...v, [f.label]: e.target.value }))}
                      {...fieldInputProps(f.fieldType, f.label, f.maxLength)}
                    />
                  </Field>
                ))}
              </div>
            </CardBody>
          </Card>
        )}

        {/* ── 계약 첨부(열람용 부속 문서) ── */}
        {step === 'info' && attachments.length > 0 && (
          <Card>
            <CardBody>
              <h2 className={styles.formTitle}>첨부 문서 ({attachments.length})</h2>
              <p className={styles.identityDesc}>계약에 첨부된 참고 문서입니다(서명 대상 아님).</p>
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {attachments.map((a) => (
                  <li key={a.attachId}>
                    <a href={portalApi.attachmentUrl(token, a.attachId)} target="_blank" rel="noopener noreferrer" className={styles.docOpenLink}>
                      📎 {a.name} <span style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>({(a.sizeBytes / 1024).toFixed(0)}KB)</span>
                    </a>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        {/* ── 안내 단계 ── */}
        {step === 'info' && info.canSignNow && (
          <Card>
            <CardBody>
              <div className={styles.formSection}>
                <h2 className={styles.formTitle}>동의서 서명 안내</h2>

                {/* 인증수준별 안내 문구 */}
                {level === 'PASS' && (
                  <p className={styles.identityDesc}>
                    PASS 앱 본인확인 후 전자서명을 진행합니다.
                  </p>
                )}
                {level === 'MOBILE_NAME' && (
                  <p className={styles.identityDesc}>
                    휴대폰 명의 정보(이름 + CI/전화번호)로 본인확인 후 서명합니다.
                  </p>
                )}
                {level === 'INPERSON' && (
                  <p className={styles.identityDesc}>
                    대면 본인확인(INPERSON) 방식입니다. 의료진의 안내에 따라 서명을 진행해 주세요.
                  </p>
                )}
                {level === 'NONE' && (
                  <p className={styles.identityDesc}>
                    본인인증 없이 전자서명을 진행합니다.
                  </p>
                )}
                {level === 'APP_STEPUP' && (
                  <p className={styles.identityDesc}>
                    병원 앱 추가인증(APP_STEPUP)을 통해 발급된 CI로 서명합니다.
                  </p>
                )}

                {/* 인증수준 뱃지 */}
                <div style={{ marginTop: 'var(--space-2)' }}>
                  <span className={styles.levelChip}>{level}</span>
                </div>
              </div>
              {formError && <div role="alert" style={{ color: 'var(--color-danger,#dc2626)', fontSize: 14, marginTop: 8 }}>{formError}</div>}
              <div className={styles.actions}>
                <Button fullWidth onClick={handleProceed} disabled={!!info.documentAvailable && !docReviewed}>
                  서명 진행하기
                </Button>
              </div>
              {!!info.documentAvailable && !docReviewed && (
                <p className={styles.expiresNote} role="note">문서 확인 후 서명을 진행할 수 있습니다.</p>
              )}
              <p className={styles.expiresNote}>만료 시각: {formatExpiry(info.expiresAt)}</p>
            </CardBody>
          </Card>
        )}

        {/* ── 본인인증 단계 ── */}
        {step === 'identity' && (
          <IdentityCard
            level={level}
            demo={!!info.identityDemo}
            ci={ci}
            phone={phone}
            name={name}
            passExpanded={passExpanded}
            formError={formError}
            onCiChange={setCi}
            onPhoneChange={setPhone}
            onNameChange={setName}
            onPassMock={() => {
              setPassExpanded(true);
              setFormError('');
            }}
            onSign={handleSign}
            onBack={() => {
              setStep('info');
              setFormError('');
              setPassExpanded(false);
            }}
            expiresAt={info.expiresAt}
            signatureRequired={isContract}
            signatureReady={!!signatureImage}
            signatureSlot={isContract ? (
              <SignaturePad onChange={setSignatureImage} label="아래 칸에 서명해 주세요 (마우스·터치) — 계약 서명 증거로 기록됩니다" />
            ) : undefined}
          />
        )}

        {/* ── 제출 중 ── */}
        {step === 'submitting' && (
          <Card>
            <CardBody>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  padding: 'var(--space-10)',
                }}
              >
                <Spinner size={36} />
                <p
                  style={{
                    marginTop: 'var(--space-4)',
                    color: 'var(--color-text-secondary)',
                    fontSize: 'var(--text-sm)',
                  }}
                >
                  서명 처리 중...
                </p>
              </div>
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}
