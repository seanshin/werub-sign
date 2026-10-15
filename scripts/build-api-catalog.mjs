#!/usr/bin/env node
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * API 카탈로그의 엔드포인트 표를 `docs/openapi.json` 에서 생성한다.
 *
 * 손으로 적은 표는 반드시 낡는다 — 스펙이 진실이고 문서는 그 투영이어야 한다.
 * 산문(연동 시나리오·정책)은 사람이 쓰고, 목록만 이 스크립트가 채운다(AUTO 마커 사이).
 *
 * 실행: npm run api:catalog  (swagger:export 로 스펙을 갱신한 뒤에 돌린다)
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SPEC = 'docs/openapi.json';
const DOC = 'docs/05-handoff/api-catalog.md';
const START = '<!-- AUTO:endpoints:start -->';
const END = '<!-- AUTO:endpoints:end -->';

const spec = JSON.parse(readFileSync(SPEC, 'utf-8'));
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** 인증 방식 표기 — 스코프가 있으면 스코프가 곧 요구사항, 없으면 x-auth 분류. */
const authLabel = (op) => {
  if (op['x-required-scope']) return `\`${op['x-required-scope']}\``;
  return {
    public: '무인증',
    'prod-api-key': '운영 시 키',
    'console-session': '콘솔 세션',
    'staff-sso': 'STAFF SSO',
    'portal-token': '포털 토큰',
    'delivery-token': '교부 토큰',
    'verify-token': '검증 토큰',
  }[op['x-auth']] ?? '—';
};

/** 설명 첫 문장만 — 표에서는 한 줄이어야 읽힌다. */
const oneLine = (s) =>
  (s ?? '')
    .split('\n')[0]
    .replace(/\|/g, '\\|')
    .replace(/^\*\*(.+?)\*\*/, '$1')
    .trim();

const byTag = new Map();
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (!METHODS.includes(method)) continue;
    const tag = (op.tags ?? ['(미분류)'])[0];
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push({ method: method.toUpperCase(), path, op });
  }
}

// 태그 순서는 스펙의 tags 선언 순서(= 연동 개발자가 읽는 순서)를 따른다
const order = (spec.tags ?? []).map((t) => t.name);
const sortedTags = [...byTag.keys()].sort((a, b) => {
  const ia = order.indexOf(a), ib = order.indexOf(b);
  return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
});

const tagDesc = Object.fromEntries((spec.tags ?? []).map((t) => [t.name, t.description ?? '']));
const out = [];
for (const tag of sortedTags) {
  const rows = byTag.get(tag).sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  out.push(`### ${tag} (${rows.length})`, '');
  if (tagDesc[tag]) out.push(`${tagDesc[tag]}`, '');
  out.push('| 메서드 | 경로 | 인증 | 설명 |', '|---|---|---|---|');
  for (const r of rows) out.push(`| ${r.method} | \`${r.path}\` | ${authLabel(r.op)} | ${oneLine(r.op.description)} |`);
  out.push('');
}

const doc = readFileSync(DOC, 'utf-8');
const s = doc.indexOf(START), e = doc.indexOf(END);
if (s < 0 || e < 0) throw new Error(`${DOC} 에 AUTO 마커가 없습니다`);
const total = [...byTag.values()].reduce((n, v) => n + v.length, 0);
const generated = [
  START,
  '',
  `> 이 절은 \`npm run api:catalog\` 가 \`docs/openapi.json\`(v${spec.info.version})에서 생성합니다 — **직접 편집하지 마세요**.`,
  `> 전체 ${Object.keys(spec.paths).length} 경로 · ${total} 오퍼레이션.`,
  '',
  ...out,
].join('\n');
writeFileSync(DOC, doc.slice(0, s) + generated + doc.slice(e), 'utf-8');
console.log(`api-catalog.md 갱신 — ${total} 오퍼레이션 / ${sortedTags.length} 그룹`);
