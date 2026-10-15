// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 런타임 연동 설정 스토어 — 본인확인(idv)·발송(notifier)·키수탁(hsm) 의 provider 와 자격증명을
 * **재배포 없이** 콘솔에서 바꾸기 위한 계층. env 는 초기값일 뿐, 여기 저장값이 있으면 우선한다
 * (`effective()` — ConfigurableIdentityProvider/ConfigurableNotifier 가 매 호출 시 조회).
 *
 * 설계 결정:
 *  - 비밀(apiKey 등)은 SecretBox(AES-256-GCM) 봉인 저장, 콘솔 응답은 **항상 마스킹**(평문 미반환).
 *    "설정을 읽을 수 있는 사람 = 비밀을 아는 사람" 등식을 끊는다.
 *  - `runtimeApplied: false`(hsm)는 **캡처만** — 키 수탁 전환은 CA 앵커 cutover 절차가 따로 필요해
 *    입력 즉시 반영하면 오히려 위험하다(go-live-runbook).
 *  - 모든 변경은 SETTINGS_UPDATED 로 감사 봉인(누가 어떤 provider 로 바꿨는지, 비밀 키 이름만).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { Injectable, BadRequestException, Inject } from '@nestjs/common';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { AuditChainService } from '../infrastructure/audit/audit-chain.service';
import { SecretBox, SealedSecret } from '../infrastructure/crypto/secret-box';
import { validateCallbackUrl } from '../infrastructure/security/hardening';

export type IntegrationType = 'idv' | 'notifier' | 'hsm';

/** 연동별 스키마 — 허용 provider·비밀필드/일반필드·런타임 적용 여부. */
interface Schema {
  providers: string[];
  fields: string[]; // 비밀 아님(엔드포인트·템플릿 등)
  secrets: string[]; // 봉인 저장(API키 등)
  runtimeApplied: boolean; // true=입력 즉시 런타임 반영 / false=캡처만(cutover 필요)
  note: string;
}

const SCHEMA: Record<IntegrationType, Schema> = {
  idv: {
    providers: ['mock', 'pass', 'mobile-name'],
    fields: ['endpoint'],
    secrets: ['apiKey'],
    runtimeApplied: true,
    note: '본인확인(PASS/명의). provider=mock=개발. 실 provider+자격증명 입력 시 어댑터가 사용(verify() 벤더 REST 구현은 계약 후).',
  },
  notifier: {
    providers: ['mock', 'kakao', 'sms'],
    fields: ['endpoint', 'templateId'],
    secrets: ['apiKey', 'senderKey'],
    runtimeApplied: true,
    note: '발송(알림톡/SMS). provider=mock=개발. 실 provider+자격증명 입력 시 어댑터가 사용(send() 벤더 REST 구현은 계약 후).',
  },
  hsm: {
    providers: ['none', 'aws-kms', 'aws-cloudhsm', 'pkcs11'],
    fields: ['region', 'keyId', 'module'],
    secrets: ['pin'],
    runtimeApplied: false,
    note: '키수탁(KMS/HSM). 키 custody 는 런타임 핫스왑 불가 — 설정은 캡처·표시용이며 실제 적용은 cutover(재배포) 필요.',
  },
};

interface StoredSettings {
  provider: string;
  enabled: boolean;
  fields: Record<string, string>;
  secrets: Record<string, SealedSecret>;
  updatedAt: string;
  updatedBy: string;
}

export interface UpdateInput {
  provider?: string;
  enabled?: boolean;
  fields?: Record<string, string>;
  secrets?: Record<string, string>; // 평문 입력(빈/미지정 = 기존 유지)
}

/**
 * 런타임 연동 설정 스토어 — 벤더 자격증명을 UI 입력으로 받아 암호화 보관, 어댑터가 런타임에 사용.
 * 시크릿은 SecretBox(AES-256-GCM, CRYPTO_MASTER_KEY)로 봉인. UI 반환은 항상 마스킹(평문 미반환).
 * 영속: SignStore meta `settings:<type>` (InMemory/File/Prisma 공통).
 */
@Injectable()
export class IntegrationSettingsService {
  private readonly box: SecretBox;

  constructor(
    @Inject(SIGN_STORE) private readonly store: SignStore,
    private readonly audit: AuditChainService,
  ) {
    this.box = new SecretBox(process.env.CRYPTO_MASTER_KEY);
  }

  static schema(type: IntegrationType): Schema {
    return SCHEMA[type];
  }
  static types(): IntegrationType[] {
    return Object.keys(SCHEMA) as IntegrationType[];
  }
  private metaKey(type: IntegrationType): string {
    return `settings:${type}`;
  }
  private assertType(type: string): asserts type is IntegrationType {
    if (!SCHEMA[type as IntegrationType]) throw new BadRequestException(`알 수 없는 연동 유형: ${type} (${IntegrationSettingsService.types().join('|')})`);
  }

