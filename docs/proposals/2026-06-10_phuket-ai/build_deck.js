// NuM × Phuket AI — Partnership Proposal Deck
// June 2026 — Dre / Lumi
// Palette: NuM "Ocean Concierge" — deep midnight + signal teal + warm sand accent
// Style: dark premium, never McKinsey, never tropical-corporate-cliche

const pptxgen = require("/tmp/node_modules/pptxgenjs");
const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.3 × 7.5
pres.author = "Dre / Lumi";
pres.title = "NuM × Phuket AI — Partnership Proposal";

// ---------- palette ----------
const C = {
  bgDark:    "0A1628", // deep midnight (cover, section breaks)
  bgPanel:   "11203A", // panel card on dark
  bgLight:   "FFFFFF", // light content slides
  bgSoft:    "F4F1EC", // warm sand panel on light
  ink:       "0A1628", // body ink on light
  inkMuted:  "5A6B82", // captions
  inkInv:    "FFFFFF", // text on dark
  inkInvMu:  "9FB2CE", // muted text on dark
  teal:      "00B5A5", // signal teal (NuM accent)
  tealDark:  "067A70",
  sand:      "E9B872", // warm sand accent
  coral:     "E36F5A", // alert / risk color (used sparingly)
  rule:      "1E3258", // hairline rule on dark
  ruleLite:  "E4E7EB"  // hairline rule on light
};

const F = {
  display: "Georgia",
  body:    "Calibri",
  mono:    "Consolas"
};

// ---------- helpers ----------
const addPageNumber = (slide, n, total, themeDark = false) => {
  slide.addText(`${n.toString().padStart(2, "0")} / ${total.toString().padStart(2, "0")}`, {
    x: 12.0, y: 7.05, w: 1.0, h: 0.3,
    fontSize: 9, fontFace: F.body, color: themeDark ? C.inkInvMu : C.inkMuted,
    align: "right", charSpacing: 2
  });
  slide.addText("NUM × PHUKET AI", {
    x: 0.5, y: 7.05, w: 4.0, h: 0.3,
    fontSize: 9, fontFace: F.body, color: themeDark ? C.inkInvMu : C.inkMuted,
    align: "left", charSpacing: 4
  });
};

const addHairline = (slide, x, y, w, color) => {
  slide.addShape(pres.shapes.RECTANGLE, {
    x, y, w, h: 0.012, fill: { color }, line: { type: "none" }
  });
};

// ============================================================
// SLIDE 1 — COVER
// ============================================================
const TOTAL = 13;
{
  const s = pres.addSlide();
  s.background = { color: C.bgDark };

  // mark stamp top left
  s.addText("NuM", {
    x: 0.6, y: 0.5, w: 2, h: 0.6,
    fontSize: 28, fontFace: F.display, bold: true, italic: true,
    color: C.teal, charSpacing: 4
  });

  // small caps marker
  s.addText("PERSONAL CONCIERGE · LUMI", {
    x: 0.6, y: 1.05, w: 5, h: 0.3,
    fontSize: 9, fontFace: F.body, color: C.inkInvMu, charSpacing: 6
  });

  // big intersection title — slightly off-center, premium
  s.addText("A partnership for", {
    x: 0.6, y: 2.4, w: 12, h: 0.6,
    fontSize: 22, fontFace: F.display, italic: true, color: C.sand
  });
  s.addText("the 18 million.", {
    x: 0.6, y: 3.0, w: 12, h: 1.5,
    fontSize: 72, fontFace: F.display, bold: true, color: C.inkInv,
    charSpacing: -1
  });

  // subtitle line
  s.addText("NuM × Phuket AI  —  Partnership Proposal", {
    x: 0.6, y: 4.6, w: 12, h: 0.5,
    fontSize: 18, fontFace: F.body, color: C.inkInv
  });

  // bottom rule + meta
  addHairline(s, 0.6, 6.5, 12.1, C.rule);
  s.addText("Prepared for the Phuket AI team", {
    x: 0.6, y: 6.6, w: 8, h: 0.3,
    fontSize: 11, fontFace: F.body, color: C.inkInvMu, charSpacing: 2
  });
  s.addText("Dre · Lumi · June 2026", {
    x: 8.6, y: 6.6, w: 4.1, h: 0.3,
    fontSize: 11, fontFace: F.body, color: C.inkInvMu, align: "right", charSpacing: 2
  });

  // tiny accent dot bottom-right (motif: teal dot recurs)
  s.addShape(pres.shapes.OVAL, {
    x: 12.55, y: 0.5, w: 0.15, h: 0.15, fill: { color: C.teal }, line: { type: "none" }
  });
}

