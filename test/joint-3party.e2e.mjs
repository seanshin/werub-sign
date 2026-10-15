// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 3자 합동 mock 하니스(D6) — HIS·PACS·ERP 가 단일 sign 인스턴스에 동시 연동되는 종단 계약 검증.
 * 실 3팀 합동(go-live 직전) 전에 계약을 자동으로 입증해 리스크를 제거한다.
 *
 * 시나리오(동일 시점 버스트): 한 환자 에피소드에 대해 세 출처가 각자 독립 봉투를 생성·서명·완료.
 *  - HIS(hospitalrun): 수술 동의서 — 환자 APP 서명
 *  - PACS(pacs):       영상 조영제 동의서 — 환자 APP 서명
 *  - ERP(erp):         외주 용역 계약서 — 거래처 포털 서명
 *
 * 계약(수용 기준):
 *  1) 세 출처 동시 생성 → 서로 다른 3개 봉투(requestId 유일), 각 검증 overall=true.
 *  2) 출처 귀속: 각 요청 createdBy = hospitalrun/pacs/erp (키→소비자 매핑).
 *  3) Webhook 격리: 각 콜백은 자기 요청만 수신(교차 전달 없음).
 *  4) 서명 시크릿 격리: ERP=ERP_WEBHOOK_SECRET(전용), HIS·PACS=HIS_WEBHOOK_SECRET(설계상 공유).
 *     ERP 서명은 HIS 시크릿으로 검증 불가(양방향 격리).
 *  5) 키 스코프: 소비자 키는 ca:admin(소비자목록) 불가(403).
 *
 * 실행: npm run build && node test/joint-3party.e2e.mjs
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';

const PORT = 4795, HOOK = 4796, B = `http://127.0.0.1:${PORT}`;
const HIS = 'his-k', PACS = 'pacs-k', ERP = 'erp-k';
const HIS_SEC = 'his-webhook-secret', ERP_SEC = 'erp-webhook-secret';
let failures = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = (k) => ({ 'Content-Type': 'application/json', 'x-api-key': k });
const post = (p, b, k) => fetch(B + p, { method: 'POST', headers: H(k), body: JSON.stringify(b ?? {}) });
const postPub = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}) });
const get = (p, k) => fetch(B + p, { headers: k ? H(k) : {} });
const dh = (s) => createHash('sha256').update(s).digest('hex');
const hmac = (body, sec) => createHmac('sha256', sec).update(body).digest('hex');

// 출처별 mock webhook 수신기(경로로 구분) — 교차 전달·시크릿 격리 검증용
const inbox = { his: [], pacs: [], erp: [] };
const hookSrv = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const who = req.url.replace('/', '').replace('-hook', '');
    if (inbox[who]) inbox[who].push({ sig: req.headers['x-sign-signature'], raw: b, body: JSON.parse(b || '{}') });
    res.writeHead(200); res.end('ok');
  });
});
const hookUrl = (who) => `http://127.0.0.1:${HOOK}/${who}-hook`;

function start() {
  return spawn('node', ['dist/main.js'], {
    env: {
      ...process.env, SIGN_PORT: String(PORT),
      HIS_INBOUND_API_KEY: HIS, PACS_API_KEY: PACS, ERP_API_KEY: ERP,
      HIS_WEBHOOK_SECRET: HIS_SEC, ERP_WEBHOOK_SECRET: ERP_SEC,
      CRYPTO_MASTER_KEY: Buffer.alloc(32, 53).toString('base64'),
    },
    stdio: 'ignore',
  });
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await get('/v1/crl')).ok) return true; } catch {} await sleep(300); } return false; }

// 단일 참가자 봉투 생성(인증서 발급 포함). 반환: { rid, pid }
async function makeEnvelope(key, { ownerType, idem, externalDocId, title, signMode, who }) {
  const serial = (await (await post('/v1/certificates/enroll', { ownerType, subjectDn: `CN=${title}`, identity: { method: 'PASS', ci: 'C' + idem } }, key)).json()).data.serialNumber;
  const cr = await (await post('/v1/requests', {
    idempotencyKey: idem, externalDocId, title, documentHash: dh(externalDocId), signMode, callbackUrl: hookUrl(who),
    participants: [{ signerRole: ownerType === 'WITNESS' ? 'VENDOR' : 'PATIENT', signerType: ownerType === 'WITNESS' ? 'WITNESS_EXTERNAL' : 'PATIENT', displayName: title, signOrder: 1, certSerial: serial, requiredIdentityLevel: 'NONE' }],
  }, key)).json();
  return { rid: cr.data.requestId, pid: cr.data.participants[0].participantId, serial };
}

