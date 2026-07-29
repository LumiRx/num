# NUM Dashboard System — Information Architecture

**Updated:** 2026-07-22 · **Supersedes** the surface map in `DASHBOARD_IA.md` (six co-equal dashboards) and the seven-role tab map in `MOBILE_UI_SPEC.md`.
**Pairs with:** `skeleton_frames.html` — the clickable wireframe of every layout below.

Three products, not seven dashboards. They differ by **who's holding the device, and what decision they're making in the next sixty seconds.**

| # | Dashboard | Who | The job | Form factor |
|---|---|---|---|---|
| 1 | **Control** | Dre + partner staff (5 role lenses) | "What needs me, and what's the state of the business?" | **Desktop-first**, mobile companion |
| 2 | **Business** | Merchants | "Did anything come in, and is my listing right?" | **Phone-only** |
| 3 | **My Trip** | Travelers | "What did NUM find for me, and what does it know?" | **Phone, no login** |

---

## 0 · The two principles that fix the current design

### Principle 1 — Organize by decision latency, not by data type

The old layout grouped panels by subject (KPIs, conversations, leads, merchants). That forces the operator to scan everything to find the one thing that's on fire. Every screen now sorts top-to-bottom by **how fast a human must act**:

| Band | Meaning | Visual treatment | Examples |
|---|---|---|---|
| **NOW** | Minutes. Money or trust is leaking. | Red/amber card, top of screen, action button on the card | SLA breach, channel down, escalation, booking request expiring |
| **TODAY** | Hours. The day's work. | Standard cards, queue lists | Whale queue, approval queue, live stream, follow-ups |
| **TREND** | Weeks. Steering, not reacting. | Charts, collapsed by default on mobile | Funnel, D7, cost/user, revenue mix |
| **RECORD** | Reference. Only when asked. | Search-first, never on the landing view | Transcripts, ledgers, audit log, closed leads |

**The rule:** if a screen's first viewport shows a TREND chart while a NOW item exists below the fold, the screen is wrong.

### Principle 2 — Navigate once, drill forever

Old pattern: tap a row → full-screen sheet → back → lose your place. Fine for a phone, wrong for a desk.