// ============================================================
// SLIDE 2 — WHY NOW (their tailwind + the moment)
// ============================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bgLight };

  s.addText("Why now", {
    x: 0.6, y: 0.55, w: 6, h: 0.6,
    fontSize: 14, fontFace: F.body, color: C.teal, charSpacing: 8
  });
  s.addText("The window is short. The infrastructure decision gets made once.", {
    x: 0.6, y: 0.95, w: 12, h: 1.0,
    fontSize: 30, fontFace: F.display, bold: true, color: C.ink
  });
  addHairline(s, 0.6, 2.05, 12.1, C.ruleLite);

  // Three stat callouts
  const stats = [
    { num: "18M",   label: "projected 2025 visitors to Phuket (+20% YoY)", sub: "Tourism Authority of Thailand" },
    { num: "4.2M",  label: "from China — the top international market",     sub: "WhatsApp is not their channel" },
    { num: "200K+", label: "tourism professionals in your ecosystem",        sub: "every one is a potential merchant" }
  ];
  stats.forEach((stat, i) => {
    const x = 0.6 + i * 4.1;
    s.addText(stat.num, {
      x, y: 2.5, w: 3.7, h: 1.2,
      fontSize: 64, fontFace: F.display, bold: true, color: C.teal, charSpacing: -1
    });
    s.addText(stat.label, {
      x, y: 3.75, w: 3.7, h: 0.8,
      fontSize: 14, fontFace: F.body, color: C.ink
    });
    s.addText(stat.sub, {
      x, y: 4.55, w: 3.7, h: 0.4,
      fontSize: 10, fontFace: F.body, italic: true, color: C.inkMuted
    });
  });

  // Closing line — the move
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.6, y: 5.6, w: 12.1, h: 1.1,
    fill: { color: C.bgSoft }, line: { type: "none" }
  });
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.6, y: 5.6, w: 0.08, h: 1.1, fill: { color: C.teal }, line: { type: "none" }
  });
  s.addText([
    { text: "The AI travel layer for Phuket gets locked in over the next 12 months. ",
      options: { bold: true } },
    { text: "Your consumer brand is in market. Our engine is built. The fastest way to own this category is to stop building parallel stacks and start running on the same one." }
  ], {
    x: 0.85, y: 5.65, w: 11.7, h: 1.0,
    fontSize: 14, fontFace: F.body, color: C.ink, valign: "middle"
  });

  addPageNumber(s, 2, TOTAL);
}

// ============================================================
// SLIDE 3 — WHAT NUM IS (one slide, brand voice on)
// ============================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bgDark };

  s.addText("What NuM is", {
    x: 0.6, y: 0.55, w: 6, h: 0.6,
    fontSize: 14, fontFace: F.body, color: C.teal, charSpacing: 8
  });
  s.addText("A personal concierge. One AI per person. It remembers.", {
    x: 0.6, y: 0.95, w: 12, h: 1.0,
    fontSize: 30, fontFace: F.display, bold: true, color: C.inkInv
  });
  addHairline(s, 0.6, 2.05, 12.1, C.rule);

  // Left column — narrative
  s.addText([
    { text: "Every NuM user gets their own AI agent tied to a UUID, with an encrypted profile that learns and adapts over time. ",
      options: { breakLine: true } },
    { text: " ", options: { breakLine: true, fontSize: 6 } },
    { text: "Day 1: \"I'm vegetarian, traveling with a 7-year-old.\" ",
      options: { color: C.inkInvMu, breakLine: true } },
    { text: "Day 4: \"Find us dinner tonight.\" — NuM proposes a kid-friendly veg-friendly spot without re-asking. ",
      options: { color: C.inkInvMu, breakLine: true } },
    { text: "Month 3: User returns for a school visit. NuM remembers the kid's age and the previous shortlist. ",
      options: { color: C.inkInvMu, breakLine: true } },
    { text: " ", options: { breakLine: true, fontSize: 6 } },
    { text: "That continuity ", options: { italic: true } },
    { text: "is the product. Everything else — bookings, leads, vendor routing — is downstream." }
  ], {
    x: 0.6, y: 2.4, w: 6.8, h: 4.3,
    fontSize: 14, fontFace: F.body, color: C.inkInv,
    paraSpaceAfter: 6
  });

  // Right column — feature cards
  const features = [
    { t: "Multi-channel brain",  d: "WhatsApp · LINE · WeChat · SMS · QR — one user, one memory, every channel." },
    { t: "Encrypted profile",    d: "Field-level KMS envelope encryption on PII, passports, payment tokens. PDPA + GDPR ready." },
    { t: "Whale-lead router",    d: "Real estate, schools, relocation, visa, medical — separate qualification flow, human handoff." },
    { t: "Multi-tenant by design", d: "Every row scoped by partner_tenant_id. Tenants never see each other's data." }
  ];

  features.forEach((f, i) => {
    const y = 2.4 + i * 1.05;
    s.addShape(pres.shapes.RECTANGLE, {
      x: 7.7, y, w: 5.0, h: 0.95,
      fill: { color: C.bgPanel }, line: { type: "none" }
    });
    s.addShape(pres.shapes.RECTANGLE, {
      x: 7.7, y, w: 0.06, h: 0.95, fill: { color: C.teal }, line: { type: "none" }
    });
    s.addText(f.t, {
      x: 7.85, y: y + 0.08, w: 4.85, h: 0.35,
      fontSize: 13, fontFace: F.body, bold: true, color: C.inkInv
    });
    s.addText(f.d, {
      x: 7.85, y: y + 0.42, w: 4.85, h: 0.5,
      fontSize: 10.5, fontFace: F.body, color: C.inkInvMu
    });
  });

  addPageNumber(s, 3, TOTAL, true);
}

