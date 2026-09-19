#!/usr/bin/env node
/**
 * What does Apple actually hold, right now?
 *
 *   node scripts/asc-status.mjs
 *
 * The version page in App Store Connect shows one build and one state, and
 * both are easy to misread. This prints the whole picture in one pass: every
 * build and its processing state, every version and its state, the build each
 * version has attached, and any review submission that is open.
 *
 * Read-only. It changes nothing.
 */
import { asc, ascAll, credentials } from './asc.mjs';

const { APP_ID } = credentials();
if (!APP_ID) { console.error('set ASC_APP_ID'); process.exit(2); }

const app = await asc(`/v1/apps/${APP_ID}`, {
  query: { 'fields[apps]': 'name,bundleId,sku,primaryLocale' },
});
console.log(`\n${app.data.attributes.name}  ·  ${app.data.attributes.bundleId}  ·  id ${APP_ID}\n`);

/* ── builds ──────────────────────────────────────────────────────────────── */
const builds = await ascAll(`/v1/builds`, {
  query: {
    'filter[app]': APP_ID,
    limit: '50',
    sort: '-uploadedDate',
    'fields[builds]': 'version,uploadedDate,processingState,expired,usesNonExemptEncryption',
    include: 'preReleaseVersion',
  },
});
const pre = new Map(builds.included.map((i) => [i.id, i.attributes?.version]));
console.log('BUILDS (newest first)');
for (const b of builds.data.slice(0, 12)) {
  const a = b.attributes;
  const v = pre.get(b.relationships?.preReleaseVersion?.data?.id) ?? '?';
  const enc = a.usesNonExemptEncryption === null ? 'encryption UNANSWERED' : 'encryption answered';
  console.log(
    `  ${v} (${a.version})  ${String(a.processingState).padEnd(10)} ` +
    `${a.expired ? 'EXPIRED   ' : '          '}${enc}   uploaded ${String(a.uploadedDate).slice(0, 16).replace('T', ' ')}  [${b.id}]`,
  );
}

/* ── versions ────────────────────────────────────────────────────────────── */
const versions = await ascAll(`/v1/apps/${APP_ID}/appStoreVersions`, {
  query: {
    limit: '10',
    'fields[appStoreVersions]': 'versionString,appStoreState,appVersionState,platform,createdDate,releaseType',
    include: 'build',
    'fields[builds]': 'version',
  },
});
const bv = new Map(versions.included.filter((i) => i.type === 'builds').map((i) => [i.id, i.attributes?.version]));
console.log('\nVERSIONS');
for (const v of versions.data.slice(0, 6)) {
  const a = v.attributes;
  const attached = v.relationships?.build?.data?.id;
  console.log(
    `  ${a.versionString}  ${a.appVersionState ?? a.appStoreState}  ${a.platform}  ` +
    `build ${attached ? (bv.get(attached) ?? attached) : 'NONE ATTACHED'}  [${v.id}]`,
  );
}

/* ── review submissions ──────────────────────────────────────────────────── */
const subs = await ascAll(`/v1/reviewSubmissions`, {
  query: {
    'filter[app]': APP_ID,
    limit: '10',
    'fields[reviewSubmissions]': 'state,platform,submittedDate',
  },
}).catch((e) => { console.log(`\nREVIEW SUBMISSIONS — could not read: ${e.message}`); return null; });
if (subs) {
  console.log('\nREVIEW SUBMISSIONS');
  if (!subs.data.length) console.log('  none');
  for (const s of subs.data) {
    console.log(`  ${s.attributes.state}  ${s.attributes.platform}  submitted ${s.attributes.submittedDate ?? '—'}  [${s.id}]`);
  }
}

/* ── the editable version's review details and phased release ────────────── */
const editable = versions.data.find((v) =>
  ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY']
    .includes(v.attributes.appVersionState ?? v.attributes.appStoreState));
if (editable) {
  console.log(`\nEDITABLE VERSION ${editable.attributes.versionString} [${editable.id}]`);
  const rd = await asc(`/v1/appStoreVersions/${editable.id}/appStoreReviewDetail`).catch(() => null);
  if (rd?.data) {
    const a = rd.data.attributes;
    console.log(`  contact      ${a.contactFirstName ?? ''} ${a.contactLastName ?? ''} ${a.contactEmail ?? ''} ${a.contactPhone ?? ''}`);
    console.log(`  demo account ${a.demoAccountRequired ? 'REQUIRED' : 'not required'}  name=${a.demoAccountName ?? '—'}  password=${a.demoAccountPassword ? '(set)' : '—'}`);
    console.log(`  notes        ${a.notes ? `${a.notes.length} chars` : 'EMPTY'}`);
    if (a.notes) console.log(`  ---\n${a.notes.split('\n').map((l) => `  | ${l}`).join('\n')}\n  ---`);
  } else {
    console.log('  no appStoreReviewDetail record yet');
  }
}
console.log('');
