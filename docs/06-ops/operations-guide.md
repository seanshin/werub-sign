# sign 운영 인계 가이드 — Prisma-live · mTLS · HSM

> **대상**: sign 운영/인프라 담당
> **전제**: 코드/마이그레이션/계약검증 완료. 본 가이드는 **배포 환경 작업**(이 환경엔 PG/HSM/인증서 부재로 미실행 항목)
> **Date**: 2026-06-12

---

## 0. 배포 토폴로지 (원내 구축형 + DMZ)

```
[인터넷] 환자앱/포털
   │ HTTPS (서명 웹뷰/앱 API only)
[DMZ] reverse-proxy(nginx) ── 본인인증 중계 · 발송 · mTLS 종단
   │ 제한 포트 + mTLS
[원내망]
   ├─ sign-core (NestJS, STORE_DRIVER=prisma, 개인키 미보유)
   │     └─ PostgreSQL (sign DB)              ← §1
   │     └─ crypto-proxy (사설망, 키 커스터디)  ──mTLS──▶  ← §2.4 / §3
   │            └─ SOFT(FileVault) + 클라우드 HSM(AWS KMS, keyClass=HSM만)
   ├─ Hospital RUN (HIS)  ──mTLS──▶  sign-core  (§2)
   └─ 시크릿: KMS/Vault (CRYPTO_MASTER_KEY·PEPPER·webhookSecret·apiKey·proxyToken)
```
원칙: **서명원본·민감정보·PG는 원내망 고정.** 개인키는 crypto-proxy에 격리(운영은 KMS 상주, 다이제스트만 송신). DMZ는 웹뷰/중계만.

---

## 1. 원클릭 배포 (Docker, 권장 경로)

> Dockerfile + `docker-compose.prod.yml` 제공 — **서비스+PG+마이그레이션+헬스체크 일괄**. HIS 서버(또는 원내 서버)에서:

```bash
git clone <repo> sign && cd sign
cat > .env.prod <<EOF
CRYPTO_MASTER_KEY=$(openssl rand -base64 32)
CRYPTO_PEPPER=$(openssl rand -base64 32)
HIS_INBOUND_API_KEY=<HIS와 합의값>
HIS_WEBHOOK_SECRET=<HIS와 합의값>
POSTGRES_PASSWORD=$(openssl rand -hex 16)
EOF
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
curl http://localhost:4000/health     # {"status":"ok","service":"sign"}
DB_URL=postgresql://sign:<pw>@localhost:5432/sign node test/prisma-live.e2e.mjs  # 라이브 영속 검증
```
- 기동 시 `prisma migrate deploy` 자동 수행(STORE_DRIVER=prisma일 때)
- 포트는 기본 `127.0.0.1:4000` 로컬바인드 — **외부 노출은 reverse-proxy(mTLS) 경유만**
- JWKS는 HIS 라이브 값 기본 내장(`his.example.org/.../jwks`, 교차검증 완료)
- `.env.prod`는 git 비추적 — Vault/CI Secrets 권장

## 1b. Prisma 라이브 영속화 (수동 경로 — 관리형 PG 사용 시)

### 1.1 PostgreSQL 기동
```bash
# 개발/검증: docker-compose 제공
npm run db:up            # postgres:16, db=sign user=sign
# 운영: 관리형 PG 또는 원내 PG 인스턴스 권장 (HA, 백업)
```

### 1.2 마이그레이션 적용
```bash
export DB_URL="postgresql://sign:<pw>@<host>:5432/sign?schema=public"
npm run prisma:generate
npx prisma migrate deploy            # prisma/migrations/0001_init (14 테이블) 적용
```
> 마이그레이션 SQL은 `prisma/migrations/0001_init/migration.sql`에 사전 생성됨(검토 가능).

> **대용량 기존 설치의 인덱스 추가(감사 R7)**: 마이그레이션의 `CREATE INDEX` 는 Prisma 가 트랜잭션 안에서
> 실행하므로 `CONCURRENTLY` 를 쓸 수 없다. `store_records` 는 감사·서명·요청이 모두 몰리는 단일 핫 테이블이라,
> **행 수가 수백만 규모인 설치**에서는 인덱스 생성 동안 쓰기가 대기해 포털 서명이 타임아웃될 수 있다.
> 이 경우 배포 **전에** 아래를 수동 적용한 뒤 `migrate deploy` 를 실행한다(이미 존재하는 인덱스는 건너뛴다).
> ```sql
> SET lock_timeout = '3s';
> CREATE INDEX CONCURRENTLY IF NOT EXISTS "store_records_kind_signMode_archived_reqCreatedAt_idx"
>   ON "store_records" ("kind", "signMode", "archived", "reqCreatedAt");
> CREATE INDEX CONCURRENTLY IF NOT EXISTS "store_records_contract_open_list_idx"
>   ON "store_records" ("kind", "signMode", "reqCreatedAt" DESC) WHERE ("archived" = false OR "archived" IS NULL);
> ```
> (0006 기준 — 이후 마이그레이션에 인덱스가 추가되면 해당 SQL의 이름·컬럼을 그대로 사용한다.)
> 소규모(수만 행 이하) 설치는 그대로 배포해도 무방하다.

