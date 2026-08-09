#!/usr/bin/env node
// Ping IndexNow (Bing, Yandex, Seznam, Naver share the endpoint) with the
// URLs that changed. Google ignores IndexNow — its path is Search Console —
// but for every other engine this is the difference between "indexed today"
// and "indexed when the crawler wanders by".
//   node scripts/indexnow.mjs /phuket/beaches/ /business/ ...   (or no args = sitemap set)
const KEY = 'b7e4a1c9d2f84356a0e8b1c4d7f2a985';
const HOST = 'itsnum.com';
const args = process.argv.slice(2);
let urls = args.map((p) => `https://${HOST}${p.startsWith('/') ? p : '/' + p}`);
if (!urls.length) {
  const xml = await (await fetch(`https://${HOST}/sitemap.xml`)).text();
  urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
}
const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList: urls }),
});
console.log(`IndexNow: ${res.status} for ${urls.length} url(s)`);
if (res.status >= 400) console.log(await res.text());