  private async raw(type: IntegrationType): Promise<StoredSettings | null> {
    return this.store.getMeta<StoredSettings>(this.metaKey(type));
  }

  /** 서버측 어댑터용 — 복호화된 유효 설정(시크릿 평문 포함). HTTP 로 절대 반환 금지. */
  async effective(type: IntegrationType): Promise<{ provider: string; enabled: boolean; fields: Record<string, string>; secrets: Record<string, string> } | null> {
    const s = await this.raw(type);
    if (!s) return null;
    const secrets: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.secrets ?? {})) {
      try { secrets[k] = this.box.open(v); } catch { /* 마스터키 변경 등 — 무시(미설정 취급) */ }
    }
    return { provider: s.provider, enabled: s.enabled, fields: s.fields ?? {}, secrets };
  }

  /** UI 반환 — 마스킹(시크릿은 설정여부만). */
  async masked(type: string): Promise<unknown> {
    this.assertType(type);
    const schema = SCHEMA[type];
    const s = await this.raw(type);
    return {
      type,
      provider: s?.provider ?? (type === 'hsm' ? process.env.HSM_PROVIDER ?? 'none' : process.env[`${type === 'idv' ? 'IDV' : 'NOTIFIER'}_PROVIDER`] ?? 'mock'),
      enabled: s?.enabled ?? false,
      source: s ? 'settings-store' : 'env-default',
      fields: s?.fields ?? {},
      secretsSet: Object.fromEntries(schema.secrets.map((k) => [k, !!s?.secrets?.[k]])),
      schema: { providers: schema.providers, fields: schema.fields, secrets: schema.secrets, runtimeApplied: schema.runtimeApplied, note: schema.note },
      updatedAt: s?.updatedAt ?? null,
      updatedBy: s?.updatedBy ?? null,
    };
  }

  async all(): Promise<unknown[]> {
    return Promise.all(IntegrationSettingsService.types().map((t) => this.masked(t)));
  }

  async update(type: string, input: UpdateInput, actor: string): Promise<unknown> {
    this.assertType(type);
    const schema = SCHEMA[type];
    const cur = (await this.raw(type)) ?? { provider: schema.providers[0], enabled: false, fields: {}, secrets: {}, updatedAt: '', updatedBy: '' };

    if (input.provider !== undefined) {
      if (!schema.providers.includes(input.provider)) throw new BadRequestException(`${type} provider 는 ${schema.providers.join('|')} 중 하나`);
      cur.provider = input.provider;
    }
    if (input.enabled !== undefined) cur.enabled = !!input.enabled;
    if (input.fields) {
      for (const [k, v] of Object.entries(input.fields)) {
        if (!schema.fields.includes(k)) throw new BadRequestException(`${type} 허용 필드 아님: ${k}`);
        const val = String(v);
        // SSRF 방어 — URL 형태 필드(endpoint)는 하드닝 시 https·공인망 강제(향후 벤더 호출 대상이 됨).
        if (k === 'endpoint' && val) {
          try { validateCallbackUrl(val); } catch (e) { throw new BadRequestException(`endpoint ${(e as Error).message}`); }
        }
        cur.fields[k] = val;
      }
    }
    if (input.secrets) {
      for (const [k, v] of Object.entries(input.secrets)) {
        if (!schema.secrets.includes(k)) throw new BadRequestException(`${type} 허용 시크릿 아님: ${k}`);
        if (v === '' || v == null) continue; // 빈 입력 = 기존 유지
        if (v === '__CLEAR__') { delete cur.secrets[k]; continue; } // 명시적 삭제
        cur.secrets[k] = this.box.seal(String(v)); // 봉인 저장
      }
    }
    cur.updatedAt = new Date().toISOString();
    cur.updatedBy = actor;
    await this.store.saveMeta(this.metaKey(type), cur);

    // 감사 — 시크릿 값 미기록(설정 변경 사실·행위자만)
    const key = `settings:${type}`;
    await this.audit.appendSerialized(key, async () => {
      const prev = await this.store.lastAudit(key);
      const entry = this.audit.next(prev, 'SETTINGS_UPDATED', { type, provider: cur.provider, enabled: cur.enabled, fields: Object.keys(cur.fields), secretsSet: Object.keys(cur.secrets), actor }, cur.updatedAt);
      await this.store.appendAudit(key, entry);
    });

    return this.masked(type);
  }

  /** 설정 변경 감사 조회 */
  async auditTrail(type: string): Promise<unknown> {
    this.assertType(type);
    return this.store.auditEntries(`settings:${type}`);
  }
}
