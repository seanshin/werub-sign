#!/usr/bin/env node
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * OpenAPI 스펙 회귀 — **연동 계약이 조용히 낡는 것**을 막는다.
 *
 * 스펙은 SaaS·연동 개발자가 보는 유일한 기계가독 계약이다. 새 엔드포인트를 추가하면서
 * 태그·설명·인증 표기를 빠뜨리면 "이건 키가 필요한가?"를 매번 되묻게 되고, 문서는 실물과 벌어진다.
 * 그래서 신규 오퍼레이션도 반드시 세 가지(그룹·설명·인증 방식)를 갖추도록 게이트로 강제한다.
 *
 * 스펙은 현재 코드에서 새로 생성해 비교한다(커밋된 파일만 보면 갱신을 잊은 경우를 놓친다).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
let failures = 0;
const check = (ok, msg) => { console.log('  ' + (ok ? '✅' : '❌') + ' ' + msg); if (!ok) failures++; };

console.log('\n== OpenAPI 스펙 회귀 ==');
execFileSync('node', ['dist/swagger-export.js'], { stdio: 'pipe' }); // 현재 코드 → docs/openapi.json
const spec = JSON.parse(readFileSync('docs/openapi.json', 'utf-8'));

const ops = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (METHODS.includes(method)) ops.push({ id: `${method.toUpperCase()} ${path}`, op });
  }
}
check(ops.length > 100, `오퍼레이션 ${ops.length}건 수집`);

const noTag = ops.filter((o) => !(o.op.tags ?? []).length);
check(noTag.length === 0, `그룹(tag) 누락 ${noTag.length}건${noTag.length ? ': ' + noTag.slice(0, 5).map((o) => o.id).join(', ') : ''}`);

const noDesc = ops.filter((o) => !(o.op.description ?? '').trim());
check(noDesc.length === 0, `설명 누락 ${noDesc.length}건${noDesc.length ? ': ' + noDesc.slice(0, 5).map((o) => o.id).join(', ') : ''}`);

// 인증 방식은 스코프(x-required-scope) 또는 분류(x-auth) 중 하나로 반드시 표기돼야 한다
const noAuth = ops.filter((o) => !o.op['x-required-scope'] && !o.op['x-auth']);
check(noAuth.length === 0, `인증 표기 누락 ${noAuth.length}건${noAuth.length ? ': ' + noAuth.slice(0, 5).map((o) => o.id).join(', ') : ''}`);

// 스코프를 요구하는 엔드포인트는 401/403 응답과 보안 스킴이 함께 선언돼야 한다(RequireScope 가 자동 부여)
const scoped = ops.filter((o) => o.op['x-required-scope']);
const badScoped = scoped.filter((o) => !o.op.responses?.['403'] || !(o.op.security ?? []).length);
check(badScoped.length === 0, `스코프 엔드포인트 ${scoped.length}건 — 403·보안스킴 누락 ${badScoped.length}건`);

// 태그는 전부 상단에 설명이 정의돼 있어야 한다(Swagger UI 그룹 안내)
const declared = new Set((spec.tags ?? []).map((t) => t.name));
const undeclared = [...new Set(ops.flatMap((o) => o.op.tags ?? []))].filter((t) => !declared.has(t));
check(undeclared.length === 0, `미정의 태그 ${undeclared.length}건${undeclared.length ? ': ' + undeclared.join(', ') : ''}`);

check((spec.servers ?? []).length > 0, `servers 선언(${(spec.servers ?? []).map((s) => s.description).join('·')})`);
check(spec.info.version === JSON.parse(readFileSync('package.json', 'utf-8')).version, `스펙 버전 = 패키지 버전(${spec.info.version})`);

console.log('\n' + (failures === 0 ? '✅ PASS — OpenAPI 스펙' : `❌ ${failures}건 실패`));
process.exit(failures === 0 ? 0 : 1);
