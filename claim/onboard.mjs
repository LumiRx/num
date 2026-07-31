/**
 * NUM · turning a verified claim into a working merchant account.
 *
 * Before this module existed, /claim/verify created a `businesses` row and
 * stopped. A claimed business therefore had no num_business_profiles row and
 * no num_business_settings row, so it had no commission rate, no timezone,
 * no locale and no feature flags. It was verified and inert.
 *
 * That mattered because the corrected schema defaults (commission 10%, tz
 * Etc/UTC, locale en) can only fire when a row is actually inserted. Fixing
 * the DEFAULTs without creating the rows fixes nothing.
 *
 * Everything here is derived from the directory row we already hold, so a
 * merchant who verifies by SMS never has to retype facts we already know.
 */

// Dial codes for every country in `destinations`. Deliberately not a global
// list: an unknown country returns null rather than a guess, and null is
// reviewable where a wrong number is not.
const DIAL = {
  TH: '66', PT: '351', GB: '44', IE: '353', FR: '33', IT: '39', ES: '34',
  NL: '31', DE: '49', AT: '43', CZ: '420', HU: '36', DK: '45', SE: '46',
  CH: '41', GR: '30', HR: '385', IS: '354', TR: '90', JP: '81', KR: '82',
  SG: '65', HK: '852', TW: '886', MY: '60', VN: '84', KH: '855', PH: '63',
  AE: '971', LK: '94', IN: '91', ID: '62', MV: '960', MU: '230', MX: '52',
  US: '1', BS: '1', BB: '1',
};

// Countries where a national number carries a leading 0 that must be dropped
// before the country code. Everywhere else the leading digits are kept as
// dialled -- Italy notably keeps its 0, and NANP/DK/ES/CZ/SG/HK never had one.
const TRUNK0 = new Set([
  'GB', 'IE', 'FR', 'NL', 'DE', 'AT', 'HU', 'SE', 'CH', 'HR', 'TR', 'JP',
  'KR', 'TW', 'MY', 'VN', 'KH', 'PH', 'AE', 'LK', 'IN', 'ID', 'MU', 'TH',
]);

// The 21 values num_business_profiles.vertical will accept. Kept in the same
// order as agents/worker.js VERTICALS so a diff between the two is obvious.
export const VERTICALS = new Set([
  'restaurant', 'cafe', 'bar', 'hotel', 'guesthouse', 'hostel', 'spa', 'massage',
  'boat', 'tour', 'market', 'shop', 'transport', 'taxi', 'event', 'clinic',
  'salon', 'gym', 'attraction', 'nightclub', 'other',
]);

// Exact matches, measured against the live GB/IE directory rather than guessed.
// The head of that distribution is restaurant / convenience / street food /
// bar / cafe, which between them are most of tomorrow's invite list.
const EXACT = {
  restaurant: 'restaurant', 'street food': 'restaurant', deli: 'shop',
  'food delivery service': 'restaurant',
  convenience: 'shop', supermarket: 'shop', shopping: 'shop', retail: 'shop',
  pharmacy: 'shop', 'souvenirs & gifts': 'shop', 'wine & spirits': 'shop',
  tailor: 'shop', 'arts and crafts': 'shop', 'shoe store': 'shop',
  'antique store': 'shop', bookstore: 'shop', 'carpet store': 'shop',
  'home goods store': 'shop',
  bar: 'bar', nightlife: 'nightclub',
  cafe: 'cafe', bakery: 'cafe', dessert: 'cafe',
  'beauty & spa': 'spa', 'massage & spa': 'massage',
  'tattoo & piercing': 'salon',
  hotel: 'hotel', guesthouse: 'guesthouse', apartment: 'guesthouse',
  hostel: 'hostel',
  'vehicle rental': 'transport', transport: 'transport',
  'train station': 'transport',
  'gym & fitness': 'gym', 'martial arts club': 'gym',
  'sports club and league': 'gym', golf: 'attraction',
  attraction: 'attraction', gallery: 'attraction', museum: 'attraction',
  theatre: 'attraction', cinema: 'attraction', viewpoint: 'attraction',
  'tours & travel': 'tour', 'travel agents': 'tour',
  market: 'market',
  hospital: 'clinic', dentist: 'clinic',
};

