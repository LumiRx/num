// Where the concierge is standing changes what it may say — and what it owes.
//
// ── WHY A FILTER AND NOT JUST A PROMPT ───────────────────────────────────
//
// The system prompt is where a model is TOLD what to say. It is not where you
// find out whether it listened. Num asks that model, in the same breath, to be
// warm, opinionated and decisive, and the failure mode of a warm, opinionated
// concierge in the Gulf is naming the wrong thing. There is no intermediary
// safe harbour in UAE law: Federal Decree-Law 34/2021 Art 53 makes a platform
// directly liable for unlawful content it makes available (AED 300k–1m), and
// Art 58 extends the same penalties to the people actually managing it.
//
// So the brief goes in before generation and this screen runs on the text
// about to be sent. A prompt is a request. This is a gate.
//
// ── THE THREE EXPOSURES THAT ARE NOT THE OBVIOUS ONES ────────────────────
//
// Everyone assumes the risk here is alcohol and LGBTQ content. Researched
// against the actual statutes, the real ones are:
//
//   1. HALLUCINATION IS A CRIMINAL OFFENCE. Art 52 punishes spreading false
//      news (≥1 year, ≥AED 100k — doubled during a crisis), and Art 54 names
//      automated systems disseminating false data specifically. A model that
//      invents a restaurant closure, a price, or a security incident has
//      committed an offence. Our grounding and anti-invention rules are not
//      only a quality feature in this market; they are the compliance story.
//
//   2. STAFF-LEVEL CRITICISM IN A REVIEW. Art 43 defamation carries AED
//      250k–500k, and — this is the part that catches foreign teams — TRUTH
//      IS NOT A GENERAL DEFENCE. Criticising the dish, the wait or the room
//      is lawful. The moment text attacks an identifiable person's character
//      it crosses into criminal defamation. An influencer paid AED 81,000
//      over a restaurant review.
//
//   3. TELLING SOMEBODY TO USE A VPN. Art 10 punishes circumventing a network
//      protocol to commit or conceal an offence with AED 500k–2m, and Art 27
//      covers inciting disobedience of legislation. "Use a VPN for WhatsApp
//      calling" is the single most natural helpful sentence a travel
//      concierge could produce here, and it is the one that puts Num in the
//      frame rather than the traveller.
//
// ── THE TWO DISTINCTIONS THAT KEEP IT USABLE ─────────────────────────────
//
// ANSWERING IS NOT RECOMMENDING. "Can I drink in Dubai?" deserves a true
// answer. "Is alcohol legal in Saudi Arabia?" deserves a true answer, and
// pretending otherwise gets somebody arrested. What is forbidden is SENDING
// SOMEBODY SOMEWHERE. A traveller who asks an honest question and gets a wall
// is not being protected; they are being failed, and they will go and ask
// something less careful instead.
//
// LISTING IS NOT ADVERTISING. The Media Regulation Law (55/2023) prohibits
// advertising alcohol outright, while naming a licensed bar is ordinary — Time
// Out Dubai does it weekly. So the UAE rule is not "never mention a bar"; it
// is "never write the drinks marketing copy".
//
// ── AND A DUTY THAT RUNS THE OTHER WAY ───────────────────────────────────
//
// There is NO UAE statute requiring an app to warn travellers about local law.
// This is duty of care, not compliance. But a concierge that confidently plans
// somebody's trip and does not mention that their ADHD medication needs a
// MOHAP permit two weeks ahead has failed them in the way that actually ends
// in a cell. The warnings below are the things that get tourists detained,
// ranked by how often they really happen.

export const BLOCK = 'block';

/**
 * Recommendation shapes. The filter looks for Num SENDING somebody, so a
 * topic term only matters within reach of one of these.
 */
