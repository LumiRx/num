/**
 * add-capture-tag.mjs — put the num-capture.js tag in a page's <head>, once.
 *
 *   node add-capture-tag.mjs public/index.html landing
 *
 * Idempotent: if the tag is already there it says so and changes nothing, so
 * re-running the deploy script cannot stack up three copies of the script.
 *
 * No pixel attributes. Without them num-capture.js logs arrivals server-side,
 * carries referral codes between pages, wires up capture forms — and shows no
 * cookie banner, because with nothing to load there is nothing to ask about.
 * A banner on a page that sets no cookies just teaches people to click banners
 * away. When the Meta and Google IDs arrive, add data-meta-pixel and
 * data-google-ads here and the banner appears by itself.
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";

const [file, page] = process.argv.slice(2);
if (!file || !page) {
  console.error("usage: node add-capture-tag.mjs <html-file> <data-page-value>");
  process.exit(2);
}

const html = readFileSync(file, "utf8");

if (html.includes("num-capture.js")) {
  console.log(`  ok  ${file} already loads num-capture.js — unchanged`);
  process.exit(0);
}

const tag = `<script src="/num-capture.js" data-page="${page}" defer></script>`;

// Anchor on the last thing in the head rather than on </head> itself, so the
// tag lands after the stylesheet and before anything a template might append.
let out;
const anchor = /(<link rel="stylesheet" href="assets\/site\.css">)/;
if (anchor.test(html)) {
  out = html.replace(anchor, `$1\n${tag}`);
} else if (html.includes("</head>")) {
  out = html.replace("</head>", `${tag}\n</head>`);
} else {
  console.error(`  !!  ${file} has no </head> — not touching it`);
  process.exit(1);
}

copyFileSync(file, `${file}.bak`);
writeFileSync(file, out, "utf8");
console.log(`  ok  ${file} now loads num-capture.js (data-page="${page}"), backup at ${file}.bak`);