> **0009(동시성 가드) 배포 — 배포 전 점검 필수(감사 R16)**
>
> 0009 는 유니크 인덱스 2개를 만든다. 하나는 **기존 데이터에 따라 마이그레이션을 의도적으로 중단**시킨다.
> ```sql
> -- ① 감사 체인 분기 점검 — 0행이어야 한다. 행이 나오면 마이그레이션이 실패하며, 그게 정상 동작이다.
> --    (이미 끊긴 체인 위에 "무결" 제약을 얹지 않기 위함 — 해당 스트림을 먼저 조사할 것)
> SELECT rkey, count(*) FROM store_records
>  WHERE kind='audit' GROUP BY rkey, (data->>'prevHash') HAVING count(*) > 1;
>
> -- ② meta 중복 슬롯 — 있어도 마이그레이션이 최신(seq 최대) 행만 남기고 자동 정리한다(조치 불요).
> --    getOne 이 이미 seq DESC 로 그 행만 읽으므로 애플리케이션 관점의 의미 변화는 없다.
> SELECT kind, rkey, count(*) FROM store_records
>  WHERE kind='meta' GROUP BY kind, rkey HAVING count(*) > 1;
> ```
> 대용량 설치는 위 CONCURRENTLY 요령을 그대로 적용한다(인덱스 정의는 `prisma/migrations/0009_store_concurrency_guards/migration.sql` 참조).

### 1.3 prisma 드라이버로 기동·검증
```bash
STORE_DRIVER=prisma DB_URL=$DB_URL npm run build && npm run start:prod
# 라이브 영속 e2e (발급→서명→검증→재기동 후 영속 확인)
DB_URL=$DB_URL node test/prisma-live.e2e.mjs
```
- `STORE_DRIVER` 미설정 = in-memory(개발), `file` = 파일 durable, `prisma` = 운영
- `PrismaService`는 STORE_DRIVER=prisma일 때만 연결(개발환경 보호)

### 1.3.1 감사 앵커 외부 검증 (S1 앵커 이중화)

`ANCHOR_TSA_URLS` 설정 시 감사 체인 앵커에 **외부 RFC3161 TSA 토큰**이 병기된다(자체 TSA 키는
운영자 수중이라 독립 증거가 아님 — `security-enhancement-plan.md` S1). 앵커 검증 API
(`/v1/requests/:id/audit/verify` 등)의 `externalAnchors[]` 가 토큰 존재·구조 정합을 보고하며,
**완전한 암호 검증은 제3자가 표준 도구로 수행**한다(그게 외부 앵커의 존재 이유):

```bash
# 앵커 레코드의 externalTokens[n].tbs(base64) → DER 저장 후:
openssl ts -verify -digest <앵커 headHash(hex)> -in token.der -token_in \
  -CAfile <해당 TSA CA 체인.pem> -untrusted <해당 TSA 서명 인증서.pem>
# → "Verification: OK" 면 해당 시각에 그 head 가 존재했음이 운영자와 무관하게 증명된다.
# freeTSA: CA=https://freetsa.org/files/cacert.pem, TSA cert=https://freetsa.org/files/tsa.crt
# (실측 2026-07-29: freeTSA 발급 토큰 openssl 검증 OK)
```

- 외부 발급은 **best-effort** — 외부 TSA 장애가 서명 완료·체결을 막지 않는다. 실패분은 앵커 스윕
  (`SCHEDULER_ANCHOR_MIN`, 기본 일 1회)이 보충하고, 스윕은 이벤트 앵커 경로가 없는 관리 스트림
  (`admin:auth` 등)도 앵커한다.
- 공인 TSA 계약 시 `ANCHOR_TSA_URLS` 만 교체(코드 변경 없음). 복수 URL(쉼표)이면 전부 병기.

### 1.4 백업·복구
- **자동화 완료(S7, v1.28.0~)** — 일별 cron(03:40 KST) `scripts/backup-sign-db.sh`:
  컨테이너 내 `pg_dump -Fc`+목차 검증 → sha256 → gpg AES256 → 로컬 14세대 → 오프사이트 30세대.
  **절차·분기 복구 리허설·재해 복구는 `backup-restore-runbook.md` 가 정본**이다.
- PG 정기 백업(pg_dump/PITR). **서명·인증서·감사체인이 법적 증거**이므로 보존기간(동의서 보존연한) 준수
- 감사체인은 append-only — 복구 후 `GET /v1/requests/:id/audit/verify`로 무결성 확인