New pattern for Control: **three panes.** Rail (where I am) · List (what's there) · Context (the one I picked). Selecting a row never navigates — it fills the right pane. The operator keeps their queue position while reading a transcript, assigning a lead, approving a vendor. On mobile the context pane becomes a bottom sheet, same content.

---

## 1 · Dashboard 1 — **Control** (admin)

One console. Eight sections. Role controls *what you can see and do*, not which app you open — that ends the four-fragmented-admin-apps problem.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ▤ NUM Control      [Tenant ▾] [Today ▾]           🔍 search      ● live  │  top bar
├────────────┬──────────────────────────────┬──────────────────────────────┤
│            │                              │                              │
│  RAIL      │  LIST / BOARD                │  CONTEXT                     │
│            │                              │                              │
│ ⌘ Command  │  the work surface for the    │  detail of the selected      │
│ 💬 Convos  │  active section — queue,     │  row: transcript, lead       │
│ 🐋 Leads   │  table, or board             │  memory, merchant record,    │
│ 🏪 Supply  │                              │  with its actions            │
│ 📍 Traffic │  filters pinned to top       │                              │
│ 💰 Money   │  bulk actions on select      │  never navigates away —      │
│ 🧪 Quality │                              │  the list keeps its place    │
│ ⚙ System   │                              │                              │
│            │                              │                              │
│ ─────────  │                              │                              │
│ [role ▾]   │                              │                              │
└────────────┴──────────────────────────────┴──────────────────────────────┘
   200px              fluid, min 480px              380px, collapsible
```

### 1.1 Command — the landing screen

The only screen that answers "what needs me?" Nothing else earns the top of this page.

```
┌─ ⚠ NEEDS YOU NOW ────────────────────────────────────────┐   ← empty state is
│ 🔴 Villa lead · 26h no contact · ฿15–25M   [Assign ▸]    │     a WIN: "Nothing
│ 🟠 WeChat replies slow (p95 4.2s)          [Check ▸]     │     needs you. Here's
│ 🟠 2 merchants awaiting approval           [Review ▸]    │     the day."
└──────────────────────────────────────────────────────────┘
┌─ TODAY ──────────────────────────────────────────────────┐
│  Revenue ฿9.2k   GMV ฿41k   Cost $18   Margin 71%        │  ← 4 numbers, no more
├──────────────────────────────────────────────────────────┤
│  Scans 214 → Chats 89 (42%) → Engaged 64 (72%) → Book 12 │  ← the circuit, one line
├──────────────────────────────────────────────────────────┤
│  AI acted: 74 searches · 19 bookings · 4 leads · 2 esc.  │
└──────────────────────────────────────────────────────────┘
┌─ LIVE ───────────────────────────────┐ ┌─ TREND (7d) ────┐
│ #a4f2 WA ZH  WHALE  "villa 20M…" 2m │ │ [funnel sparkline]│
│ #7c19 LN TH  BOOK   "โต๊ะ 4 คน…"  3m │ │ [lang donut]     │
│ #e83b WA RU  TOUR   "закат…"      6m │ │ [cost curve]     │
│                          [see all ▸] │ └──────────────────┘
└──────────────────────────────────────┘
```

### 1.2 The eight sections

| Section | List pane | Context pane | Primary action |
|---|---|---|---|
| **Command** | alert stack + today + live feed | selected alert | act on the alert |
| **Conversations** | searchable stream, filters: channel · lang · intent · date | full transcript w/ tool calls + memory state | escalate · flag · open user |
| **Leads** | whale board (columns = status) or list w/ SLA | lead detail: budget, timeline, memory, transcript excerpt | **assign** · change status · log touch |
| **Supply** | merchants table + approval queue tab | merchant record: bookings, freshness, listing preview | **approve/reject** · nudge · edit tier |
| **Traffic** | per-source table (car/hotel QR) + channel mix | source detail: scans → chats → bookings funnel | flag placement · export |
| **Money** | revenue by stream + commission ledger | line-item detail: which booking, which vendor, which split | mark settled · export |
| **Quality** | sampling queue + flag list | conversation w/ grading controls | grade · confirm/dismiss flag |
| **System** | health board, channels, prompt version, tenants | component detail + logs | pause channel · ship prompt |

### 1.3 Role lenses (same app, different visibility)

| Lens | Sees | Lands on | Hidden |
|---|---|---|---|
| **Master** (Dre) | everything, all tenants | Command | — |
| **Operator** | own tenant, all sections except Money detail + System settings | Command | cross-tenant, margin, prompt shipping |
| **Executive** | read-only: Command, Traffic, Money summary, Quality summary | Command (trend-weighted) | conversation detail (privacy), system controls |
| **Specialist** | Leads (assigned to them only) + linked conversations | Leads | supply, money, system, other reps' leads |
| **AI Quality** | Quality + Conversations (full) | Quality | money, supply |

**Why this beats four separate role-apps:** one codebase, one nav pattern to learn, and a person who wears two hats (very common at pilot scale) doesn't switch apps — they switch a dropdown.

### 1.4 Mobile Control (the companion, not the main event)

Phone gets 5 bottom tabs mapped from the 8 sections by role. Master: **Now · Leads · Supply · Traffic · More**. The context pane becomes a bottom sheet. Everything is readable; the heavy work (bulk approve, ledger reconciliation, prompt shipping) is desktop-only by design — don't build cramped versions of tasks nobody does on a phone.

---

## 2 · Dashboard 2 — **Business** (merchant)

**Reduced from five tabs to three.** A restaurant owner opens this mid-service, one-handed. Every tab they don't need is friction.

```
┌───────────────────────────┐
│ Kan Eang @ Pier     [TH]  │
├───────────────────────────┤
│ ⚠ 2 booking requests      │  ← NOW band: the only thing that
│ ┌───────────────────────┐ │     can cost them money today
│ │ Chinese family · 5    │ │
│ │ Tonight 19:00 · ฿4.5k │ │
│ │ [Accept]   [Decline]  │ │  ← action ON the card, thumb-reachable
│ └───────────────────────┘ │
├───────────────────────────┤
│ TODAY                     │
│  12 bookings  ฿41k  NPS 71│  ← 3 numbers. Not 6.
├───────────────────────────┤
│ THIS WEEK ▸ (collapsed)   │  ← TREND band, collapsed by default
└───────────────────────────┘
  [ Today ]  [ Listing ]  [ Insights ]
```

| Tab | Contains | Why |
|---|---|---|
| **Today** | Pending bookings (action) → today's 3 numbers → this week (collapsed) | The 90% case. Open, accept, close. |
| **Listing** | **"How NUM describes you"** preview card, then editable fields: photos · hours · promo · contact | Shows the *outcome* first — merchants care what the AI says about them, not about form fields |
| **Insights** | Reviews (with reply) + guest demand asks + freshness nudge | Merged the old Reviews + Asks. Weekly-cadence content, not daily. |

**The killer feature stays on Listing:** the preview of the exact sentence NUM uses to sell them. That's what makes a merchant log in, and it's how we get them to keep photos fresh.

---

## 3 · Dashboard 3 — **My Trip** (traveler) — *new surface*

Travelers live in chat. This doesn't compete with that — it's the **one link NUM texts you** when a list is easier than a conversation.

- **No login.** Signed token in the URL (`num.5arz.com/t/{token}`), expires with the trip, revocable. Asking a tourist to make an account is how you lose them.
- **Sent, not discovered.** NUM drops the link when it becomes useful: after a booking, when a trip is saved, or on request ("send me my list").

```
┌───────────────────────────┐
│  Your Phuket trip    [ZH] │
│  Jul 24 – Jul 31          │
├───────────────────────────┤
│ NEXT UP                   │  ← NOW band
│ ┌───────────────────────┐ │
│ │ 🦞 Kan Eang @ Pier    │ │
│ │ Tonight 19:00 · 4 pax │ │
│ │ [Directions] [Call]   │ │
│ └───────────────────────┘ │
├───────────────────────────┤
│ SAVED FOR YOU             │  ← everything NUM recommended,
│ 💆 Baan Thai Spa          │     kept in one place
│ 🛶 Sea cave tour          │
├───────────────────────────┤
│ WHAT NUM REMEMBERS        │  ← trust + PDPA surface
│ · Vegetarian              │
│ · Traveling with 2 kids   │
│ · Staying in Kata         │
│      [Edit]  [Delete all] │
├───────────────────────────┤
│ 💬 Back to chat           │  ← always return them to the conversation
└───────────────────────────┘
```

| Section | Purpose |
|---|---|
| **Next up** | The imminent booking with directions + call. The reason they opened it. |
| **Saved for you** | Every place NUM recommended — solves "what was that restaurant called?" |
| **Trip** | Dates, hotel, party — editable, feeds better recommendations back into chat |
| **What NUM remembers** | Plain-language memory list with edit/delete. **This is the PDPA right-to-access surface** — compliance as a feature, and the single best trust builder we have. |

**Strategic note:** this is also the retention loop. A traveler who opens My Trip on day 3 is a traveler who comes back on day 6 — which is exactly when the whale conversations (schools, property, long-stay) start.

---

## 4 · Shared component grammar

One vocabulary across all three products, so a chip means the same thing everywhere.

| Component | Rule |
|---|---|
| **Entity chip** | `#a4f2` handle · channel badge · language badge · intent pill — always in that order, always together |
| **SLA chip** | icon + text + colour, never colour alone: `🟢 2h` `🟠 9h` `🔴 26h` |
| **Money** | THB primary with `k`/`M` shorthand, one decimal max, tabular numerals |
| **Action button** | One primary per card. Destructive = ghost outline, never solid red |
| **Empty state** | Teaches what will appear here and why it's good news |
| **Freshness dot** | fresh < 7d · aging 7–21d · stale > 21d — same thresholds in Control and Business |
| **Time** | Relative under 24h (`3m`, `9h`), absolute after (`Jul 19`) |

### Numbers discipline
- Glance zones: **max 4 numbers** (Control) / **3** (Business). More becomes wallpaper.
- Every number gets a comparison — delta, target, or sparkline. A bare number is unactionable.
- Every chart gets one plain-language line explaining what "good" looks like.

### Density by context
| Surface | Row height | Font | Rationale |
|---|---|---|---|
| Control desktop | 36–40px | 13px | Scanning hundreds of rows |
| Control mobile | 56px+ | 14px | Thumbs |
| Business | 64px+ | 15px | One-handed, mid-service, glare |
| My Trip | 72px+ | 16px | Tourist, outdoors, one hand, possibly a second language |

---

## 5 · What changes from what's built

| Change | From | To | Why |
|---|---|---|---|
| Admin consolidation | 4 role-apps × 5 tabs | 1 console × 8 sections × role lens | Two-hat staff stop app-switching |
| Desktop pattern | phone tabs stretched wide | 3-pane rail/list/context | Selecting a lead shouldn't lose your queue position |
| Landing screen | KPI strip first | **Alert stack first** | KPIs are TREND; alerts are NOW |
| Merchant tabs | 5 | 3 | Merchants use 2 features; the rest is noise mid-service |
| Traveler surface | none | My Trip web view | Retention loop + PDPA access + "what was that place called?" |
| Data ordering | grouped by subject | **ordered by decision latency** | The screen tells you what to do, not just what happened |

## 6 · Build order

1. **Control · Command + Conversations + Leads** — the daily driver, desktop 3-pane. Everything else can be SQL for two more weeks.
2. **Business · Today + Listing** — merchants need Accept and the listing preview; Insights can trail.
3. **My Trip** — ships with the first booking flow; the memory section doubles as the PDPA access requirement.
4. **Control · Supply + Traffic + Money** — as vendor volume and settlement volume justify.
5. **Control · Quality + System** — internal, lowest urgency, desktop-only.
