#!/usr/bin/env node
/**
 * NUM · Phuket business ingestion v2 — "find everything, ground team verifies"
 * Sources (both legitimate, no scraping):
 *   1. OpenStreetMap via Overpass API — free, open-licensed (ODbL): names, categories,
 *      coordinates, phones, websites, opening hours, addresses.
 *   2. Google Places API (New) — OPTIONAL, adds ratings/review counts. Licensed via your key:
 *      GOOGLE_PLACES_API_KEY=xxxx node scripts/ingest_places.mjs
 * Outputs:
 *   public/console/directory.json   → the console auto-loads it (map, directory, search)
 *   verification_sheet.csv          → for the ground team (NOT deployed — stays local)
 * Run from the num-console folder:   node scripts/ingest_places.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const BBOX = '7.72,98.22,8.22,98.48'; // Phuket island + edges
const MIRRORS = ['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter','https://lz4.overpass-api.de/api/interpreter'];
const UA = 'NUM-Phuket-Directory/1.0 (business directory bootstrap; contact: andre@thatislumi.com)';
const KEY = process.env.GOOGLE_PLACES_API_KEY || '';

const AREAS = [
  ['Patong',7.896,98.296],['Kata',7.820,98.298],['Karon',7.845,98.294],['Bang Tao',7.993,98.295],
  ['Kamala',7.955,98.283],['Surin',7.977,98.278],['Old Town',7.885,98.387],['Chalong',7.846,98.339],
  ['Rawai',7.771,98.325],['Nai Harn',7.777,98.302],['Mai Khao',8.140,98.308],['Nai Yang',8.090,98.300],
  ['Paklok',8.033,98.397],['Cape Panwa',7.805,98.400],['Cherngtalay',7.984,98.303],['Phuket Town',7.884,98.391],
  ['Koh Kaew',7.936,98.405],['Kathu',7.917,98.333],['Panwa',7.800,98.370],['Airport',8.110,98.310]
];
const areaFor = (lat,lng) => { let best='Phuket', bd=1e9;
  for (const [n,a,b] of AREAS){ const d=(lat-a)**2+(lng-b)**2; if(d<bd){bd=d;best=n;} } return best; };

const CATMAP = {
  restaurant:'Restaurant', cafe:'Café', bar:'Bar', pub:'Bar', nightclub:'Nightlife', fast_food:'Street food',
  marketplace:'Market', pharmacy:'Pharmacy', car_rental:'Vehicle rental', boat_rental:'Boat charter', taxi:'Transport',
  hotel:'Hotel', guest_house:'Guesthouse', attraction:'Attraction', museum:'Museum', theme_park:'Theme park',
  massage:'Massage & spa', beauty:'Beauty & spa', spa:'Massage & spa', scuba_diving:'Diving',
  motorcycle:'Vehicle rental', tailor:'Tailor', gift:'Souvenirs & gifts',
  fitness_centre:'Gym & fitness', water_park:'Water park', golf_course:'Golf', marina:'Marina & charters',
  sports_centre:'Gym & fitness', travel_agency:'Tours & travel'
};
const norm = s => (s||'').toLowerCase().normalize('NFKD').replace(/[^a-z0-9฀-๿]/g,'');

async function fromOSM(){
  const q = `[out:json][timeout:120];
(
  nwr["amenity"~"^(restaurant|cafe|bar|fast_food|pub|nightclub|marketplace|pharmacy|car_rental|boat_rental|taxi)$"]["name"](${BBOX});
  nwr["tourism"~"^(hotel|guest_house|attraction|museum|theme_park)$"]["name"](${BBOX});
  nwr["shop"~"^(massage|beauty|scuba_diving|motorcycle|tailor|gift|travel_agency)$"]["name"](${BBOX});
  nwr["leisure"~"^(spa|fitness_centre|water_park|golf_course|marina|sports_centre)$"]["name"](${BBOX});
  nwr["office"="travel_agent"]["name"](${BBOX});
);
out center 12000;`;
  console.log('→ Pulling Phuket businesses from OpenStreetMap (free, open-licensed)…');
  let j = null, lastErr = null;
  for (const url of MIRRORS){
    try {
      const res = await fetch(url, { method:'POST',
        headers:{ 'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8',
                  'User-Agent': UA, 'Accept':'application/json' },
        body:'data='+encodeURIComponent(q) });
      if(!res.ok){ lastErr = 'HTTP '+res.status+' from '+url; console.log('  !', lastErr, '— trying next mirror'); continue; }
      j = await res.json(); break;
    } catch(e){ lastErr = String(e); console.log('  !', lastErr, '— trying next mirror'); }
  }
  if(!j) throw new Error('All Overpass mirrors failed. Last error: '+lastErr+' — wait 2 minutes and rerun.');
  const out = [];
  for (const el of j.elements||[]){
    const t = el.tags||{}; const name = t.name || t['name:en']; if(!name) continue;
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon; if(!lat) continue;
    const raw = t.amenity || t.tourism || t.shop || t.leisure || (t.office==='travel_agent'?'travel_agency':'business');
    const addr = [t['addr:housenumber'], t['addr:street'], t['addr:subdistrict']||t['addr:city']].filter(Boolean).join(' ');
    out.push({ name, name_th: t['name:th']||null, category: CATMAP[raw]||raw, area: areaFor(lat,lng),
      lat:+lat.toFixed(5), lng:+lng.toFixed(5),
      phone: t.phone || t['contact:phone'] || null,
      website: t.website || t['contact:website'] || null,
      email: t.email || t['contact:email'] || null,
      hours: t.opening_hours || null, cuisine: t.cuisine || null,
      address: addr || null, source:'osm', status:'unclaimed' });
  }
  console.log('  ✓ OSM gave us', out.length, 'named businesses');
  return out;
}

async function fromGoogle(){
  if(!KEY){ console.log('→ No GOOGLE_PLACES_API_KEY — skipping ratings (rerun with the key to add them).'); return []; }
  console.log('→ Pulling ratings from Google Places API (licensed)…');
  const QUERIES = [
    'restaurants in Patong','restaurants in Kata Phuket','restaurants in Karon','restaurants in Bang Tao',
    'restaurants Phuket Old Town','seafood restaurants Phuket','beach clubs Phuket',
    'spas in Phuket','massage in Patong','massage in Kata',
    'diving centers Phuket','boat charters Phuket','island tours Phuket','travel agency Phuket',
    'muay thai gym Phuket','water park Phuket','kids activities Phuket',
    'cafes in Phuket','nightlife Patong','tailors Phuket','motorbike rental Phuket','hotels in Phuket',
    // boats · water sports · transport (vertical expansion)
    'jet ski rental Phuket','parasailing Patong','speedboat charter Phuket','longtail boat tour Phuket',
    'private boat tour Phang Nga Bay','yacht charter Phuket','catamaran tour Phuket',
    'kayaking Phuket','surf school Phuket','stand up paddle Phuket','banana boat Patong','water sports Kata Beach',
    'airport transfer Phuket','taxi service Phuket','private driver Phuket','tuk tuk Phuket',
    'breakfast Phuket Old Town','dessert cafe Phuket','pharmacy Patong','convenience store Patong'
  ];
  const out = [];
  for (const textQuery of QUERIES){
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'X-Goog-Api-Key':KEY,
        'X-Goog-FieldMask':'places.displayName,places.rating,places.userRatingCount,places.location,places.formattedAddress,places.primaryTypeDisplayName,places.nationalPhoneNumber,places.websiteUri' },
      body: JSON.stringify({ textQuery, maxResultCount:20 }) });
    if(!res.ok){ console.log('  ! Places error', res.status, 'on "'+textQuery+'"'); continue; }
    const j = await res.json();
    for (const p of j.places||[]){
      const name = p.displayName?.text; if(!name) continue;
      out.push({ name, category: p.primaryTypeDisplayName?.text || 'Business',
        area: areaFor(p.location?.latitude||7.9, p.location?.longitude||98.35),
        lat:+(p.location?.latitude||0).toFixed(5), lng:+(p.location?.longitude||0).toFixed(5),
        google_rating: p.rating||null, google_reviews: p.userRatingCount||0,
        address: p.formattedAddress||null, phone: p.nationalPhoneNumber||null,
        website: p.websiteUri||null, source:'google_places', status:'unclaimed' });
    }
    console.log('  ✓', textQuery, '→', (j.places||[]).length);
  }
  return out;
}

const osm = await fromOSM();
const goog = await fromGoogle();
const byName = new Map(osm.map(b=>[norm(b.name), b]));
let enriched=0, added=0;
for (const g of goog){
  const hit = byName.get(norm(g.name));
  if(hit){ hit.google_rating=g.google_rating; hit.google_reviews=g.google_reviews;
    hit.address=g.address||hit.address; hit.phone=hit.phone||g.phone; hit.website=hit.website||g.website; enriched++; }
  else { byName.set(norm(g.name), g); added++; }
}
const businesses = [...byName.values()]
  .sort((a,b)=>(b.google_reviews||0)-(a.google_reviews||0) || a.name.localeCompare(b.name));

// per-category + per-area summary
const cat={}, area={};
for(const b of businesses){ cat[b.category]=(cat[b.category]||0)+1; area[b.area]=(area[b.area]||0)+1; }
console.log('\nBy category:'); Object.entries(cat).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log('  '+String(v).padStart(5), k));
console.log('By area:');     Object.entries(area).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log('  '+String(v).padStart(5), k));

// 1 · console dataset (public)
mkdirSync('public/console', { recursive:true });
writeFileSync('public/console/directory.json', JSON.stringify({
  generated: new Date().toISOString(),
  sources: ['OpenStreetMap (Overpass, ODbL)', KEY?'Google Places API (New)':'Google Places: not run yet'],
  count: businesses.length, businesses }, null, 1));

// 2 · ground-team verification sheet (LOCAL ONLY — not in public/, never deployed)
const esc = v => v==null?'':/[",\n]/.test(String(v))?'"'+String(v).replace(/"/g,'""')+'"':String(v);
const cols = ['name','name_th','category','area','phone','website','address','hours','google_rating','google_reviews','lat','lng','source',
  'VERIFIED (Y/N)','CORRECT PHONE','OWNER NAME','LINE ID','WANTS TO JOIN (Y/N)','NOTES'];
const rows = businesses.map(b=>[b.name,b.name_th,b.category,b.area,b.phone,b.website,b.address,b.hours,
  b.google_rating,b.google_reviews,b.lat,b.lng,b.source,'','','','','',''].map(esc).join(','));
writeFileSync('verification_sheet.csv', '﻿'+cols.join(',')+'\n'+rows.join('\n'));

console.log(`\n✅ public/console/directory.json — ${businesses.length} businesses (console + map auto-load it)`
  + (KEY?`\n   Google: ${enriched} enriched + ${added} added`:'' )
  + `\n✅ verification_sheet.csv — the ground team's worksheet (opens in Excel/Google Sheets, Thai names intact)`
  + `\nNext: npx wrangler@latest deploy`);
