/**
 * A box to paste the token into, instead of a terminal prompt.
 *
 *   node scripts/telegram-connect.mjs
 *
 * Serves a small page on this machine only (127.0.0.1) with one field. The
 * token goes from the browser to this local process to Telegram and stops
 * there: it is never printed, never logged, and never leaves the machine.
 *
 * Doing the Telegram calls here rather than in the page avoids the two things
 * that make the browser-only version of this flaky — cross-origin rules and a
 * token sitting in a URL bar — and lets the result be written straight to
 * disk where the deploy step can pick it up.
 */
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const PORT = Number(process.env.PORT || 4599);
const api = (token, method, body) => fetch(`https://api.telegram.org/bot${token}/${method}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
}).then((r) => r.json()).catch((e) => ({ ok: false, description: String(e?.message ?? e) }));

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Telegram alerts</title>
<style>
:root{--bg:#f6f6f4;--fg:#1a1a18;--mut:#6b6b66;--line:#dededa;--card:#fff;--ok:#0f7b4f;--bad:#b3261e;--acc:#1a1a18}
@media(prefers-color-scheme:dark){:root{--bg:#141413;--fg:#f0efec;--mut:#9b9b95;--line:#2f2f2c;--card:#1d1d1b;--ok:#4ade80;--bad:#f87171;--acc:#f0efec}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;max-width:520px;width:100%}
h1{font-size:21px;margin:0 0 6px;letter-spacing:-.01em}
p{color:var(--mut);margin:0 0 18px;font-size:14.5px}
ol{color:var(--mut);font-size:14.5px;padding-left:20px;margin:0 0 20px}
li{margin-bottom:7px}
b{color:var(--fg);font-weight:600}
input{width:100%;padding:13px 14px;font:15px ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid var(--line);
border-radius:9px;background:var(--bg);color:var(--fg);margin-bottom:12px}
input:focus{outline:2px solid var(--acc);outline-offset:1px;border-color:transparent}
button{width:100%;padding:13px;font-size:15px;font-weight:600;border:0;border-radius:9px;background:var(--acc);
color:var(--card);cursor:pointer}
button:disabled{opacity:.55;cursor:default}
#out{margin-top:18px;font-size:14.5px;display:none}
#out.on{display:block}
.id{font:22px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);border:1px solid var(--line);
border-radius:9px;padding:14px;text-align:center;margin:10px 0;user-select:all}
.ok{color:var(--ok)}.bad{color:var(--bad)}
</style></head><body><div class="card">
<h1>Connect Telegram alerts</h1>
<p>This page runs on your Mac. The token goes straight to Telegram and is never sent anywhere else.</p>
<ol>
<li>In Telegram, message <b>@BotFather</b> and send <b>/newbot</b>.</li>
<li>Copy the whole token it gives you &mdash; digits, colon and letters.</li>
<li>Open your new bot and press <b>Start</b>. A bot can&rsquo;t message you until you message it first.</li>
</ol>
<input id="t" type="text" placeholder="8123456789:AAH..." autocomplete="off" spellcheck="false">
<button id="go">Find my chat ID</button>
<div id="out"></div>
</div><script>
const out=document.getElementById('out'),go=document.getElementById('go'),t=document.getElementById('t');
const show=h=>{out.className='on';out.innerHTML=h};
async function run(){
  const token=t.value.trim();
  if(!/^\\d+:[\\w-]+$/.test(token)){show('<p class="bad">That doesn\\'t look like a full token. It should be digits, then a colon, then letters.</p>');return}
  go.disabled=true;go.textContent='Asking Telegram...';
  try{
    const r=await fetch('/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
    const d=await r.json();
    if(!d.ok){show('<p class="bad">'+d.error+'</p>')}
    else{show('<p class="ok">Connected to @'+d.bot+'. Check your phone \\u2014 a test alert just went out.</p>'
      +'<div class="id">'+d.chatId+'</div><p>That\\'s your chat ID. It\\'s saved; you can close this page and tell Claude it\\'s done.</p>')}
  }catch(e){show('<p class="bad">'+e.message+'</p>')}
  go.disabled=false;go.textContent='Find my chat ID';
}
go.onclick=run;t.onkeydown=e=>{if(e.key==='Enter')run()};t.focus();
</script></body></html>`;

const server = createServer(async (req, res) => {
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
  if (req.method === 'GET' && req.url === '/') return send(200, 'text/html; charset=utf-8', PAGE);
  if (req.method !== 'POST' || req.url !== '/connect') return send(404, 'text/plain', 'not found');

  let raw = '';
  for await (const chunk of req) raw += chunk;
  const token = String(JSON.parse(raw || '{}').token || '').trim();
  const fail = (error) => send(200, 'application/json', JSON.stringify({ ok: false, error }));

  const me = await api(token, 'getMe');
  if (!me.ok) return fail(`Telegram rejected that token: ${me.description}. Check you copied all of it.`);

  const upd = await api(token, 'getUpdates');
  const chats = new Map();
  for (const u of upd.result ?? []) {
    const c = u.message?.chat ?? u.channel_post?.chat;
    if (c) chats.set(String(c.id), c);
  }
  if (!chats.size) {
    return fail(`No messages yet, so Telegram can't tell us the chat ID. Open @${me.result.username} in Telegram, `
      + 'press Start, send it anything, then try again. This is the step almost everyone misses.');
  }

  const [chatId] = [...chats.keys()];
  const test = await api(token, 'sendMessage', {
    chat_id: chatId,
    text: '[Num] Alert channel connected. This is what a sign-in outage will look like.',
    disable_web_page_preview: true,
  });
  if (!test.ok) return fail(`Found the chat but the test message failed: ${test.description}`);

  // Written where the deploy step can read them. Both are gitignored.
  writeFileSync(new URL('../.telegram-token', import.meta.url), token);
  writeFileSync(new URL('../.telegram-chat-id', import.meta.url), chatId);
  console.log(`\nChat ID: ${chatId}  (saved)  bot @${me.result.username}`);
  console.log('Done — you can stop this server with Ctrl+C.');
  return send(200, 'application/json', JSON.stringify({ ok: true, chatId, bot: me.result.username }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Open this in your browser:   http://localhost:${PORT}\n`);
});