### 1.5 운영 알림 (S9, v1.29.0~)
스케줄러가 `SCHEDULER_WATCH_MIN`(기본 5분) 주기로 5종을 점검하고 `OPS_ALERT_TO` 로 통지한다.

| 점검 | 판단 기준 | 관련 설정 |
|---|---|---|
| 백업 중단 | 성공 하트비트가 `BACKUP_MAX_AGE_H`(기본 26h) 초과 — **신호의 부재로 판단** | 크론에 `SIGN_API_KEY` 필요 |
| 감사 체인 붕괴 | 최근 표본 스트림의 `chainValid=false` | `ALERT_CHAIN_SAMPLE`(기본 20) |
| 로그인 실패 폭주 | 창 내 `LOGIN_FAILED` 임계 초과(상위 출처 IP 병기) | `ALERT_LOGIN_FAIL_THRESHOLD`·`_WINDOW_MIN` |
| 웹훅 DEAD | 재시도 소진분 존재 | — |
| ready 실패 | db·ca 점검 실패 | — |

- 같은 알림은 `ALERT_THROTTLE_MIN` 1회로 억제되고(코드 기본 60분, **라이브는 2026-09-10 부터 10080분=7일**),
  억제된 횟수는 다음 본문에 합산된다. 억제 상태는 스토어에 있어 **재기동해도 유지**된다.
  스로틀은 **alertKey 별**이라, 지금까지 없던 종류의 경보(예: 감사 체인 붕괴)는 7일 창과 무관하게 **즉시 1통** 나간다.
  대신 같은 조건이 계속 살아 있어도 재알림은 주 1회뿐이므로, **주간 점검(§일상 점검)을 건너뛰지 말 것**.
- `OPS_ALERT_TO` 미설정이면 **로그 전용**(`[ops-alert]`)으로 동작한다 — 알림 실패가 서비스를 막지 않는다.
- 주기와 별개로 즉시 점검: `POST /v1/maintenance/health-watch`(requests:write).
- 발송 경로 점검 요령: `BACKUP_MAX_AGE_H=0` 으로 일시 전환 → `health-watch` 호출(경보 1건 발생) → 원복.

---

## 2. mTLS 구성 (HIS ↔ sign, DMZ)

### 2.1 HIS → sign (원내, 상호 TLS)
- sign-core 앞에 TLS 종단(또는 NestJS HTTPS). HIS는 클라이언트 인증서 제시.
- sign은 `x-api-key`(ConsumerApp) + **mTLS 클라이언트 인증서 지문**을 병행 검증 권장.
  - `ConsumerApp.mtlsFingerprint`(스키마 보유) 활용 — 현재 ApiKeyGuard에 지문 검증 추가:
    ```
    리버스프록시가 검증한 클라 인증서 지문을 X-Client-Cert-Fingerprint 헤더로 전달 →
    ApiKeyGuard에서 ConsumerApp.mtlsFingerprint와 대조
    ```
- 인증서 발급: 원내 CA 또는 sign 자체 CA. 갱신 주기·CRL 운영.

### 2.2 DMZ reverse-proxy (환자앱/원외)
- nginx: 환자앱 API·서명 웹뷰만 노출, sign-core 직접 노출 금지.
- TLS1.2+ 강제, HSTS. 본인인증 사업자(PASS/명의) 콜백도 DMZ 종단.

### 2.3 시크릿 (전송)
- Webhook HMAC: `HIS_WEBHOOK_SECRET` 공유(이미 sign↔HIS 합의). 전구간 TLS + HMAC 이중.

### 2.4 sign-core → crypto-proxy (개인키 경계, **최우선 mTLS 대상**)
- `KEY_SIGNER_DRIVER=proxy`이면 sign-core는 개인키 연산(`/generate`·`/sign`)을 **crypto-proxy**로 위임한다. 이 경로는 **키 커스터디 엔드포인트**이므로 가장 강한 보호가 필요.
- 토폴로지: crypto-proxy는 **사설망에만** 바인드(외부·DMZ 절대 노출 금지). sign-core만 호출자.
- 다층 방어: ① mTLS(클라이언트=sign-core만) ② `CRYPTO_PROXY_TOKEN`(앱이 `x-proxy-token` 부착) ③ 네트워크 ACL(sign-core IP만 허용).
- nginx 예시(crypto-proxy 앞 mTLS 종단):
  ```nginx
  server {
    listen 4900 ssl;
    ssl_certificate     /etc/sign/proxy-server.crt;
    ssl_certificate_key /etc/sign/proxy-server.key;
    ssl_client_certificate /etc/sign/internal-ca.crt; # sign-core 클라 인증서 발급 CA
    ssl_verify_client on;                              # mTLS 강제
    ssl_protocols TLSv1.2 TLSv1.3;
    location / { proxy_pass http://127.0.0.1:4901; }   # 실제 crypto-proxy(로컬)
  }
  ```
  → sign-core는 `CRYPTO_PROXY_URL=https://crypto-proxy.internal:4900` + 클라 인증서로 호출.
