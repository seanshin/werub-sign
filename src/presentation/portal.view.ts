// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 환자 서명 포털 최소 HTML — standalone fallback UI(서버 렌더, SPA 불요).
 * 동의서 정보 열람 + 본인확인 입력 + 서명 제출. XSS 방지를 위해 값은 이스케이프.
 * 정식 UX는 HIS 환자앱이 담당하며, 본 페이지는 원외/앱미사용 fallback 용도.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
type PortalView = {
  request: { title: string; externalDocId: string; documentHashPrefix: string; signMode: string };
  signer: { role: string; displayName: string; requiredIdentityLevel: string; signOrder: number; status: string };
  canSignNow: boolean;
  expiresAt: string;
};

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export function renderPortalPage(token: string, v: PortalView | null, error?: string): string {
  const head = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>전자동의 서명</title>
<style>
  :root{--p:#1f6feb}*{box-sizing:border-box}body{font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;margin:0;background:#f6f8fa;color:#1f2328}
  .wrap{max-width:480px;margin:0 auto;padding:20px}
  .card{background:#fff;border:1px solid #d0d7de;border-radius:12px;padding:20px;margin-top:16px}
  h1{font-size:18px;margin:0 0 4px}.muted{color:#656d76;font-size:13px}
  .row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f0f2f4;font-size:14px}
  label{display:block;font-size:13px;margin:12px 0 4px;color:#414853}
  input{width:100%;padding:10px;border:1px solid #d0d7de;border-radius:8px;font-size:15px}
  button{width:100%;padding:13px;margin-top:16px;background:var(--p);color:#fff;border:0;border-radius:8px;font-size:16px;font-weight:600}
  button:disabled{opacity:.5}.ok{color:#1a7f37}.err{color:#cf222e}
  .badge{display:inline-block;padding:2px 8px;border-radius:20px;background:#ddf4ff;color:var(--p);font-size:12px}
</style></head><body><div class="wrap">`;
  const foot = `</div></body></html>`;

  if (!v) {
    return head + `<div class="card"><h1>서명할 수 없습니다</h1><p class="err">${esc(error ?? '유효하지 않은 링크')}</p></div>` + foot;
  }

  const inperson = v.signer.requiredIdentityLevel === 'INPERSON' || v.signer.requiredIdentityLevel === 'NONE';
  const signed = v.signer.status === 'SIGNED';
  const idForm = inperson
    ? `<p class="muted">대면 확인 서명입니다.</p>`
    : `<label>이름</label><input id="name" placeholder="홍길동" value="${esc(v.signer.displayName)}">
       <label>생년월일/CI (본인확인)</label><input id="ci" placeholder="본인확인 식별값">
       <label>휴대폰(선택)</label><input id="phone" placeholder="01000000000">`;

  return head + `
  <div class="card">
    <span class="badge">${esc(v.request.signMode)}</span>
    <h1>${esc(v.request.title)}</h1>
    <p class="muted">문서 ${esc(v.request.externalDocId)} · 해시 ${esc(v.request.documentHashPrefix)}…</p>
    <div class="row"><span>서명자</span><b>${esc(v.signer.displayName)} (${esc(v.signer.role)})</b></div>
    <div class="row"><span>본인확인</span><span>${esc(v.signer.requiredIdentityLevel)}</span></div>
    <div class="row"><span>상태</span><span>${signed ? '서명 완료' : v.canSignNow ? '서명 대기' : '앞 서명자 대기중'}</span></div>
  </div>
  <div class="card">
    ${signed ? '<p class="ok">이미 서명이 완료되었습니다.</p>' : !v.canSignNow ? '<p class="muted">앞 순서 서명자가 완료되면 서명할 수 있습니다.</p>' : `
    ${idForm}
    <button id="go" onclick="doSign()">동의하고 서명</button>
    <p id="msg" class="muted"></p>`}
  </div>
  <script>
    var L=${JSON.stringify(v.signer.requiredIdentityLevel)};
    async function doSign(){
      var btn=document.getElementById('go'),msg=document.getElementById('msg');
      btn.disabled=true;msg.className='muted';msg.textContent='처리 중…';
      var identity={method:L==='NONE'?'INPERSON':L};
      if(L!=='INPERSON'&&L!=='NONE'){identity.ci=(document.getElementById('ci')||{}).value;identity.phone=(document.getElementById('phone')||{}).value;identity.name=(document.getElementById('name')||{}).value;}
      try{
        var r=await fetch(location.pathname.replace('/portal/','/v1/portal/')+'/sign',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identity:identity})});
        var j=await r.json();
        if(r.ok){msg.className='ok';msg.textContent='서명이 완료되었습니다. ('+(j.data&&j.data.requestStatus)+')';btn.style.display='none';}
        else{msg.className='err';msg.textContent=(j.error&&j.error.message)||j.message||'서명 실패';btn.disabled=false;}
      }catch(e){msg.className='err';msg.textContent='네트워크 오류';btn.disabled=false;}
    }
  </script>` + foot;
}