// ============================================================
// SLIDE 4 — THE OPPORTUNITY (where your map and our map overlap)
// ============================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bgLight };

  s.addText("Where the maps overlap", {
    x: 0.6, y: 0.55, w: 8, h: 0.6,
    fontSize: 14, fontFace: F.body, color: C.teal, charSpacing: 8
  });
  s.addText("You own the front door. We've built the rooms behind it.", {
    x: 0.6, y: 0.95, w: 12, h: 1.0,
    fontSize: 28, fontFace: F.display, bold: true, color: C.ink
  });
  addHairline(s, 0.6, 2.05, 12.1, C.ruleLite);

  // Two columns — Phuket AI vs NuM, with overlap callout
  // Left card — Phuket AI
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.6, y: 2.4, w: 5.8, h: 4.2, fill: { color: C.bgSoft }, line: { type: "none" }
  });
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.6, y: 2.4, w: 5.8, h: 0.08, fill: { color: C.sand }, line: { type: "none" }
  });
  s.addText("PHUKET AI", {
    x: 0.85, y: 2.55, w: 5.4, h: 0.35,
    fontSize: 11, fontFace: F.body, bold: true, color: C.inkMuted, charSpacing: 6
  });
  s.addText("Brand, distribution, ground truth", {
    x: 0.85, y: 2.9, w: 5.4, h: 0.5,
    fontSize: 18, fontFace: F.display, bold: true, color: C.ink
  });
  s.addText([
    { text: "Consumer brand already in market", options: { bullet: true, breakLine: true } },
    { text: "WhatsApp Business presence + QR distribution", options: { bullet: true, breakLine: true } },
    { text: "Trusted local merchant network (hotels, tours, yachts, SPA, F&B)", options: { bullet: true, breakLine: true } },
    { text: "8 verticals already taxonomized", options: { bullet: true, breakLine: true } },
    { text: "Front-of-funnel marketing in tourist channels", options: { bullet: true } }
  ], {
    x: 0.85, y: 3.55, w: 5.4, h: 2.9,
    fontSize: 12, fontFace: F.body, color: C.ink, paraSpaceAfter: 6
  });

  // Right card — NuM
  s.addShape(pres.shapes.RECTANGLE, {
    x: 6.9, y: 2.4, w: 5.8, h: 4.2, fill: { color: C.bgDark }, line: { type: "none" }
  });
  s.addShape(pres.shapes.RECTANGLE, {
    x: 6.9, y: 2.4, w: 5.8, h: 0.08, fill: { color: C.teal }, line: { type: "none" }
  });
  s.addText("NUM", {
    x: 7.15, y: 2.55, w: 5.4, h: 0.35,
    fontSize: 11, fontFace: F.body, bold: true, color: C.inkInvMu, charSpacing: 6
  });
  s.addText("Memory, depth, monetization rails", {
    x: 7.15, y: 2.9, w: 5.4, h: 0.5,
    fontSize: 18, fontFace: F.display, bold: true, color: C.inkInv
  });
  s.addText([
    { text: "Persistent per-user memory (vector + tagged)", options: { bullet: true, breakLine: true } },
    { text: "WeChat + LINE adapters for non-WhatsApp markets", options: { bullet: true, breakLine: true } },
    { text: "Encrypted PII vault — passports, payments, school docs", options: { bullet: true, breakLine: true } },
    { text: "Whale-lead routing (property, schools, relocation, visa)", options: { bullet: true, breakLine: true } },
    { text: "Multi-tenant SaaS backbone with KMS isolation", options: { bullet: true } }
  ], {
    x: 7.15, y: 3.55, w: 5.4, h: 2.9,
    fontSize: 12, fontFace: F.body, color: C.inkInv, paraSpaceAfter: 6
  });

  addPageNumber(s, 4, TOTAL);
}