- 인증서: 운영 PKI(서명 PKI와 **별개**의 내부 운영 CA — step-ca/cert-manager 권장)로 발급·자동갱신.

---

## 3. 키 커스터디 — crypto-proxy 분리 + 클라우드 HSM(AWS KMS)

> 결정: HSM = **클라우드(AWS KMS)**, **표면 최소화**(CA 트러스트 앵커만), **개발은 프록시 분리로 실 HSM 없이 진행**.

### 3.1 경계 분리 (구현 완료 — Inc12)
- 개인키 취급은 **crypto-proxy**(독립 프로세스)로 격리. sign-core는 개인키·마스터키·HSM SDK **미보유**.
- `KEY_SIGNER_DRIVER`: `soft`(인프로세스, 개발 단순) | `proxy`(분리, **운영 권장**).
- 프록시 백엔드 라우팅(`HsmRoutingKeySigner`): `keyClass=HSM`(CA Root/Issuing)만 HSM, 환자/스태프 말단키·TSA는 SOFT → **HSM 호출·비용·표면 최소화**.

### 3.2 개발 (실 HSM 불요)
- `HSM_PROVIDER=none` → 프록시가 전부 SOFT(`FileKeyVault` 영속). 실 HSM/클라우드 자격증명 없이 전체 흐름 개발·검증.
- 검증: `npm run e2e:proxy`(inc12), `test/increment13.e2e.mjs`(CA/TSA 재기동 영속·회전).

### 3.3 운영 (AWS KMS 드롭인 — 구현 완료, 자격증명만 주입)
1. `npm i @aws-sdk/client-kms` (optionalDependency — 개발은 불요).
2. crypto-proxy env: `HSM_PROVIDER=aws-kms`, `AWS_REGION`, IAM 자격증명(역할 권장).
3. IAM 최소권한: `kms:CreateKey`, `kms:GetPublicKey`, `kms:Sign`.
4. `AwsKmsKeySigner`: CA 키를 KMS에 생성(개인키 반출 불가), 서명은 **다이제스트만 송신**(`MessageType=DIGEST`, `RSASSA_PKCS1_V1_5_SHA_256`) → 환자정보 외부반출과 분리. keyRef=`hsm:…`.
5. **원내망/DMZ 아웃바운드**: sign-core/proxy → KMS 엔드포인트(`kms.<region>.amazonaws.com`) HTTPS 송신 허용 필요. **배포 전 망정책 확인**(원내 고정 정책과의 정합 — 키핸들/다이제스트만 이동, 동의서 원본·환자정보는 미이동).

### 3.4 키 전환 주의
- **SOFT 키는 HSM 이식 불가** — `keyClass=HSM`으로 신규 발급한 CA 키부터 KMS 상주. 기존 SOFT CA로 발급된 인증서는 **CA 이력(`issuingHistory`)으로 계속 검증**(Inc13). 무중단 전환 시 `POST /v1/ca/rotate-issuing`로 KMS 기반 Issuing으로 회전.
- **CA Root 우선 HSM/오프라인**(design §13) — 전체 신뢰의 단일점.

### 3.5 온프레 HSM (PKCS#11 — 구현 완료, SoftHSM2 e2e 검증)
원내 구축형·키 원내고정 정책의 1순위. AWS CloudHSM·Thales·Utimaco 등 표준 PKCS#11 모듈 공통.
1. 벤더 PKCS#11 라이브러리(.so) 설치 + Node 바인딩: `npm i graphene-pk11`(네이티브, pkcs11js 포함 — 빌드도구 필요).
2. crypto-proxy env:
   - `HSM_PROVIDER=pkcs11`(또는 `aws-cloudhsm`)
   - `PKCS11_MODULE=/경로/vendor_pkcs11.so`
   - `PKCS11_PIN=<사용자 PIN>`
   - `PKCS11_TOKEN_LABEL=<토큰 라벨>`(권장) 또는 `PKCS11_SLOT=<인덱스>`
3. 동작: CA 앵커키(keyClass=HSM)는 HSM 내부 token object로 생성(`CKA_SENSITIVE`·`!CKA_EXTRACTABLE` → **비추출**), keyRef=`hsm:`+label. 서명은 `SHA256_RSA_PKCS`(RSA)/`ECDSA`. 말단·TSA는 SOFT(건당 HSM 비용 0).
4. 구현: `src/infrastructure/crypto/pkcs11-key-signer.ts`. **검증**: `npm run e2e:hsm`(SoftHSM2로 RSA-3072·ECDSA-P256 generate→sign→verify + 전체 흐름, `test/increment22-pkcs11-hsm.e2e.mjs`). 실 HSM은 `PKCS11_MODULE`만 교체하면 동일 동작.
- ⚠️ `graphene-pk11`은 네이티브라 Docker 이미지 기본 미포함(npm 의존성에서 제외) — 온프레 HSM 사용 시에만 설치. 미설치 시 e2e:hsm 은 SKIP.

