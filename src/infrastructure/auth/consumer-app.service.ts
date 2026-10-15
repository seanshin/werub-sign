// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Injectable, Logger, NotFoundException, BadRequestException, ConflictException, OnModuleInit, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { SIGN_STORE, SignStore } from '../../domain/ports/sign-store.port';

const ROTATION_META = 'consumer:keyhashes'; // 회전 키 영속(재기동·폐기키 부활 방지)
const DYNAMIC_META = 'consumer:dynamic'; // UI 등록 소비자 정의(name·scopes·status) 영속·복원

/**
 * UI로 부여 가능한 스코프 — 기계(연동) 권한만. 민감 스코프(ca:admin·users:admin)는 UI 부여 금지(권한상승 차단).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export const ASSIGNABLE_SCOPES = ['requests:write', 'certificates:write', 'settings:write', 'approval:write', 'documents:read', 'contracts:write'] as const;
/** 예약어(환경변수 시드 시스템 소비자) — 동적 등록/이름충돌 금지. */
const RESERVED_NAMES = new Set(['hospitalrun', 'console', 'pacs', 'erp', 'sign-admin']);

export interface ConsumerApp {
  id: string;
  name: string;
  apiKeyHashes: Set<string>; // 다중키(현재+grace) — 무중단 회전
  allowedScopes: string[];
  status: 'ACTIVE' | 'SUSPENDED';
  dynamic?: boolean; // true=UI 등록(영속·스코프편집 가능), false/undefined=env 시드 시스템
}

/**
 * Consumer 앱 레지스트리 — 플랫폼화/멀티테넌트 (FR-11 / design §16).
 * 무중단 API Key 회전: 신규 키 추가(grace) → 양키 허용 → 구키 폐기.
 * conventions §6: API 인증 + 키 회전.
 */
@Injectable()
export class ConsumerAppService implements OnModuleInit {
  private readonly logger = new Logger('ConsumerApp');
  private readonly appsById = new Map<string, ConsumerApp>();
  private readonly hashIndex = new Map<string, string>(); // apiKeyHash -> appId

  constructor(config: ConfigService, @Inject(SIGN_STORE) private readonly store: SignStore) {
    let key = config.get<string>('HIS_INBOUND_API_KEY');
    if (!key) {
      if (config.get<string>('NODE_ENV') === 'production') {
        throw new Error('HIS_INBOUND_API_KEY 필수 (production) — 약한 임시키 가동 방지');
      }
      key = `dev_${randomBytes(16).toString('hex')}`;
      this.logger.warn(`HIS_INBOUND_API_KEY 미설정 — 개발용 키 생성: ${key}`);
    }
    // approval:write = 전자결재 상신(기계키). 결재(approval:act)는 사람/SSO 전용이라 미부여(최소권한).
    this.register('hospitalrun', key, ['certificates:write', 'requests:write', 'approval:write']);

    // 콘솔(사람) 전용 키 — HIS 기계 시크릿과 분리(독립 회전·감사). 관리자 콘솔 로그인용.
    const consoleKey = config.get<string>('CONSOLE_API_KEY');
    if (consoleKey) this.register('console', consoleKey, ['certificates:write', 'requests:write', 'settings:write', 'approval:write']);

    // PACS 전용 키 — 영상 판독보고서 서명(의료진 STAFF/SSO) + 영상·조영제 동의서(환자 포털).
    // HIS와 동일 스코프, 별도 ConsumerApp(독립 회전·감사). 의료진 SSO는 병원 공통 JWKS 재사용.
    const pacsKey = config.get<string>('PACS_API_KEY');
    if (pacsKey) this.register('pacs', pacsKey, ['certificates:write', 'requests:write', 'approval:write']);

    // ERP 전용 키 — 외부 거래처 계약 전자서명(트랙 A) + 일반 전자계약(contracts:write). 독립 회전·감사, webhook은 ERP_WEBHOOK_SECRET 분리.
    const erpKey = config.get<string>('ERP_API_KEY');
    if (erpKey) this.register('erp', erpKey, ['certificates:write', 'requests:write', 'approval:write', 'contracts:write']);

    // CA 운영(회전 등) 전용 admin 키 — HIS 키와 권한 분리(최소권한).
    // users:admin = C-4 RBAC 최초 사용자 부트스트랩/관리용 break-glass(관리자 계정과 동등 권한).
    const adminKey = config.get<string>('SIGN_ADMIN_API_KEY');
    if (adminKey) this.register('sign-admin', adminKey, ['ca:admin', 'settings:write', 'users:admin']);
  }

