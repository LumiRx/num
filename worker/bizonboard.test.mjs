import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendOnboarding } from './bizonboard.mjs';

// The onboarding batch on 30 Aug landed in junk. Authentication is DNS work,
// but the message itself must also carry the signal every mailbox provider
// looks for on a young sending domain.
test('the onboarding email offers one-click unsubscribe', async () => {
  let seen = null;
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind: () => ({
            first: async () => (/COUNT\(\*\)/.test(sql) ? { n: 1 } : null),
            run: async () => ({}),
          }),
          first: async () => (/COUNT\(\*\)/.test(sql) ? { n: 1 } : null),
        };
      },
    },
    MAIL_REPLY_TO: 'info@thatislumi.com',
  };
  await sendOnboarding(env, { id: 9, email: 'owner@example.com', business_name: 'Test', created_at: '2026-08-20 00:00:00' }, {
    mailer: async (_e, msg) => { seen = msg; return { ok: true }; },
  });
  assert.ok(seen, 'no message was sent');
  assert.match(seen.headers['List-Unsubscribe'], /mailto:info@thatislumi\.com/);
  assert.equal(seen.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});