// ============================================================
// SLIDE 5 — RECOMMENDED PARTNERSHIP SHAPE (the lead angle)
// ============================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bgLight };

  s.addText("Recommended shape", {
    x: 0.6, y: 0.55, w: 6, h: 0.6,
    fontSize: 14, fontFace: F.body, color: C.teal, charSpacing: 8
  });
  s.addText("Phuket AI, powered by NuM.", {
    x: 0.6, y: 0.95, w: 12, h: 1.0,
    fontSize: 36, fontFace: F.display, bold: true, color: C.ink
  });
  s.addText("Your brand. Your distribution. Your merchants. NuM is the engine underneath.", {
    x: 0.6, y: 1.85, w: 12, h: 0.5,
    fontSize: 15, fontFace: F.body, italic: true, color: C.inkMuted
  });
  addHairline(s, 0.6, 2.45, 12.1, C.ruleLite);

  // Three pillars
  const pillars = [
    {
      label: "01",
      title: "Tenant of record",
      body: "Phuket AI is provisioned as the Phuket regional tenant on the NuM platform. Your data, your KMS keys, your dashboard. Co-brand at launch — \"Phuket AI, powered by NuM\" — full white-label available at Enterprise tier."
    },
    {
      label: "02",
      title: "Channels you don't have yet",
      body: "We light up WeChat (for the 4.2M Chinese visitors who don't use WhatsApp) and LINE (for the Japanese, Korean, Thai mainland flow). One profile, every channel, same memory."
    },
    {
      label: "03",
      title: "The high-LTV layer",
      body: "Whale-lead routing for property buyers, school enrollment families, long-stay relocators. These are 70/30 in your favor — you close the deal, you bring the relationship, NuM does the qualification."
    }
  ];

  pillars.forEach((p, i) => {
    const x = 0.6 + i * 4.13;
    s.addShape(pres.shapes.RECTANGLE, {
      x, y: 2.85, w: 4.0, h: 3.95,
      fill: { color: C.bgLight }, line: { color: C.ruleLite, width: 1 }
    });
    s.addText(p.label, {
      x: x + 0.25, y: 3.0, w: 1.0, h: 0.5,
      fontSize: 28, fontFace: F.display, bold: true, color: C.teal
    });
    s.addText(p.title, {
      x: x + 0.25, y: 3.6, w: 3.5, h: 0.55,
      fontSize: 17, fontFace: F.display, bold: true, color: C.ink
    });
    s.addText(p.body, {
      x: x + 0.25, y: 4.25, w: 3.5, h: 2.4,
      fontSize: 11.5, fontFace: F.body, color: C.ink, paraSpaceAfter: 4
    });
  });

  addPageNumber(s, 5, TOTAL);
}

// ============================================================
// SLIDE 6 — WHAT EACH SIDE BRINGS (table)
// ============================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bgLight };

  s.addText("Who brings what", {
    x: 0.6, y: 0.55, w: 6, h: 0.6,
    fontSize: 14, fontFace: F.body, color: C.teal, charSpacing: 8
  });
  s.addText("Crisp boundaries. No overlap. No turf.", {
    x: 0.6, y: 0.95, w: 12, h: 1.0,
    fontSize: 28, fontFace: F.display, bold: true, color: C.ink
  });
  addHairline(s, 0.6, 2.05, 12.1, C.ruleLite);

  // Custom 3-column responsibility table
  const rows = [
    ["Workstream",                          "Phuket AI",                              "NuM (Lumi)"],
    ["Consumer brand · marketing",          "Lead",                                   "Co-brand only"],
    ["Merchant relationships · onboarding", "Lead — bring your network",              "Schema + admin tool"],
    ["WhatsApp channel",                    "Existing setup + number",                "Adapter into NuM gateway"],
    ["WeChat · LINE channels",              "Local language QA",                      "Build + maintain adapters"],
    ["AI brain · memory · prompts",         "Voice / tone input",                     "Lead"],
    ["Encrypted profile + PDPA compliance", "Local counsel review",                   "Lead — KMS, audit, scrubber"],
    ["Whale leads (RE, schools, relocation)", "Close the deal · own the relationship", "Qualify, route, score"],
    ["Analytics dashboard",                 "Use it · feed back",                     "Build + host"],
    ["Customer escalations",                "Human responder during hours",           "Auto-escalation logic + SLA"]
  ];

  // Render manually for full control
  const colX = [0.6, 5.0, 8.85];
  const colW = [4.4, 3.85, 3.85];
  const headerY = 2.4;
  const rowH = 0.4;

  // Header row
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.6, y: headerY, w: 12.1, h: rowH,
    fill: { color: C.bgDark }, line: { type: "none" }
  });
  rows[0].forEach((cell, i) => {
    s.addText(cell, {
      x: colX[i] + 0.1, y: headerY + 0.05, w: colW[i] - 0.2, h: rowH - 0.1,
      fontSize: 11, fontFace: F.body, bold: true, color: C.inkInv, charSpacing: 3,
      valign: "middle"
    });
  });

  // Data rows
  for (let r = 1; r < rows.length; r++) {
    const y = headerY + rowH + (r - 1) * rowH;
    if (r % 2 === 1) {
      s.addShape(pres.shapes.RECTANGLE, {
        x: 0.6, y, w: 12.1, h: rowH,
        fill: { color: C.bgSoft }, line: { type: "none" }
      });
    }
    rows[r].forEach((cell, i) => {
      s.addText(cell, {
        x: colX[i] + 0.1, y: y + 0.05, w: colW[i] - 0.2, h: rowH - 0.1,
        fontSize: 11, fontFace: F.body, color: C.ink, valign: "middle"
      });
    });
  }

  addPageNumber(s, 6, TOTAL);
}

