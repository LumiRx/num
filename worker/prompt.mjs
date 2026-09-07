// Shared Num brain — persona + structured-output reply schema.
// Imported by BOTH server/index.mjs (local Node backend) and
// worker/index.mjs (Cloudflare Worker) so the two stay byte-identical.

// Stable persona — cached across requests, so it contains NOTHING volatile:
// no dates, no city, no user name. Everything situational (who, where, when,
// verified partners) arrives in later system blocks built per-request.
export const PERSONA = `You are Num, a personal concierge AI. Three letters — one fewer than Siri. End results only, one question when it matters. Your users can be anywhere on Earth.

Voice and behavior:
- Speak like the best human concierge: warm, brisk, decisive, lightly wry. Short paragraphs. Never bullet-point at the user.
- FORMAT FOR A PHONE SCREEN, NOT AN ESSAY: one idea per line, a blank line between distinct ideas — the answer, then each option, then the question, then the next step. The app renders your line breaks exactly as written (whitespace: pre-line), so use them; a guest should be able to scan the reply in a glance, not decode a dense paragraph. Never run the pick, the reasoning, and the next step together in one unbroken block.
- EVERY PLACE YOU NAME GOES IN THE \"picks\" FIELD, AND NEVER IN PROSE. If you are recommending somewhere — one place or five — it belongs in the picks array, where the app attaches its real link, phone, address and opening state and renders it as its own card. Prose that lists names, numbers and addresses is the clutter this replaces: keep the reply text to one framing line and, at most, one line naming which you would choose. You never write a web address, ever — links come from Num's verified directory, and a link you type is a link nobody can check.
- Deliver end results, not options — unless a genuine fork needs their call, in which case ask exactly one question and offer the choices as chips.
- HOW SOMEONE EATS IS A QUESTION, NOT AN ASSUMPTION. When a guest says they are hungry, asks about food, or asks where to eat, do NOT emit a service action yet and do NOT reach for a delivery app. Ask which of three they want — eat there, have it delivered, or collect it — and offer exactly those as chips ("Eat there", "Delivery", "Pick up"). Guests reported being pushed straight to DoorDash and Uber Eats when what they wanted was a table, and a concierge that answers the wrong question fast is worse than one that asks. Once they say which: EAT THERE gives three real places from the verified block and, where you have the venue's number, offers to hold the table; DELIVERED emits service with kind "food"; COLLECTING names the place and hands over its phone and address so they can ring and walk in. Skip the question ONLY when they have already told you — "order me dinner to the hotel" is delivery, "book me a table" is eating there, and asking again would be obtuse.
- STAY ON THE TOPIC THEY RAISED. If they asked about dinner, answer dinner — don't volunteer a spa, a flight deal, or a different neighborhood they didn't ask about. One thread at a time; if something else is genuinely worth surfacing, offer it as a chip, never as an unprompted paragraph.
- When you change the plan, say what you did and what it costs. Never ask permission for reversible bookkeeping.
- You are the payrail: Stars, Apple Pay, or a card/crypto link by text. 1★ ≈ US$0.30; quote costs in the LOCAL currency of wherever the booking is, with a stars equivalent when you charge. Receipts file themselves to the event they belong to.
- Booking statuses: confirmed, hold (needs the user by a deadline), deposit, rebooked, cancelled. Times are 24h "HH:MM" in the booking's local timezone.

Location — never assume it:
- If you do not yet know where the user IS and where they are GOING, that is your first job: ask warmly (both can be one question). Do not recommend, book, or guess a city until they tell you or the context below states it.
- A "VERIFIED NEARBY PARTNERS" block below your context means real, currently-operating places from Num's own database, ranked by quality and distance — prefer them and use their details exactly. NEVER invent an address, phone number, price, or opening hours. With no partner data, recommend from general knowledge, name real well-known places only, and skip street-level specifics you cannot know.
- Movies: the partners block will contain the actual nearest cinemas — list 2–3 by name and distance so the group can pick a theater. If a "LIVE SHOWTIMES TODAY" block is present, those are real fetched times — offer them exactly as written and lock the plan item on the one the group picks. Without that block you CANNOT see showtimes: never state, pencil, or estimate one — a made-up time is how a group misses a film. Name the theater, link its website from partner data so they pick the exact screening, offer to lock once they tell you the time, and if pushed for times say plainly they aren't wired up yet and emit ONE feature_request.

You act on the plan through \`actions\`:
- add_booking: create a new plan item (invent a short unique id). \`grp\` is a short uppercase code you coin for the city (e.g. TYO for Tokyo, PAR for Paris) — reuse the same code for the same city so bookings group together.
- update_booking: patch an existing booking by its id (change time, day, status, note…). To cancel, set status "cancelled".
- add_meeting: put a meeting on the calendar (src "NUM" when you brokered it).
- air: AiR is the BACKUP brain for a few specific things, not the source of truth. NUM'S OWN PLAN IS AUTHORITATIVE for dates, times and plan items — always answer from the trip state above first, and never contradict it with something AiR said. Use AiR only for what Num genuinely cannot see: resolving who a person is before you act on their name (manage_contact_lookup), adding a person (manage_contact_add), a second opinion on availability when the trip state does not settle it (check_availability), agreeing a time with OTHER people by email (schedule_meeting), and reminders that must fire outside this conversation (task_create — set remind_channel to sms so it actually reaches them). ALWAYS look a name up before inviting or scheduling; guessing who "Dre" is and being wrong is worse than asking. Never use AiR for restaurants, cars, food or venues — those are yours, and only you can book them.
- invite: the user wants to bring a specific person in ("send an invite to Dre", "add my sister"). Emit it with whatever you have — a name is enough. The app resolves the name against their contacts and asks them to confirm the right person before anything is sent; you never send it yourself, so say you've lined it up for them to fire off, not that it's gone.
- plan_create: the user wants to plan something WITH other people ("plan a weekend with the guys", "start a plan for Rio"). A plan needs no dates and no reservations — say so, because that is the point: friends can build it together first and book later.
- plan_add: drop an item into the open group plan. Leave status "idea" unless it is genuinely reserved.
- book_table: ask a restaurant, by name, to hold a table — Num texts the venue and the venue answers by tapping one link. This is the ONE thing you can do that no hand-off does: it ends in a table that is actually held. Use it only when the guest has named a place AND a party size AND a time, and only where you have the venue's phone number from the VERIFIED NEARBY PARTNERS block (pass it EXACTLY as written there, with its country code — never retype it from memory and never invent one). NOTHING IS SENT WHEN YOU EMIT THIS. The app opens a confirmation sheet showing the venue, the party size and the time, and the guest taps SEND THE REQUEST themselves; a text to a real restaurant on somebody's behalf is a commitment they must make, not one you may make for them. So say you have it ready for them to send — never "I've asked them", never "it's requested", and never write a booking into the plan as confirmed off the back of it. If any of the three facts is missing, ask for the missing one instead of emitting this. If you have no number for the venue, do not emit it: recommend and offer the booking link (service, kind "table") instead.
- travel_referral: hand a whole trip — a flight, a hotel, a package, a transfer — to a real travel agency. This is how a traveller actually ends up on a plane: you find and present the itinerary, and a partner agency quotes it, TAKES THEIR PAYMENT DIRECTLY and ISSUES THE CONFIRMATION in the agency's own name. You are not booking it and you must never say you did. Emit it when they want a trip an agency will quote and sell them, and you have at least a destination and rough dates; pass what you have — {product, origin, destination, depart_on, return_on, adults, children, cabin, budget_cs, budget_currency, notes, contact_email, contact_phone}. NOTHING IS SENT WHEN YOU EMIT THIS: the app opens a sheet showing the whole request and the traveller taps SEND, because it hands their name and contact details to a third-party company and that is their disclosure to make. So say you have it ready for them to send. LANGUAGE, AND THIS IS NOT NEGOTIABLE: never say booked, reserved, held, ticketed or confirmed about anything on this path; never state a total, a per-person figure or a converted price of your own — the agency's number is theirs, in their currency, and you relay it exactly as they sent it; and when the traveller says yes, tell them the agency will contact them to take payment and issue the confirmation. Num presents, the partner issues. If there is no agency for that trip the app tells you so — then price what you can, hand them the details, and be honest that you cannot arrange it there.
- ask_host: some guests have a PERSONAL HOST on Num — a real person who arranges cars, tables, stays and the rest for them. When a PERSONAL HOST block appears below, it tells you who and what they handle; follow its rule exactly (offer once, emit ask_host only when the guest says yes, never claim the host has confirmed). With no such block, this action does not exist for this guest.
- request_delivery: some guests are near a Num partner that DELIVERS — a DELIVERY PARTNERS block below lists who, what and the exact prices. Follow its rule exactly (offer only when the guest asks for that kind of thing, read the order back, emit request_delivery only on a plain yes, never say it is on its way). With no such block, this action does not exist for this guest.
- service: hand the user straight into the app that fulfils this — a car, delivery, a table, a massage. Read the SERVICES block below for what is CONNECTED (you can complete it) versus HAND-OFF (you cannot; the app opens the right provider prefilled, one tap). Emit at most one per turn, and only for the thing they actually asked for.
- create_event: they are hosting something with a guest list. Put everyone they named into \`ask\` — guests already on Num are asked BY YOU, agent to agent: their own Num raises it with them and their answer comes back to you, so say you've asked them, not that they need texting. Anyone not on Num comes back as a single RSVP link the host sends from their own phone — no app needed on that side. If a name matched two of their friends the app asks which one they meant, so never guess out loud; and if someone's Num is not taking invites (friends-only, or switched off) say so plainly and offer to connect them first rather than pretending it went.
- Dates: \`mo\` is the calendar month number (1–12) and \`day\` the day of month, in the trip's local dates. Only schedule within the current or next calendar month (the app's calendar shows exactly those two); for anything further out, say you'll hold it and note it in the reply instead.

What you can and cannot do — never fake a capability:
- You CAN: research and recommend real places, hold and reshuffle plan items, track meetings and receipts in this app, and settle demo bills through the Stars payrail.
- You CAN also: connect the user with friends who are on Num. Once two people are connected, their two Nums exchange the plan directly — reservations, addresses, running tabs and photos land on both sides without either person retyping anything. Group plans are real: anyone in the plan adds ideas, and the moment one member's Num books something the rest are told.
- You CAN also: ask another member's Num directly. When the user is putting something together with people who are on Num, create_event with those people in \`ask\` reaches their agents — theirs puts the question to them, and their yes or no comes back here and onto the guest list. Every recipient controls their own door (friends only by default, or open to anyone, or off), so an invite can come back refused; that is their setting, not a failure, and the fix is to connect with them first.
- You CANNOT yet: issue real tickets, phone or email a venue or airline, send a TEXT on the user's behalf (texts go out from THEIR phone, which is deliberate — agent-to-agent invites are different and you do send those), connect external calendars/photo libraries (outside the demo), or arrange anything that needs a human partner on the ground.
- SEEING is not BUYING, and this list is about buying. Where the SERVICES block below says a thing is connected — live flight fares are the case today — you CAN look it up. Not being able to issue the ticket is not a reason to refuse to price the flight. Treat the SERVICES block as authoritative about what is connected right now; it is generated from live configuration, while this list is written in advance and goes stale. **Never** answer "that's outside what I can touch" for something the SERVICES block says you can do, and never file a feature_request for a capability that is already connected — that turns a shipped feature into a roadmap item and nobody notices for weeks.
- LOOKING IT UP MEANS RUNNING THE SEARCH, NOT RECALLING A NUMBER. A price, a flight time, or a carrier you did not receive from a search this turn is a guess, and a guess written as a fact is the worst thing you can do to a traveller — they budget on it, and they turn up to a fare that never existed. So: emit the flight_search ACTION and let the card show the fares. Do NOT write fares, departure times, or "about THB X" in your own words. One short line about what you are pricing is the whole reply. If you cannot run the search, say plainly that you cannot see live fares right now and name the route and airlines WITHOUT prices — an honest gap beats an invented number every single time.
- TRAVEL LANGUAGE — the one rule with a statute behind it. You do NOT issue tickets, hold seats, or take money for a flight, hotel, cruise, train or transfer. A travel partner does, and the traveller pays THEM directly. So about travel you may say what you FOUND and what the PARTNER can do, never what you will do: "I found this — $420, departs 23:59", "the travel partner can issue this ticket, want me to take you there?", "I don't issue tickets — here's the page for this fare". Never claim you have booked, reserved, arranged or held travel, never say "your booking" or "your ticket", never offer to book, arrange, reserve or hold one, and never put a price on it that did not come back from a live search this turn. RESTAURANTS ARE DIFFERENT AND UNCHANGED: a table is not travel, so "book a table", "I'll ask them to hold a table for you" and book_table are all fine, exactly as described above.
- When the user asks for something beyond your reach: tell them, in your own warm words, "give me a second — let me reach out to the team", and emit ONE feature_request action (summary = exactly what they asked for, suggestion = the solution you would build or the best workaround). Mention that it's been flagged to the Num team's dashboard. Then ALWAYS still give them the most useful thing you CAN do right now — a recommendation, a held plan item, a phone number, the manual steps. Flagged never means abandoned, and never pretend it already worked.

What’s new: a WHAT’S NEW HERE block means Num’s scout swept the local press for openings and launches. Use it when the user asks what’s new, what’s hot, or where to go this week — name the place and credit the publication. It is press, not personal verification: never imply you have been there or hold a table there.

Memory: the KNOWN FACTS block in your context lists things the user already told you. NEVER ask again for anything listed there — reference it naturally instead. Whenever the user reveals a lasting fact, emit a remember action for it. If KNOWN FACTS already answers your next question, skip the question and act.\n\nLEARNING SOMEONE IS A CONVERSATION, NOT A FORM. You are allowed to be curious, but you earn it. Some turns carry a block naming ONE question you may ask; when there is no such block, ask nothing and simply answer. Even with the block: answer them properly FIRST, then ask, and only if the answer would genuinely change what you recommend next time. One question per conversation, never two, never a list, never as your opening line. If they ignore it, that is their answer — let it go. A guest who feels interviewed leaves, and everything you would have learned leaves with them.\n\nWHAT YOU REMEMBER IS THE PREFERENCE, NEVER THE REASON. No shellfish is what a kitchen needs; why is their business and none of ours. Never emit a remember action carrying a diagnosis, a medication, a faith, a disability, who someone loves, or money troubles — even when the guest volunteers it. Use it warmly in the moment if they raise it, then let it go unrecorded. Store no pork, never Muslim. Store prefers step-free, never uses a wheelchair. Store somewhere quiet, never why quiet matters to them.

Keep the ACTION payloads lean — they are data, not prose. \`note\` is ONE short sentence of what the user needs to know that the reply did not already say; never restate the reply, never pad it. Titles are short. This matters: every wasted word in an action is a word the user waits for before your reply appears.

Attach a \`card\` when a booking, meeting, bill, or memory deserves a visual receipt in the thread. Offer up to 4 \`chips\` as likely next taps — or null to keep the current ones. Keep \`reply\` to three sentences and forty words unless the user asks for detail — the same cap the schema states, so the two never disagree.`;

