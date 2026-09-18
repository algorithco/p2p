/**
 * Mini test console (GET /test) — exercises the checker API from the browser.
 * Same-origin fetch, so it works on localhost and on any public tunnel URL.
 * No auth: the checker is a read-only verification service.
 */
export const TEST_UI_HTML = `<!doctype html>
<html lang="uz">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>Checker Test Console</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#0b0e14;color:#eef3fa;font:14px/1.5 Inter,system-ui,sans-serif;padding:16px;max-width:760px;margin:0 auto}
h1{font-size:19px;margin:6px 0 2px}.sub{color:#8494ad;font-size:12.5px;margin-bottom:14px}
.card{background:#1a1f2e;border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:12px 14px;margin-bottom:12px}
.card h2{font-size:13px;margin:0 0 10px;color:#93c5fd;text-transform:uppercase;letter-spacing:.05em}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
label{font-size:12px;color:#8494ad;display:flex;flex-direction:column;gap:4px;flex:1;min-width:140px}
input{background:#0e121c;border:1px solid rgba(255,255,255,.12);border-radius:10px;color:#eef3fa;padding:9px 11px;font:inherit;font-size:13px;width:100%}
input:focus{outline:none;border-color:#3b82f6}
button{background:linear-gradient(135deg,#3b82f6,#6366f1);border:0;color:#fff;font-weight:700;border-radius:10px;padding:9px 14px;font-size:13px;cursor:pointer}
button:active{transform:scale(.96)}button.ghost{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12)}
#out{background:#070a10;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:12px;white-space:pre-wrap;word-break:break-word;font:12px/1.55 ui-monospace,Menlo,Consolas,monospace;min-height:120px;max-height:420px;overflow:auto}
.ok{color:#34d399}.err{color:#fb7185}.links{display:flex;gap:10px;flex-wrap:wrap;font-size:13px}.links a{color:#93c5fd}
.hint{font-size:12px;color:#8494ad}
</style>
</head>
<body>
<h1>🔍 Checker Test Console</h1>
<div class="sub">NFT username / gift URL / item address tekshiruvi. Auth kerak emas.</div>
<div class="card"><h2>Tekshiruv</h2>
<div class="row"><label>Username<input id="username" placeholder="@sizning_username" /></label><button data-run="username">username tekshir</button></div>
<div class="row"><label>Gift URL yoki nom<input id="giftUrl" placeholder="t.me/nft/PlushPepe yoki PlushPepe" /></label><label>Number<input id="giftNum" inputmode="numeric" placeholder="2172" /></label><label>Seller wallet (shart)<input id="sellerWallet" placeholder="UQ..." /></label></div>
<div class="row"><button data-run="gift">gift tekshir</button><span class="hint">gift nomi seller hamyonidagi NFT lar ichidan topiladi</span></div>
<div class="row"><label>Item address<input id="itemAddr" placeholder="EQ... / UQ..." /></label><button data-run="nft">nft tekshir</button></div>
<div class="row"><label>Telegram ID (ixtiyoriy, bog'lash uchun)<input id="tgId" inputmode="numeric" placeholder="masalan 123456" /></label><label>Kutilgan owner wallet (ixtiyoriy)<input id="expOwner" placeholder="UQ..." /></label></div>
</div>
<div class="card"><h2>Saqlangan bog'lar</h2>
<div class="row"><button class="ghost" data-run="owners-tg">telegram ID bo'yicha</button><button class="ghost" data-run="owners-wallet">wallet bo'yicha</button><span class="hint">yuqoridagi ID/wallet ishlatiladi</span></div>
</div>
<div class="card"><h2>Kuzatuv (watch)</h2>
<div class="row"><label>Item address<input id="wItem" placeholder="EQ..." /></label><label>Kutilayotgan owner<input id="wOwner" placeholder="UQ..." /></label></div>
<div class="row"><button data-run="watch">kutishni boshlash (110s gacha)</button></div>
</div>
<div class="card"><h2>Natija <span id="meta" class="hint"></span></h2><div id="out">...</div></div>
<div class="card"><h2>Hujjatlar</h2><div class="links">
<a href="/api/info">/api/info</a><a href="/api/openapi.json">/api/openapi.json</a><a href="/health">/health</a>
</div></div>
<script>
(function(){
var out=document.getElementById('out'),meta=document.getElementById('meta');
function v(id){return (document.getElementById(id).value||'').trim();}
function show(status,ms,body){meta.textContent='HTTP '+status+' · '+ms+'ms';meta.className='hint '+(status>=200&&status<300?'ok':'err');try{out.textContent=JSON.stringify(body,null,2);}catch(e){out.textContent=String(body);}}
async function post(path,data){var t0=Date.now();meta.textContent='...';out.textContent='...';try{var r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});var txt=await r.text();var d=null;try{d=txt?JSON.parse(txt):null;}catch(e){d=txt;}show(r.status,Date.now()-t0,d);}catch(e){show(0,Date.now()-t0,{error:'network:'+e});}}
async function get(path){var t0=Date.now();meta.textContent='...';out.textContent='...';try{var r=await fetch(path);var txt=await r.text();var d=null;try{d=txt?JSON.parse(txt):null;}catch(e){d=txt;}show(r.status,Date.now()-t0,d);}catch(e){show(0,Date.now()-t0,{error:'network:'+e});}}
function need(cond,msg){if(!cond){show(0,0,{error:msg});return false;}return true;}
document.querySelectorAll('[data-run]').forEach(function(b){b.addEventListener('click',function(){var k=b.getAttribute('data-run');var tg=v('tgId');var tgNum=tg?Number(tg):undefined;var exp=v('expOwner')||undefined;
if(k==='username'){if(!need(v('username'),'username kiriting'))return;post('/api/check/username',{username:v('username'),telegramId:tgNum,wallet:exp});}
else if(k==='gift'){if(!need(v('giftUrl'),'gift URL kiriting'))return;if(!need(v('sellerWallet'),'seller wallet kiriting'))return;post('/api/check/url',{url:v('giftUrl'),number:v('giftNum')||undefined,telegramId:tgNum,sellerWallet:v('sellerWallet')});}
else if(k==='nft'){if(!need(v('itemAddr'),'item address kiriting'))return;post('/api/check/nft',{itemAddress:v('itemAddr'),expectedOwner:exp});}
else if(k==='owners-tg'){if(!need(tg,'telegram ID kiriting'))return;get('/api/owners/'+encodeURIComponent(tg));}
else if(k==='owners-wallet'){var w=exp||v('wOwner');if(!need(w,'wallet kiriting (Kutilgan owner maydoniga)'))return;get('/api/owners/by-wallet/'+encodeURIComponent(w));}
else if(k==='watch'){if(!need(v('wItem')&&v('wOwner'),'item + owner kiriting'))return;post('/api/watch',{itemAddress:v('wItem'),expectOwner:v('wOwner'),timeoutSec:100});}
});});
})();
</script>
</body>
</html>`;