### 3.6 KCMVP (공공 확장 시)
- 민간 의료법인 = **KCMVP 비강제**(현재). 공공의료기관 확장·복지부 연계 시 **검증필 암호모듈**로 백엔드 교체. 동일 `KeySigner` 포트라 무중단 전환.

---

## 4. 시크릿 관리·회전

| 시크릿 | 보관 | 회전 |
|---|---|---|
| `CRYPTO_MASTER_KEY` | KMS/Vault | 키 래핑 교체(재암호화) |
| `CRYPTO_PEPPER` | KMS | 해시 일관성 영향 — 신중(블라인드인덱스 재계산) |
| `HIS_INBOUND_API_KEY` | config-runtime/Vault | **무중단 회전 지원**: `ConsumerAppService.rotateKey`→grace→`retireOldKeys` |
| `HIS_WEBHOOK_SECRET` | 공유 시크릿 | **무중단**: HIS가 dual-secret(current+prev) 병행수용 → sign이 신규로 config 교체 → HIS가 prev 폐기. **sign측 코드 무변경**(단일 시크릿 서명, config만 교체) |
| HSM PIN | HSM/Vault | 정책 준수 |

> **JWKS 키 회전(HIS RS256)**: HIS가 multi-kid(old+new) 게시하면 **sign은 무변경** — `jose` createRemoteJWKSet가 JWT 헤더 kid로 매칭 키를 자동 선택. 인플라이트 JWT 검증 보장.
- 모든 시크릿 **repo/이미지/로그 비저장**. CI/CD Secrets·Vault 주입.

---

## 5. 감사·모니터링

- `GET /v1/requests/:id/audit/verify` — 해시체인+TSA앵커 무결성(주기 점검 배치 권장)
- `GET /v1/verify/:requestId` — 서명·CMS·LTV·폐기 검증
- 로그: 민감정보 마스킹(conventions §5) 확인. 키/토큰/CI 미노출.
- 메트릭: 서명 처리시간(<2s), Webhook 성공률, 인증서 만료 임박 알림.
- Outbox(`WebhookDelivery`) 실패건 재시도 배치 + HIS reconcile(`GET /v1/requests/:id`).

---

## 5b. ⚠️ 겪은 사고 — 수신 URL 이 바뀌면 **이미 만들어진 요청**이 남는다 (2026-08-08)

**증상**: `[sign 운영알림] 웹훅 DEAD 2건` 이 **시간당 1통씩 16시간 넘게** 반복.

**원인은 두 겹이었다.**
1. edu 의 `callbackUrl` 이 실재하지 않는 경로(`/api/sign-webhook`, 404)였다.
   edu 가 2026-07-28 에 수신부(`/api/v1/webhooks/sign`)를 신설하고 자기 코드도 고쳤다.
2. ⚠️ **그런데도 계속 터졌다.** 웹훅의 `targetUrl` 은 **요청 생성 시점의 `callbackUrl`** 에서 온다.
   수정 이전에 만들어진 요청 47건에 옛 주소가 **박혀 있었고**, 그 요청들이 만료되는 시점에
   하나씩 옛 주소로 발사됐다. 발견 당시 `CREATED` 19건이 그날부터 줄줄이 만료 예정이었다.

**교훈**: 수신 측 URL 변경은 **코드만 고쳐서는 끝나지 않는다.** 이미 저장된 요청의
`callbackUrl` 까지 정정해야 한다. 안 그러면 만료·완료가 도래할 때마다 새 DEAD 가 생긴다.

**조치**(둘 다 필요 — 순서도 이 순서다)
```bash
# ① 저장된 요청의 옛 주소 정정 = 근본. 안 하면 ②를 해도 다음 만료 때 DEAD 가 다시 태어난다.
#    기본이 모의 실행(dryRun) — 먼저 대상 수·표본을 보고, 그다음 dryRun:false 로 적용한다.
curl -X POST -H "x-api-key: $CONSOLE_API_KEY" -H 'content-type: application/json' \
  -d '{"fromUrl":"api/sign-webhook","toUrl":"https://edu.example.org/api/v1/webhooks/sign"}' \
  http://127.0.0.1:4100/v1/maintenance/callback-retarget            # → matched·samples 확인
#    확인 후 실제 적용: 위 본문에 "dryRun":false 추가
#    대상 상태 기본값 = CREATED·IN_PROGRESS(통지가 아직 남은 요청). 종결 요청까지 고치려면 statuses 로 지정.
#    응답의 deliveries {pending, dead} = 옛 주소를 물고 있는 **기존 통지**(요청 정정으로는 안 따라온다) → ②로.

# ② 이미 만들어진 통지 — DEAD 는 newTargetUrl 로 재지정 재발송
curl -X POST -H "x-api-key: $CONSOLE_API_KEY" -H 'content-type: application/json' \
  -d '{"targetUrl":"api/sign-webhook","newTargetUrl":"https://edu.example.org/api/v1/webhooks/sign"}' \
  http://127.0.0.1:4100/v1/maintenance/webhook-redrive
```