  /** 기동 시 영속 상태 복원 — ①UI 등록 소비자 정의(name·scopes·status) ②회전 키 해시 */
  async onModuleInit(): Promise<void> {
    // ① UI 등록(동적) 소비자 정의 복원 — env 시드에 없는 소비자를 재생성(해시는 ②에서 채움)
    const dyn = await this.store.getMeta<Array<{ name: string; scopes: string[]; status: 'ACTIVE' | 'SUSPENDED' }>>(DYNAMIC_META);
    if (dyn) {
      let dynRestored = 0;
      for (const d of dyn) {
        if (!d?.name || RESERVED_NAMES.has(d.name.toLowerCase()) || this.findByName(d.name)) continue; // 시스템 충돌 방지
        const id = randomBytes(8).toString('hex');
        this.appsById.set(id, { id, name: d.name, apiKeyHashes: new Set(), allowedScopes: d.scopes ?? [], status: d.status ?? 'ACTIVE', dynamic: true });
        dynRestored++;
      }
      if (dynRestored) this.logger.log(`UI 등록 소비자 복원: ${dynRestored}개`);
    }

    // ② 회전 키 해시 복원 — 재기동 후 폐기키 부활 방지·멀티노드 일관성(동적 소비자 해시도 여기서 채움)
    const persisted = await this.store.getMeta<Record<string, string[]>>(ROTATION_META);
    if (!persisted) return;
    let restored = 0;
    for (const [name, hashes] of Object.entries(persisted)) {
      const app = [...this.appsById.values()].find((a) => a.name === name);
      if (!app || !hashes?.length) continue;
      for (const h of app.apiKeyHashes) this.hashIndex.delete(h); // 구 인덱스 제거
      app.apiKeyHashes = new Set(hashes); // 영속 집합으로 교체(env 폐기키 제외 반영)
      for (const h of hashes) this.hashIndex.set(h, app.id);
      restored++;
    }
    if (restored) this.logger.log(`Consumer 키 회전 상태 복원: ${restored}개 앱(env 폐기키 부활 차단)`);
  }

  private async persistRotation(): Promise<void> {
    const map: Record<string, string[]> = {};
    for (const app of this.appsById.values()) map[app.name] = [...app.apiKeyHashes];
    await this.store.saveMeta(ROTATION_META, map);
  }

  register(name: string, apiKey: string, allowedScopes: string[], dynamic = false): ConsumerApp {
    const id = randomBytes(8).toString('hex');
    const app: ConsumerApp = { id, name, apiKeyHashes: new Set([this.hash(apiKey)]), allowedScopes, status: 'ACTIVE', dynamic };
    this.appsById.set(id, app);
    this.hashIndex.set(this.hash(apiKey), id);
    return app;
  }