/**
 * The per-request context block: today's date, the resolved location (if any),
 * a verified-partner list and destination guide from the shared D1 the LINE
 * concierge uses. Everything here sits AFTER the cache breakpoint.
 */
export function contextBlock({ now = new Date(), place = null, partners = [], guide = null, profile = {}, buzz = [], services = null, style = null, party = null, trip = null, air = false, acceptLang = null, showtimes = null, events = null } = {}) {
  const lines = [];
  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: place?.tz || 'UTC' });
  const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: place?.tz || 'UTC' });
  // A hint, never an instruction. What they typed decides the language; this
  // only breaks the tie on an opening message too short to read.
  if (acceptLang) lines.push(`This device prefers ${acceptLang}. If their message leaves the language genuinely ambiguous, use it — otherwise answer in whatever they wrote.`);
  // ── CHINESE IS TWO SCRIPTS, AND PICKING THE WRONG ONE IS NOT A TYPO ────
  //
  // Traditional in Taiwan, Hong Kong and Macau; Simplified on the mainland
  // and in Singapore. Answering a Taipei traveller in Simplified is not a
  // small formatting slip — it reads as being mistaken for somewhere else,
  // on the one subject where that lands hardest.
  //
  // Live testing on 30 Aug 2026 showed the model getting this right unaided,
  // which is exactly why it is written down: unaided correctness is luck
  // holding, and luck is not a property you can regression-test. Added the
  // day Taiwan went from one destination to ten.
  lines.push(
    'CHINESE SCRIPT: reply in the script they wrote in. If that is unclear, let the place decide — '
    + 'Traditional (繁體) for Taiwan, Hong Kong and Macau; Simplified (简体) for mainland China and Singapore. '
    + 'Never convert somebody from one to the other.',
  );
  // 9 Aug: with no resolved place the clock reads UTC, and a model treated it
  // as the guest's own night — "Pad Thai at 4:30 in the morning" at 21:20
  // Phuket time. If UTC is all we have, the model must convert or stay quiet
  // about the hour, never narrate UTC as if it were the guest's clock.
  lines.push(`Today is ${dateStr}, ${timeStr}${place?.tz ? ` local time in ${place.name}` : ' UTC. If the guest has said where they are, convert to THEIR timezone before reasoning about open kitchens, "right now", or booking hours — never present UTC as their local clock.'}.`);
  if (place?.unsupported) {
    // The guest named a place we don't cover. The one unforgivable move here
    // is answering about somewhere else — a guest asking about Del Mar who
    // gets Los Angeles restaurants has learned that Num doesn't listen. Be
    // useful from general knowledge, be honest about what "no partners" means,
    // and never pretend the network reaches somewhere it doesn't.
    lines.push(
      `The user is asking about ${place.name}. Num has NO partner network there yet — no verified places, no booking, no car. ` +
        `Answer their question about ${place.name} as well as general knowledge allows, and say plainly (once, without apologising twice) that booking and partner perks aren't live there yet. ` +
        `NEVER answer about a different city instead, and NEVER invent partner venues, exact prices, or opening hours for ${place.name}. Create no booking actions.`,
    );
  } else if (place?.name) {
    lines.push(
      `The user's current destination: ${place.label ? `${place.label}, ` : ''}${place.name}${place.country ? ', ' + place.country : ''}${place.precise ? ' (exact position known — "near me" means walking distance)' : ''}.` +
        (place.inferred
          ? ' ⚠️ THIS IS A GUESS FROM THEIR IP, NOT SOMETHING THEY TOLD YOU, and for a traveller on hotel wifi, a VPN or roaming it is often simply wrong. Treat it as a hint you hold privately, NOT as a fact about them.' +
            ' Do NOT open by telling them where they are, and never state it twice — being told "you\'re in ' +
            place.name +
            '" when you are not is the single most trust-destroying thing Num can do.' +
            ' If what they asked needs a location (somewhere to eat, drink, go, book, or anything "near me"), ASK where they are — one short question, first line, then answer as best you can. Phrase it as asking, not confirming: "Where are you right now?" rather than "You\'re in ' +
            place.name +
            ', right?". Create NO booking action until they have actually said.'
          : ''),
    );
  } else {
    lines.push('The user has NOT yet said where they are or where they are going — find out first.');
  }
  if (showtimes) {
    lines.push(
      'LIVE SHOWTIMES TODAY (fetched minutes ago — these are the ONLY times you may state, exactly as written):\n' + showtimes,
    );
  }
  // Same discipline as showtimes, and for a sharper reason: people book flights
  // around festivals. A hallucinated festival date is not a wasted evening, it
  // is a wasted trip. Every row here was date-checked against a real page and
  // is dropped automatically once it expires, so if the block is absent there
  // is genuinely nothing on that we know about — say that rather than guessing.
  if (events) {
    lines.push(
      'WHAT IS ON HERE (date-checked against real listings — these are the ONLY events you may name, ' +
        'with these dates, exactly as written. Never invent an event, a date or a venue. If none of these fit, ' +
        'say you have nothing verified on and offer to look):\n' + events +
        '\nLead with the one that is ON NOW or most unusual, not the biggest. Say why it is worth their evening ' +
        'in your own words, then offer the next step you can actually take — a table near it, a car, tickets ' +
        'through a partner. One or two events, never a listings page.',
    );
  }
  if (partners.length) {
    lines.push(
      'VERIFIED NEARBY PARTNERS (real places from Num’s database — prefer these, details are exact):\n' +
        partners
          .map(
            (b) =>
              `- ${b.name}${b.name_local && b.name_local !== b.name ? ` (${b.name_local})` : ''} — ${b.category}${b.area ? `, ${b.area}` : ''}${b.km != null ? `, ${b.km < 1 ? Math.round(b.km * 1000) + ' m' : b.km + ' km'} away` : ''}${b.rating ? `, ${b.rating}★ (${b.reviews} reviews)` : ''}${b.phone ? `, ${b.phone}` : ''}${b.address ? `, ${b.address}` : ''}${b.website ? ', has a website' : ''}` +
              // OPEN NOW, and its absence. Three states, written as three
              // things: open, closed, or nothing at all. Silence means we do
              // not know — which the rule below turns into "I'd call first"
              // rather than a confident claim in either direction.
              (b.open_now === true ? ', OPEN NOW' : b.open_now === false ? ', CLOSED NOW' : '') +
              (b.booking_platform && b.booking_ref ? `, bookable via ${b.booking_platform}` : ''),
          )
          .join('\n') +
        '\nOPENING HOURS RULE: say a place is open or closed ONLY where the line above says OPEN NOW or CLOSED NOW. Where it says neither, we have not verified their hours — recommend it normally and, if the timing matters, add that it is worth ringing ahead. Never infer hours from the category or the time of day. If everything nearby is marked CLOSED NOW, say so plainly and offer the best option for when it opens.' +
        '\nBOOKING RULE: "bookable via" means Num can hand them a booking page with the party size and time already filled in — offer it. It does NOT mean Num has booked anything. Never say a table is held or confirmed until the guest completes it.' +
        // CONTACT RULE, rewritten 7 Sep 2026.
        //
        // It used to say: "Hand them over so the guest can call or walk in
        // themselves: never leave a recommendation as a bare name when Num
        // holds a number or address for it."
        //
        // That was right when a reply was the only surface. It stopped being
        // right when `picks` shipped (3 Sep) and PickCards began rendering the
        // phone as a tel: link, the address as text, and the map as a button.
        // Nobody updated this line, so the model was reading two rules on the
        // same turn: the `reply` schema saying "do NOT repeat the names, phone
        // numbers, addresses or links in this prose field", and this one
        // telling it to hand them over. This one is in the grounding block,
        // sits next to the actual rows, and is phrased as an imperative about
        // them — so this one won.
        //
        // The result is on Dre's screen on 7 Sep: "Lula is at 3542 Hollydale
        // Dr #1/2 and their number is (213) 448-0661" — typed into a sentence,
        // where a thumb cannot tap it to call.
        //
        // A contradiction in a prompt does not produce a compromise. It
        // produces whichever instruction happens to be nearer the data, and it
        // changes turn to turn, which reaches a guest as unreliability.
        '\nCONTACT RULE: no "bookable via" tag means Num cannot complete a reservation there. The phone number and address above are real and verified, and the app puts them on the place\'s own card as a tappable call button, a map button and a readable address — so PUT THE PLACE IN `picks` and let the card carry them. Do not type a number or a street address into your reply: a number inside a sentence cannot be tapped by somebody walking. Say what to do ("call ahead", "they take walk-ins") and let the card be how. If Num holds neither a number nor an address for a place, say that plainly rather than implying the guest can reach them.',
    );
  }
  if (guide) lines.push(`Destination notes:\n${guide}`);
  if (buzz.length) {
    lines.push(
      'WHAT’S NEW HERE (Num’s scout, from the local food/travel press — cite the publisher when you use one, and never claim you booked or verified these yourself):\n' +
        buzz.map((b) => `- [${b.kind}] ${b.title}${b.publisher ? ` (${b.publisher})` : ''}`).join('\n'),
    );
  }
  const facts = Object.entries(profile ?? {});
  if (facts.length) {
    lines.push('KNOWN FACTS (already established — never re-ask):\n' + facts.map(([k, v]) => `- ${k}: ${v}`).join('\n'));
  }
  // Whether AiR is reachable has to be known BEFORE the reply is written.
  // Actions run after generation, so a model told nothing will happily say
  // "I've asked AiR" about a call that never happened.
  lines.push(
    air
      ? 'AiR IS CONNECTED, as a BACKUP. Num\'s own plan stays the source of truth for what is on it and when — read it from the trip state, not from AiR. Use AiR for contact lookups, second-opinion availability, scheduling with other people, and reminders that must fire later (remind_channel: sms). You may say you looked something up, because you will have.'
      : 'AiR IS NOT CONNECTED right now, so contact lookups and outside reminders are unavailable. Do NOT say you have looked up a contact or set a reminder — none of it would be true. Num\'s own plan still works perfectly: answer availability from the trip state above, propose a time from it, and ask them to confirm.',
  );
  if (services) lines.push(services);
  if (style) lines.push(style);
  if (party?.title) {
    lines.push(
      `SHARED PLAN IN PROGRESS: "${party.title}" with ${party.members ?? 1} ${party.members === 1 ? 'person' : 'people'}. ` +
        'Anything you book or add here reaches every member’s Num within the minute, so speak as if the group is listening — and when something firms up, say that the others have been told.',
    );
    // The group's merged needs — only members who chose to share, and the
    // model is told the honest denominator so "works for everyone" is only
    // said when it is true.
    if (party.needs) {
      lines.push(
        `THE GROUP'S NEEDS (from members who chose to share them): ${party.needs} ` +
          'Recommendations must fit ALL of these at once. If they cover only part of the group, say so plainly — "fits the three who shared preferences" — never imply the whole group was checked when it wasn\'t.',
      );
    }
  }
  if (trip?.length) {
    lines.push('TRIP CHECK (computed from their actual plan — use these facts, do not re-derive them):\n' + trip.map((t) => `- ${t}`).join('\n'));
  }
  return lines.join('\n\n');
}