// Fallbacks for the long tail ("italian restaurant", "womens clothing store",
// "topic concert venue"). Ordered: the first hit wins, so the narrow cases sit
// above the broad ones -- nightclub before bar, salon before spa. Word
// boundaries throughout, because otherwise "barber" reads as a bar.
const RULES = [
  [/\b(restaurant|eatery|bistro|canteen|diner|steakhouse|pizzeria|grill)\b/, 'restaurant'],
  [/\b(cafe|coffee|espresso|tearoom|patisserie|bakery|creamery)\b/, 'cafe'],
  [/\b(hostel)\b/, 'hostel'],
  [/\b(guesthouse|guest house|bed and breakfast|apartment|villa|lodge)\b/, 'guesthouse'],
  [/\b(hotel|resort|inn)\b/, 'hotel'],
  [/\b(nightclub|night club|nightlife|disco)\b/, 'nightclub'],
  [/\b(bar|pub|brewery|taproom|cocktail|distillery)\b/, 'bar'],
  [/\b(salon|barber|hairdresser|hairdressing|nail|tattoo|beauty)\b/, 'salon'],
  [/\b(massage)\b/, 'massage'],
  [/\b(spa|sauna|wellness)\b/, 'spa'],
  [/\b(gym|fitness|yoga|pilates|martial arts|sports?|crossfit)\b/, 'gym'],
  [/\b(market|bazaar)\b/, 'market'],
  [/\b(clinic|hospital|dental|dentist|doctors?|medical|physio|veterinary)\b/, 'clinic'],
  [/\b(museum|gallery|theatre|theater|cinema|park|zoo|aquarium|monument|castle|garden|landmark|viewpoint|cathedral|palace)\b/, 'attraction'],
  [/\b(tours?|travel|sightseeing|excursion)\b/, 'tour'],
  [/\b(taxi|cab|minicab|chauffeur)\b/, 'taxi'],
  [/\b(boat|yacht|cruise|ferry|sailing|diving)\b/, 'boat'],
  [/\b(transport|station|rental|car hire|parking|airport|rail)\b/, 'transport'],
  [/\b(events?|venue|concert|conference|wedding|catering)\b/, 'event'],
  [/\b(store|shop|boutique|retail|grocer|pharmacy|optician|florist|jeweller|jeweler|supermarket)\b/, 'shop'],
];

/**
 * Directory category -> profile vertical.
 *
 * The directory stores messy human labels ("Shopping · jewellery",
 * "Cafe" with an acute accent, "Attraction · park"). The profile column
 * takes a closed set of 21. Anything we cannot place confidently becomes
 * 'other' rather than a guess: 'other' shows up in review, a wrong guess does
 * not, and a mislabelled merchant is worse than an unlabelled one.
 */
export function verticalFor(category) {
  if (!category) return 'other';
  const base = String(category)
    .split(/[\u00b7|/>]/)[0]               // 'Shopping <dot> jewellery' -> 'Shopping '
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // accented cafe -> cafe
    .toLowerCase().replace(/\s+/g, ' ').trim();
  if (!base) return 'other';
  const hit = EXACT[base] || RULES.find(([re]) => re.test(base))?.[1] || 'other';
  return VERTICALS.has(hit) ? hit : 'other';
}

/**
 * Best-effort E.164. Returns null rather than a malformed number, because the
 * column is named phone_e164 and anything else in it silently breaks SMS
 * later. The raw directory number is never lost -- it stays on places.phone.
 */
export function toE164(raw, country) {
  if (!raw) return null;
  const s = String(raw).trim().replace(/[^\d+]/g, '');
  if (!s) return null;
  if (s.startsWith('+')) {
    const d = s.slice(1).replace(/\D/g, '');
    return d.length >= 8 && d.length <= 15 ? '+' + d : null;
  }
  const dial = DIAL[String(country || '').toUpperCase()];
  if (!dial) return null;
  let d = s.replace(/\D/g, '');
  if (d.startsWith(dial) && d.length >= dial.length + 7) return '+' + d;
  if (TRUNK0.has(String(country).toUpperCase()) && d.startsWith('0')) d = d.slice(1);
  const out = dial + d;
  return out.length >= 8 && out.length <= 15 ? '+' + out : null;
}

/**
 * The two rows that make a verified business actually operable. Returns
 * prepared statements so the caller can append them to the existing
 * env.DB.batch() and keep the whole verification atomic -- a business that
 * exists without a profile is exactly the state this module removes.
 */
export async function onboardStatements(env, businessId, place, verifiedBy) {
  const dest = place?.dest
    ? await env.DB.prepare('SELECT name, tz, country FROM destinations WHERE slug=?1')
        .bind(place.dest).first()
    : null;

  const country = place?.country || dest?.country || null;
  const tz = dest?.tz || 'Etc/UTC';
  const city = dest?.name || place?.dest || null;
  const vertical = verticalFor(place?.category);
  const phone = toE164(place?.phone, country);

  return [
    env.DB.prepare(
      `INSERT INTO num_business_profiles
         (business_id, vertical, country, city, area, address, lat, lng,
          timezone, place_id, phone_e164, email, website,
          verified_by, verified_at, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,
               CAST(strftime('%s','now') AS INTEGER),
               CAST(strftime('%s','now') AS INTEGER),
               CAST(strftime('%s','now') AS INTEGER))
       ON CONFLICT(business_id) DO NOTHING`,
    ).bind(
      businessId, vertical, country, city, place?.area ?? null, place?.address ?? null,
      place?.lat ?? null, place?.lng ?? null, tz, place?.id ?? null, phone,
      place?.email ?? null, place?.website ?? null, verifiedBy,
    ),
    env.DB.prepare(
      `INSERT INTO num_business_settings (business_id, updated_at, updated_by)
       VALUES (?1, CAST(strftime('%s','now') AS INTEGER), ?2)
       ON CONFLICT(business_id) DO NOTHING`,
    ).bind(businessId, verifiedBy),
  ];
}