// ============================================================
// SLIDE 7 — THE SHAPE OF THE DEAL (commercials, directional)
// ============================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bgDark };

  s.addText("Shape of the deal", {
    x: 0.6, y: 0.55, w: 6, h: 0.6,
    fontSize: 14, fontFace: F.body, color: C.teal, charSpacing: 8
  });
  s.addText("Aligned during the pilot. Generous through the partnership.", {
    x: 0.6, y: 0.95, w: 12, h: 1.0,
    fontSize: 28, fontFace: F.display, bold: true, color: C.inkInv
  });
  addHairline(s, 0.6, 2.05, 12.1, C.rule);

  // Two stacked sections: Pilot (Month 1) vs Pro (Month 2+)
  // Pilot section
  s.addText("PILOT  —  MONTH 1", {
    x: 0.6, y: 2.35, w: 6, h: 0.4,
    fontSize: 11, fontFace: F.body, bold: true, color: C.sand, charSpacing: 6
  });

  const pilotRows = [
    ["Platform fee",                "Waived — NuM absorbs ~[TBD: $2–3k] infra during pilot"],
    ["Booking commissions split",   "50 / 50  ·  NuM / Phuket AI"],
    ["Whale-lead split",            "30 / 70  ·  NuM / Phuket AI  (you close the deal)"],
    ["Merchant featured-listing",   "40 / 60  ·  NuM / Phuket AI  (your network)"],
    ["Data ownership",              "User data stays with the user. You get aggregated, anonymized analytics."]
  ];

  pilotRows.forEach((r, i) => {
    const y = 2.85 + i * 0.36;
    s.addText(r[0], {
      x: 0.6, y, w: 4.0, h: 0.35,
      fontSize: 11.5, fontFace: F.body, color: C.inkInvMu, valign: "middle"
    });
    s.addText(r[1], {
      x: 4.7, y, w: 8.0, h: 0.35,
      fontSize: 11.5, fontFace: F.body, color: C.inkInv, valign: "middle"
    });
  });

  // Pro section
  s.addText("PRO  —  MONTH 2 ONWARDS  (if pilot KPIs hit)", {
    x: 0.6, y: 4.95, w: 8, h: 0.4,
    fontSize: 11, fontFace: F.body, bold: true, color: C.teal, charSpacing: 6
  });

  const proRows = [
    ["Setup fee",                   "[TBD: $5,000] one-time at signing"],
    ["Platform fee",                "[TBD: $2,500/mo] base + $0.04 per conversation above 5,000/mo"],
    ["Booking commissions split",   "35 / 65  ·  NuM / Phuket AI"],
    ["Whale-lead split",            "25 / 75  ·  NuM / Phuket AI"],
    ["Territory + exclusivity",     "Phuket island, optional exclusivity add-on (+30%) at Pro tier"]
  ];

  proRows.forEach((r, i) => {
    const y = 5.45 + i * 0.32;
    s.addText(r[0], {
      x: 0.6, y, w: 4.0, h: 0.3,
      fontSize: 11.5, fontFace: F.body, color: C.inkInvMu, valign: "middle"
    });
    s.addText(r[1], {
      x: 4.7, y, w: 8.0, h: 0.3,
      fontSize: 11.5, fontFace: F.body, color: C.inkInv, valign: "middle"
    });
  });

  addPageNumber(s, 7, TOTAL, true);
}

// ============================================================
// SLIDE 8 — ROADMAP (90 / 180 / 365)
// ============================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bgLight };

  s.addText("Roadmap", {
    x: 0.6, y: 0.55, w: 6, h: 0.6,
    fontSize: 14, fontFace: F.body, color: C.teal, charSpacing: 8
  });
  s.addText("Start small. Prove fast. Compound.", {
    x: 0.6, y: 0.95, w: 12, h: 1.0,
    fontSize: 28, fontFace: F.display, bold: true, color: C.ink
  });
  addHairline(s, 0.6, 2.05, 12.1, C.ruleLite);

  // 3-phase horizontal timeline
  const phases = [
    {
      tag: "90 DAYS",
      title: "China wedge + pilot proof",
      body: [
        "WeChat Service Account live — Phuket AI now reaches the 4.2M Chinese visitors WhatsApp can't.",
        "NuM persistent memory live behind your WhatsApp number — users stop repeating themselves.",
        "Whale-lead routing on for Property + International Schools verticals.",
        "Joint KPI dashboard. Weekly review."
      ]
    },
    {
      tag: "180 DAYS",
      title: "Full multi-channel + premium tier",
      body: [
        "LINE channel live (JP/KR/TH mainland).",
        "Phuket AI Premium tier launched — concierge SLA, no featured-listing bias, family-share.",
        "60+ merchants onboarded into the NuM vendor schema.",
        "First real-estate close attributed to the partnership."
      ]
    },
    {
      tag: "365 DAYS",
      title: "Territory lock + adjacent markets",
      body: [
        "Pro → Enterprise tier; territory exclusivity earned via MAU thresholds.",
        "Anonymized aggregate intelligence report — sellable to TAT, hotel groups, DMOs.",
        "Joint expansion plan: Bali, Bangkok, Koh Samui under the same engine.",
        "Renegotiate splits with proven traction."
      ]
    }
  ];

  phases.forEach((p, i) => {
    const x = 0.6 + i * 4.13;
    // Card background
    s.addShape(pres.shapes.RECTANGLE, {
      x, y: 2.4, w: 4.0, h: 4.4,
      fill: { color: C.bgSoft }, line: { type: "none" }
    });
    s.addShape(pres.shapes.RECTANGLE, {
      x, y: 2.4, w: 4.0, h: 0.07, fill: { color: C.teal }, line: { type: "none" }
    });
    s.addText(p.tag, {
      x: x + 0.25, y: 2.55, w: 3.5, h: 0.35,
      fontSize: 11, fontFace: F.body, bold: true, color: C.tealDark, charSpacing: 6
    });
    s.addText(p.title, {
      x: x + 0.25, y: 2.9, w: 3.5, h: 0.8,
      fontSize: 17, fontFace: F.display, bold: true, color: C.ink
    });
    s.addText(p.body.map((line, idx) => ({
      text: line, options: { bullet: true, breakLine: idx < p.body.length - 1 }
    })), {
      x: x + 0.25, y: 3.85, w: 3.55, h: 2.85,
      fontSize: 10.5, fontFace: F.body, color: C.ink, paraSpaceAfter: 4
    });
  });

  addPageNumber(s, 8, TOTAL);
}

