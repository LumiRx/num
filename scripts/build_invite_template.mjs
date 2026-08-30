#!/usr/bin/env node
/**
 * Regenerates growth/invitetemplate.mjs from campaign/invite_v2.html.
 *
 * The Cloudflare Worker that sends invites automatically (growth/invitecron.mjs)
 * has no filesystem, so it cannot read the .html file the way the manual CLI
 * sender (scripts/send_invites.mjs) does. Rather than maintain a second,
 * hand-copied template that quietly drifts from the one marketing actually
 * edits, the .html file stays the ONLY thing a person edits, and this script
 * embeds it as a JS string for the worker to import.
 *
 * Run this after every change to campaign/invite_v2.html, then deploy:
 *   node scripts/build_invite_template.mjs
 *   npx wrangler deploy --config growth/wrangler.jsonc
 *
 * A CI/pre-commit check could enforce this is never forgotten; for now
 * growth/invitecron.test.mjs asserts the two files are in sync, which fails
 * loudly in `npm test` the moment someone edits the .html and forgets to run
 * this.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = new URL('../campaign/invite_v2.html', import.meta.url);
const OUT = new URL('../growth/invitetemplate.mjs', import.meta.url);

const html = readFileSync(SRC, 'utf8');

// The whole file becomes one template literal. Backticks or ${...} in the
// HTML would break that — the invite copy has never needed either, so this
// fails loudly and early rather than emitting silently-broken JS.
if (html.includes('`')) throw new Error('invite_v2.html contains a backtick — cannot embed as a template literal');
if (/\$\{/.test(html)) throw new Error('invite_v2.html contains ${ — cannot embed as a template literal');

const out = `/**
 * The invite HTML, embedded as a string.
 *
 * Workers have no filesystem, so this cannot \`readFileSync\` campaign/invite_v2.html
 * the way the CLI sender (scripts/send_invites.mjs) does. Rather than keep a
 * second hand-copied template that drifts from the one marketing edits, this
 * file is REGENERATED from campaign/invite_v2.html by
 * scripts/build_invite_template.mjs — never hand-edit the string below.
 * Edit the .html, then run: node scripts/build_invite_template.mjs
 */
export const INVITE_TEMPLATE = \`
${html}\`;
`;

writeFileSync(OUT, out);
console.log(`Wrote ${OUT.pathname} (${out.length} bytes) from ${SRC.pathname}`);
