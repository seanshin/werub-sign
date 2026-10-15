// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import 'reflect-metadata';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { IdentityProvider } from '../domain/ports/identity-provider.port';
import { MockIdentityProvider } from '../infrastructure/identity/mock-identity-provider';
import { PassIdentityProvider, MobileNameIdentityProvider } from '../infrastructure/identity/vendor-identity-provider';

/**
 * idv-proxy — 환자 본인확인(PASS/명의)을 sign-core에서 분리한 DMZ 중계 서비스.
 * 개발: IDV_PROVIDER=mock → 실 사업자 계약 없이 진행.
 * 운영: IDV_PROVIDER=pass|mobile-name → 사업자 자격증명(IDV_API_KEY·IDV_ENDPOINT) 드롭인.
 * sign-core(RemoteIdentityProvider)가 x-idv-token으로 /verify 호출. 운영은 mTLS 추가.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
const log = new Logger('idv-proxy');
const PORT = Number(process.env.IDV_PROXY_PORT ?? 4920);
const TOKEN = process.env.IDV_PROXY_TOKEN ?? '';
const PROVIDER = process.env.IDV_PROVIDER ?? 'mock';

function buildProvider(): IdentityProvider {
  const pepper = process.env.CRYPTO_PEPPER || (process.env.NODE_ENV === 'production' ? (() => { throw new Error('CRYPTO_PEPPER 미설정(PUBLIC-EDITION.md)'); })() : 'dev-pepper');
  const apiKey = process.env.IDV_API_KEY;
  const endpoint = process.env.IDV_ENDPOINT;
  switch (PROVIDER) {
    case 'mock':
      return new MockIdentityProvider(pepper);
    case 'pass':
      return new PassIdentityProvider(pepper, apiKey, endpoint);
    case 'mobile-name':
      return new MobileNameIdentityProvider(pepper, apiKey, endpoint);
    default:
      throw new Error(`알 수 없는 IDV_PROVIDER=${PROVIDER} (mock|pass|mobile-name)`);
  }
}

const provider = buildProvider();

function tokenOk(req: IncomingMessage): boolean {
  if (!TOKEN) return process.env.IDV_PROXY_ALLOW_NO_TOKEN === '1'; // 공개판: 토큰이 없으면 거부 — 개발에서만 명시적으로 연다
  const got = String(req.headers['x-idv-token'] ?? '');
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
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const stats = { verify: 0, success: 0, fail: 0 };

const server = createServer(async (req, res) => {
  try {
    const url = req.url ?? '';
    if (req.method === 'GET' && url === '/health') return send(res, 200, { status: 'ok', provider: PROVIDER });
    if (req.method === 'GET' && url === '/stats') {
      if (!tokenOk(req)) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, { provider: PROVIDER, ...stats });
    }
    if (req.method === 'POST' && url === '/verify') {
      if (!tokenOk(req)) return send(res, 401, { error: 'unauthorized' });
      const input = await readJson(req);
      const result = await provider.verify(input);
      stats.verify++;
      result.result === 'SUCCESS' ? stats.success++ : stats.fail++;
      return send(res, 200, result);
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    log.error(`verify failed: ${(e as Error).message}`);
    return send(res, 500, { error: (e as Error).message });
  }
});

server.listen(PORT, () => {
  log.log(`idv-proxy 기동 — http://localhost:${PORT} (IDV_PROVIDER=${PROVIDER}, token=${TOKEN ? 'set' : 'unset'})`);
});
