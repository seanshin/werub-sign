// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

/**
 * KeyVault — SOFT 개인키의 암호화 blob 보관소(평문 키 금지).
 * SoftKeySigner가 AES-256-GCM으로 봉인한 레코드를 저장/조회만 한다.
 *
 *  - InMemoryKeyVault: 개발/단위 (프로세스 종료 시 소멸)
 *  - FileKeyVault: crypto-proxy 분리 구동 시 키 영속(재기동 보존)
 * 운영 HSM은 개인키가 HSM 내부에 상주하므로 이 Vault를 거치지 않는다(keyRef=핸들).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export interface SealedKey {
  iv: string; // base64
  enc: string; // base64
  tag: string; // base64
}

export interface KeyVault {
  put(keyRef: string, sealed: SealedKey): Promise<void>;
  get(keyRef: string): Promise<SealedKey | null>;
}

export class InMemoryKeyVault implements KeyVault {
  private readonly m = new Map<string, SealedKey>();
  async put(keyRef: string, sealed: SealedKey): Promise<void> {
    this.m.set(keyRef, sealed);
  }
  async get(keyRef: string): Promise<SealedKey | null> {
    return this.m.get(keyRef) ?? null;
  }
}

export class FileKeyVault implements KeyVault {
  private cache?: Record<string, SealedKey>;
  constructor(private readonly path: string) {}

  private async load(): Promise<Record<string, SealedKey>> {
    if (!this.cache) {
      try {
        this.cache = JSON.parse(await fs.readFile(this.path, 'utf8'));
      } catch {
        this.cache = {};
      }
    }
    return this.cache!;
  }

  async put(keyRef: string, sealed: SealedKey): Promise<void> {
    const c = await this.load();
    c[keyRef] = sealed;
    await fs.mkdir(dirname(this.path), { recursive: true });
    await fs.writeFile(this.path, JSON.stringify(c), { mode: 0o600 });
  }

  async get(keyRef: string): Promise<SealedKey | null> {
    const c = await this.load();
    return c[keyRef] ?? null;
  }
}