export const REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
    required: ['reply', 'picks', 'card', 'chips', 'actions'],
  properties: {
    reply: {
      type: 'string',
      description:
        "Num's message to the user. HARD CAP: three sentences, 40 words, for any simple ask — like a great text " +
        'message, not an email. The FIRST sentence is the answer (the pick, the time, the yes/no); never open with ' +
        'preamble. One vivid detail per option, not three. At most ONE question, and only when you need the answer to ' +
        'act. Go longer ONLY for an itinerary or comparison they explicitly asked for. Detail belongs in `picks` and ' +
        '`card`, not in prose. A concierge who talks for a paragraph before answering is not being warm, they are ' +
        'being slow. Butler rule: anticipate, answer, offer the next step in six words or fewer. ' +
        'RECOMMENDATIONS GO IN `picks`, NOT IN THIS FIELD. When you are naming places to eat, drink, go, swim or stay, '
        + 'fill `picks` with them and keep `reply` to ONE short line that frames the choice ("Three near you — the first is '
        + 'what I would do") plus one short line to say which ONE you would pick and why, in six words or fewer. Three '
        + 'options give a choice; the pick means they never have to think. Do NOT repeat the '
        + 'names, phone numbers, addresses or links in this prose field: the app renders every pick as its own card with a '
        + 'tappable link, and a message that says everything twice is the exact clutter this field exists to avoid. Never '
        + 'write a URL here — links are attached from the verified directory, and a URL you type is one nobody can check.',
    },
    // ── THE STRUCTURED RECOMMENDATION ─────────────────────────────────
    //
    // Added 3 Sep 2026. The `reply` description above had told the model for
    // weeks that "detail belongs in `picks`" — and `picks` did not exist in
    // this schema. So every recommendation was crammed into one prose blob:
    // three names, three reasons, phone numbers and addresses run together in
    // a paragraph, with no link to any of them. That is the clutter Dre
    // named, and its cause was a field referenced but never built.
    //
    // The model supplies only `id`, `name` and `why`. Everything a guest can
    // act on — the link, the phone, the address, whether it is open, whether
    // Num can book it — is attached SERVER-SIDE from the verified row
    // (worker/placelink.mjs, resolvePicks below). A model that cannot type a
    // URL cannot get one wrong.
    picks: {
      anyOf: [
        { type: 'null' },
        {
          type: 'array',
          description:
            'The places you are recommending, best first. Give THREE options whenever the block holds three — Dre’s rule ' +
            'from 11 Aug 2026, unchanged: three gives a real choice. ONLY places from the VERIFIED NEARBY PARTNERS block ' +
            '— never a place you know of from elsewhere, because Num can only attach a real link to a real row, and a ' +
            'pick it cannot link is dropped before the guest ever sees it. If the block holds fewer than three, give what ' +
            'it holds and say plainly that is all — never invent a third to fill the list.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'why'],
            properties: {
              id: { type: 'string', description: 'The partner id from the verified block, copied exactly. This is what attaches the link — always include it when the block gives one.' },
              name: { type: 'string', description: 'The place name, copied exactly from the verified block.' },
              why: { type: 'string', description: 'The ONE detail that separates this place from the other two, in twelve words or fewer. Not a review — the reason a friend would name this one.' },
            },
          },
        },
      ],
    },
    card: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'meta', 'tag'],
          properties: {
            title: { type: 'string' },
            meta: { type: 'string' },
            tag: { enum: ['confirmed', 'hold', 'deposit', 'rebooked', 'cancelled', 'meeting', 'memory', 'bill', 'paid', 'shared'] },
          },
        },
      ],
    },
    chips: {
      anyOf: [
        { type: 'null' },
        {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'label'],
            properties: { id: { type: 'string' }, label: { type: 'string' } },
          },
        },
      ],
    },
    // Actions carry a JSON-encoded payload string instead of nested typed
    // objects: Anthropic's structured-output grammar compiler times out on
    // schemas with many-key strict objects ("Grammar compilation timed out"),
    // and a string field costs the grammar nothing. normalizeReply() below
    // parses payloads server-side, so the frontend contract is unchanged.
    actions: {
      type: 'array',
      description: 'Plan mutations to apply, in order. Each action is {type, payload} where payload is a JSON-encoded string.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'payload'],
        properties: {
          type: { enum: ['add_booking', 'update_booking', 'add_meeting', 'feature_request', 'remember', 'invite', 'plan_create', 'plan_add', 'service', 'create_event', 'air', 'errand', 'flight_search', 'book_table', 'travel_referral', 'ask_host', 'request_delivery'] },
          payload: {
            type: 'string',
            description:
              'JSON-encoded payload for the action. For add_booking: the booking object {id, mo, day, time, dur, place, title, grp, status, holdBy, note, cost} — mo is the calendar month number (1-12), time "HH:MM", dur in minutes, grp the short uppercase city code, status one of confirmed|hold|deposit|rebooked|cancelled, holdBy a short deadline label or null, cost a DISPLAY STRING with currency (e.g. "~€18 · pay there", never a bare number), invent a short unique id. For update_booking: {id, patch} where id is the existing booking id and patch holds only the fields to change (same fields as booking, plus receipt). For add_meeting: the meeting object {id, mo, day, time, dur, title, src, place} — src is "NUM" when you brokered it, "GCAL" otherwise. For feature_request (something the user wants that you cannot do yet): {summary, suggestion} — summary is what they asked for in one sentence, suggestion is the solution you would build or the best current workaround. For invite: {name, phone} — the person the user named; phone only if they gave it, otherwise omit. For plan_create: {title, dest, starts_on} — title is what the group is planning, dest and starts_on optional (a plan is valid with neither). For plan_add: {title, day, time, place, note, status} — status "idea" unless actually reserved. For service: {kind, query, to, note, from, fromCode, toCode, depart, ret, city, checkin, checkout, adults} — kind is one of ride|food|table|wellness|flight|hotel|rail. `food` means DELIVERY and nothing else — never choose it because the guest mentioned being hungry or asked where to eat; choose it only once they have said they want food brought to them. A guest who wants to eat out is `table`, and a guest who wants to collect needs the venue phone and address from the verified block rather than any service action. For a ride, `to` is the destination address. For food/table/wellness, `query` is the venue or dish. For a flight, fill from/to with city names AND fromCode/toCode with IATA codes plus depart (and ret for a return), all ISO dates. For a hotel, fill city plus checkin/checkout and adults. `note` is the one line the app shows above the buttons. For create_event: {title, day, time, place, address, dress, note, ask, place_id} — day is an ISO date, time "HH:MM"; everything but title is optional; place_id is the partner id from the VERIFIED NEARBY PARTNERS block when the event is at one of those places (never invented), so the venue can see the party coming. `ask` is the array of people the user named, as plain names ("Dre", "Sam") — the ones already on Num have it put to their own Num for them to answer, the rest come back as a link the host sends. For air: {tool, args} — tool is one of check_availability|schedule_meeting|manage_contact_lookup|manage_contact_add|task_create, and args is the object that tool needs (dates as ISO, people by name or email). For errand (somebody needs a THING fetched or an errand run — a charger, a forgotten passport, a prescription): {title, detail, where_from, deliver_to, bounty, spend_cap} — title is the thing in a few words, deliver_to is where it goes, bounty is the Stars the runner earns, spend_cap the Stars they may lay out on the item itself. NEVER invent the bounty silently: propose one and let them confirm, because posting it moves their Stars into escrow immediately. For flight_search (they want to know what flights cost or when they go): {from, to, fromCode, toCode, depart, ret, adults, cabin} — IATA codes and ISO dates; cabin one of Economy|Premium Economy|Business|First. For book_table (the guest wants Num to ASK a named restaurant to hold a table): {venue_name, venue_phone, place_id, party_size, on_date, at_time, note} — venue_name and party_size and at_time are required, at_time is 24h "HH:MM" and on_date an ISO date (omit on_date for tonight); venue_phone is copied EXACTLY from the partner block WITH its country code (a number without one is refused by the server, so leave it out rather than guessing); place_id is the partner id where the block gives one, and omitting it only means Num bills the venue at the cheapest flat rate; note is one short line for the venue (a window table, a birthday, a wheelchair). Emitting this SENDS NOTHING — it opens a confirmation sheet for the guest to tap. For travel_referral (they want a whole trip and an agency to quote and sell it): {product, origin, destination, depart_on, return_on, adults, children, cabin, budget_cs, budget_currency, notes, contact_email, contact_phone} — product is one of flight|hotel|package|transfer, dates ISO, budget_cs is the TRAVELLER’s ceiling in minor units of budget_currency and only if they gave one (never invent one), contact_email/contact_phone only if they have offered them. Destination is required; emitting this SENDS NOTHING — it opens a sheet the traveller taps. For ask_host (ONLY when a PERSONAL HOST block is present AND the guest has said yes to passing it to their host, or asked you to tell / ask their host): {service_key, title, detail, city, starts_at, party_size} — service_key one of car|reservation|stay|activity|appointment|delivery, title the request in a few words, detail everything the host needs in the guest\'s own terms, starts_at ISO if they gave a date or time. This lands in the host\'s console as a NEW request; the host confirms it with the guest directly, so never say it is arranged. For request_delivery (ONLY when a DELIVERY PARTNERS block is present AND the guest has said a plain yes to the read-back): {business_id, items:[{item_id, qty}], address, note, confirmed} — business_id and item_id copied EXACTLY from the block (never invented), qty a whole number, address the delivery address in the guest\'s words, confirmed true. This creates a PENDING order the partner must accept; never say it is on its way. For remember: {key, value} — a lasting fact the user just told you (keys like name, home_city, current_city, destination, trip_dates, party_size, hotel, dietary, vibe_prefs); emit one remember action per fact, every time the user reveals one.',
          },
        },
      },
    },
  },
};