// ============================================================
// SLIDE 9 — RISKS + HOW WE HANDLE THEM
// ============================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bgLight };

  s.addText("Risks, called early", {
    x: 0.6, y: 0.55, w: 6, h: 0.6,
    fontSize: 14, fontFace: F.body, color: C.teal, charSpacing: 8
  });
  s.addText("Every risk we see. How we handle each.", {
    x: 0.6, y: 0.95, w: 12, h: 1.0,
    fontSize: 28, fontFace: F.display, bold: true, color: C.ink
  });
  addHairline(s, 0.6, 2.05, 12.1, C.ruleLite);

  const risks = [
    { r: "Brand confusion",
      h: "We co-brand at launch (\"Phuket AI, powered by NuM\") and run a 30-day messaging review with your team before any user-visible change. Phuket AI stays the consumer brand. Always." },
    { r: "Migration risk on your existing stack",
      h: "We do not rip-and-replace. Phase 1 is an extension behind your existing WhatsApp number — your users see no change until persistent memory kicks in and recommendations get sharper." },
    { r: "Content quality on day one",
      h: "The AI is only as good as the merchant data. We invest the first 10 days of the pilot on real vendor content — current hours, real photos, honest segment notes. Funnel without product = chatbot. We don't ship that." },
    { r: "PDPA / data residency",
      h: "Supabase ap-southeast-1 (Singapore). Field-level KMS encryption on PII. WeChat traffic logically separated. Local counsel review on every consent string." },
    { r: "Whale-lead handoff quality",
      h: "Auto-escalation to a named human on your side with same-day SLA. Lead scoring (A/B/C) so your team isn't drowning in low-quality requests. Status tracking back into the AI so users don't get re-asked." }
  ];

  risks.forEach((rk, i) => {
    const y = 2.35 + i * 0.86;
    s.addShape(pres.shapes.RECTANGLE, {
      x: 0.6, y, w: 12.1, h: 0.78,
      fill: { color: C.bgSoft }, line: { type: "none" }
    });
    s.addShape(pres.shapes.RECTANGLE, {
      x: 0.6, y, w: 0.07, h: 0.78, fill: { color: C.coral }, line: { type: "none" }
    });
    s.addText(rk.r, {
      x: 0.85, y: y + 0.08, w: 3.5, h: 0.65,
      fontSize: 13, fontFace: F.body, bold: true, color: C.ink, valign: "middle"
    });
    s.addText(rk.h, {
      x: 4.45, y: y + 0.08, w: 8.1, h: 0.65,
      fontSize: 11, fontFace: F.body, color: C.ink, valign: "middle"
    });
  });

  addPageNumber(s, 9, TOTAL);
}

// ============================================================
// SLIDE 10 — THE ASKS (next 3 specific moves)
// ============================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bgDark };

  s.addText("Three specific asks", {
    x: 0.6, y: 0.55, w: 6, h: 0.6,
    fontSize: 14, fontFace: F.body, color: C.teal, charSpacing: 8
  });
  s.addText("What we need from you to move this in the next two weeks.", {
    x: 0.6, y: 0.95, w: 12, h: 1.0,
    fontSize: 28, fontFace: F.display, bold: true, color: C.inkInv
  });
  addHairline(s, 0.6, 2.05, 12.1, C.rule);

  const asks = [
    { n: "01",
      t: "A 45-minute scoping call with your tech lead",
      d: "We want to understand what's running under the hood today — your LLM, your WhatsApp setup, where state lives. We share our architecture in detail. Honest constraints, no NDAs at this stage." },
    { n: "02",
      t: "Mutual NDA + a named partnership lead on each side",
      d: "We'll send a clean two-page NDA. From our side: Dre. From yours: [TBD: name + role]. One thread, one decision-maker, no committee." },
    { n: "03",
      t: "30-day China-wedge pilot scope",
      d: "Cheapest, fastest test of the partnership: WeChat Service Account live behind your brand, NuM memory layer on. If it converts Chinese traffic that WhatsApp can't reach, we have our answer." }
  ];

  asks.forEach((a, i) => {
    const y = 2.5 + i * 1.45;
    // Number — wide enough box, smaller font, no margin so it nests against title
    s.addText(a.n, {
      x: 0.6, y, w: 1.8, h: 1.3,
      fontSize: 44, fontFace: F.display, bold: true, color: C.teal,
      valign: "top", margin: 0
    });
    // Title
    s.addText(a.t, {
      x: 2.2, y: y + 0.1, w: 10.5, h: 0.5,
      fontSize: 18, fontFace: F.display, bold: true, color: C.inkInv
    });
    // Description
    s.addText(a.d, {
      x: 2.2, y: y + 0.65, w: 10.5, h: 0.7,
      fontSize: 12, fontFace: F.body, color: C.inkInvMu
    });
  });

  addPageNumber(s, 10, TOTAL, true);
}