const SENDING = /\b(recommend|i'?d go|i would go|head (?:to|over)|go to|try|check out|worth a visit|book|reserve|take you|best (?:place|spot|bar|club)|my pick|you'?ll love|pop (?:in|into)|drop by|make your way|you (?:can|could|should) (?:get|find|buy|use|score|ask|preach|photograph|film|snap|mock|criticis\w+|criticiz\w+|convert|smoke|drink|gamble|bet|hire|pick up)|i (?:can|could|will|'ll) (?:find|get|sort|arrange|book|point|line up|hook)|let me (?:find|get|book|sort|arrange)|just (?:use|ask|go)|grab (?:a|some)|go for it|say the word|no one minds|nobody minds|they do not mind|they don'?t mind)\b/i;

/**
 * Refusal and negation. A reply saying "I can't point you at a bar here"
 * contains both a topic term and a sending verb, and it is exactly the
 * behaviour we asked for. Flagging it would teach us to weaken the prompt
 * that produced the right answer.
 */
const NEG = 'go|drink|try|buy|use|touch|photograph|film|ask|risk|bother|do it|suggest|recommend|point|send|help';

// `never`, `do not` and `don't` used to sit here bare, and "they do not mind"
// was enough to launder a recommendation to photograph police — the negation
// has to be aimed at the ACT, not merely present in the sentence.
const REFUSING = new RegExp(
  '\\b(can\'?t|cannot|not able|won\'?t|will not|isn\'?t (?:something|possible)'
  + '|is illegal|are illegal|not legal|illegal|prohibited|banned|against the law'
  + '|no alcohol|alcohol[- ]free|non[- ]alcoholic|dry|not permitted|not allowed'
  + '|avoid|steer clear|instead|criminal offence|you\'?d be arrested'
  + '|not something (?:i|we)|nothing (?:i|we) can'
  + `|never (?:${NEG})|do not (?:${NEG})|don'?t (?:${NEG})|would not (?:${NEG})|wouldn'?t (?:${NEG})`
  + `|not going to (?:${NEG})|not gonna (?:${NEG})`
  + ')\\b',
  'i',
);

const NEAR = 100;

const TOPICS = Object.freeze({
  // Naming a licensed venue is fine in the UAE; writing drinks marketing is
  // not, and in Saudi neither is. `alcohol_promo` is the advertising shape,
  // separated from the plain mention so the UAE can allow one and block the
  // other.
  alcohol: /\b(bar|bars|pub|pubs|cocktail|cocktails|brewery|wine|beer|spirits|whisky|whiskey|vodka|gin|champagne|nightcap|booze)\b/i,
  alcohol_promo: /\b(happy hour|ladies'? night|free[- ]flow|bottomless|two for one|2[- ]for[- ]1|drinks? (?:deal|offer|promo|package)|open bar|bar crawl|get (?:drunk|hammered|wasted)|drink (?:up|deal))\b/i,

  lgbtq_venue: /\b(gay bar|gay club|gay scene|lgbtq?\+? (?:bar|club|venue|night|scene|guide)|drag (?:show|bar|night)|queer (?:bar|club|night))\b/i,
  gambling: /\b(casino|casinos|roulette|blackjack table|slot machines?|betting (?:shop|site|app)|sportsbook|poker room|place a bet)\b/i,
  pork: /\b(pork|bacon|prosciutto|chorizo|pancetta|pulled pork|pork belly|ham hock)\b/i,

  // Cybercrime Art 33 — incitement to immoral acts or prostitution.
  // Temporary imprisonment plus AED 250k–1m. The highest-severity thing a
  // concierge can plausibly be asked for.
  sex_work: /\b(escort|escorts|prostitut\w*|brothel|massage with (?:extras|happy ending)|happy ending|call girl|sex worker)\b/i,

  // Art 31 (narcotics online) and Federal Decree-Law 30/2021. CBD is banned
  // outright regardless of legality at origin, which is the trap.
  drugs: /\b(weed|cannabis|marijuana|hashish|cbd|thc|cocaine|mdma|ecstasy|ketamine|shrooms|magic mushrooms|kratom|dealer|score some|edibles)\b/i,

  // Art 10 — circumventing a network protocol, AED 500k–2m — and Art 27,
  // inciting disobedience of legislation. Telling somebody to VPN around a
  // block is the most natural helpful sentence here and the most dangerous.
  vpn_circumvention: /\b(vpn|proxy)\b/i,

  // Art 25 (mockery of the UAE, its institutions or officials, to 5 years)
  // and Art 28 (offending foreign countries). An LLM discussing regional
  // politics walks straight into the second one.
  // NOT a bare mention of the ruler. "The Ruler's palace is worth a visit" is
  // an ordinary and good answer, and an earlier draft of this line blocked it
  // — a filter that eats the Qasr Al Watan recommendation has made Num worse
  // in Abu Dhabi without making it safer anywhere.
  state_criticism: /\b(?:(?:criticis|criticiz|mock|insult|slag off|slate)\w*\s+(?:the\s+)?(?:ruler|sheikh|royal family|government|regime|authorities|emirates)|the regime|government here is|this country is (?:backward|repressive|awful|a joke)|human rights record|corrupt (?:government|police|officials|regime))\b/i,

  // Art 37, to 7 years for insulting the Divine Essence or the Messengers,
  // plus Federal Decree-Law 34/2023 Art 4. Includes proselytising in either
  // direction — recommending a church to attend is fine, discussing
  // conversion is not.
  // "Islam is the state religion; the Grand Mosque is worth a visit" is a good
  // answer, and a bare `islam is` caught it. What is actually forbidden is
  // proselytising, apostasy talk, and insult — not the noun.
  religion: /\b(?:convert to|converting to|leave islam|renounce (?:islam|your faith)|apostasy|preach to|spread the gospel|missionary work|hand out (?:bibles|tracts)|blasphem\w*|insult\w*\s+(?:islam|the prophet|allah|god)|the prophet (?:was|is) a)\b/i,

  // Art 44 — unauthorised photographing or publishing of others' images,
  // ≥6 months and AED 150k–500k, close to strict liability. Currently acute:
  // over 100 detentions reported for images of security incidents, including
  // in private messages.
  // `palace` is deliberately absent. Qasr Al Watan is a palace that sells
  // tickets and asks you to photograph it, and Emirates Palace is a hotel.
  // The buildings that matter are covered by the duty text instead, where
  // being over-inclusive costs a warning rather than a good answer.
  photography: /\b(photograph|photo of|take a picture of|film|filming|snap) (?:the |a |some )?(?:people|woman|women|girl|family|locals|police|soldier|airport|military|checkpoint|border post|government building)\b/i,
});

/** Rules whose match is a duty to WARN, not a duty to stay silent. */
const DUTIES = Object.freeze({
  medication:
    'MEDICATION IS THE ONE THAT ACTUALLY GETS PEOPLE ARRESTED. Codeine, tramadol, benzodiazepines (Xanax, Valium), '
    + 'ADHD stimulants (Ritalin, Adderall), strong painkillers and sleeping tablets all need a MOHAP eDrug permit '
    + 'applied for at least two weeks before travel — it is free. Bring the original English prescription and the '
    + 'original packaging, and DECLARE at the red channel. Declaring an unpermitted medicine usually means it is '
    + 'confiscated; concealing it becomes a drug-import case. CBD is banned outright however legal it is at home.',
  photography:
    'PHOTOGRAPHY: get consent before photographing anyone, especially women, families and children — doing it '
    + 'without consent is a privacy offence, not a faux pas, and people are arrested for it on beaches. Never '
    + 'photograph government or military buildings, palaces, checkpoints or airports. And do not photograph or '
    + 'forward anything relating to a security incident: people have been detained for images in private messages, '
    + 'including for receiving one and not deleting it.',
  alcohol_rules:
    'ALCOHOL, PRACTICALLY: drinking in a licensed bar, restaurant or hotel needs no licence anywhere it is '
    + 'permitted. Being drunk in public is an offence, and driving is zero tolerance — any detectable alcohol at '
    + 'all. SHARJAH IS COMPLETELY DRY, including in international hotels, so never send somebody there for a drink.',
  debts:
    'BEFORE THEY LEAVE: settle every bill, fine and card. Unpaid debts produce travel bans and a retained passport '
    + 'rather than a court case, and it can surface on their next visit rather than this one.',
  decency:
    'PUBLIC DECENCY: kissing and heavy public affection can be prosecuted on a complaint, and rude gestures — '
    + 'including a middle-finger emoji — are treated as indecent. Enforcement is relaxed in Dubai tourist areas '
    + 'and meaningfully stricter in Sharjah, Deira, family malls and outside the tourist zones. Sharjah has its own '
    + 'written decency rules on dress and on unmarried couples.',
});

export const POLICIES = Object.freeze({
  AE: {
    country: 'AE',
    name: 'the UAE',
    // Alcohol is deliberately NOT blocked — it is legal in licensed venues and
    // blocking it would delete most of Dubai. `alcohol_promo` is blocked
    // instead, because advertising alcohol is prohibited under the Media
    // Regulation Law while listing a venue is not.
    block: ['alcohol_promo', 'lgbtq_venue', 'gambling', 'sex_work', 'drugs',
      'vpn_circumvention', 'state_criticism', 'religion', 'photography'],
    warn: ['medication', 'photography', 'alcohol_rules', 'debts', 'decency'],
    brief:
      'WHERE YOU ARE — THE UAE. There is no platform safe harbour in UAE law, so what you write is Num\'s liability, '
      + 'not only the traveller\'s. Read this as carefully as the voice rules.\n\n'
      + 'NEVER INVENT A FACT HERE. Spreading false information is a criminal offence in the UAE, and the law names '
      + 'automated systems specifically. A made-up closing time, price, or security claim is not a bad answer here, '
      + 'it is an offence. If you do not know, say you do not know.\n\n'
      + 'ALCOHOL IS FINE TO NAME AND WRONG TO ADVERTISE. It is legal in licensed venues, so recommending a rooftop or '
      + 'a hotel bar is completely normal and you should do it when it is the right answer. What you must not write is '
      + 'drinks marketing — no happy hours, no bottomless brunch copy, no free-flow deals, nothing that makes drinking '
      + 'the point of the evening. Sharjah is entirely dry; never send anybody there for a drink.\n\n'
      + 'NEVER CRITICISE A NAMED PERSON. Say the dish was disappointing, the room was loud, the wait was long — never '
      + 'that a manager was rude or a waiter was slow. Truth is not a defence against defamation here and it is the '
      + 'staff-level detail that turns a review into a criminal matter.\n\n'
      + 'NEVER SUGGEST A VPN. Not for calling apps, not for anything. Telling somebody to route around a block is an '
      + 'offence committed by us, not by them. If a service is blocked, say so plainly and offer a legal alternative.\n\n'
      + 'REFUSE OUTRIGHT: escorts or anything sexual for hire, drugs of any kind including CBD, and gambling — no '
      + 'casino operates in the UAE and the only licensed product is the national lottery. Do not surface LGBTQ '
      + 'venues, events or scene guides; you may answer factually and neutrally about the law if asked directly.\n\n'
      + 'STAY OUT OF POLITICS AND RELIGION. No mockery or criticism of the UAE, its rulers or its institutions, and '
      + 'none of any other country either — offending a foreign state is separately an offence. No theological '
      + 'argument and no proselytising in either direction. Recommending a church, temple or gurdwara to visit is '
      + 'completely fine.\n\n'
      + 'WHAT YOU OWE THEM, UNPROMPTED, WHEN IT IS RELEVANT: medication permits, photography consent, and — right now '
      + '— never photographing or forwarding anything about a security incident. Those are the things that actually '
      + 'end with somebody detained.\n\n'
      + 'If somebody asks directly whether something is legal, answer honestly and plainly. Refusing a straight '
      + 'question helps nobody and they will go and ask something less careful.',
  },

  SA: {
    country: 'SA',
    name: 'Saudi Arabia',
    block: ['alcohol', 'alcohol_promo', 'lgbtq_venue', 'gambling', 'pork', 'sex_work',
      'drugs', 'vpn_circumvention', 'state_criticism', 'religion'],
    warn: ['medication', 'photography', 'decency'],
    brief:
      'WHERE YOU ARE — SAUDI ARABIA. Alcohol is illegal, full stop. Never name a bar, never suggest where to drink, '
      + 'and if asked, say plainly it is not available in the Kingdom — that is the honest and useful answer, not a '
      + 'dodge. The same goes for gambling, pork, drugs and anything sexual for hire. Do not surface LGBTQ venues or '
      + 'events; the penalties are severe.\n'
      + 'Entertainment is a different matter and is opening fast: concerts, Riyadh Season, mixed venues and '
      + 'restaurants are all good answers.\n'
      + 'RAMADAN IS NOT ETIQUETTE HERE. Eating or drinking in public during fasting hours is an offence, so a lunch '
      + 'recommendation during Ramadan can get somebody in real trouble. Check the date before you answer.\n'
      + 'MAKKAH: non-Muslims are legally barred from the city and restricted in central Madinah. If a trip touches '
      + 'either, say so before anything else — routing somebody to a city they cannot legally enter is a genuine '
      + 'harm, not a bad suggestion.\n'
      + 'Never suggest a VPN, never invent a fact, and never criticise the state, another state, or anybody\'s '
      + 'religion.',
  },
});

export const policyFor = (cc) => POLICIES[String(cc || '').toUpperCase()] || null;

/** The duty-of-care lines, for a caller that wants them separately. */
export const dutiesFor = (policy) => (policy?.warn || []).map((k) => DUTIES[k]).filter(Boolean);

/**
 * The brief that goes into the prompt: what may not be said, then what is
 * owed. The duties ride along with the brief on purpose — a caller that
 * remembered the restrictions and forgot the warnings is the failure mode
 * this market actually punishes, and the person detained over an ADHD
 * prescription was never at risk from anything on the block list.
 */
export const policyBrief = (policy) => {
  if (!policy) return '';
  const duties = dutiesFor(policy);
  if (!duties.length) return `\n\n${policy.brief}`;
  return `\n\n${policy.brief}\n\n`
    + 'WHAT YOU OWE THEM — DUTY OF CARE, NOT CENSORSHIP. No law obliges an app to say these things; they are the '
    + 'things that actually end with a traveller detained. Raise the one the trip touches, in your own voice, at the '
    + 'moment it is useful. Never recite the list.\n\n- '
    + duties.join('\n\n- ');
};

function sends(sentence, re) {
  const m = re.exec(sentence);
  if (!m) return false;
  const at = m.index;
  const win = sentence.slice(Math.max(0, at - NEAR), Math.min(sentence.length, at + m[0].length + NEAR));
  if (REFUSING.test(win)) return false;
  return SENDING.test(win);
}

/**
 * Screen a reply before it is sent.
 *
 * Sentence-scoped on purpose: a reply can refuse in one sentence and
 * recommend in the next, and screening the whole blob would let the refusal
 * launder the recommendation.
 *
 * @returns {{ok: true} | {ok: false, rule: string, sentence: string}}
 */
export function screen(reply, policy) {
  if (!policy || !reply) return { ok: true };
  const sentences = String(reply).split(/(?<=[.!?\n])\s+/);
  for (const s of sentences) {
    for (const rule of policy.block) {
      const re = TOPICS[rule];
      if (re && sends(s, re)) return { ok: false, rule, sentence: s.trim().slice(0, 160) };
    }
  }
  return { ok: true };
}

/**
 * What to say instead. Never a bare refusal — somebody asked a real question
 * and gets the true reason plus somewhere else to go.
 */
export const SUBSTITUTES = Object.freeze({
  alcohol: 'That is one thing I genuinely cannot help with here — alcohol is not available in the Kingdom, and I would rather tell you straight than send you somewhere that does not exist. What I can do is find you somewhere worth sitting: the coffee scene is very good and the restaurant rooms are better than people expect. Want me to pick one?',
  alcohol_promo: 'I will point you at good rooms, but I am not going to write you a drinks-deal pitch — promoting alcohol is not allowed here even where drinking it is. Tell me the night you actually want and I will find the right place for it. Rooftop, quiet corner, somewhere with a view?',
  lgbtq_venue: 'I am not able to point you towards that here, and I would rather say so plainly than pretend I have not understood. Is there something else I can line up for the evening?',
  gambling: 'There is no casino in the UAE — the only licensed thing of that kind is the national lottery, and I would not send you anywhere else for it. If it is a big night you are after though, that I can do. What sort of room are you in the mood for?',
  pork: 'That one is not available here, so I will not send you looking. Tell me what you were actually in the mood for — something rich, something smoky? — and I will find the closest thing worth eating.',
  sex_work: 'No — that is not something I will help with anywhere, and here it carries serious criminal penalties for everyone involved. Is there something else I can sort for you tonight?',
  drugs: 'I will not help with that, and I would be doing you a disservice if I softened it: this is a zero-tolerance country, traces from something you took before you arrived can be enough, and refusing a test is a separate offence. If you are after a good night, let me find you one properly.',
  vpn_circumvention: 'I am not going to walk you around a block — doing that is an offence here and the exposure is real. If it is calling home you need, the regular apps work over data for messages, and most hotels and telecom packages have a legal calling option. Want me to find out what your hotel offers?',
  state_criticism: 'I will leave the politics alone — that is genuinely not safe ground for me to hold forth on here, for either of us. What can I help you actually do today?',
  religion: 'That is not a conversation I should be having here, and I mean that about the setting rather than about you. If you want to visit a mosque, a church or a temple, though, I can tell you which ones welcome visitors and when to go.',
  photography: 'I would leave the camera down for that one. Photographing people without asking is a privacy offence here rather than bad manners, and anything involving police, airports or government buildings is a hard no. Somewhere scenic I can point you at instead?',
});

export const substituteFor = (rule) =>
  SUBSTITUTES[rule] || 'That is not something I can help with here. Tell me what else you need and I will sort it.';
