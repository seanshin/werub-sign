// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * PrismaSignStore 계약 검증 — 시뮬레이션 Prisma(storeRecord)로 어댑터 로직 검증.
 * 실 PostgreSQL 없이 query 변환·정렬·라운드트립을 확인(운영 PG는 docker-compose).
 * 실행: npx ts-node test/prisma-store.contract.ts
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import 'reflect-metadata';
import { PrismaSignStore } from '../src/infrastructure/store/prisma-sign-store';

type Row = { seq: number; kind: string; rkey: string; data: unknown; status?: string | null; reqCreatedAt?: Date | null; createdBy?: string | null; signMode?: string | null; ownerType?: string | null; notBefore?: Date | null; searchText?: string | null; archived?: boolean | null; category?: string | null; labelsText?: string | null };
type Where = {
  kind?: string; rkey?: string; seq?: number; status?: string | { in?: string[] }; ownerType?: string; createdBy?: string; signMode?: string;
  NOT?: { ownerType?: string; archived?: boolean };
  OR?: Array<Record<string, unknown>>;
  AND?: Array<Record<string, unknown>>;
  archived?: boolean | null;
  category?: string;
  labelsText?: { contains?: string };
  reqCreatedAt?: { gte?: Date; lte?: Date };
  searchText?: { contains?: string };
};
const matches = (r: Row, where: Where) => {
  if (where.kind !== undefined && r.kind !== where.kind) return false;
  if (where.rkey !== undefined && r.rkey !== where.rkey) return false;
  if (where.seq !== undefined && r.seq !== where.seq) return false; // CAS(saveMetaIfUnchanged)의 버전 조건
  if (where.status !== undefined) {
    if (typeof where.status === 'object') { if (!(where.status.in ?? []).includes(r.status ?? '')) return false; }
    else if (r.status !== where.status) return false;
  }
  if (where.createdBy !== undefined && r.createdBy !== where.createdBy) return false;
  if (where.signMode !== undefined && r.signMode !== where.signMode) return false;
  if (where.ownerType !== undefined && r.ownerType !== where.ownerType) return false;
  // PG 3VL: NOT(x=v)는 NULL도 제외(운영 cert 행은 ownerType 항상 존재 → NULL 비발생)
  if (where.NOT?.ownerType !== undefined && (r.ownerType == null || r.ownerType === where.NOT.ownerType)) return false;
  if (where.reqCreatedAt) {
    const t = r.reqCreatedAt ? +new Date(r.reqCreatedAt) : NaN;
    if (where.reqCreatedAt.gte && !(t >= +where.reqCreatedAt.gte)) return false;
    if (where.reqCreatedAt.lte && !(t <= +where.reqCreatedAt.lte)) return false;
  }
  if (where.searchText?.contains !== undefined && !(r.searchText ?? '').includes(where.searchText.contains)) return false;
  // 계약 필터(A3) — 비보관/'기타'는 NULL 포함이므로 서비스가 OR 로 명시(Prisma `not` 은 NULL 미반환).
  // AND 합성(보관 + 카테고리 동시 필터)도 그대로 평가한다.
  if (where.archived !== undefined && r.archived !== where.archived) return false;
  if (where.category !== undefined && r.category !== where.category) return false;
  const orMatch = (clauses: Array<Record<string, unknown>>) =>
    clauses.some((o) =>
      Object.entries(o).every(([k, v]) => {
        const cur = (r as unknown as Record<string, unknown>)[k];
        return v === null ? cur == null : cur === v;
      }),
    );
  if (where.OR !== undefined && !orMatch(where.OR as Array<Record<string, unknown>>)) return false;
  if (where.AND !== undefined) {
    for (const clause of where.AND as Array<Record<string, unknown>>) {
      if (clause.OR !== undefined) { if (!orMatch(clause.OR as Array<Record<string, unknown>>)) return false; }
      else if (!matches(r, clause as Where)) return false;
    }
  }
  if (where.labelsText?.contains !== undefined && !(r.labelsText ?? '').includes(where.labelsText.contains)) return false;
  return true;
};