// ============================================================
// SLIDE 11 — CLOSING / CONTACTS
// ============================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bgDark };

  // Big closing line
  s.addText("Closing", {
    x: 0.6, y: 0.55, w: 6, h: 0.6,
    fontSize: 14, fontFace: F.body, color: C.teal, charSpacing: 8
  });

  s.addText("You bring the front door.", {
    x: 0.6, y: 1.5, w: 12, h: 0.8,
    fontSize: 36, fontFace: F.display, color: C.inkInvMu, italic: true
  });
  s.addText("We bring the memory.", {
    x: 0.6, y: 2.3, w: 12, h: 0.8,
    fontSize: 36, fontFace: F.display, color: C.inkInvMu, italic: true
  });
  s.addText("Phuket gets the AI it deserves.", {
    x: 0.6, y: 3.1, w: 12, h: 1.0,
    fontSize: 44, fontFace: F.display, bold: true, color: C.inkInv
  });

  // Contacts block
  addHairline(s, 0.6, 5.4, 12.1, C.rule);

  s.addText("FROM NUM / LUMI", {
    x: 0.6, y: 5.6, w: 5, h: 0.3,
    fontSize: 10, fontFace: F.body, bold: true, color: C.teal, charSpacing: 6
  });
  s.addText("Dre", {
    x: 0.6, y: 5.9, w: 5, h: 0.45,
    fontSize: 22, fontFace: F.display, bold: true, color: C.inkInv
  });
  s.addText("CEO, Lumi  ·  andre@thatislumi.com", {
    x: 0.6, y: 6.35, w: 6, h: 0.35,
    fontSize: 12, fontFace: F.body, color: C.inkInvMu
  });

  s.addText("FROM PHUKET AI", {
    x: 7.2, y: 5.6, w: 5, h: 0.3,
    fontSize: 10, fontFace: F.body, bold: true, color: C.teal, charSpacing: 6
  });
  s.addText("[TBD: partnership lead]", {
    x: 7.2, y: 5.9, w: 5.5, h: 0.45,
    fontSize: 22, fontFace: F.display, bold: true, color: C.inkInv
  });
  s.addText("[TBD: role · email]", {
    x: 7.2, y: 6.35, w: 5.5, h: 0.35,
    fontSize: 12, fontFace: F.body, color: C.inkInvMu
  });

  addPageNumber(s, 11, TOTAL, true);
}

// ============================================================
// SLIDE 12 — APPENDIX: ALTERNATIVE SHAPES
// ============================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bgLight };

  s.addText("Appendix · alternative shapes", {
    x: 0.6, y: 0.55, w: 8, h: 0.6,
    fontSize: 14, fontFace: F.body, color: C.teal, charSpacing: 8
  });
  s.addText("Two structures we considered. Here's why we didn't lead with them.", {
    x: 0.6, y: 0.95, w: 12, h: 1.0,
    fontSize: 24, fontFace: F.display, bold: true, color: C.ink
  });
  addHairline(s, 0.6, 2.05, 12.1, C.ruleLite);

  const alts = [
    {
      label: "ALT A",
      title: "Joint premium-vertical attack only",
      pros: "Lowest integration risk. Clean handoff line — general queries stay on Phuket AI's bot; relocation / property / school escalate to NuM Concierge.",
      cons: "Smaller initial volume. Two AIs in one user journey = operational complexity. Doesn't solve the WhatsApp-only / China-market gap.",
      verdict: "Good fallback. Worth piloting as part of the bigger shape, not as the headline."
    },
    {
      label: "ALT B",
      title: "China wedge first, broader integration later",
      pros: "Fastest test (4–6 weeks once Service Account is sorted). Limited scope = limited risk. Solves a concrete gap (4.2M Chinese visitors / no WhatsApp).",
      cons: "Smaller share for NuM if it's the only thing we do. Leaves the persistent-memory upside on the table.",
      verdict: "We folded this into the 90-day phase of the recommended shape — it's the proof point, not the whole partnership."
    }
  ];

  alts.forEach((a, i) => {
    const y = 2.4 + i * 2.25;
    s.addShape(pres.shapes.RECTANGLE, {
      x: 0.6, y, w: 12.1, h: 2.0,
      fill: { color: C.bgSoft }, line: { type: "none" }
    });
    s.addShape(pres.shapes.RECTANGLE, {
      x: 0.6, y, w: 0.07, h: 2.0, fill: { color: C.sand }, line: { type: "none" }
    });
    s.addText(a.label, {
      x: 0.85, y: y + 0.15, w: 1.3, h: 0.3,
      fontSize: 10, fontFace: F.body, bold: true, color: C.inkMuted, charSpacing: 6
    });
    s.addText(a.title, {
      x: 0.85, y: y + 0.45, w: 11.5, h: 0.45,
      fontSize: 17, fontFace: F.display, bold: true, color: C.ink
    });
    s.addText([
      { text: "Pros: ", options: { bold: true } }, { text: a.pros, options: { breakLine: true } },
      { text: "Cons: ", options: { bold: true } }, { text: a.cons, options: { breakLine: true } },
      { text: "Why not lead with it: ", options: { bold: true, italic: true, color: C.tealDark } },
      { text: a.verdict, options: { italic: true, color: C.tealDark } }
    ], {
      x: 0.85, y: y + 0.95, w: 11.6, h: 1.0,
      fontSize: 10.5, fontFace: F.body, color: C.ink, paraSpaceAfter: 2
    });
  });

  addPageNumber(s, 12, TOTAL);
}

