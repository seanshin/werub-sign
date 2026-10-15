// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { applyDecorators } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';

/**
 * 스펙에 **인증 방식을 명시**하는 표시용 데코레이터(런타임 동작 없음).
 *
 * sign 은 키 인증 외에 두 가지 경로가 더 있다 — URL 에 박힌 1회용 토큰이 곧 자격증명인 경우,
 * 그리고 아무 자격증명도 필요 없는 공개 검증. 스펙에 아무 표시가 없으면 연동 개발자는
 * "키를 안 붙였으니 빠뜨린 건가?" 를 매번 되묻게 되므로, 의도적으로 열려 있다는 사실을 적어 둔다.
 * (실제 강제는 각 핸들러의 토큰 검증·가드가 담당한다.)
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export const TokenAuth = (kind: 'portal' | 'delivery' | 'verify') =>
  applyDecorators(
    ApiExtension('x-auth', `${kind}-token`),
    ApiExtension(
      'x-auth-note',
      {
        portal: '수신자 서명 링크의 1회용 토큰이 자격증명 — `x-api-key` 불요. 만료·사용완료·철회 시 4xx.',
        delivery: '완료 문서 교부 링크 토큰이 자격증명 — `x-api-key` 불요. 유효기간·열람 횟수 제한이 있다.',
        verify: '공개 검증 토큰(QR) — 진위 확인 정보만 노출하며, 서명자가 직접 기재한 정보가 있는 문서는 원문을 공개하지 않는다.',
      }[kind],
    ),
  );

/** 자격증명이 전혀 필요 없는 공개 엔드포인트 — 검증·OCSP·CRL·헬스체크. */
export const PublicApi = () =>
  applyDecorators(
    ApiExtension('x-auth', 'public'),
    ApiExtension('x-auth-note', '무인증 공개 — 누구나 호출할 수 있다(개인정보 미노출 범위만 반환).'),
  );

/** 콘솔 세션 토큰(사람) 전용 — 기계 연동 키로는 호출하지 않는다. */
export const SessionAuth = () =>
  applyDecorators(
    ApiExtension('x-auth', 'console-session'),
    ApiExtension('x-auth-note', '콘솔 로그인 세션(`x-session-token` 또는 `Authorization: Bearer`) 전용. 연동 API 아님.'),
  );

/** HIS SSO STAFF 토큰(`aud=sign`) — 의료진 본인이 직접 서명·결재하는 경로. */
export const StaffSsoAuth = () =>
  applyDecorators(
    ApiExtension('x-auth', 'staff-sso'),
    ApiExtension('x-auth-note', '`Authorization: Bearer <HIS SSO 토큰>`(aud=sign). 토큰의 sub 가 서명·결재 주체와 일치해야 한다.'),
  );