/** 유니크 위반 시뮬레이트 — Prisma 는 P2002 로 던진다. */
class FakeUniqueViolation extends Error {
  code = 'P2002';
}

/**
 * storeRecord 테이블을 메모리 배열로 시뮬레이트한 가짜 PrismaService.
 * 마이그레이션 0009 의 **부분 유니크 인덱스 2종**도 함께 모사한다(R16) — 이게 없으면 어댑터의
 * 충돌 처리 경로(CAS 실패·체인 분기 거부)가 테스트에서 한 번도 실행되지 않는다.
 */
class FakePrisma {
  private rows: Row[] = [];
  private seq = 0;
  /** store_records_meta_slot_uniq: (kind,rkey) WHERE kind='meta' */
  private violatesMetaSlot(r: { kind: string; rkey: string }): boolean {
    return r.kind === 'meta' && this.rows.some((x) => x.kind === 'meta' && x.rkey === r.rkey);
  }
  /** store_records_audit_prevhash_uniq: (rkey, data->>'prevHash') WHERE kind='audit' */
  private violatesAuditChain(r: { kind: string; rkey: string; data: unknown }): boolean {
    if (r.kind !== 'audit') return false;
    const ph = (r.data as { prevHash?: string })?.prevHash;
    if (ph == null) return false; // PG: 인덱스 값이 NULL 이면 서로 충돌하지 않는다
    return this.rows.some((x) => x.kind === 'audit' && x.rkey === r.rkey && (x.data as { prevHash?: string })?.prevHash === ph);
  }
  storeRecord = {
    create: async ({ data }: { data: { kind: string; rkey: string; data: unknown } }) => {
      if (this.violatesMetaSlot(data)) throw new FakeUniqueViolation('meta slot uniq');
      if (this.violatesAuditChain(data)) throw new FakeUniqueViolation('audit prevHash uniq');
      const row = { seq: ++this.seq, ...data };
      this.rows.push(row);
      return row;
    },
    deleteMany: async ({ where }: { where: Where }) => {
      const before = this.rows.length;
      this.rows = this.rows.filter((r) => !matches(r, where));
      return { count: before - this.rows.length };
    },
    findFirst: async ({ where, orderBy }: { where: Where; orderBy?: { seq: 'asc' | 'desc' } }) => {
      const f = this.rows.filter((r) => matches(r, where)).sort((a, b) => (orderBy?.seq === 'desc' ? b.seq - a.seq : a.seq - b.seq));
      return f[0] ?? null;
    },
    findMany: async ({ where, orderBy, skip, take }: { where: Where; orderBy?: { seq?: 'asc' | 'desc'; reqCreatedAt?: 'asc' | 'desc'; notBefore?: 'asc' | 'desc' }; skip?: number; take?: number }) => {
      let f = this.rows.filter((r) => matches(r, where));
      const tsSort = (key: 'reqCreatedAt' | 'notBefore', dir: 'asc' | 'desc') => {
        f = f.sort((a, b) => {
          const at = a[key] ? +new Date(a[key] as Date) : 0;
          const bt = b[key] ? +new Date(b[key] as Date) : 0;
          return dir === 'desc' ? bt - at : at - bt;
        });
      };
      if (orderBy?.reqCreatedAt) tsSort('reqCreatedAt', orderBy.reqCreatedAt);
      else if (orderBy?.notBefore) tsSort('notBefore', orderBy.notBefore);
      else f = f.sort((a, b) => (orderBy?.seq === 'desc' ? b.seq - a.seq : a.seq - b.seq));
      if (skip) f = f.slice(skip);
      if (take !== undefined) f = f.slice(0, take);
      return f;
    },
    count: async ({ where }: { where: Where }) => this.rows.filter((r) => matches(r, where)).length,
  };
  /**
   * 배열형(배치)과 콜백형(인터랙티브)을 모두 지원. 콜백형은 예외 시 **롤백**한다 —
   * `saveMetaIfUnchanged` 가 create 실패 시 앞선 deleteMany 까지 되돌아가는 데 의존하기 때문.
   */
  $transaction = async (arg: Promise<unknown>[] | ((tx: FakePrisma) => Promise<unknown>)) => {
    if (typeof arg !== 'function') return Promise.all(arg);
    const snapshot = [...this.rows];
    try {
      return await arg(this);
    } catch (e) {
      this.rows = snapshot;
      throw e;
    }
  };
}

