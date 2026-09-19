#!/usr/bin/env node
/** Read the 1.0 version record in full: review detail, attached build, submission items. */
import { asc } from './asc.mjs';

const APP_ID = process.env.ASC_APP_ID;
const vs = await asc(`/v1/apps/${APP_ID}/appStoreVersions`, {
  query: { limit: '5', 'fields[appStoreVersions]': 'versionString,appStoreState,appVersionState,releaseType,earliestReleaseDate' },
});
for (const v of vs.data) {
  console.log(`\n=== ${v.attributes.versionString} · ${v.attributes.appVersionState} · ${v.id}`);
  const rd = await asc(`/v1/appStoreVersions/${v.id}/appStoreReviewDetail`).catch((e) => ({ err: e.message }));
  if (rd?.err) console.log(`  reviewDetail: ${rd.err}`);
  else if (rd?.data) {
    const a = rd.data.attributes;
    console.log(`  reviewDetail id ${rd.data.id}`);
    console.log(`  contact: ${a.contactFirstName} ${a.contactLastName} | ${a.contactEmail} | ${a.contactPhone}`);
    console.log(`  demoRequired=${a.demoAccountRequired} name=${a.demoAccountName ?? '—'} pass=${a.demoAccountPassword ?? '—'}`);
    console.log(`  NOTES:\n${(a.notes ?? '(empty)').split('\n').map((l) => '    | ' + l).join('\n')}`);
  }
  const b = await asc(`/v1/appStoreVersions/${v.id}/build`, { query: { 'fields[builds]': 'version' } }).catch(() => null);
  console.log(`  attached build: ${b?.data ? b.data.attributes.version : 'NONE'}`);
  const loc = await asc(`/v1/appStoreVersions/${v.id}/appStoreVersionLocalizations`, {
    query: { 'fields[appStoreVersionLocalizations]': 'locale,whatsNew', limit: '10' },
  }).catch(() => null);
  for (const l of loc?.data ?? []) console.log(`  loc ${l.attributes.locale}: whatsNew=${l.attributes.whatsNew ? JSON.stringify(l.attributes.whatsNew.slice(0, 120)) : 'EMPTY'}`);
  const sub = await asc(`/v1/appStoreVersions/${v.id}/appStoreVersionSubmission`).catch((e) => ({ err: e.status }));
  console.log(`  versionSubmission: ${sub?.data ? sub.data.id : `none (${sub?.err ?? '—'})`}`);
}

console.log('\n=== OPEN REVIEW SUBMISSIONS ===');
const subs = await asc('/v1/reviewSubmissions', {
  query: { 'filter[app]': APP_ID, 'filter[state]': 'READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES', limit: '10', include: 'items' },
}).catch((e) => ({ err: e.message }));
if (subs?.err) console.log(subs.err);
else for (const s of subs.data ?? []) {
  console.log(`  ${s.id} ${s.attributes.state} submitted=${s.attributes.submittedDate} canceled=${s.attributes.canceled} items=${(s.relationships?.items?.data ?? []).length}`);
}

console.log('\n=== BUILDS 10-12 detail ===');
for (const id of ['25bb4502-d310-4873-85a1-8ac53f1a36e2', '4b7246ed-4a0f-4f34-a501-6fa6f21d6c0e', 'cd60fc38-75d5-4674-aafc-c531aa2856a4']) {
  const b = await asc(`/v1/builds/${id}`, { query: { 'fields[builds]': 'version,uploadedDate,processingState,expired,minOsVersion,usesNonExemptEncryption' } });
  const a = b.data.attributes;
  console.log(`  build ${a.version}: ${a.processingState} expired=${a.expired} minOS=${a.minOsVersion} enc=${a.usesNonExemptEncryption} uploaded=${a.uploadedDate}`);
}
