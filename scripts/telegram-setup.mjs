/**
 * Turn a fresh Telegram bot into two Cloudflare secrets, without the token
 * ever leaving this machine.
 *
 *   node scripts/telegram-setup.mjs <bot-token>
 *
 * Why a script rather than a paragraph of instructions: the chat id is the
 * part people get wrong. It is not the @username, it is not the bot's id, and
 * Telegram will not reveal it until the human has sent the bot a message
 * first — a bot cannot open a conversation. So this asks Telegram directly,
 * tells you plainly if the missing step is the one everybody misses, sends a
 * real test message, and prints the exact commands to run.
 */
const token = (process.argv[2] || '').trim();
if (!/^\d+:[\w-]+$/.test(token)) {
  console.error('Usage: node scripts/telegram-setup.mjs <bot-token>');
  console.error('Get a token by messaging @BotFather in Telegram and sending /newbot.');
  process.exit(1);
}

const api = (m, q = '') => fetch(`https://api.telegram.org/bot${token}/${m}${q}`).then((r) => r.json());

const me = await api('getMe');
if (!me.ok) {
  console.error(`\nTelegram rejected that token: ${me.description}`);
  console.error('Check you pasted the whole thing, including the digits before the colon.');
  process.exit(1);
}
console.log(`\nBot found: @${me.result.username}`);

const updates = await api('getUpdates');
const chats = new Map();
for (const u of updates.result ?? []) {
  const c = u.message?.chat ?? u.channel_post?.chat;
  if (c) chats.set(String(c.id), c);
}

if (!chats.size) {
  console.error('\nTelegram has no messages for this bot yet, so it cannot tell us your chat id.');
  console.error(`This is the step everyone misses: open Telegram, search @${me.result.username},`);
  console.error('press Start, send it any message — then run this command again.');
  process.exit(1);
}

if (chats.size > 1) {
  console.log('\nMore than one chat has messaged this bot. Pick the one you want alerts in:');
  for (const [id, c] of chats) console.log(`   ${id}  ${c.title || [c.first_name, c.last_name].filter(Boolean).join(' ')} (${c.type})`);
}

const [chatId, chat] = [...chats][0];
const who = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ');
console.log(`\nChat id: ${chatId}   (${who})`);

const test = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    chat_id: chatId,
    text: '[Num] Alert channel connected. This is what a sign-in outage will look like.',
    disable_web_page_preview: true,
  }),
}).then((r) => r.json());

console.log(test.ok
  ? '\nTest message sent — check your phone. If it arrived, this wire works.'
  : `\nTest message FAILED: ${test.description}`);

console.log(`
Now set the two secrets (each command will prompt you to paste the value):

  npx wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler.app.jsonc
  npx wrangler secret put TELEGRAM_CHAT_ID --config wrangler.app.jsonc

TELEGRAM_CHAT_ID is ${chatId}
TELEGRAM_BOT_TOKEN is the token you just passed to this script.
`);