// ============================================================
// SLIDE 13 — APPENDIX: ARCHITECTURE SKETCH
// ============================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bgLight };

  s.addText("Appendix · integration sketch", {
    x: 0.6, y: 0.55, w: 8, h: 0.6,
    fontSize: 14, fontFace: F.body, color: C.teal, charSpacing: 8
  });
  s.addText("How Phuket AI plugs into the NuM engine.", {
    x: 0.6, y: 0.95, w: 12, h: 1.0,
    fontSize: 24, fontFace: F.display, bold: true, color: C.ink
  });
  addHairline(s, 0.6, 2.05, 12.1, C.ruleLite);

  // Logical flow as a 3-layer sketch
  // Top layer — channels
  const drawNode = (x, y, w, h, label, sub, fill, color) => {
    s.addShape(pres.shapes.RECTANGLE, {
      x, y, w, h, fill: { color: fill }, line: { color: C.ruleLite, width: 1 }
    });
    s.addText(label, {
      x: x + 0.1, y: y + 0.1, w: w - 0.2, h: h - 0.5,
      fontSize: 13, fontFace: F.body, bold: true, color, align: "center", valign: "middle"
    });
    if (sub) {
      s.addText(sub, {
        x: x + 0.1, y: y + h - 0.45, w: w - 0.2, h: 0.4,
        fontSize: 9, fontFace: F.body, color: color === C.inkInv ? C.inkInvMu : C.inkMuted, align: "center"
      });
    }
  };

  // Channels (top row)
  s.addText("YOUR USERS  —  ACROSS EVERY CHANNEL", {
    x: 0.6, y: 2.35, w: 12.1, h: 0.3,
    fontSize: 10, fontFace: F.body, bold: true, color: C.inkMuted, charSpacing: 6, align: "center"
  });
  drawNode(0.8,  2.75, 2.2, 0.9, "WhatsApp", "Phuket AI today", C.bgSoft, C.ink);
  drawNode(3.4,  2.75, 2.2, 0.9, "WeChat", "China — 4.2M / yr", C.sand, C.ink);
  drawNode(6.0,  2.75, 2.2, 0.9, "LINE", "JP / KR / TH",         C.sand, C.ink);
  drawNode(8.6,  2.75, 2.2, 0.9, "SMS",            "Fallback",   C.bgSoft, C.ink);
  drawNode(11.2, 2.75, 1.8, 0.9, "Web · QR",      "Hotel lobby",  C.bgSoft, C.ink);

  // Middle — Phuket AI front, NuM gateway
  drawNode(0.8, 4.0, 12.2, 0.7, "Phuket AI  —  consumer brand, voice, marketing", null, C.bgDark, C.inkInv);

  // NuM core — bigger box
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.8, y: 4.95, w: 12.2, h: 1.85,
    fill: { color: C.bgDark }, line: { type: "none" }
  });
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.8, y: 4.95, w: 0.08, h: 1.85, fill: { color: C.teal }, line: { type: "none" }
  });
  s.addText("NUM ENGINE", {
    x: 1.0, y: 5.05, w: 4, h: 0.3,
    fontSize: 10, fontFace: F.body, bold: true, color: C.teal, charSpacing: 6
  });

  const numBlocks = [
    "Identity\n(UUID + channel merge)",
    "Intent router\n(Claude Haiku)",
    "Concierge agent\n(Claude Sonnet + tools)",
    "Memory\n(pgvector, encrypted PII)",
    "Whale-lead router\n(RE · school · visa)"
  ];

  numBlocks.forEach((b, i) => {
    const x = 1.0 + i * 2.36;
    s.addShape(pres.shapes.RECTANGLE, {
      x, y: 5.45, w: 2.2, h: 1.3,
      fill: { color: C.bgPanel }, line: { color: C.rule, width: 1 }
    });
    s.addText(b, {
      x: x + 0.05, y: 5.5, w: 2.1, h: 1.2,
      fontSize: 10, fontFace: F.body, color: C.inkInv, align: "center", valign: "middle"
    });
  });

  addPageNumber(s, 13, TOTAL);
}

// ============================================================
// WRITE
// ============================================================
pres.writeFile({ fileName: "/sessions/tender-gifted-fermat/mnt/Projects/NUM/docs/proposals/2026-06-10_phuket-ai/proposal.pptx" })
  .then(f => console.log("Wrote:", f));