⚠️ 사고 당시에는 ①의 지원 API 가 없어 **운영 DB 에 직접 UPDATE** 를 날렸다
(되돌리기 SQL 을 먼저 만들어 두고 실행 — `~/sign-callback-rollback-*.sql`).
`callback-retarget` 은 그 경로를 대체하며, DB 직접 수정에 없던 것을 더한다:
`toUrl` SSRF 검증 · 요청별 감사 봉인(`CALLBACK_RETARGETED`) · 모의 실행.

**검증**(2026-08-08 실측): 재발송 2건 `sent=2 failed=0` · 요청 47건 정정 ·
만료 스윕으로 3건 만료 → **전부 새 경로로 첫 시도에 SENT** · `health-watch` `alerts=0`.

⚠️ 재발송이 안전한 이유는 **수신 측이 멱등**이기 때문이다(edu 는 상태 재확인 reconcile).
멱등이 보장되지 않는 수신처에는 재발송 전에 확인할 것.

**후속 반영**(코드): 같은 사고를 다시 16시간 끌지 않도록 셋을 고쳤다.
- `POST /v1/maintenance/callback-retarget` — 위 ①의 지원 API(모의 실행 기본).
- 웹훅 DEAD 경보 본문에 **그 주소를 향하는 대기 중 요청 수**를 병기 —
  "DEAD 2건 · ⚠ 대기 중 요청 19건이 같은 주소" 가 첫 통에 보였다면 원인 파악이 16시간 걸리지 않았다.
- 실패 이력이 있는 주소로 신규 요청이 들어오면 생성 응답 `warnings` 로 호출자에게 알리고
  운영 알림으로도 밀어낸다(종전에는 `log.warn` 뿐이라 아무도 보지 않았다).
  ⚠️ 다만 이 경고는 **이번 사고를 막지 못했을 것**이다 — 요청 생성 시점에는 DEAD 가 0 이었고,
  DEAD 는 나중에 만료되며 생겼다. 별개 값어치로 고친 항목이다.

**라이브 배포·실측(2026-08-08, 커밋 5392c1d)** — rsync → `build sign web` → `up -d`,
3컨테이너 healthy · `ready {db:true, ca:true}`.

- `callback-retarget` **dryRun 으로 옛 edu 경로 조회 → `matched:0` · `deliveries{pending:0,dead:0}`**
  = 8/8 DB 직접 정정분이 그대로 유지되고 있음을 지원 API 로 재확인(무키 호출 401).
- ⚠️ **같은 사고 시나리오가 배포 직후 실제로 재현됐고, 이번엔 무사히 지나갔다.**
  컨테이너 재기동 → 스케줄러 기동 catch-up 이 만료 배치를 돌려 **요청 5건이 EXPIRED**,
  `request.expired` 통지 5건이 **전부 edu 새 경로로 `attempts=1` 첫 시도에 SENT**
  (웹훅 67→72 · SENT 65→70 · **DEAD 0 유지**). 옛 주소가 남아 있었다면 이 5건이 그대로 새 DEAD 였다.
- 대기 요청(CREATED·IN_PROGRESS 13건)의 수신 주소 분포 = edu 새 경로 10 · weve 계약 웹훅 3.
  **옛 주소 잔존 0** — 팀이 물은 "다른 연동처도 같은 지뢰가 있는지"에 대한 실측 답이다.
- `health-watch` `alerts=0`.

⚠️ **확인 요령(당시)**: 이 배포는 릴리즈가 아니라 `[Unreleased]` 반영분이라 `ops-status` 의
`config.version` 은 **1.29.0 그대로**였다. 새 코드가 떴는지는 버전이 아니라
**`callback-retarget` 응답으로 판정**했다(구 이미지면 404).
> 후속(2026-08-26): `callback-retarget` 을 포함한 `[Unreleased]` 분은 **v1.30.0 으로 정식 릴리즈**되었다
> (콜백 정정 API + 코드 리뷰 후속 보안·동시성·성능). v1.30.0 라이브 배포 후에는 `config.version` 이 `1.30.0`
> 으로 올라가므로, 그 이후로는 버전으로 판정해도 된다.

---

## 6. 운영 배포 체크리스트