async function main() {
  console.log('\n══════ 3자 합동(HIS·PACS·ERP) mock 하니스 D6 ══════\n');
  await new Promise((r) => hookSrv.listen(HOOK, r));
  const app = start();
  if (!(await up())) { console.log('❌ 기동 실패'); app.kill(); hookSrv.close(); process.exit(1); }
  try {
    // ── 1) 세 출처 동시 봉투 생성(버스트) ──
    console.log('— 동시 생성(버스트) —');
    const [his, pacs, erp] = await Promise.all([
      makeEnvelope(HIS, { ownerType: 'PATIENT', idem: 'joint-his', externalDocId: 'HIS-OP-1', title: '수술동의서', signMode: 'APP', who: 'his' }),
      makeEnvelope(PACS, { ownerType: 'PATIENT', idem: 'joint-pacs', externalDocId: 'PACS-CT-1', title: '조영제동의서', signMode: 'APP', who: 'pacs' }),
      makeEnvelope(ERP, { ownerType: 'WITNESS', idem: 'joint-erp', externalDocId: 'ERP-VC-1', title: '외주용역계약서', signMode: 'PORTAL', who: 'erp' }),
    ]);
    const ids = new Set([his.rid, pacs.rid, erp.rid]);
    check(ids.size === 3 && [...ids].every(Boolean), `독립 봉투 3개 생성(requestId 유일): ${[...ids].map((x) => x.slice(0, 8)).join(', ')}`);

    // ── 2) 출처 귀속(createdBy) ──
    const cb = async (rid) => (await (await get(`/v1/requests/${rid}`)).json()).data.createdBy;
    check((await cb(his.rid)) === 'hospitalrun', `HIS 요청 createdBy=hospitalrun`);
    check((await cb(pacs.rid)) === 'pacs', `PACS 요청 createdBy=pacs`);
    check((await cb(erp.rid)) === 'erp', `ERP 요청 createdBy=erp`);

    // ── 3) 각자 서명 → 완료 ──
    console.log('— 동시 서명 —');
    await Promise.all([
      post(`/v1/sign/${his.pid}/submit`, {}, HIS),
      post(`/v1/sign/${pacs.pid}/submit`, {}, PACS),
      (async () => {
        const token = (await (await post(`/v1/requests/${erp.rid}/portal-tokens`, {}, ERP)).json()).data[0].token;
        return postPub(`/v1/portal/${token}/sign`, {});
      })(),
    ]);
    await sleep(1000);

    for (const [who, env] of [['HIS', his], ['PACS', pacs], ['ERP', erp]]) {
      const v = await (await get(`/v1/verify/${env.rid}`)).json();
      check(v.data.overall === true, `${who} 봉투 검증 overall=true`);
      const rc = await (await get(`/v1/requests/${env.rid}`)).json();
      check(rc.data.status === 'COMPLETED', `${who} 봉투 상태 COMPLETED`);
    }

    // ── 4) Webhook 교차 전달 없음(각 수신기는 자기 요청만) ──
    console.log('— Webhook 격리 —');
    const completed = (arr, rid) => arr.find((h) => h.body.requestId === rid && h.body.eventType === 'request.completed');
    const hisHook = completed(inbox.his, his.rid);
    const pacsHook = completed(inbox.pacs, pacs.rid);
    const erpHook = completed(inbox.erp, erp.rid);
    check(!!hisHook && !!pacsHook && !!erpHook, '각 출처 콜백이 request.completed 수신');
    check(inbox.his.every((h) => h.body.requestId === his.rid), 'HIS 수신기 = HIS 요청만(교차 없음)');
    check(inbox.pacs.every((h) => h.body.requestId === pacs.rid), 'PACS 수신기 = PACS 요청만(교차 없음)');
    check(inbox.erp.every((h) => h.body.requestId === erp.rid), 'ERP 수신기 = ERP 요청만(교차 없음)');

    // ── 5) 서명 시크릿 격리 ──
    console.log('— 시크릿 격리 —');
    check(erpHook && erpHook.sig === hmac(erpHook.raw, ERP_SEC) && erpHook.sig !== hmac(erpHook.raw, HIS_SEC), 'ERP webhook = ERP_WEBHOOK_SECRET(전용·HIS 불가)');
    check(hisHook && hisHook.sig === hmac(hisHook.raw, HIS_SEC) && hisHook.sig !== hmac(hisHook.raw, ERP_SEC), 'HIS webhook = HIS_WEBHOOK_SECRET(ERP 불가)');
    check(pacsHook && pacsHook.sig === hmac(pacsHook.raw, HIS_SEC), 'PACS webhook = HIS_WEBHOOK_SECRET(설계상 HIS 공유)');

    // ── 6) 소비자 키 스코프(최소권한) ──
    console.log('— 키 스코프 —');
    check((await get('/v1/admin/consumers', HIS)).status === 403, 'HIS 키 — 소비자목록(ca:admin) 403');
    check((await get('/v1/admin/consumers', PACS)).status === 403, 'PACS 키 — 소비자목록(ca:admin) 403');
    check((await get('/v1/admin/consumers', ERP)).status === 403, 'ERP 키 — 소비자목록(ca:admin) 403');

    console.log('\n' + (failures === 0 ? '✅ 3자 합동 mock 하니스 전체 통과 — 동시 연동 계약 동작 확인' : `❌ ${failures}건 실패`));
  } finally {
    app.kill();
    hookSrv.close();
  }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