let fail = 0;
const check = (c: boolean, m: string) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) fail++; };

async function main() {
  console.log('\n══════ PrismaSignStore 계약 검증 (시뮬 PG) ══════\n');
  const store = new PrismaSignStore(new FakePrisma() as never);

  // 인증서
  const cert = { certId: 'c1', cert: { tbs: { serialNumber: 'CERT-1' } } } as never;
  await store.saveCert(cert);
  check((await store.getCertBySerial('CERT-1'))?.certId === 'c1', '인증서 저장·조회 라운드트립');
  check((await store.hasCertSerial('CERT-1')) === true && (await store.hasCertSerial('X')) === false, 'hasCertSerial');
  // upsert(중복 저장 시 1건 유지)
  await store.saveCert({ certId: 'c1b', cert: { tbs: { serialNumber: 'CERT-1' } } } as never);
  check((await store.getCertBySerial('CERT-1'))?.certId === 'c1b', 'upsert(최신 1건 유지)');

  // queryCerts — DB 푸시다운(검색·CA 제외·정렬 notBefore desc·페이지·count)
  await store.saveCert({ cert: { status: 'ACTIVE', tbs: { serialNumber: 'CERT-A', ownerType: 'PATIENT', subjectDn: 'CN=김환자', notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2030-01-01T00:00:00.000Z' } } } as never);
  await store.saveCert({ cert: { status: 'ACTIVE', tbs: { serialNumber: 'CERT-B', ownerType: 'STAFF', subjectDn: 'CN=이의사', licenseNumber: 'MD-7', notBefore: '2026-06-01T00:00:00.000Z', notAfter: '2030-01-01T00:00:00.000Z' } } } as never);
  await store.saveCert({ cert: { status: 'ACTIVE', tbs: { serialNumber: 'CERT-CA', ownerType: 'CA', subjectDn: 'CN=Issuing', notBefore: '2025-01-01T00:00:00.000Z', notAfter: '2035-01-01T00:00:00.000Z' } } } as never);
  const cQ = await store.queryCerts({ offset: 0 });
  check(cQ.total === 2 && cQ.items.every((c) => c.cert.tbs.ownerType !== 'CA'), `queryCerts CA 제외 total=2 (=${cQ.total})`); // CERT-1(ownerType 없음)·CA 제외 → A·B
  const cSearch = await store.queryCerts({ offset: 0, q: 'md-7' });
  check(cSearch.total === 1 && cSearch.items[0].cert.tbs.serialNumber === 'CERT-B', '면허번호 검색(md-7) → CERT-B');
  const cName = await store.queryCerts({ offset: 0, q: '김환자' });
  check(cName.total === 1 && cName.items[0].cert.tbs.serialNumber === 'CERT-A', '주체DN 검색(김환자) → CERT-A');
  const cSort = await store.queryCerts({ offset: 0 });
  check(cSort.items[0].cert.tbs.serialNumber === 'CERT-B', '최신순 정렬(notBefore desc) — CERT-B(2026-06) 우선');
  const cPage = await store.queryCerts({ offset: 1, limit: 1 });
  check(cPage.total === 2 && cPage.items.length === 1, '페이지(offset1·limit1) → total=2·data=1');

  // 요청 + 멱등
  const req = { requestId: 'r1', idempotencyKey: 'idem-1', status: 'CREATED', participants: [] } as never;
  await store.saveRequest(req);
  check((await store.getRequest('r1'))?.status === 'CREATED', '요청 저장·조회');
  check((await store.getRequestIdByIdempotency('idem-1')) === 'r1', '멱등키→requestId');
  check((await store.allRequests()).length === 1, 'allRequests');

  // queryRequests — DB 푸시다운(상태·기간·검색·정렬·페이지·count)
  await store.saveRequest({ requestId: 'q1', idempotencyKey: 'iq1', status: 'CREATED', title: '수술 동의서', externalDocId: 'D-1', createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'hospitalrun', signMode: 'APP', participants: [{ displayName: '홍길동' }] } as never);
  await store.saveRequest({ requestId: 'q2', idempotencyKey: 'iq2', status: 'COMPLETED', title: '마취 동의서', externalDocId: 'D-2', createdAt: '2026-06-01T00:00:00.000Z', createdBy: 'pacs', signMode: 'PORTAL', participants: [{ displayName: '김환자' }] } as never);
  await store.saveRequest({ requestId: 'q3', idempotencyKey: 'iq3', status: 'CREATED', title: '수혈 동의서', externalDocId: 'D-3', createdAt: '2026-03-01T00:00:00.000Z', participants: [] } as never);
  await store.saveRequest({ requestId: 'q4', idempotencyKey: 'iq4', status: 'IN_PROGRESS', title: '재활 동의서', externalDocId: 'D-4', createdAt: '2026-01-15T00:00:00.000Z', createdBy: 'erp', signMode: 'MULTI', participants: [] } as never);
  // 출처·서명모드·미완료 필터
  const fSrc = await store.queryRequests({ offset: 0, createdBy: 'pacs' });
  check(fSrc.total === 1 && fSrc.items[0].requestId === 'q2', '출처 필터(createdBy=pacs) → q2');
  const fMode = await store.queryRequests({ offset: 0, signMode: 'MULTI' });
  check(fMode.total === 1 && fMode.items[0].requestId === 'q4', '서명모드 필터(MULTI) → q4');
  const fInc = await store.queryRequests({ offset: 0, incomplete: true });
  check(fInc.total === 4 && fInc.items.every((x) => x.status === 'CREATED' || x.status === 'IN_PROGRESS'), '미완료 필터 → 4건(r1·q1·q3·q4)'); // CREATED 3 + IN_PROGRESS 1
  const fCombo = await store.queryRequests({ offset: 0, createdBy: 'hospitalrun', signMode: 'APP', incomplete: true });
  check(fCombo.total === 1 && fCombo.items[0].requestId === 'q1', '복합 필터(출처+모드+미완료) → q1');
  const qAll = await store.queryRequests({ offset: 0 });
  check(qAll.total === 5, `queryRequests 전체 total=5 (=${qAll.total})`); // r1 + q1~q4
  const qStatus = await store.queryRequests({ offset: 0, status: 'CREATED' });
  check(qStatus.total === 3 && qStatus.items.every((x) => x.status === 'CREATED'), '상태 필터 status=CREATED → 3');
  const qSearch = await store.queryRequests({ offset: 0, q: '마취' });
  check(qSearch.total === 1 && qSearch.items[0].requestId === 'q2', '검색 q=마취 → q2');
  const qName = await store.queryRequests({ offset: 0, q: '홍길동' });
  check(qName.total === 1 && qName.items[0].requestId === 'q1', '참가자명 검색 → q1');
  const qFrom = await store.queryRequests({ offset: 0, from: '2026-02-01T00:00:00.000Z' });
  check(qFrom.total === 2, '기간 from=2026-02 → q2·q3 (2건)');
  const qRange = await store.queryRequests({ offset: 0, from: '2026-02-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' });
  check(qRange.total === 1 && qRange.items[0].requestId === 'q3', '기간 범위 → q3');
  const qSort = await store.queryRequests({ offset: 0, status: 'CREATED' });
  const idxOf = (id: string) => qSort.items.findIndex((x) => x.requestId === id);
  check(idxOf('q3') >= 0 && idxOf('q3') < idxOf('q1'), '최신순 정렬(q3가 q1보다 앞, createdAt desc)'); // 운영은 백필로 null 없음
  const qPage = await store.queryRequests({ offset: 1, limit: 1, status: 'CREATED' });
  check(qPage.total === 3 && qPage.items.length === 1, '페이지(offset=1,limit=1) → total=3·data=1');

  // 계약 필터 푸시다운(A3) — 보관·분류·라벨(ct* 캐시 컬럼)
  await store.saveRequest({ requestId: 'c1', idempotencyKey: 'ic1', status: 'CREATED', title: '용역 계약', externalDocId: 'C-1', createdAt: '2026-07-01T00:00:00.000Z', signMode: 'CONTRACT', participants: [], ctArchived: false, ctCategory: '용역', ctLabels: ['정기', '2026'] } as never);
  await store.saveRequest({ requestId: 'c2', idempotencyKey: 'ic2', status: 'COMPLETED', title: '보관 계약', externalDocId: 'C-2', createdAt: '2026-07-02T00:00:00.000Z', signMode: 'CONTRACT', participants: [], ctArchived: true, ctCategory: '근로', ctLabels: [] } as never);
  await store.saveRequest({ requestId: 'c3', idempotencyKey: 'ic3', status: 'CREATED', title: '레거시 계약', externalDocId: 'C-3', createdAt: '2026-07-03T00:00:00.000Z', signMode: 'CONTRACT', participants: [] } as never); // ct* 미동기화(레거시)
  const caEx = await store.queryRequests({ offset: 0, signMode: 'CONTRACT', archived: false });
  check(caEx.total === 2 && caEx.items.every((x) => x.requestId !== 'c2'), '보관 제외(archived=false) — 레거시(null)도 비보관 취급 → c1·c3');
  const caOn = await store.queryRequests({ offset: 0, signMode: 'CONTRACT', archived: true });
  check(caOn.total === 1 && caOn.items[0].requestId === 'c2', '보관만(archived=true) → c2');
  const cCat = await store.queryRequests({ offset: 0, signMode: 'CONTRACT', archived: false, category: '용역' });
  check(cCat.total === 1 && cCat.items[0].requestId === 'c1', '분류 필터(용역) → c1');
  const cEtc = await store.queryRequests({ offset: 0, signMode: 'CONTRACT', archived: false, category: '기타' });
  check(cEtc.total === 1 && cEtc.items[0].requestId === 'c3', "분류 '기타' — 레거시(null) 포함 → c3");
  const cLab = await store.queryRequests({ offset: 0, signMode: 'CONTRACT', label: '정기' });
  check(cLab.total === 1 && cLab.items[0].requestId === 'c1', '라벨 필터(정기) → c1');
  check((await store.queryRequests({ offset: 0, signMode: 'CONTRACT', label: '2026' })).total === 1, '라벨 부분충돌 없음(|구분자) — 2026 → 1건');

  // 서명(append) + 조회
  await store.saveSignature({ signatureId: 's1', requestId: 'r1', signerRole: 'PATIENT' } as never);
  await store.saveSignature({ signatureId: 's2', requestId: 'r1', signerRole: 'DOCTOR' } as never);
  check((await store.signaturesByRequest('r1')).length === 2, '서명 append·요청별 조회');

  // 감사 해시체인(순서 보존)
  await store.appendAudit('r1', { eventType: 'CREATED', entryHash: 'h1' } as never);
  await store.appendAudit('r1', { eventType: 'SIGNED', entryHash: 'h2' } as never);
  const entries = await store.auditEntries('r1');
  check(entries.length === 2 && (entries[0] as { entryHash: string }).entryHash === 'h1', '감사 순서(asc) 보존');
  check((await store.lastAudit('r1') as { entryHash: string }).entryHash === 'h2', 'lastAudit(desc) = 최신');

  // 본인확인
  await store.saveIdentity({ id: 'i1', method: 'PASS', result: 'SUCCESS' } as never);
  check((await store.getIdentity('i1'))?.method === 'PASS', '본인확인 저장·조회');

  // 폐기 + CRL 카운터
  await store.saveRevocation({ serialNumber: 'CERT-1', revokedAt: 'now', reason: 'x', crlNumber: 1 } as never);
  check((await store.getRevocation('CERT-1'))?.reason === 'x', '폐기 저장·조회');
  check((await store.allRevocations()).length === 1, 'allRevocations');
  const n1 = await store.nextCrlNumber();
  const n2 = await store.nextCrlNumber();
  check(n2 === n1 + 1 && (await store.currentCrlNumber()) === n2, 'CRL 번호 증가·현재값');

  // Webhook
  await store.saveWebhook({ id: 'w1', status: 'PENDING', attempts: 0 } as never);
  await store.updateWebhook({ id: 'w1', status: 'SENT', attempts: 1 } as never);
  console.log('  ✅ Webhook 저장·갱신(예외 없음)');

  // ── R16: 저장소 수준 동시성 가드 ─────────────────────────────────────────
  console.log('\n── R16 낙관적 잠금·체인 분기 차단 ──');
  await store.saveMeta('cas-slot', { n: 1 });
  const v1 = await store.getMetaVersioned<{ n: number }>('cas-slot');
  check(v1.value?.n === 1 && typeof v1.version === 'number', 'getMetaVersioned — 값+버전 반환');
  check((await store.getMetaVersioned('nope')).version === null, '없는 슬롯 → version null');

  check(await store.saveMetaIfUnchanged('cas-slot', v1.version, { n: 2 }), '버전 일치 → CAS 성공');
  check((await store.getMeta<{ n: number }>('cas-slot'))?.n === 2, 'CAS 후 값 갱신 확인');
  // v1.version 은 이제 낡았다 — 다른 노드가 먼저 쓴 상황과 동형
  check(!(await store.saveMetaIfUnchanged('cas-slot', v1.version, { n: 99 })), '낡은 버전 → CAS 거부(lost update 차단)');
  check((await store.getMeta<{ n: number }>('cas-slot'))?.n === 2, 'CAS 거부 시 값 불변(부분 쓰기 없음)');

  check(await store.saveMetaIfUnchanged('cas-new', null, { fresh: true }), '최초 생성(expected=null) → 성공');
  check(!(await store.saveMetaIfUnchanged('cas-new', null, { fresh: false })), '이미 있는 슬롯에 expected=null → 거부');

  // 감사 체인 분기 — 같은 prevHash 재사용은 저장소가 거부해야 한다
  await store.appendAudit('chain:1', { eventType: 'A', prevHash: '0'.repeat(64), entryHash: 'e1' } as never);
  let forked = false;
  try {
    await store.appendAudit('chain:1', { eventType: 'B', prevHash: '0'.repeat(64), entryHash: 'e2' } as never);
  } catch (e) {
    forked = (e as Error).name === 'StoreConflictError';
  }
  check(forked, '같은 prevHash 재사용 → StoreConflictError(체인 분기 거부)');
  await store.appendAudit('chain:1', { eventType: 'C', prevHash: 'e1', entryHash: 'e3' } as never);
  check((await store.auditEntries('chain:1')).length === 2, '정상 진행(prevHash=직전 entryHash)은 허용 — 2건');
  await store.appendAudit('chain:2', { eventType: 'A', prevHash: '0'.repeat(64), entryHash: 'z1' } as never);
  check((await store.auditEntries('chain:2')).length === 1, '다른 스트림의 genesis(같은 prevHash)는 허용');

  console.log('\n' + (fail === 0 ? '✅ PrismaSignStore 계약 전부 통과 — query 변환·정렬·라운드트립 정상' : `❌ ${fail}건 실패`));
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