- [ ] PostgreSQL 기동 + `migrate deploy` + `STORE_DRIVER=prisma`
- [ ] `prisma-live.e2e` 통과 (영속·재기동 보존)
- [ ] `KEY_SIGNER_DRIVER=proxy` + crypto-proxy 사설망 기동(`CRYPTO_PROXY_TOKEN` 주입, 외부 미노출)
- [ ] mTLS: HIS↔sign + **sign-core↔crypto-proxy(§2.4, 최우선)** + DMZ reverse-proxy
- [ ] `CRYPTO_MASTER_KEY`(프록시측)·`CRYPTO_PEPPER` KMS/Vault 주입 (개발용 임시키 경고 제거)
- [ ] `HIS_SSO_JWKS_URL=https://his.example.org/api/v1/sign-integration/jwks` (교차검증 완료)
- [ ] `HIS_INBOUND_API_KEY`·`HIS_WEBHOOK_SECRET`·`SIGN_ADMIN_API_KEY` 주입(admin은 ca:admin 분리)
- [ ] HSM 도입 시: `HSM_PROVIDER=aws-kms` + `@aws-sdk/client-kms` + IAM + AWS_REGION + 망정책(§3.3)
- [ ] CA/TSA 키 영속 확인(`increment13.e2e` — 재기동 후 검증 유지)
- [ ] 백업·보존기간·감사 무결성 배치
- [ ] 침투테스트 Critical 0 / 감사로그 누락 0

### 6.1 보안 리뷰 항목 — **코드 구현 완료(prod-gated)**, ✅ **라이브 활성화 완료(2026-06-16)**
> **2026-06-16 go-live 하드닝 활성**: `.env.prod` `SECURITY_HARDENING=true` 적용·재배포. 라이브 검증 — `config.hardening.enabled=true`(piiAuth·rateLimit 120·webhookSsrfGuard), 무키 PII GET 401·유키 200, 공개 verify/crl 200, **서버↔서버 facade 라운드트립 overall=true·rate-limit 면제 40/40**. H2(nginx admin allowlist)만 잔여.

> C1(무인증 서명 제출)·M3(운영 시크릿 부팅 가드)는 적용·배포 완료. H3/H4/M1/M2는 **구현 완료**,
> `isHardened()`(production 또는 `SECURITY_HARDENING=true`) 게이트로 활성. **통합 단계엔 `SECURITY_HARDENING=false`로 비활성**(HIS/PACS 연동 무중단), go-live 시 변수 제거/`=true`.
- [x] **H3** PII GET 보호 — `GET /v1/requests/:id`·`/audit`에 `ProdApiKeyGuard`(하드닝 시 x-api-key 강제). verify/ocsp/crl 공개 유지. `audit-certificate`(PDF 직접URL)는 서명URL 후속과제(현행 공개).
- [x] **H4** rate-limit — `@nestjs/throttler` 전역(`RATE_LIMIT_PER_MIN`/분/실IP, 기본 120). `skipIf`로 비하드닝 시 통과. (NAT 동시성 따라 운영서 상향)
  - **IP 트래커 정합(필수)**: `main.ts` `trust proxy`(`TRUST_PROXY`, 기본 loopback/linklocal/uniquelocal) 로 nginx `X-Forwarded-For` 의 **실 클라이언트 IP** 를 `req.ip` 로 해석. 미설정 시 모든 공개 트래픽이 docker 게이트웨이 단일 IP 로 수렴 → 단일 버킷 → 공개+HIS+PACS 동반 429. **서버↔서버(HIS/PACS = localhost 바인드 포트 직접호출, XFF 부재)는 `skipIf` 로 면제** — 공개(nginx 경유) 트래픽만 실 IP별 제한. 회귀가드 `test/hardening-ratelimit.e2e.mjs`(`npm run e2e:hardening`).
- [x] **M2** 보안 헤더 — `helmet`(X-Frame·X-Content-Type·nosniff 상시, HSTS는 하드닝/https만). CSP는 SPA(nginx/Next) 담당.
- [x] **M1** webhook `callbackUrl` SSRF — 하드닝 시 https 강제 + 사설망/루프백/메타데이터(169.254.169.254) 차단 + `WEBHOOK_ALLOWED_HOSTS` allowlist.
- [ ] **H2** 관리자 콘솔(`/admin`) IP allowlist — **실서비스 적용 시 진행(원내망 CIDR 확정 후)**. nginx conf에 템플릿 존재. ⚠️ **Cloudflare 프록시 뒤**라 `$remote_addr`=CF 엣지 IP → 단순 allow/deny 는 전원 차단됨; `set_real_ip_from <CF대역> + real_ip_header CF-Connecting-IP` 로 실IP 복원 선행, 또는 **Cloudflare Zero Trust/Access 로 /admin 보호**(앱 앞단, 더 견고) 택1. 현재는 `CONSOLE_API_KEY` 로그인으로 보호(공개 접근 유지).
- [x] **Swagger UI**(`/api-docs`) 운영 비노출 — `SWAGGER_ENABLED` 미설정 시 production OFF. 통합팀엔 `docs/openapi.json`.
> 가시화: `GET /v1/admin/ops-status` → `config.hardening`(enabled·piiAuth·rateLimitPerMin·webhookSsrfGuard).

