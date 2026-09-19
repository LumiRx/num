/**
 * Just enough MIME to read a reply from a restaurant.
 *
 * ── WHY THIS IS HAND-WRITTEN AND SMALL ───────────────────────────────────
 *
 * A Cloudflare Email Worker is handed the raw RFC 5322 message and nothing
 * else. Proper libraries exist; none is installed here, and a dependency that
 * runs on every inbound message is a thing to keep for when the shape of the
 * problem is known. The shape of this problem is narrow: a person at a venue
 * hits reply in Gmail, Outlook or Apple Mail and types a paragraph.
 *
 * So this handles what those three send — multipart/alternative,
 * quoted-printable, base64, RFC 2047 subjects — and NOTHING ELSE, on purpose.
 *
 * ── THE RULE THAT MAKES THAT SAFE ────────────────────────────────────────
 *
 * The caller keeps the raw message whatever happens here. Every function
 * returns its best effort and says what it could not do, and the inbound
 * handler stores `text ?? raw`. A parse that fails therefore degrades to "a
 * human reads the source of an email", which is inconvenient. A parse that
 * fails and is trusted would lose a business's reply silently, which is the
 * failure this whole file exists to prevent.
 *
 * Attachments are deliberately not extracted. A menu PDF is real and will
 * matter one day; today it would be a large object store write on a path with
 * no size discipline, so its presence is RECORDED and its bytes are not.
 */

const decoder = (label) => {
  try { return new TextDecoder(label || 'utf-8', { fatal: false }); } catch { return new TextDecoder('utf-8'); }
};

/** Split a message into its headers map and its body, unfolding continuations. */
export function splitMessage(raw) {
  const text = String(raw ?? '');
  // \r\n\r\n by the RFC; \n\n from anything that has been through a pipe.
  const i = (() => {
    const a = text.indexOf('\r\n\r\n');
    const b = text.indexOf('\n\n');
    if (a === -1) return b === -1 ? -1 : { at: b, len: 2 };
    if (b === -1 || a < b) return { at: a, len: 4 };
    return { at: b, len: 2 };
  })();
  if (i === -1) return { headers: {}, body: text };

  const head = text.slice(0, i.at).replace(/\r\n[ \t]+/g, ' ').replace(/\n[ \t]+/g, ' ');
  const headers = {};
  for (const line of head.split(/\r?\n/)) {
    const c = line.indexOf(':');
    if (c < 1) continue;
    const k = line.slice(0, c).trim().toLowerCase();
    const v = line.slice(c + 1).trim();
    // A header can legally repeat (Received:, References:). Later wins for the
    // ones we read, except References, where they are joined — losing half of
    // a References chain loses half the chances of matching a thread.
    headers[k] = k === 'references' && headers[k] ? `${headers[k]} ${v}` : v;
  }
  return { headers, body: text.slice(i.at + i.len) };
}

/** `=?UTF-8?B?…?=` and `=?UTF-8?Q?…?=`, which is how a subject carries an é. */
export function decodeWords(s) {
  return String(s ?? '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset, enc, data) => {
    try {
      if (enc.toUpperCase() === 'B') {
        const bin = atob(data);
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        return decoder(charset).decode(bytes);
      }
      const bytes = [];
      const q = data.replace(/_/g, ' ');
      for (let i = 0; i < q.length; i++) {
        if (q[i] === '=' && /[0-9a-f]{2}/i.test(q.slice(i + 1, i + 3))) {
          bytes.push(parseInt(q.slice(i + 1, i + 3), 16)); i += 2;
        } else bytes.push(q.charCodeAt(i));
      }
      return decoder(charset).decode(Uint8Array.from(bytes));
    } catch { return whole; }
  }).replace(/\?=\s+=\?/g, '?==?');
}

function decodeBody(body, encoding, charset) {
  const enc = String(encoding ?? '').toLowerCase();
  try {
    if (enc === 'base64') {
      const bin = atob(String(body).replace(/\s+/g, ''));
      return decoder(charset).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    }
    if (enc === 'quoted-printable') {
      const joined = String(body).replace(/=\r?\n/g, '');
      const bytes = [];
      for (let i = 0; i < joined.length; i++) {
        if (joined[i] === '=' && /[0-9a-f]{2}/i.test(joined.slice(i + 1, i + 3))) {
          bytes.push(parseInt(joined.slice(i + 1, i + 3), 16)); i += 2;
        } else bytes.push(joined.charCodeAt(i) & 0xff);
      }
      return decoder(charset).decode(Uint8Array.from(bytes));
    }
  } catch { /* fall through to the raw text, which is better than nothing */ }
  return String(body);
}

