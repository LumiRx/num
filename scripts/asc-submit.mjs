#!/usr/bin/env node
/**
 * Attach a build, replace the App Review notes, and submit for review.
 *
 *   node scripts/asc-submit.mjs --build 12            # dry run, prints the plan
 *   node scripts/asc-submit.mjs --build 12 --go       # actually does it
 *
 * ── WHY THIS IS A SCRIPT ───────────────────────────────────────────────────
 *
 * Four submissions, three rejections, and the notes field was wrong in all of
 * them — it described a start-up sheet removed in 0.8.323 and a 40-second wait
 * that no longer happens. Notes drift because they live in a web form nobody
 * diffs. Here they come from docs/APP-REVIEW-INFORMATION.md, which is in git,
 * so "what did we tell Apple" has an answer with a commit hash on it.
 *
 * The notes are read from the fenced block under "## Field: Notes" in that
 * file. Edit the document, not this script.
 */
import { readFileSync } from 'node:fs';
import { asc } from './asc.mjs';

const APP_ID = process.env.ASC_APP_ID;
const GO = process.argv.includes('--go');
const wantBuild = (() => {
  const i = process.argv.indexOf('--build');
  return i > -1 ? String(Number(process.argv[i + 1])) : null;
})();
if (!APP_ID || !wantBuild) {
  console.error('usage: ASC_APP_ID=… node scripts/asc-submit.mjs --build <n> [--go]');
  process.exit(2);
}
const say = (s) => console.log(s);
const act = async (label, fn) => {
  if (!GO) { say(`   WOULD ${label}`); return null; }
  const r = await fn();
  say(`   ✓ ${label}`);
  return r;
};

/* ── the notes, from the document ─────────────────────────────────────────── */
const doc = readFileSync('docs/APP-REVIEW-INFORMATION.md', 'utf8');
const NOTES = (/## Field: Notes\s*```([\s\S]*?)```/.exec(doc)?.[1] ?? '').trim();
if (!NOTES) { console.error('no fenced Notes block in docs/APP-REVIEW-INFORMATION.md'); process.exit(1); }
if (NOTES.length > 4000) { console.error(`notes are ${NOTES.length} chars; App Store Connect caps at 4000.`); process.exit(1); }
say(`\n── notes: ${NOTES.length} chars from docs/APP-REVIEW-INFORMATION.md`);

/* ── the build ────────────────────────────────────────────────────────────── */
const builds = await asc('/v1/builds', {
  query: { 'filter[app]': APP_ID, limit: '50', sort: '-uploadedDate', 'fields[builds]': 'version,processingState,expired' },
});
const build = builds.data.find((b) => b.attributes.version === wantBuild);
if (!build) { console.error(`Apple has no build ${wantBuild} for this app.`); process.exit(1); }
if (build.attributes.processingState !== 'VALID') { console.error(`build ${wantBuild} is ${build.attributes.processingState}, not VALID.`); process.exit(1); }
if (build.attributes.expired) { console.error(`build ${wantBuild} has expired.`); process.exit(1); }
say(`── build ${wantBuild} is VALID  [${build.id}]`);

/* ── the version ──────────────────────────────────────────────────────────── */
const vs = await asc(`/v1/apps/${APP_ID}/appStoreVersions`, {
  query: { limit: '5', 'fields[appStoreVersions]': 'versionString,appStoreState,appVersionState' },
});
const version = vs.data[0];
const state = version.attributes.appVersionState ?? version.attributes.appStoreState;
say(`── version ${version.attributes.versionString} is ${state}  [${version.id}]`);
if (['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE', 'READY_FOR_DISTRIBUTION'].includes(state)) {
  console.error(`\n✘ ${state} — this version is already with Apple. Nothing to submit.`);
  process.exit(1);
}

/* ── 1 · clear any submission still holding the version ───────────────────── */
const open = await asc('/v1/reviewSubmissions', {
  query: { 'filter[app]': APP_ID, 'filter[state]': 'READY_FOR_REVIEW,WAITING_FOR_REVIEW,UNRESOLVED_ISSUES', limit: '10', 'fields[reviewSubmissions]': 'state,submittedDate' },
});
for (const s of open.data) {
  say(`\n── open submission ${s.id} is ${s.attributes.state}`);
  // A submission left in UNRESOLVED_ISSUES keeps its item, and Apple refuses a
  // second submission for the same version while it does. Cancelling it is the
  // documented way out; it does not withdraw anything already reviewed.
  await act(`cancel submission ${s.id}`, () => asc(`/v1/reviewSubmissions/${s.id}`, {
    method: 'PATCH',
    body: { data: { type: 'reviewSubmissions', id: s.id, attributes: { canceled: true } } },
  }));
}

/* ── 2 · attach the build ─────────────────────────────────────────────────── */
const attached = await asc(`/v1/appStoreVersions/${version.id}/build`, { query: { 'fields[builds]': 'version' } }).catch(() => null);
say(`\n── attached build is ${attached?.data ? attached.data.attributes.version : 'NONE'}, want ${wantBuild}`);
if (attached?.data?.id !== build.id) {
  await act(`attach build ${wantBuild}`, () => asc(`/v1/appStoreVersions/${version.id}/relationships/build`, {
    method: 'PATCH',
    body: { data: { type: 'builds', id: build.id } },
  }));
} else say('   already attached');

/* ── 3 · the notes ────────────────────────────────────────────────────────── */
const rd = await asc(`/v1/appStoreVersions/${version.id}/appStoreReviewDetail`).catch(() => null);
say(`\n── review detail ${rd?.data ? rd.data.id : '(none yet)'}`);
if (rd?.data) {
  await act('replace the App Review notes', () => asc(`/v1/appStoreReviewDetails/${rd.data.id}`, {
    method: 'PATCH',
    body: { data: { type: 'appStoreReviewDetails', id: rd.data.id, attributes: { notes: NOTES } } },
  }));
} else {
  await act('create the review detail with notes', () => asc('/v1/appStoreReviewDetails', {
    method: 'POST',
    body: {
      data: {
        type: 'appStoreReviewDetails',
        attributes: { notes: NOTES },
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } } },
      },
    },
  }));
}

