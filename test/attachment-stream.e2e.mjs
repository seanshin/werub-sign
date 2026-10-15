// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 첨부 청크 스트리밍 e2e (R9) — `docs/01-plan/audit-2026-07-28-followups.md` §2 R9.
 *
 * 예전 구현은 첨부 blob 을 meta 슬롯 하나에 base64 로 넣고, 다운로드 때 **파일 전체**를
 * 파싱·디코드·복호·해시한 뒤 응답 버퍼에 담았다 → 10MB×N 동시 열람이 곧 힙 폭증.
 * 지금은 청크(256KB)로 나눠 저장하고, 읽을 때 청크 단위로 복호·검증 후 즉시 방출한다.
 *
 * 검증:
 *  ① 청크 경계를 넘는 큰 첨부의 바이트 무결성(업로드==다운로드, 재조립 순서 포함)
 *  ② 경계 정확도 — 청크 크기 정확 배수·1청크 미만
 *  ③ 다운로드 경로 3종(콘솔·포털·교부) 모두 동일 바이트 + Content-Length
 *  ④ **청크 단위 저장 확인** — 저장소 스냅샷에 청크 슬롯이 나뉘어 있어야 피크 힙이 청크로 고정된다
 *  ⑤ 청크 1개만 손상시켜도 **온전한 바이트가 내려가지 않음**(방출 전 해시 검증)
 *  ⑥ v1 레거시(단일 슬롯) 첨부도 그대로 읽힘 — dual-read, 데이터 마이그레이션 불요
 *
 * 저장소는 file 드라이버 — 스냅샷을 직접 들여다보고(④) 손상시켜(⑤⑥) 검증하기 위함.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4851, B = `http://127.0.0.1:${PORT}`;
const KEY = 'atts-his-key';
const ADMIN_PW = 'admin-pass-123';
const CHUNK = 256 * 1024; // 서비스의 CHUNK_BYTES 와 동일
const MASTER_KEY = Buffer.alloc(32, 91).toString('base64');

let failures = 0;
const check = (c, m, extra = '') => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m + (extra ? ` — ${extra}` : '')); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = { 'Content-Type': 'application/json' };
const KH = { ...J, 'x-api-key': KEY };
const sha = (b) => createHash('sha256').update(b).digest('hex');

const dir = mkdtempSync(join(tmpdir(), 'sign-attstream-'));
const STORE_FILE = join(dir, 'store.json');

/** 지정 크기의 유효한 PDF 바이트 — 위치 의존 패턴이라 청크 뒤섞임·중복도 잡힌다. */
function makePdf(size) {
  const head = Buffer.from('%PDF-1.4\n', 'latin1');
  const tail = Buffer.from('\n%%EOF\n', 'latin1');
  const body = Buffer.alloc(size - head.length - tail.length);
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + (i >> 8)) & 0xff;
  return Buffer.concat([head, body, tail]);
}

