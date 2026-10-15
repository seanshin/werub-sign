'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import React from 'react';
import { VerifyResult, AuditVerifyResult, SignatureVerification } from '@/types/api';

/**
 * 상세 서명 검증 패널 — 문서 무결성·감사체인·트러스트 근거·서명자별 검증 항목을 구체적으로 서술.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

const OK = '#16a34a';
const BAD = '#dc2626';
const MUTED = 'var(--color-text-muted)';

function Chip({ ok, label, na }: { ok: boolean; label: string; na?: boolean }) {
  const color = na ? MUTED : ok ? OK : BAD;
  const mark = na ? '—' : ok ? '✓' : '✗';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, padding: '3px 9px', borderRadius: 999, border: `1px solid ${color}`, color, whiteSpace: 'nowrap' }}>
      <span style={{ fontWeight: 700 }}>{mark}</span> {label}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: '6px 12px', alignItems: 'baseline', fontSize: 13 }}>
      <span style={{ color: MUTED }}>{label}</span>
      <span style={{ wordBreak: 'break-all' }}>{children}</span>
    </div>
  );
}

const SIGNER_TYPE_LABEL: Record<string, string> = {
  INTERNAL: '내부(콘솔 서명)',
  EXTERNAL_PARTY: '외부(포털 서명)',
  STAFF: '직원(SSO)',
  PATIENT: '환자',
  APPROVER: '결재자',
};
const IDENTITY_LABEL: Record<string, string> = {
  INPERSON: '대면 확인',
  PASS: 'PASS 본인인증',
  MOBILE_NAME: '휴대폰 본인확인',
  STAFF_SSO: '직원 SSO',
  NONE: '본인확인 없음',
  APP_STEPUP: '앱 추가인증',
};

function SignatureCard({ s, idx }: { s: SignatureVerification; idx: number }) {
  return (
    <div style={{ border: `1px solid ${s.valid ? 'var(--color-border)' : BAD}`, borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14 }}>서명 #{idx + 1} · {s.signerRole || '서명자'}</strong>
        <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, background: s.valid ? '#dcfce7' : '#fee2e2', color: s.valid ? '#166534' : '#991b1b', fontWeight: 600 }}>
          {s.valid ? '유효' : '검증 실패'}
        </span>
        {s.signerType && <span style={{ fontSize: 12, color: MUTED }}>{SIGNER_TYPE_LABEL[s.signerType] ?? s.signerType}</span>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <Row label="인증서 시리얼"><code style={{ fontSize: 12 }}>{s.certSerial}</code></Row>
        <Row label="서명 형식">{s.format || '—'}</Row>
        <Row label="신원확인 방법">{IDENTITY_LABEL[s.identityMethod] ?? s.identityMethod ?? '—'}</Row>
        <Row label="서명키 수탁">{s.keyCustody === 'HSM' ? 'HSM(하드웨어 보안모듈)' : s.keyCustody === 'SOFT' ? '소프트웨어 키' : '—'}</Row>
        {s.relationship === 'PROXY' && <Row label="대리 서명">{s.onBehalfOf ? `${s.onBehalfOf} 대리` : '대리 서명'}</Row>}
      </div>

      <div>
        <span style={{ fontSize: 12, color: MUTED, display: 'block', marginBottom: 6 }}>검증 항목</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <Chip ok={s.cryptoVerify} label="서명 암호검증" />
          <Chip ok={s.cmsValid} label="CMS(PKCS#7) 구조" />
          <Chip ok={s.chainValid} label="인증서 체인(CA 신뢰)" />
          <Chip ok={s.notExpired} label="유효기간 내" />
          <Chip ok={s.notRevoked} label="미폐기(OCSP/CRL)" />
          <Chip ok={s.timestampValid} label="타임스탬프(TSA)" />
          <Chip ok={s.ltvValid} label="장기검증(LTV)" />
        </div>
      </div>
    </div>
  );
}

export function ContractVerifyPanel({ verify, audit, completedSigners, verifyToken }: { verify: VerifyResult; audit: AuditVerifyResult | null; completedSigners: number; verifyToken?: string | null }) {
  if (completedSigners === 0) {
    return (
      <div style={{ padding: 14, borderRadius: 8, background: 'var(--color-bg-secondary,#f1f5f9)', color: 'var(--color-text-secondary)', fontSize: 14 }}>
        아직 서명이 없어 검증할 항목이 없습니다(서명 대기 중). 서명이 완료되면 서명별 암호검증·인증서·타임스탬프·감사체인 무결성이 여기에 표시됩니다.
      </div>
    );
  }

  const chainOk = verify.auditChainValid && (audit ? audit.valid : true);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 종합 판정 */}
      <div style={{ padding: '12px 16px', borderRadius: 10, background: verify.overall ? '#dcfce7' : '#fee2e2', color: verify.overall ? '#166534' : '#991b1b' }}>
        <strong style={{ fontSize: 15 }}>{verify.overall ? '✓ 검증 성공 — 모든 서명과 감사체인이 유효합니다' : '✗ 검증 실패 — 아래 항목을 확인하세요'}</strong>
        <div style={{ fontSize: 13, marginTop: 4 }}>
          서명 {verify.signatures.length}건 · 문서 무결성 {verify.documentIntegrity === 'VALID' ? '일치' : verify.documentIntegrity} · 감사체인 {chainOk ? '유효' : '이상'}
        </div>
      </div>

      {/* 문서 무결성 */}
      <section>
        <h4 style={{ fontSize: 13, margin: '0 0 8px', color: MUTED }}>문서 무결성</h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <Row label="서명 대상 문서">
            <Chip ok={verify.documentIntegrity === 'VALID'} label={verify.documentIntegrity === 'VALID' ? '원본 해시 일치(위변조 없음)' : verify.documentIntegrity} />
          </Row>
          <Row label="계약 상태">{verify.status}</Row>
        </div>
      </section>

      {/* 감사·이력 무결성 */}
      <section>
        <h4 style={{ fontSize: 13, margin: '0 0 8px', color: MUTED }}>감사·이력 무결성 (해시체인 + TSA 봉인)</h4>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          <Chip ok={verify.auditChainValid} label="해시체인 연속성" />
          <Chip ok={!!audit?.anchored} label={audit?.anchored ? 'TSA 시점봉인됨' : '미앵커(진행중)'} na={!audit?.anchored} />
          {audit?.anchored && <Chip ok={!!audit.anchorTsValid} label="타임스탬프 유효" />}
          {audit?.anchored && <Chip ok={!!audit.anchorMatchesChain} label="봉인 지점 일치(prefix 무결)" />}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {audit?.currentHead && <Row label="현재 체인 head"><code style={{ fontSize: 11 }}>{audit.currentHead.slice(0, 32)}…</code></Row>}
          {audit?.anchoredAt && <Row label="TSA 봉인 시각">{new Date(audit.anchoredAt).toLocaleString()}</Row>}
          {!audit?.anchored && <span style={{ fontSize: 12, color: MUTED }}>체결(전원 서명 완료) 시 TSA로 시점봉인되어 장기 무결성이 보장됩니다.</span>}
        </div>
      </section>

      {/* 트러스트 근거 */}
      {(verify.assuranceLevel || verify.caKeyCustody) && (
        <section>
          <h4 style={{ fontSize: 13, margin: '0 0 8px', color: MUTED }}>트러스트 근거 (인증기관)</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <Row label="보증 수준">{verify.assuranceLevel === 'HSM_ANCHORED' ? 'HSM 보호(하드웨어 보안모듈 앵커)' : verify.assuranceLevel === 'SOFTWARE' ? '소프트웨어' : verify.assuranceLevel}</Row>
            <Row label="CA 키 수탁">{verify.caKeyCustody === 'HSM' ? `HSM (${verify.caKeyCustodyProvider ?? ''})` : verify.caKeyCustody === 'SOFT' ? '소프트웨어' : '—'}</Row>
          </div>
        </section>
      )}

      {/* 서명자별 상세 */}
      <section>
        <h4 style={{ fontSize: 13, margin: '0 0 8px', color: MUTED }}>서명자별 검증 상세 ({verify.signatures.length}건)</h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {verify.signatures.map((s, i) => <SignatureCard key={i} s={s} idx={i} />)}
          {verify.signatures.length === 0 && <span style={{ fontSize: 13, color: MUTED }}>서명 데이터가 없습니다.</span>}
        </div>
      </section>

      {/* 공개 검증 링크(QR) */}
      {verifyToken && (
        <section>
          <h4 style={{ fontSize: 13, margin: '0 0 8px', color: MUTED }}>공개 검증 링크 (완료문서 QR)</h4>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
            <a href={`/contracts/verify/${verifyToken}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary,#2563eb)', fontWeight: 600 }}>
              /contracts/verify/{verifyToken.slice(0, 10)}…
            </a>
            <span style={{ color: MUTED }}>— 완료문서 각 페이지 하단 QR을 스캔하면 이 페이지(로그인 불요)로 연결됩니다.</span>
          </div>
        </section>
      )}

      <p style={{ fontSize: 12, color: MUTED, margin: 0, lineHeight: 1.6 }}>
        서명은 PKI 실서명(X.509 인증서 + PKCS#7/CAdES-BES)으로 봉인되며, 각 서명 시점의 인증서 유효성(체인·만료·폐기)과 타임스탬프(TSA)를 검증합니다.
        감사 이력은 해시체인으로 연결되어 위변조를 탐지하고, 체결 시 TSA로 시점봉인됩니다. 전자서명법 제3조에 따라 서명으로서의 효력이 인정됩니다.
      </p>
    </div>
  );
}
