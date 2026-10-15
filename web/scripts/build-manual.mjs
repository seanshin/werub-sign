// manual.source.html(편집용 소스) → src/app/admin/manual/manualHtml.ts(번들용, 인증 페이지 srcDoc).
// 매뉴얼 수정 시: manual.source.html 편집 → npm run manual:build → web 재배포.
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('../manual.source.html', import.meta.url), 'utf8');
if (html.includes('`') || html.includes('${')) throw new Error('manual.source.html 에 백틱/${ 포함 — String.raw 안전성 위반');
// 헤더는 생성물 자신이 들고 있어야 한다 — 손으로 붙이면 다음 빌드에서 사라진다(실제로 사라진 적 있음)
const header = `// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 운영 매뉴얼 HTML(생성물) — 원본은 web/manual.source.html 이며 \`npm run manual:build\` 가
 * 이 파일을 재생성한다. **직접 편집 금지**(다음 빌드에서 덮어써짐).
 */
`;
writeFileSync(new URL('../src/app/admin/manual/manualHtml.ts', import.meta.url),
  header + 'export const MANUAL_HTML = String.raw`' + html + '`;\n');
console.log('manualHtml.ts 생성 완료(' + html.length + ' chars)');
