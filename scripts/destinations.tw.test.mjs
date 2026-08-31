import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DESTINATIONS } from './destinations.mjs';
import { COVER, gridFor } from './coverplan.mjs';
import { assignDest, boxArea, distKm, inBox } from './osmplace.mjs';

const TW = DESTINATIONS.filter((d) => d.country === 'TW');

test('Taiwan has destinations for the whole island, not just the cities', () => {
  const slugs = new Set(TW.map((d) => d.slug));
  // The 22 administrative divisions people actually name, plus the offshore
  // county groups. A traveller in Douliu says "Yunlin", not "near Taichung".
  for (const s of ['taipei', 'new-taipei', 'taoyuan', 'taichung', 'tainan', 'kaohsiung',
    'keelung', 'hsinchu', 'chiayi', 'changhua', 'yunlin', 'nantou', 'miaoli',
    'yilan', 'hualien', 'taitung', 'pingtung', 'penghu', 'kinmen', 'matsu']) {
    assert.ok(slugs.has(s), `missing Taiwan destination: ${s}`);
  }
  assert.ok(TW.length >= 24, `only ${TW.length} Taiwan destinations`);
});

test('every Taiwan destination is well formed', () => {
  const seen = new Set();
  for (const d of TW) {
    assert.ok(!seen.has(d.slug), `duplicate slug ${d.slug}`);
    seen.add(d.slug);
    assert.equal(d.tz, 'Asia/Taipei', `${d.slug} has the wrong timezone`);
    assert.equal(d.region, 'Asia');
    assert.equal(d.bbox.length, 4);
    assert.ok(d.bbox[2] > d.bbox[0] && d.bbox[3] > d.bbox[1], `${d.slug} bbox is inside out`);
    assert.ok(inBox(d.lat, d.lng, d.bbox), `${d.slug}'s own centre is outside its box`);
  }
});

test('no Taiwan box reaches into the South China Sea', () => {
  // Kaohsiung municipality administers Pratas and Taiping, 1,300km out.
  // Ingesting its official envelope would pull in open ocean and disputed
  // features. Every box here is an urban or county core.
  for (const d of TW) {
    assert.ok(d.bbox[0] > 21.0, `${d.slug} reaches south of 21°N`);
    assert.ok(d.bbox[1] > 117.5, `${d.slug} reaches west of 117.5°E`);
    assert.ok(boxArea(d.bbox) < 1.2, `${d.slug}'s box is ${boxArea(d.bbox).toFixed(2)}° — too coarse to mean anything`);
  }
});

test('every square of the island cover finds a home', () => {
  // This is what "island-wide" has to mean: not that every point sits inside
  // a rectangle somebody drew, but that no point is dropped on the floor.
  for (const t of gridFor('TW', 0.25)) {
    const lat = (t.bbox[0] + t.bbox[2]) / 2;
    const lng = (t.bbox[1] + t.bbox[3]) / 2;
    const d = assignDest(lat, lng, TW);
    assert.ok(d, `no destination for tile ${t.bbox.join(',')}`);
    assert.equal(d.country, 'TW');
  }
});

test('every real place on the island lands where a traveller would say it is', () => {
  // The grid covers sea as well as land — a square in the middle of the
  // Taiwan Strait is assigned to whichever coast is nearest and then returns
  // nothing, which is fine. What matters is the places that exist.
  const at = (lat, lng) => assignDest(lat, lng, TW);
  const spots = [
    ['Taipei 101', 25.0339, 121.5645, 'taipei'],
    ['Banqiao', 25.0143, 121.4670, 'new-taipei'],
    ['Taoyuan station', 24.9890, 121.3140, 'taoyuan'],
    ['Hsinchu station', 24.8018, 120.9718, 'hsinchu'],
    ['Keelung harbour', 25.1315, 121.7391, 'keelung'],
    ['Yilan city', 24.7570, 121.7530, 'yilan'],
    ['Taichung station', 24.1369, 120.6869, 'taichung'],
    ['Douliu', 23.7075, 120.5439, 'yunlin'],
    ['Tainan', 22.9908, 120.2019, 'tainan'],
    ['Kaohsiung station', 22.6396, 120.3021, 'kaohsiung'],
    ['Hengchun', 21.9980, 120.7440, 'kenting'],
    ['Magong', 23.5654, 119.5794, 'penghu'],
    ['Kinmen', 24.4368, 118.3171, 'kinmen'],
    ['Nangan', 26.1520, 119.9390, 'matsu'],
    ['Orchid Island', 22.0490, 121.5410, 'lanyu'],
    ['Green Island', 22.6610, 121.4870, 'green-island'],
    ['Taroko Gorge', 24.1580, 121.4900, 'taroko'],
    ['Fugui Cape', 25.2980, 121.5370, 'new-taipei'],
  ];
  for (const [name, lat, lng, slug] of spots) {
    const d = at(lat, lng);
    assert.equal(d.slug, slug, `${name} was assigned to ${d.slug}`);
    assert.ok(distKm(lat, lng, d.lat, d.lng) < 40, `${name} is ${distKm(lat, lng, d.lat, d.lng).toFixed(0)}km from ${d.slug}`);
  }
});

test('the cities people name beat the counties that contain them', () => {
  const at = (lat, lng) => assignDest(lat, lng, TW).slug;
  assert.equal(at(25.0330, 121.5654), 'taipei', 'Taipei 101');
  assert.equal(at(22.6396, 120.3021), 'kaohsiung', 'Kaohsiung station');
  assert.equal(at(22.9908, 120.2019), 'tainan', 'central Tainan');
  assert.equal(at(24.1477, 120.6736), 'taichung', 'Taichung station');
});

test('the offshore counties are their own destinations, not the nearest city', () => {
  const at = (lat, lng) => assignDest(lat, lng, TW).slug;
  assert.equal(at(23.5654, 119.5794), 'penghu', 'Magong');
  assert.equal(at(24.4368, 118.3171), 'kinmen', 'Kinmen');
  assert.equal(at(26.1608, 119.9497), 'matsu', 'Nangan');
});

test('the cover and the destinations describe the same island', () => {
  for (const d of TW) {
    const c = COVER.TW.find((box) => inBox(d.lat, d.lng, box.bbox));
    assert.ok(c, `${d.slug} sits outside every cover box — it would never be walked`);
  }
});
