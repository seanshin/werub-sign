// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import type { FieldValueType } from '@/types/api';

/**
 * 입력란(FIELD) 타입 — fill-at-signing(A4) 기재값의 표시·입력 규칙.
 * 검증·정규화의 정본은 서버(contract.service.normalizeFieldValue) — 여기 값은 입력 편의(힌트·길이·키패드)용.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export const FIELD_TYPE_LABEL: Record<FieldValueType, string> = {
  text: '텍스트',
  date: '날짜',
  money: '금액',
  number: '숫자',
};

export const FIELD_TYPE_OPTIONS: Array<{ value: FieldValueType; label: string }> = [
  { value: 'text', label: '텍스트' },
  { value: 'date', label: '날짜(YYYY-MM-DD)' },
  { value: 'money', label: '금액(원)' },
  { value: 'number', label: '숫자' },
];

/** 서버 FIELD_MAX_LEN 과 동일 — 초과 입력 자체를 막아 왕복을 줄인다(정본은 서버). */
export const FIELD_MAX_LEN: Record<FieldValueType, number> = { text: 200, date: 10, money: 20, number: 20 };

/**
 * 클라이언트 선검증 — 서버 normalizeFieldValue 와 같은 규칙(정본은 서버).
 * 서명 제출 전에 잡아 본인확인 단계로 넘어간 뒤 400 으로 튕기는 왕복을 막는다. 문제 없으면 null.
 */
export function validateFieldValue(type: FieldValueType | undefined, label: string, raw: string): string | null {
  const t: FieldValueType = type ?? 'text';
  const value = raw.trim();
  if (!value) return `${label}: 값을 입력해 주세요`;
  if (value.length > FIELD_MAX_LEN[t]) return `${label}: 최대 ${FIELD_MAX_LEN[t]}자`;
  if (t === 'date') {
    const m = /^(\d{4})[-./]?(\d{1,2})[-./]?(\d{1,2})$/.exec(value.replace(/\s/g, ''));
    if (!m) return `${label}: 날짜 형식(YYYY-MM-DD)으로 입력해 주세요`;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (y < 1900 || y > 2999 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return `${label}: 존재하지 않는 날짜입니다`;
  }
  if (t === 'money' && !/^\d+$/.test(value.replace(/[,\s원]/g, ''))) return `${label}: 금액은 숫자로 입력해 주세요(원 단위)`;
  if (t === 'number' && !/^-?\d+(\.\d+)?$/.test(value.replace(/[,\s]/g, ''))) return `${label}: 숫자만 입력해 주세요`;
  return null;
}

/** 타입별 입력 힌트 — placeholder·소프트키패드·최대 길이. */
export function fieldInputProps(type: FieldValueType | undefined, label: string, maxLength?: number) {
  const t: FieldValueType = type ?? 'text';
  const max = maxLength ?? FIELD_MAX_LEN[t];
  if (t === 'date') return { maxLength: max, inputMode: 'numeric' as const, placeholder: '예: 2026-07-28' };
  if (t === 'money') return { maxLength: max, inputMode: 'numeric' as const, placeholder: '예: 1,500,000 (원)' };
  if (t === 'number') return { maxLength: max, inputMode: 'decimal' as const, placeholder: '숫자만 입력' };
  return { maxLength: max, inputMode: 'text' as const, placeholder: `${label} 입력` };
}
