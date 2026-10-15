# sign — 공개판 안내

**sign — about this public edition**

> **EN** — This repository is the public edition of sign v1.30.1. Development continues in a private repository; this edition is its final state with internal working records (reports and replies exchanged with other systems, key-rotation runbooks, server measurements) and operational details removed, licensed under MIT. Operational domains, server addresses and accounts were replaced with example values, and **every password, secret, token and key was emptied to `CHANGE_ME`** — you must set your own before running anything. The table below lists each emptied setting and where it appears.

이 저장소는 **sign v1.30.1 의 공개판**입니다. 개발은 비공개 저장소에서 계속하고, 공개판은 그 최종 상태에서 다음을 빼거나 바꾼 것입니다(MIT).

| 무엇 | 어떻게 |
|---|---|
| 내부 작업 기록 | 다른 시스템과 주고받은 결함 보고 · 회신, 키 교체 런북, 서버 실측 등 34개 문서를 뺐습니다. 소스 주석이 빠진 문서를 가리키는 곳이 남아 있을 수 있습니다 |
| 운영 정보 | 운영 도메인 · 서버 주소 · 서버 계정을 예시 값(`example.org` · 문서용 IP 대역 · `deploy`)으로 바꿨습니다 |
| 🔴 비밀값 | 비밀번호 · 비밀 · 토큰 · 키 **4곳**을 `CHANGE_ME` 로 비웠습니다. **실행 전에 아래 값을 직접 정하십시오** |

## 직접 설정할 값

| 설정 이름 | 있는 곳 |
|---|---|
| `CONSOLE_API_KEY` | `.env.prod.example`(비어 있음) |
| `CRYPTO_MASTER_KEY` | `.env.example`(비어 있음) · `.env.prod.example`(비어 있음) |
| `CRYPTO_PROXY_TOKEN` | `.env.example`(비어 있음) |
| `ERP_API_KEY` | `.env.example`(비어 있음) · `.env.prod.example`(비어 있음) |
| `ERP_WEBHOOK_SECRET` | `.env.example`(비어 있음) · `.env.prod.example`(비어 있음) |
| `HIS_INBOUND_API_KEY` | `.env.prod.example`(비어 있음) |
| `HIS_WEBHOOK_SECRET` | `.env.example`(비어 있음) · `.env.prod.example`(비어 있음) |
| `IDV_API_KEY` | `.env.example`(비어 있음) |
| `IDV_PROXY_TOKEN` | `.env.example`(비어 있음) |
| `NOTIFY_API_KEY` | `.env.example`(비어 있음) |
| `NOTIFY_SENDER_KEY` | `.env.example`(비어 있음) |
| `PACS_API_KEY` | `.env.prod.example`(비어 있음) |
| `POSTGRES_PASSWORD` | `.env.prod.example`(비어 있음) · `.github/workflows/ci.yml` · `docker-compose.yml` |
| `SESSION_SECRET` | `.env.example`(비어 있음) · `.env.prod.example`(비어 있음) |
| `SIGN_ADMIN_API_KEY` | `.env.example`(비어 있음) · `.env.prod.example`(비어 있음) |
| `SIGN_ADMIN_PASSWORD` | `.env.example`(비어 있음) · `.env.prod.example`(비어 있음) |
| 문서 · 예시 속 비밀번호 | `.env.example` · `.github/workflows/ci.yml` — 접속 문자열 · 예시 명령의 비밀번호를 `CHANGE_ME` 로 비웠습니다. 실제 값으로 바꿔 쓰십시오 |

- 같은 이름이 여러 곳에 있으면 **모두 같은 값**이어야 하는지(서로 맞물리는 연동 비밀) 확인하십시오.
- 값은 길고 무작위로 만드십시오(예: `openssl rand -base64 32`). 저장소에 다시 커밋하지 마십시오.

## 켜기 전에 기관이 정할 보안 설정

아래 기능은 공개판에서 **설정하지 않으면 안전한 쪽으로 멈추거나 꺼져 있습니다.** 기관의 운영 절차에 맞춰 직접 정하십시오.

| 설정 | 무엇을 정하나 |
|---|---|
| `CRYPTO_PEPPER` | 본인확인 값 해시용 페퍼. 운영(`NODE_ENV=production` 또는 하드닝)에서는 **반드시** 정해야 하며, 비어 있으면 서비스와 본인확인 프록시가 기동하지 않습니다. 두 서비스가 같은 값이어야 합니다. |
| `IDV_PROXY_TOKEN` | 본인확인 프록시 호출 토큰. **비어 있으면 프록시가 모든 요청을 거부합니다.** 개발에서만 `IDV_PROXY_ALLOW_NO_TOKEN=1` 로 토큰 없이 열 수 있습니다. |
| `<소비자>_WEBHOOK_SECRET` | 서명 완료 통지(웹훅) 서명 시크릿. HIS 계열(hospitalrun · console · pacs)은 `HIS_WEBHOOK_SECRET`, 그 밖의 소비자(예: `ERP_WEBHOOK_SECRET` · `EDU_WEBHOOK_SECRET`)는 **각자 자기 시크릿**이 있어야 하며, 운영에서는 없으면 통지를 서명하지 않습니다. |
| `요청 목록 조회 범위` | 연동 소비자 키로 요청 목록 · CSV 를 부르면 **그 소비자가 만든 요청만** 보입니다. 전체 조회는 콘솔 · 관리 키 · 관리자 세션에서 합니다. |
| `SECURITY_HARDENING` | 운영(`NODE_ENV=production`)에서는 보안 검사가 켜집니다. `false` 로 끄면 웹훅 주소 검사 · 개발용 기본값 차단이 함께 꺼지므로, 연동 시험 중에만 쓰고 운영 전 반드시 지우십시오. |

- 코드 안의 개발용 기본값은 운영에서 반드시 환경 변수로 덮어쓰십시오.
- 이 생태계 전체의 소개 · 구축 순서: [werub-his-ecosystem](https://github.com/seanshin/werub-his-ecosystem)
