// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * ConsumerAppService 무중단 API Key 회전 계약 검증.
 * 실행: npx ts-node test/consumer-rotation.contract.ts
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import 'reflect-metadata';
import { ConsumerAppService } from '../src/infrastructure/auth/consumer-app.service';

const fakeConfig = { get: (k: string) => (k === 'HIS_INBOUND_API_KEY' ? 'key-old' : undefined) } as never;
let fail = 0;
const check = (c: boolean, m: string) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) fail++; };

const svc = new ConsumerAppService(fakeConfig);
console.log('\n══════ API Key 무중단 회전 계약 ══════\n');

check(svc.verifyApiKey('key-old')?.name === 'hospitalrun', '초기 키 인증');
check(svc.verifyApiKey('wrong') === null, '잘못된 키 거부');

// 회전: 신규키 추가(구키 grace)
svc.rotateKey('hospitalrun', 'key-new');
check(svc.verifyApiKey('key-old') !== null, '회전 중: 구키 여전히 유효(grace)');
check(svc.verifyApiKey('key-new') !== null, '회전 중: 신규키 유효');

// 회전 완료: 구키 폐기
svc.retireOldKeys('hospitalrun', 'key-new');
check(svc.verifyApiKey('key-new') !== null, '폐기 후: 신규키 유효');
check(svc.verifyApiKey('key-old') === null, '폐기 후: 구키 거부');

// 멀티테넌트 등록
svc.register('erp', 'erp-key', ['requests:write']);
const erp = svc.verifyApiKey('erp-key');
check(erp?.name === 'erp' && erp.allowedScopes.includes('requests:write'), '타 시스템(erp) 등록·스코프');
check(svc.verifyApiKey('erp-key')?.id !== svc.verifyApiKey('key-new')?.id, '테넌트 격리(다른 app id)');

console.log('\n' + (fail === 0 ? '✅ 무중단 회전 계약 전부 통과' : `❌ ${fail}건 실패`));
process.exit(fail === 0 ? 0 : 1);