/* ── 4 · submit ───────────────────────────────────────────────────────────── */
say('\n── submitting');
if (GO) {
  // Reuse a submission left open by an earlier run rather than stacking a
  // second empty one beside it. An empty READY_FOR_REVIEW submission is what a
  // failed attempt leaves behind, and two of them is a confusing console.
  const already = await asc('/v1/reviewSubmissions', {
    query: { 'filter[app]': APP_ID, 'filter[state]': 'READY_FOR_REVIEW', limit: '5' },
  });
  let subId = already.data[0]?.id;
  if (subId) say(`   reusing open submission ${subId}`);
  else {
    const made = await asc('/v1/reviewSubmissions', {
      method: 'POST',
      body: {
        data: {
          type: 'reviewSubmissions',
          attributes: { platform: 'IOS' },
          relationships: { app: { data: { type: 'apps', id: APP_ID } } },
        },
      },
    });
    subId = made.data.id;
    say(`   ✓ created submission ${subId}`);
  }

  // Cancelling the old submission is what releases the version — but Apple
  // does not apply it synchronously. The first attempt after a cancel comes
  // back 409 ENTITY_STATE_INVALID even though the cancel succeeded, so retry
  // rather than reporting a failure that is really a race.
  const addItem = () => asc('/v1/reviewSubmissionItems', {
    method: 'POST',
    body: {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: subId } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
        },
      },
    },
  });
  let added = false;
  for (let i = 1; i <= 6 && !added; i++) {
    try { await addItem(); added = true; say(`   ✓ added version ${version.attributes.versionString} to the submission`); }
    catch (e) {
      if (e.status !== 409 || i === 6) throw e;
      say(`   … version not released by Apple yet (409), retrying ${i}/5`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  const done = await act('SUBMIT to App Review', () => asc(`/v1/reviewSubmissions/${subId}`, {
    method: 'PATCH',
    body: { data: { type: 'reviewSubmissions', id: subId, attributes: { submitted: true } } },
  }));
  say(`\n✓ submission ${subId} is now ${done.data.attributes.state}, submitted ${done.data.attributes.submittedDate}\n`);
} else {
  say('   WOULD add the version as an item and set submitted=true');
  say('\n(dry run — nothing changed. Re-run with --go)\n');
}