const paramOf = (value, name) => {
  const m = String(value ?? '').match(new RegExp(`${name}\\s*=\\s*"?([^";]+)"?`, 'i'));
  return m ? m[1].trim() : null;
};

/** HTML to something a person can read, when that is all the message carries. */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The readable text of a message. Returns `{ text, kind, parts, attachments }`
 * where `kind` says where the text came from, so a caller can tell a real
 * plain-text part from an HTML page that was flattened.
 */
export function readBody(raw, depth = 0) {
  const { headers, body } = splitMessage(raw);
  const ctype = headers['content-type'] ?? 'text/plain';
  const charset = paramOf(ctype, 'charset') ?? 'utf-8';
  const enc = headers['content-transfer-encoding'];
  const attachments = [];

  if (/^multipart\//i.test(ctype) && depth < 4) {
    const boundary = paramOf(ctype, 'boundary');
    if (!boundary) return { text: String(body), kind: 'unparsed', attachments };
    const chunks = String(body).split(new RegExp(`\r?\n--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(--)?\r?\n?`))
      .filter((c) => c && c !== '--');

    let plain = null; let html = null;
    for (const chunk of chunks) {
      const sub = splitMessage(chunk);
      const subType = sub.headers['content-type'] ?? '';
      const disp = sub.headers['content-disposition'] ?? '';
      if (/attachment/i.test(disp) || paramOf(disp, 'filename')) {
        // Recorded, not stored. See the note at the top of the file.
        attachments.push({
          filename: paramOf(disp, 'filename') ?? paramOf(subType, 'name') ?? 'attachment',
          type: String(subType).split(';')[0].trim() || 'application/octet-stream',
        });
        continue;
      }
      if (/^multipart\//i.test(subType)) {
        const inner = readBody(chunk, depth + 1);
        if (inner.text && !plain) plain = inner.text;
        attachments.push(...inner.attachments);
        continue;
      }
      const decoded = decodeBody(sub.body, sub.headers['content-transfer-encoding'],
        paramOf(subType, 'charset') ?? charset);
      if (/text\/plain/i.test(subType) && !plain) plain = decoded;
      else if (/text\/html/i.test(subType) && !html) html = decoded;
    }
    if (plain) return { text: plain.trim(), kind: 'plain', attachments };
    if (html) return { text: htmlToText(html), kind: 'html', attachments };
    return { text: '', kind: 'empty', attachments };
  }

  const decoded = decodeBody(body, enc, charset);
  return /text\/html/i.test(ctype)
    ? { text: htmlToText(decoded), kind: 'html', attachments }
    : { text: decoded.trim(), kind: 'plain', attachments };
}

/**
 * Drop the quoted history, keeping what this person actually wrote.
 *
 * Used for the SUMMARY shown in a list, never for what is stored: the full
 * body is kept, because the quoted part is sometimes where the answer is (a
 * venue that replies inline, under each question, is answering thoroughly and
 * would come out blank here).
 */
export function topReply(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^\s*On .+ wrote:\s*$/.test(line)) break;
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^\s*From:\s.+@/.test(line) && out.length) break;
    out.push(line);
  }
  const t = out.join('\n').trim();
  return t || String(text ?? '').trim();
}

/** Everything the inbound handler needs, from one raw message. */
export function parseMessage(raw) {
  const { headers } = splitMessage(raw);
  const { text, kind, attachments } = readBody(raw);
  return {
    headers,
    subject: decodeWords(headers.subject ?? ''),
    from: headers.from ?? '',
    to: (headers.to ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    deliveredTo: headers['delivered-to'] ?? null,
    messageId: (headers['message-id'] ?? '').replace(/[<>]/g, '') || null,
    inReplyTo: (headers['in-reply-to'] ?? '').replace(/[<>]/g, '') || null,
    references: headers.references ?? null,
    // An auto-reply is a fact about a mail server, not a message from a
    // business. Recorded, but it must never raise "they answered".
    auto: /auto-(replied|generated|notify)/i.test(headers['auto-submitted'] ?? '')
      || String(headers['x-autoreply'] ?? '').length > 0
      || /^(out of office|automatic reply|autoreply)/i.test(decodeWords(headers.subject ?? '')),
    text, kind, attachments,
  };
}