  /** UI 소비자 등록 — 이름/스코프 검증 후 키 생성(1회 반환)·영속. 민감 스코프 부여 차단. */
  async createConsumer(name: string, scopes: string[]): Promise<{ name: string; apiKey: string; scopes: string[] }> {
    const nm = (name ?? '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{1,30}$/i.test(nm)) throw new BadRequestException('소비자 이름 형식 오류(영숫자·-_ 2~31자)');
    if (RESERVED_NAMES.has(nm.toLowerCase()) || this.findByName(nm)) throw new ConflictException(`이미 사용 중인 이름: ${nm}`);
    const clean = this.validateScopes(scopes);
    const apiKey = `sk_${randomBytes(24).toString('base64url')}`;
    this.register(nm, apiKey, clean, true);
    await this.persistDynamic();
    await this.persistRotation();
    this.logger.log(`소비자 등록: ${nm} [${clean.join(', ')}]`);
    return { name: nm, apiKey, scopes: clean };
  }

  /** 스코프 편집 — 동적(UI 등록) 소비자만. 시스템(env) 소비자는 코드/env 소유. */
  async setScopes(name: string, scopes: string[]): Promise<ConsumerApp> {
    const app = this.byName(name);
    if (!app.dynamic) throw new BadRequestException('시스템 소비자는 스코프 편집 불가(env/코드 소유)');
    app.allowedScopes = this.validateScopes(scopes);
    await this.persistDynamic();
    return app;
  }

  /** 상태 변경(일시중지/재개) — 동적 소비자만. */
  async setStatus(name: string, status: 'ACTIVE' | 'SUSPENDED'): Promise<ConsumerApp> {
    const app = this.byName(name);
    if (!app.dynamic) throw new BadRequestException('시스템 소비자는 상태 변경 불가');
    app.status = status;
    await this.persistDynamic();
    return app;
  }

  assignableScopes(): string[] {
    return [...ASSIGNABLE_SCOPES];
  }

  private validateScopes(scopes: string[]): string[] {
    const clean = [...new Set((scopes ?? []).map((s) => s.trim()).filter(Boolean))];
    if (!clean.length) throw new BadRequestException('스코프 최소 1개 필요');
    const bad = clean.filter((s) => !(ASSIGNABLE_SCOPES as readonly string[]).includes(s));
    if (bad.length) throw new BadRequestException(`부여 불가 스코프(민감/미정의): ${bad.join(', ')}`);
    return clean;
  }

  private async persistDynamic(): Promise<void> {
    const dyn = [...this.appsById.values()].filter((a) => a.dynamic).map((a) => ({ name: a.name, scopes: a.allowedScopes, status: a.status }));
    await this.store.saveMeta(DYNAMIC_META, dyn);
  }

  private findByName(name: string): ConsumerApp | undefined {
    for (const app of this.appsById.values()) if (app.name === name) return app;
    return undefined;
  }

  /** 무중단 회전: 신규 키 추가(구키 grace 유지) — 영속화 */
  async rotateKey(name: string, newApiKey: string): Promise<ConsumerApp> {
    const app = this.byName(name);
    const h = this.hash(newApiKey);
    app.apiKeyHashes.add(h);
    this.hashIndex.set(h, app.id);
    await this.persistRotation();
    this.logger.log(`${name} API Key 회전: 신규키 추가(grace), 활성키 ${app.apiKeyHashes.size}`);
    return app;
  }

  /** 회전 완료: 지정 키만 남기고 나머지(구키) 폐기 — 영속화(폐기키 부활 방지) */
  async retireOldKeys(name: string, keepApiKey: string): Promise<ConsumerApp> {
    const app = this.byName(name);
    const keep = this.hash(keepApiKey);
    if (!app.apiKeyHashes.has(keep)) throw new NotFoundException('keep key not active');
    for (const h of app.apiKeyHashes) if (h !== keep) this.hashIndex.delete(h);
    app.apiKeyHashes = new Set([keep]);
    await this.persistRotation();
    this.logger.log(`${name} 구키 폐기 완료, 활성키 1`);
    return app;
  }

  /** 소비자 목록(키 값/해시 제외) — 콘솔 키 회전·등록 UI. dynamic=UI 등록(관리 가능) 표시. */
  list(): Array<{ name: string; scopes: string[]; activeKeys: number; status: string; dynamic: boolean }> {
    return [...this.appsById.values()].map((a) => ({ name: a.name, scopes: a.allowedScopes, activeKeys: a.apiKeyHashes.size, status: a.status, dynamic: !!a.dynamic }));
  }

  verifyApiKey(apiKey: string | undefined): ConsumerApp | null {
    if (!apiKey) return null;
    const appId = this.hashIndex.get(this.hash(apiKey));
    if (!appId) return null;
    const app = this.appsById.get(appId);
    return app && app.status === 'ACTIVE' ? app : null;
  }

  private byName(name: string): ConsumerApp {
    for (const app of this.appsById.values()) if (app.name === name) return app;
    throw new NotFoundException(`consumer app not found: ${name}`);
  }
  private hash(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }
}
