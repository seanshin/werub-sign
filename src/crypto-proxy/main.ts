// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import 'reflect-metadata';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { SoftKeySigner } from '../infrastructure/crypto/soft-key-signer';
import { AwsKmsKeySigner } from '../infrastructure/crypto/aws-kms-key-signer';
import { Pkcs11KeySigner } from '../infrastructure/crypto/pkcs11-key-signer';
import { HsmRoutingKeySigner } from '../infrastructure/crypto/hsm-routing-key-signer';
import { FileKeyVault } from '../infrastructure/crypto/key-vault';
import { KeySigner } from '../domain/ports/key-signer.port';

/**
 * crypto-proxy — 개인키 취급을 앱에서 분리한 독립 키 커스터디 서비스.
 * 개발: HSM_PROVIDER=none → 전부 SOFT(FileKeyVault 영속), 실 HSM 불요.
 * 운영: HSM_PROVIDER=aws-kms|aws-cloudhsm → keyClass=HSM(CA 앵커)만 HSM, 나머지 SOFT.
 *
 * 앱(RemoteKeySigner)이 x-proxy-token 으로 /generate·/sign 호출. 운영은 사설망+mTLS 추가.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
const log = new Logger('crypto-proxy');
const PORT = Number(process.env.CRYPTO_PROXY_PORT ?? 4900);
const TOKEN = process.env.CRYPTO_PROXY_TOKEN ?? '';
const HSM_PROVIDER = process.env.HSM_PROVIDER ?? 'none';

function buildBackend(): HsmRoutingKeySigner {
  let master = process.env.CRYPTO_MASTER_KEY;
  if (!master) {
    master = randomBytes(32).toString('base64');
    log.warn('CRYPTO_MASTER_KEY 미설정 — 개발용 임시 키 생성(운영 금지)');
  }
  const vaultPath = process.env.CRYPTO_PROXY_VAULT ?? './data/key-vault.json';
  const soft: KeySigner = new SoftKeySigner(master, new FileKeyVault(vaultPath));
  const hsm: KeySigner | null = buildHsm();
  return new HsmRoutingKeySigner(soft, hsm);
}

function buildHsm(): KeySigner | null {
  switch (HSM_PROVIDER) {
    case 'none':
      return null; // 개발 — 전부 SOFT
    case 'aws-kms':
      return new AwsKmsKeySigner(process.env.AWS_REGION); // 개인키 KMS 상주
    case 'pkcs11': // 온프레 HSM (Thales/Utimaco/SoftHSM 등 표준 PKCS#11)
    case 'aws-cloudhsm': // CloudHSM 도 PKCS#11
      return new Pkcs11KeySigner({
        module: process.env.PKCS11_MODULE ?? '',
        pin: process.env.PKCS11_PIN ?? '',
        tokenLabel: process.env.PKCS11_TOKEN_LABEL,
        slot: process.env.PKCS11_SLOT ? Number(process.env.PKCS11_SLOT) : undefined,
      });
    default:
      throw new Error(`알 수 없는 HSM_PROVIDER=${HSM_PROVIDER} (none|aws-kms|pkcs11|aws-cloudhsm)`);
  }
}

const backend = buildBackend();

function tokenOk(req: IncomingMessage): boolean {
  if (!TOKEN) return true; // 토큰 미설정(개발) — 운영은 반드시 설정
  const got = String(req.headers['x-proxy-token'] ?? '');
  const a = Buffer.from(got);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(s);
}

const server = createServer(async (req, res) => {
  try {
    const url = req.url ?? '';
    if (req.method === 'GET' && url === '/health') return send(res, 200, { status: 'ok' });
    if (req.method === 'GET' && url === '/stats') {
      if (!tokenOk(req)) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, backend.stats());
    }
    if (req.method === 'POST' && (url === '/generate' || url === '/sign')) {
      if (!tokenOk(req)) return send(res, 401, { error: 'unauthorized' });
      const body = await readJson(req);
      if (url === '/generate') {
        const out = await backend.generate(body.algorithm, { keyClass: body.keyClass, ownerRef: body.ownerRef });
        return send(res, 200, out);
      }
      const sig = await backend.sign(body.keyRef, Buffer.from(body.data, 'base64'));
      return send(res, 200, { signature: sig.toString('base64') });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    log.error(`request failed: ${(e as Error).message}`);
    return send(res, 500, { error: (e as Error).message });
  }
});

server.listen(PORT, () => {
  log.log(`crypto-proxy 기동 — http://localhost:${PORT} (HSM_PROVIDER=${HSM_PROVIDER}, token=${TOKEN ? 'set' : 'unset'})`);
});