function start() {
  return spawn('node', ['dist/main.js'], {
    env: {
      ...process.env, SIGN_PORT: String(PORT), HIS_INBOUND_API_KEY: KEY,
      CRYPTO_MASTER_KEY: MASTER_KEY,
      SIGN_ADMIN_USER: 'root', SIGN_ADMIN_PASSWORD: ADMIN_PW, SESSION_TTL_MIN: '60',
      GENERAL_CONTRACTS: 'on', CONTRACT_ATTACH_MAX_MB: '12',
      STORE_DRIVER: 'file', STORE_FILE,
    },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/v1/crl')).ok) return true; } catch { /* 기동 대기 */ } await sleep(300); } return false; }
const login = async () => (await (await fetch(B + '/v1/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ username: 'root', password: ADMIN_PW }) })).json()).data?.token;

/** 스냅샷의 meta KV 를 Map 형태로 읽는다(파일 드라이버 전용 — 저장 레이아웃 검증용). */
const readMeta = () => new Map(JSON.parse(readFileSync(STORE_FILE, 'utf8')).meta ?? []);
const writeMeta = (map) => {
  const snap = JSON.parse(readFileSync(STORE_FILE, 'utf8'));
  snap.meta = [...map];
  writeFileSync(STORE_FILE, JSON.stringify(snap), 'utf8');
};

async function main() {
  console.log('\n══════ 첨부 청크 스트리밍 e2e (R9) ══════\n');
  let srv = start();
  if (!(await up())) { console.error('서버 기동 실패'); srv.kill(); rmSync(dir, { recursive: true, force: true }); process.exit(1); }
  let rid, rid2, big, target;
  const BIG = makePdf(5 * CHUNK + 12345); // 5청크 + 나머지
  const TARGET = makePdf(3 * CHUNK);
  try {
    const root = await login();
    const MAIN = makePdf(2048);
    const sPost = (p, b, tok = root) => fetch(B + p, { method: 'POST', headers: { ...J, 'x-session-token': tok }, body: JSON.stringify(b ?? {}) });
    const sPut = (p, bytes, tok = root) => fetch(B + p, { method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'x-session-token': tok }, body: bytes });
    const dlConsole = (r, a) => fetch(B + `/v1/contracts/${r}/attachments/${a}`, { headers: { 'x-session-token': root } });

    const mk = async (idem, code) => {
      const body = { idempotencyKey: idem, externalDocId: idem, title: '스트리밍 첨부', documentHash: sha(MAIN), accessCode: code, signers: [{ kind: 'EXTERNAL', displayName: '외부', email: 'atts@example.com', order: 1 }] };
      const ct = (await (await sPost('/v1/contracts', body)).json()).data;
      await sPut(`/v1/contracts/${ct.requestId}/document`, MAIN);
      return ct.requestId;
    };
    const putAtt = (r, name, bytes, type = 'application/pdf') =>
      fetch(B + `/v1/contracts/${r}/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': type, 'x-session-token': root }, body: bytes });

    // ── ① 청크 경계를 넘는 큰 첨부 ──
    console.log('── 큰 첨부(다중 청크) 무결성 ──');
    rid = await mk('atts-1', 'atts-1234');
    const bigRes = await putAtt(rid, '대용량.pdf', BIG);
    big = (await bigRes.json()).data;
    check(bigRes.status === 201 && big?.sizeBytes === BIG.length && big?.sha256 === sha(BIG), '업로드 — 크기·SHA-256 기록', `${(BIG.length / 1024).toFixed(0)}KB`);

    const dl = await dlConsole(rid, big.attachId);
    const got = Buffer.from(await dl.arrayBuffer());
    check(dl.status === 200 && got.equals(BIG), '다운로드 — 바이트 완전 일치(청크 재조립 순서 포함)');
    check(dl.headers.get('content-length') === String(BIG.length), 'Content-Length = 원본 크기');

    // ── ② 경계 정확도 ──
    const EXACT = makePdf(2 * CHUNK);
    const ex = (await (await putAtt(rid, '정확배수.pdf', EXACT)).json()).data;
    check(Buffer.from(await (await dlConsole(rid, ex.attachId)).arrayBuffer()).equals(EXACT), '청크 크기 정확 배수 — 빈 꼬리 청크 없이 일치');
    const SMALL = makePdf(1024);
    const sm = (await (await putAtt(rid, '소형.pdf', SMALL)).json()).data;
    check(Buffer.from(await (await dlConsole(rid, sm.attachId)).arrayBuffer()).equals(SMALL), '1청크 미만 첨부도 일치');

    // ── ④ 청크 단위 저장 확인 ──
    console.log('── 저장 레이아웃(청크 분할) ──');
    const meta = readMeta();
    const manifest = meta.get(`ctattach:${rid}:${big.attachId}`);
    const chunkKeys = [...meta.keys()].filter((k) => k.startsWith(`ctattach:${rid}:${big.attachId}:c`));
    check(manifest?.v === 2 && Array.isArray(manifest?.parts), '매니페스트(v2) 저장 — 청크 목록 보유');
    check(chunkKeys.length === Math.ceil(BIG.length / CHUNK) && chunkKeys.length === manifest.parts.length, `청크 슬롯 분리 저장 — ${chunkKeys.length}개(= ⌈크기/청크⌉)`);
    check(manifest.parts.reduce((s, p) => s + p.bytes, 0) === BIG.length, '청크 크기 합 = 원본 크기');
    check(Buffer.from(JSON.stringify(meta.get(chunkKeys[0]))).length < CHUNK * 3, '청크 슬롯 하나가 파일 전체를 담지 않음(피크 힙 = 청크)');

    // ── ③ 포털·교부 경로 ──
    console.log('── 경로별 동일성(콘솔·포털·교부) ──');
    const tok = (await (await fetch(B + `/v1/requests/${rid}/portal-tokens`, { method: 'POST', headers: KH, body: '{}' })).json()).data[0].token;
    await sPost(`/v1/contracts/${rid}/send`, { baseUrl: B });
    await fetch(B + `/v1/portal/${tok}/unlock`, { method: 'POST', headers: J, body: JSON.stringify({ code: 'atts-1234' }) });
    check(Buffer.from(await (await fetch(B + `/v1/portal/${tok}/attachments/${big.attachId}`)).arrayBuffer()).equals(BIG), '포털 다운로드 — 바이트 일치');

    await fetch(B + `/v1/portal/${tok}/sign`, { method: 'POST', headers: J, body: '{}' });
    await sleep(500);
    const dLinks = (await (await sPost(`/v1/contracts/${rid}/deliver`, {})).json()).data;
    const dTok = dLinks[0].url.split('/delivery/')[1];
    check(Buffer.from(await (await fetch(B + `/v1/contracts/delivery/${dTok}/attachments/${big.attachId}`)).arrayBuffer()).equals(BIG), '교부 다운로드 — 바이트 일치');

    // 동시 열람 — 전부 정확히 같은 바이트(청크 스트림이 요청 간 간섭 없이 독립)
    const N = 8;
    const many = await Promise.all(Array.from({ length: N }, () => dlConsole(rid, big.attachId).then((r) => r.arrayBuffer())));
    check(many.every((b) => Buffer.from(b).equals(BIG)), `동시 ${N}건 다운로드 — 전부 바이트 일치(스트림 독립)`);

    // ⑤⑥ 준비 — 손상시킬 첨부와, v1 레거시로 되돌릴 첨부
    rid2 = await mk('atts-2', 'atts-5678');
    target = (await (await putAtt(rid2, '손상대상.pdf', TARGET)).json()).data;
  } finally {
    srv.kill();
    await sleep(600);
  }

  // ── ⑤ 청크 1개 손상 → 온전한 바이트 차단 ──
  console.log('── 손상 청크 차단 ──');
  {
    const meta = readMeta();
    const k = `ctattach:${rid2}:${target.attachId}:c1`; // 중간 청크
    const victim = meta.get(k);
    const other = meta.get(`ctattach:${rid2}:${target.attachId}:c0`);
    meta.set(k, other); // 다른 청크의 암호문으로 교체 — 복호는 되지만 청크 해시가 어긋난다
    check(!!victim && !!other, '손상 주입 대상 청크 확인');
    writeMeta(meta);
  }
  srv = start();
  if (!(await up())) { console.error('재기동 실패'); srv.kill(); rmSync(dir, { recursive: true, force: true }); process.exit(1); }
  try {
    const root = await login();
    let complete = false;
    try {
      const r = await fetch(B + `/v1/contracts/${rid2}/attachments/${target.attachId}`, { headers: { 'x-session-token': root } });
      const b = Buffer.from(await r.arrayBuffer());
      complete = r.status === 200 && b.equals(TARGET);
    } catch { complete = false; } // 스트림 중단 = 정상
    check(!complete, '청크 1개 손상 — 온전한 바이트가 내려가지 않음(방출 전 해시 검증)');

    // ── ⑥ v1 레거시(단일 슬롯) dual-read ──
    console.log('── v1 레거시 dual-read ──');
    // 정상 첨부(BIG)는 그대로 읽혀야 한다 — 손상은 rid2 에만 주입했다
    const okAgain = await fetch(B + `/v1/contracts/${rid}/attachments/${big.attachId}`, { headers: { 'x-session-token': root } });
    check(Buffer.from(await okAgain.arrayBuffer()).equals(BIG), '재기동 후에도 v2 첨부 정상 판독');
  } finally {
    srv.kill();
    await sleep(400);
  }

  // v1 형식 위조 — 매니페스트 자리에 단일 sealed 를 넣어 레거시 데이터를 재현한다.
  // sealed 는 서비스와 같은 SecretBox 로 만들어야 하므로, 기존 c0 청크의 sealed 를 재사용하고
  // 목록 레코드의 크기·해시를 그 청크에 맞춰 고친다(= v1 시절에 저장된 작은 첨부와 동형).
  {
    const meta = readMeta();
    const listKey = `ctattach:${rid}`;
    const list = meta.get(listKey);
    const smallRec = list.find((a) => a.name === '소형.pdf');
    const c0 = meta.get(`ctattach:${rid}:${smallRec.attachId}:c0`); // 1청크짜리 → 청크 = 파일 전체
    meta.set(`ctattach:${rid}:${smallRec.attachId}`, { sealed: c0.sealed }); // v1 레이아웃으로 교체
    meta.delete(`ctattach:${rid}:${smallRec.attachId}:c0`);
    writeMeta(meta);
    globalThis.__legacyAttachId = smallRec.attachId;
  }
  srv = start();
  if (!(await up())) { console.error('재기동 실패(v1)'); srv.kill(); rmSync(dir, { recursive: true, force: true }); process.exit(1); }
  try {
    const root = await login();
    const SMALL = makePdf(1024);
    const r = await fetch(B + `/v1/contracts/${rid}/attachments/${globalThis.__legacyAttachId}`, { headers: { 'x-session-token': root } });
    check(r.status === 200 && Buffer.from(await r.arrayBuffer()).equals(SMALL), 'v1 단일 슬롯 첨부 — 마이그레이션 없이 그대로 판독(dual-read)');
  } finally {
    srv.kill();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n' + (failures === 0 ? '✅ 첨부 청크 스트리밍(R9) 전부 통과' : `❌ ${failures}건 실패`));
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); rmSync(dir, { recursive: true, force: true }); process.exit(1); });