→ go-live 시 `SECURITY_HARDENING` 활성 = **H2(nginx) 외 §6.1 완료**, P1 파일럿 공동 게이트 해제.

#### 6.1.1 하드닝 활성화 런북 (라이브, 무중단 절차)
> 라이브 공유 서버 + HIS/PACS 연동 가동 중. 아래 순서로 적용해야 연동 무중단.
1. **사전 코드 정합 확인**: `trust proxy` + throttler 서버↔서버 면제 반영분 배포(본 커밋). `npm run e2e:hardening` 통과.
2. **연동팀 공지**: H3 활성 시 PII GET(`/v1/requests/:id`·`/audit`)에 `x-api-key` 필수 — HIS/PACS 완료확인은 **공개 `GET /v1/verify/:id` 폴링 또는 webhook** 사용(영향 없음). PACS `callbackUrl` 은 **https 공개 URL**(M1 SSRF: 사설망·http 차단) 또는 verify 폴링.
3. **rate-limit 한도 합의**: 공개 포털 버스트 고려 `RATE_LIMIT_PER_MIN` 운영값 설정(기본 120, 서버↔서버는 면제이므로 공개 기준). `.env.prod` + compose passthrough.
4. **`.env.prod` 적용**: `SECURITY_HARDENING=false` 제거(또는 `=true`) + `RATE_LIMIT_PER_MIN`·`TRUST_PROXY`·(필요시)`WEBHOOK_ALLOWED_HOSTS` 명시. compose `environment` passthrough 확인.
5. **재배포·검증**: `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build` → `GET /v1/admin/ops-status` `config.hardening.enabled=true` 확인, 무키 PII GET 401·공개 verify 200·HIS facade 라운드트립 200.
6. **H2(관리자 콘솔 IP 제한, nginx) — 실서비스 시**: `deploy/nginx/sign.example.org.conf` `location /admin` allowlist 활성. ⚠️ Cloudflare 뒤라 `set_real_ip_from <CF대역>+real_ip_header CF-Connecting-IP` 로 실IP 복원 선행(아니면 전원 차단) 또는 CF Zero Trust 택1 → `nginx -t` → `systemctl reload`. **CIDR 운영팀 확정 필요**. (sudo)
7. **P8 시크릿 회전**: `POST /v1/admin/consumers/:name/rotate`→`commit` 무중단 회전 + `.env.prod` 갱신.

### 6.2 전체 검토(code-analyzer) 보완 — 적용 완료 / 운영전환 잔여
**적용·배포 완료(2026-06-15)**:
- ✅ **C1** audit-events 행위자 위조 차단(SSO 시 actor↔검증 sub 바인딩, 불일치 400).
- ✅ **H1** WITNESS X.509 유효기간 1일 통일. ✅ **H4** SSRF 강화(숫자IP·IPv4-mapped IPv6·대괄호·후행점).
- ✅ **M5** 하드닝 시 webhook dev-secret 금지. ✅ **L3** suspend/resume 409(Conflict).

**운영 전환 항목 — 구현 완료(2026-06-15)**:
- [x] **H2(rotation)** Consumer API키 회전 SignStore 영속화(consumer:keyhashes meta) — 재기동 후 폐기키 부활 차단(검증완료). 멀티노드 라이브전파는 기동 로드 기준(노드 재기동 시 반영).
- [x] **H3/M6(동시성)** submit에 서명 중복 가드(기존 서명 존재 시 ALREADY_SIGNED) + completedSigners를 서명 count로 재계산(멱등). 포털 이중서명은 이 가드로 차단(consume 멱등).
- [x] **M3(테넌트 격리)** audit-events 조회는 consumerApp별 필터(자기 system만), ca:admin·console은 전체(검증완료).
- 참고: **suspend 의미** — 중단은 *향후 서명 차단*(submit). 과거 서명은 서명시점 ACTIVE였으므로 LTV로 유효 유지(정상). OCSP는 현재상태 SUSPENDED 반영.

---

## 7. 관련 산출물
- `docker-compose.yml` · `prisma/migrations/0001_init/migration.sql`
- 키 경계: `src/crypto-proxy/main.ts`(분리 프록시) · `src/infrastructure/crypto/{key-signer.port,soft-key-signer,remote-key-signer,hsm-routing-key-signer,aws-kms-key-signer,pkcs11-key-signer,key-vault}`
- CA/TSA 영속·회전: `src/infrastructure/pki/ca.service.ts` · `src/infrastructure/tsa/self-tsa.provider.ts` · `src/presentation/ca-admin.controller.ts`
- `src/presentation/guards/api-key.guard.ts` · `src/infrastructure/auth/consumer-app.service.ts`(회전)
- 검증: `test/prisma-live.e2e.mjs` · `test/increment12.e2e.mjs`(프록시 분리) · `test/increment13.e2e.mjs`(CA/TSA 영속·회전) · `test/integration-his.e2e.mjs`(연동 하니스)
