import { test } from 'node:test';
import assert from 'node:assert/strict';
import { impersonation } from './oauth.js';

/* The consent screen is the last place a person can catch a fake client, and
   the only fact on it that cannot be forged is the return address. These tests
   pin that comparison, because getting it wrong in either direction is bad:
   a missed warning is the phishing case, and a false warning on a real client
   teaches people to click through warnings. */

test('a stranger calling itself Claude, returning somewhere else, is called out', () => {
  const r = impersonation('Claude', 'https://evil.example/cb');
  assert.equal(r.label, 'Claude');
  assert.equal(r.host, 'evil.example');
});

test('the real clients are never warned about', () => {
  assert.equal(impersonation('Claude', 'https://claude.ai/api/mcp/auth_callback'), null);
  assert.equal(impersonation('Claude Desktop', 'https://claude.com/api/mcp/auth_callback'), null);
  assert.equal(impersonation('ChatGPT', 'https://chatgpt.com/connector_platform_oauth_redirect'), null);
  assert.equal(impersonation('Cursor', 'https://cursor.com/cb'), null);
  assert.equal(impersonation('VS Code', 'https://vscode.dev/redirect'), null);
});

test('subdomains of a brand count as that brand', () => {
  assert.equal(impersonation('Claude', 'https://api.claude.ai/cb'), null);
  assert.equal(impersonation('ChatGPT', 'https://platform.openai.com/cb'), null);
});

test('a lookalike domain does NOT count — this is the whole attack', () => {
  assert.ok(impersonation('Claude', 'https://claude.ai.evil.example/cb'));
  assert.ok(impersonation('Claude', 'https://claude-ai.example/cb'));
  assert.ok(impersonation('ChatGPT', 'https://openai.example.com/cb'));
});

test('loopback is exempt, because that is how desktop clients really work', () => {
  assert.equal(impersonation('Claude Code', 'http://localhost:8765/callback'), null);
  assert.equal(impersonation('Claude Code', 'http://127.0.0.1:1410/callback'), null);
});

test('a client claiming to be NUM itself is checked too', () => {
  assert.equal(impersonation('NUM', 'https://itsnum.com/cb'), null);
  assert.ok(impersonation('NUM Concierge', 'https://not-num.example/cb'));
});

test('an ordinary name is never warned about, however odd', () => {
  for (const n of ['Acme Listings Bot', 'n8n', 'LibreChat', '', 'Unnamed MCP client']) {
    assert.equal(impersonation(n, 'https://anything.example/cb'), null, n);
  }
});

test('the check is case- and spacing-insensitive, because the attacker picks the spelling', () => {
  assert.ok(impersonation('CLAUDE', 'https://evil.example/cb'));
  assert.ok(impersonation('chat gpt', 'https://evil.example/cb'));
  assert.ok(impersonation('Chat-GPT by OpenAI', 'https://evil.example/cb'));
});

test('a redirect_uri we cannot parse is not evidence of anything', () => {
  assert.equal(impersonation('Claude', 'not a url'), null);
  assert.equal(impersonation('Claude', ''), null);
});