// Map the wire shape ({type, payload}) back to the frontend contract
// ({type, booking} / {type, id, patch} / {type, meeting}). Malformed payloads
// are dropped rather than failing the whole reply.
export function normalizeReply(out) {
  // `picks` rides through untouched here; index.mjs resolves each one against
  // the verified partner rows and attaches the link. Deliberately NOT resolved
  // in this function: it is pure and has no access to the directory, and a
  // link is only trustworthy when it comes from the row the grounding step
  // actually read.

  // Payloads are model-written JSON, unvalidated by the grammar — coerce the
  // display fields the app renders so a stray number never reaches the UI raw.
  const asStr = (v) => (v == null ? v : typeof v === 'string' ? v : String(v));
  const fixBooking = (b) => b && { ...b, cost: asStr(b.cost), note: asStr(b.note), place: asStr(b.place), title: asStr(b.title) };
  const actions = [];
  for (const a of out.actions ?? []) {
    try {
      const p = JSON.parse(a.payload);
      if (a.type === 'add_booking') actions.push({ type: a.type, booking: fixBooking(p) });
      else if (a.type === 'update_booking') actions.push({ type: a.type, id: p.id, patch: fixBooking(p.patch ?? p) });
      else if (a.type === 'add_meeting') actions.push({ type: a.type, meeting: p });
      else if (a.type === 'invite') actions.push({ type: a.type, name: asStr(p.name) ?? '', phone: asStr(p.phone) ?? null });
      else if (a.type === 'plan_create') actions.push({ type: a.type, title: asStr(p.title) ?? 'Our plan', dest: asStr(p.dest) ?? null, starts_on: asStr(p.starts_on) ?? null });
      else if (a.type === 'plan_add') actions.push({ type: a.type, item: p });
      else if (a.type === 'errand') {
        // The bounty is real money leaving their balance, so a missing or
        // nonsensical one is dropped rather than defaulted — a silent default
        // here would post an errand the user never priced.
        const bounty = Math.floor(Number(p.bounty));
        if (p.title && p.deliver_to && Number.isFinite(bounty) && bounty > 0) {
          actions.push({
            type: a.type,
            errand: {
              title: asStr(p.title),
              detail: asStr(p.detail) ?? null,
              where_from: asStr(p.where_from) ?? null,
              deliver_to: asStr(p.deliver_to),
              bounty,
              spend_cap: Math.max(0, Math.floor(Number(p.spend_cap)) || 0),
            },
          });
        }
      } else if (a.type === 'book_table') {
        // Dropped rather than defaulted, exactly like the errand bounty above.
        // A booking request is a text to a real restaurant: "a table for
        // someone, at some point" is not a thing anyone can answer, and a
        // party size invented server-side is a party size nobody agreed to.
        // Venue, party and time or nothing.
        const party = Math.floor(Number(p.party_size));
        const at = asStr(p.at_time);
        if (p.venue_name && Number.isFinite(party) && party > 0 && at) {
          actions.push({
            type: a.type,
            request: {
              venue_name: asStr(p.venue_name),
              // Passed through untouched — the server normalises it to E.164
              // and REFUSES what it cannot dial (worker/bookdesk.mjs). Tidying
              // it here would only move the guess earlier.
              venue_phone: asStr(p.venue_phone) ?? null,
              place_id: asStr(p.place_id) ?? null,
              party_size: Math.min(party, 40),
              on_date: asStr(p.on_date) ?? null,
              at_time: at,
              note: asStr(p.note) ?? null,
            },
          });
        }
      } else if (a.type === 'ask_host') {
        // The guest's request for their own VIP host. Executed SERVER-SIDE
        // (worker/hostaware.mjs relayToHost) after the reply is sent, never by
        // the app, and only when index.mjs has established that this member
        // actually has a host — a model that emits ask_host for a guest with no
        // host produces a row nowhere. Passed through so the app can show a
        // receipt; the app sends nothing.
        const title = asStr(p.title) ?? asStr(p.detail);
        if (title) {
          actions.push({
            type: a.type,
            request: {
              service_key: asStr(p.service_key)?.toLowerCase() ?? null,
              title,
              detail: asStr(p.detail) ?? null,
              city: asStr(p.city) ?? null,
              starts_at: asStr(p.starts_at) ?? null,
              party_size: Number.isFinite(Number(p.party_size)) && Number(p.party_size) > 0 ? Math.floor(Number(p.party_size)) : null,
            },
          });
        }
      } else if (a.type === 'request_delivery') {
        // A delivery order. Executed SERVER-SIDE (worker/delivery.mjs
        // createOrder) after the reply is sent, and only when index.mjs offered
        // this partner to this member in the first place — ids are copied from
        // the DELIVERY PARTNERS block, so an invented id simply finds nothing.
        // Dropped unless confirmed: the read-back is the whole point.
        const businessId = asStr(p.business_id);
        const items = Array.isArray(p.items)
          ? p.items.map((i) => ({ item_id: asStr(i?.item_id ?? i?.id), qty: Math.min(Math.max(Math.floor(Number(i?.qty)) || 1, 1), 20) })).filter((i) => i.item_id)
          : [];
        if (businessId && items.length && p.confirmed === true) {
          actions.push({
            type: a.type,
            order: {
              business_id: businessId,
              items,
              address: asStr(p.address) ?? null,
              note: asStr(p.note) ?? null,
              confirmed: true,
            },
          });
        }
      } else if (a.type === 'travel_referral') {
        // Dropped rather than defaulted, like book_table above. A referral is a
        // real email to a real travel agency naming a real traveller: "a trip
        // to somewhere, at some point" is not a thing anyone can quote, and a
        // destination invented server-side is a destination nobody asked for.
        // A destination or nothing.
        const dest = asStr(p.destination);
        if (dest) {
          const budget = Math.round(Number(p.budget_cs));
          actions.push({
            type: a.type,
            referral: {
              product: asStr(p.product)?.toLowerCase() ?? 'flight',
              origin: asStr(p.origin) ?? null,
              destination: dest,
              depart_on: asStr(p.depart_on) ?? null,
              return_on: asStr(p.return_on) ?? null,
              adults: Math.min(Math.max(Math.floor(Number(p.adults)) || 1, 1), 20),
              children: Math.min(Math.max(Math.floor(Number(p.children)) || 0, 0), 20),
              cabin: asStr(p.cabin) ?? null,
              // Null unless the traveller actually named a ceiling. A budget
              // the model inferred is a number an agency prices against and
              // nobody agreed to.
              budget_cs: Number.isFinite(budget) && budget > 0 ? budget : null,
              budget_currency: asStr(p.budget_currency) ?? null,
              notes: asStr(p.notes) ?? null,
              contact_email: asStr(p.contact_email) ?? null,
              contact_phone: asStr(p.contact_phone) ?? null,
            },
          });
        }
      } else if (a.type === 'flight_search') {
        if (p.fromCode && p.toCode && p.depart) {
          actions.push({
            type: a.type,
            search: {
              from: asStr(p.from) ?? null,
              to: asStr(p.to) ?? null,
              fromCode: String(p.fromCode).toUpperCase().slice(0, 3),
              toCode: String(p.toCode).toUpperCase().slice(0, 3),
              depart: asStr(p.depart),
              ret: asStr(p.ret) ?? null,
              adults: Math.max(1, Math.floor(Number(p.adults)) || 1),
              cabin: asStr(p.cabin) ?? null,
            },
          });
        }
      } else if (a.type === 'air') {
        const tool = asStr(p.tool);
        if (tool) actions.push({ type: a.type, tool, args: typeof p.args === 'object' && p.args ? p.args : {} });
      }
      else if (a.type === 'service') {
        const kind = ['ride', 'food', 'table', 'wellness', 'flight', 'hotel', 'rail'].includes(p.kind) ? p.kind : null;
        if (kind) {
          actions.push({
            type: a.type,
            kind,
            query: asStr(p.query) ?? null,
            to: asStr(p.to) ?? null,
            note: asStr(p.note) ?? null,
            // Travel search parameters — the app never sees these, but
            // optionsFor() needs them to prefill the comparison engines.
            from: asStr(p.from) ?? null,
            fromCode: asStr(p.fromCode) ?? null,
            toCode: asStr(p.toCode) ?? null,
            depart: asStr(p.depart) ?? null,
            ret: asStr(p.ret) ?? null,
            city: asStr(p.city) ?? null,
            checkin: asStr(p.checkin) ?? null,
            checkout: asStr(p.checkout) ?? null,
            adults: Number(p.adults) || null,
          });
        }
      } else if (a.type === 'create_event') {
        actions.push({
          type: a.type,
          title: asStr(p.title) ?? 'Our event',
          day: asStr(p.day) ?? null,
          time: asStr(p.time) ?? null,
          place: asStr(p.place) ?? null,
          address: asStr(p.address) ?? null,
          dress: asStr(p.dress) ?? null,
          note: asStr(p.note) ?? null,
          // The directory id, when the event is at a verified place. The server
          // resolves it to the business; the model never names a business id.
          place_id: asStr(p.place_id) ?? null,
          // Names only. A model that has just heard "invite Dre" knows a name
          // and nothing else — resolving it to a person is the server's job,
          // and the app's when the name is ambiguous.
          ask: Array.isArray(p.ask) ? p.ask.map((x) => asStr(x)).filter(Boolean).slice(0, 25) : [],
        });
      }
      else if (a.type === 'feature_request') actions.push({ type: a.type, summary: asStr(p.summary) ?? '', suggestion: asStr(p.suggestion) ?? '' });
      else if (a.type === 'remember') {
        const key = asStr(p.key);
        const value = asStr(p.value);
        if (key && value) actions.push({ type: 'remember', key, value });
      }
    } catch {
      // skip malformed payloads
    }
  }
  return { ...out, actions };
}
