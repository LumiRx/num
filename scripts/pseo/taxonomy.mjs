/**
 * Which sets NUM is allowed to publish a page about.
 *
 * The directory holds 2,529,721 places across 77 destinations under roughly
 * 300 distinct category strings. Crossing those gives about 12,000 pairs that
 * are *enumerable* — small enough to list completely on one page. Publishing
 * all of them would be the exact thing Google's March 2024 policy names as
 * scaled content abuse, and worse for NUM specifically: the site sells
 * "verified, never paid placement", and twelve thousand auto-generated lists
 * of crawled data would make that sentence untrue.
 *
 * So there are two filters, and this file is the first one.
 *
 * ── 1. TRAVEL INTENT
 *
 * A set earns a page when a traveller would actually search for it AND the
 * completeness is the point. "Every named beach on Phuket, with coordinates"
 * is a thing no single page on the web gives you. "Every dentist in Tokyo" is
 * a thing nobody wants and nobody would ever write the concierge line for — it
 * would sit in the queue forever, which is how a queue stops being read.
 *
 * Three categories of exclusion are deliberate and not negotiable on volume
 * grounds:
 *
 *   MEDICAL   hospitals, pharmacies, dentists, clinics. Emergency intent, and
 *             a stale row in a directory is a person driving to a closed door
 *             at 3am. Maps does this with live data; NUM does not have it.
 *   REGULATED cannabis, gambling, adult, firearms, pawn. Brand risk that no
 *             amount of long-tail traffic pays for.
 *   ERRANDS   supermarkets, clothing shops, car parts, homeware. A resident's
 *             search, not a traveller's, and Maps already answers it.
 *
 * ── 2. A HUMAN WROTE THE LINE
 *
 * Enforced in generate.mjs, not here. A set on this list still does not ship
 * until somebody writes the judgement that makes the page worth reading.
 *
 * `note` is the editorial brief for whoever writes that line: what this set is
 * FOR. It is not published copy.
 */

/**
 * @typedef {object} SetSpec
 * @property {string} slug   the URL segment, e.g. "beaches"
 * @property {string} title  plural noun for headings, e.g. "beaches"
 * @property {string} note   what the set is for — a brief, never published
 */

const S = (slug, title, note) => Object.freeze({ slug, title, note });

/**
 * Category string from `places.category` → the set it belongs to.
 *
 * Several categories map to ONE set on purpose: a traveller looking for a
 * place to pray does not care whether the crawler labelled it "Attraction ·
 * church" or "Catholic Church", and three near-identical pages for one city
 * is the city-swapping failure in miniature.
 */
export const CATEGORY_SETS = Object.freeze({
  /* ── the reasons people came ─────────────────────────────────────────── */
  'Beach': S('beaches', 'beaches',
    'Which one for which kind of day — sunset, families, quiet, monsoon season.'),
  'Viewpoint': S('viewpoints', 'viewpoints',
    'When the light is right, how hard the climb is, which are worth the taxi.'),
  'Hiking Trail': S('hiking-trails', 'hiking trails',
    'Length, difficulty, when it is too hot to start late.'),
  'National Park': S('national-parks', 'national parks',
    'What each is actually for, and how far out of town it really is.'),
  'Waterfall': S('waterfalls', 'waterfalls',
    'Which run dry in the dry season — the single most useful thing to say.'),
  'Rock Climbing Spot': S('climbing', 'climbing spots', 'Grade range, the season it is climbable, and who guides there.'),
  'Diving': S('diving', 'dive shops', 'Which sites they run to, the season for each, and their certification.'),
  'Watersports': S('watersports', 'watersports operators', 'What is genuinely safe to do when the warning flags are up.'),
  'Marina & charters': S('marinas', 'marinas and charters', 'Where the boats actually leave from, which is rarely the office.'),
  'Boat Tours': S('boat-tours', 'boat tours', 'Which islands they run to, how early to leave, how crowded it gets.'),
  'Golf': S('golf', 'golf courses', 'Green fees, whether visitors get on at all, and the best tee times.'),
  'Theme park': S('theme-parks', 'theme parks', 'Which age it suits, and which day of the week is quietest.'),
  'Water park': S('water-parks', 'water parks', 'Which age it suits, and which day of the week is quietest.'),
  'Zoo': S('zoos', 'zoos', 'Be honest about animal welfare where it is known, and say when it is not.'),
  'Aquarium': S('aquariums', 'aquariums', 'Worth it or not, for what age, and how long it actually takes.'),
  'Swimming Pool': S('pools', 'public pools', 'Which take non-members, at what hours, and the swim-cap rule.'),

  /* ── culture ─────────────────────────────────────────────────────────── */
  'Museum': S('museums', 'museums', 'Which one to choose if you only have a single afternoon.'),
  'Gallery': S('galleries', 'galleries', 'Which are free, which are worth paying for, and which are shops.'),
  'Theatre': S('theatres', 'theatres', 'What actually plays there, and how a visitor gets a seat.'),
  'Music Venue': S('music-venues', 'music venues', 'What kind of night each one actually is, and when it starts.'),
  'Jazz And Blues': S('jazz-bars', 'jazz bars', 'Which nights have a live set, and whether there is a cover.'),
  'Comedy Club': S('comedy-clubs', 'comedy clubs', 'Which run English-language nights, and how often.'),
  'Cinema': S('cinemas', 'cinemas', 'Which screen films in the original language rather than dubbed.'),
  'Cultural Center': S('cultural-centres', 'cultural centres', 'What is actually on, for whom, and in what language.'),
  'Palace': S('palaces', 'palaces', 'Which are still lived in, which you can enter, and what the ticket covers.'),
  'Fountain': S('fountains', 'fountains',
    'Which are worth crossing the city for, and which you photograph because you walked past.'),
  'Sculpture Statue': S('landmarks', 'landmarks and statues', 'The ones worth crossing town for, and the ones you pass anyway.'),
  'Attraction': S('attractions', 'attractions', 'What each actually is, in one line, for someone who has never heard of it.'),
  'Attraction · temple': S('temples', 'temples',
    'Dress rules, what time to arrive, which are working temples rather than sights.'),
  'Attraction · church': S('churches', 'churches',
    'Dress rules, what time to arrive, which are working churches rather than sights.'),
  'Catholic Church': S('churches', 'churches', 'Dress rules, mass times, which are worth entering.'),
  'Anglican Church': S('churches', 'churches', 'Dress rules, service times, and which are worth entering.'),
  'Attraction · mosque': S('mosques', 'mosques',
    'Whether non-Muslims may enter, when, and what to wear.'),
  'Attraction · place of worship': S('places-of-worship', 'places of worship',
    'Which welcome visitors, and the etiquette for each.'),
  'Place Of Worship': S('places-of-worship', 'places of worship',
    'Which welcome visitors, and the etiquette for each.'),
  'Synagogue': S('synagogues', 'synagogues', 'Service times, security at the door, and where to ask first.'),
  'Convents And Monasteries': S('monasteries', 'monasteries', 'Which take visitors, and which take overnight guests.'),
  'Attraction · park': S('parks', 'parks', 'Which is the one to run in, sit in, take children to.'),

  /* ── eating, where the set is the answer ─────────────────────────────── */
  'Vegan Restaurant': S('vegan', 'vegan restaurants',
    'This is a completeness question — a vegan traveller wants ALL of them, not the top five.'),
  'Vegetarian Restaurant': S('vegetarian', 'vegetarian restaurants',
    'Completeness matters more than ranking here.'),
  'Halal Restaurant': S('halal', 'halal restaurants',
    'Certified or self-declared is the distinction that matters. Say which if known.'),
  'Health Food Restaurant': S('health-food', 'health food restaurants', 'What each actually serves, since the label means very little.'),
  'Street food': S('street-food', 'street food',
    'Which stalls, what hours, and the one thing to order at each.'),
  'Market': S('markets', 'markets', 'Which days, which hours, and what each is really for.'),
  'Flea Market': S('flea-markets', 'flea markets', 'Which days it actually runs, and what time the good stuff goes.'),
  'Seafood Restaurant': S('seafood', 'seafood restaurants', 'Where the fish is actually landed, not merely where it is cooked.'),
  'Bubble Tea': S('bubble-tea', 'bubble tea shops', 'The local chains worth trying instead of the global ones.'),
  'Gelato': S('gelato', 'gelato shops', 'Which make it on site, and how you can tell by looking.'),
  'Chocolatier': S('chocolatiers', 'chocolatiers', 'Which are makers rather than resellers of somebody else\'s bars.'),
  'Winery': S('wineries', 'wineries', 'Which take walk-ins, and which need booking a week out.'),
  'Bar · brewery': S('breweries', 'breweries', 'Which brew on site, which only pour, and which run a tour.'),
  'Beer Garden': S('beer-gardens', 'beer gardens', 'Which are open-air year round, and which shut for the winter.'),
  'Whiskey Bar': S('whisky-bars', 'whisky bars', 'What is actually behind the bar, and what a pour costs.'),
  'Sake Bar': S('sake-bars', 'sake bars', 'Which have an English menu, and which just have a patient bartender.'),
  'Gay Bar': S('gay-bars', 'gay bars', 'Which nights are which, and how out this city actually is.'),
  'Irish Pub': S('irish-pubs', 'Irish pubs', 'Which show which sport, and which have the Guinness worth ordering.'),
  'Hotel Bar': S('hotel-bars', 'hotel bars', 'Which let non-guests in, the dress code, and the view from each.'),
  'Bar · lounge': S('cocktail-bars', 'cocktail bars', 'Which take reservations, the dress code, and when the queue starts.'),
  'Hookah Bar': S('shisha-bars', 'shisha bars', 'Which are indoors, which run late, and which serve food too.'),

  /* ── where people sleep, when the type is the search ─────────────────── */
  'Hostel': S('hostels', 'hostels', 'Which are party, which are quiet — the only thing that matters.'),
  'Guesthouse': S('guesthouses', 'guesthouses', 'Family-run or not, and what that changes about the stay.'),
  'Resort': S('resorts', 'resorts', 'Which beach it sits on, and how far it is from anything else.'),
  'Lodge': S('lodges', 'lodges', 'What the setting actually is, and how far from a road.'),
  'Inn': S('inns', 'inns', 'What the setting actually is, and whether food is included.'),
  'Campground': S('campgrounds', 'campgrounds', 'The season it opens, and whether you can pitch without booking.'),
  'Service Apartments': S('serviced-apartments', 'serviced apartments',
    'Minimum stay — the thing that decides it for a month-long visitor.'),
  'Apartment': S('apartments', 'apartment buildings', 'Which take short stays at all, and the minimum nights.'),

  /* ── getting around and getting sorted ───────────────────────────────── */
  'Metro Station': S('metro-stations', 'metro stations', 'Which lines each serves, and the one worth changing at.'),
  'Train Station': S('train-stations', 'train stations', 'Which serves which direction, and where to buy the ticket.'),
  'Bus Station': S('bus-stations', 'bus stations', 'Which serves long distance and which is local — easy to get wrong.'),
  'Airport Terminal': S('airport-terminals', 'airport terminals', 'Which airlines use each, and how long it takes to move between them.'),
  'Airport Lounge': S('airport-lounges', 'airport lounges', 'Which take a card at the door, which take cash, which take neither.'),
  'Luggage Storage': S('luggage-storage', 'luggage storage',
    'Hours and price — the whole search, for somebody with a bag and six hours.'),
  'Visitor Center': S('visitor-centres', 'visitor centres', 'Which actually have a human at a desk rather than a rack of leaflets.'),
  'Bike Rentals': S('bike-rental', 'bike rental', 'The deposit, and whether they ask to hold a passport — never leave one.'),
  'Vehicle rental': S('vehicle-rental', 'vehicle rental', 'Say what the licence law actually is, including the helmet rule.'),
  'Boat Rental And Training': S('boat-rental', 'boat rental', 'What licence the law actually requires, and the season it runs.'),
  'Car Sharing': S('car-sharing', 'car sharing', 'Which accept a foreign licence, and what the deposit is.'),
  'Internet Cafe': S('internet-cafes', 'internet cafés', 'Which have printing and scanning — the real reason anyone searches.'),

  /* ── doing something ─────────────────────────────────────────────────── */
  'Escape Rooms': S('escape-rooms', 'escape rooms', 'Which run in English, and the minimum group size.'),
  'Arcade': S('arcades', 'arcades', 'Retro or modern, which take coins, and which take a card.'),
  'Bowling Alley': S('bowling', 'bowling alleys', 'Which are open late, and which take walk-ins at the weekend.'),
  'Pool Billiards': S('pool-halls', 'pool halls', 'Which are open late, and whether tables are hourly or per game.'),
  'Tattoo & piercing': S('tattoo-studios', 'tattoo studios',
    'Walk-ins or appointment, and hygiene — say it plainly.'),
  'Meditation Center': S('meditation', 'meditation centres', 'Which take drop-ins, in what language, and whether it is free.'),
  'Dance School': S('dance-schools', 'dance schools', 'Which run a class tonight that a visitor can simply walk into.'),
  'Martial Arts Club': S('martial-arts', 'martial arts gyms', 'Which take drop-ins, and what gear they lend.'),
  'Boxing Class': S('boxing-gyms', 'boxing gyms', 'Which take visitors by the session rather than the month.'),
  'Tennis Court': S('tennis-courts', 'tennis courts', 'Which are public, how to book one, and whether racquets are for hire.'),
  'Basketball Court': S('basketball-courts', 'basketball courts', 'Which are public, which are lit at night, and where a pickup game runs.'),
  'Skate Park': S('skate-parks', 'skate parks', 'Which are covered, which matters a great deal in a wet season.'),
  'Dog Park': S('dog-parks', 'dog parks', 'Which are fenced, the off-lead rules, and whether there is water.'),
  'Playground': S('playgrounds', 'playgrounds', 'Which have shade and which have water — the two parent questions.'),
  'Bookstore': S('bookshops', 'bookshops', 'Which carry English, which carry second-hand, which have a café.'),
  'Arts And Crafts': S('craft-shops', 'craft shops', 'Which run a class a visitor can join for one afternoon.'),
  'Photography Store And Services': S('camera-shops', 'camera shops', 'Which repair, which rent, and which still sell and develop film.'),
  'Musical Instrument Store': S('music-shops', 'music shops', 'Which rent by the day, and which will restring on the spot.'),
  'Sightseeing Tour Agency': S('tour-operators', 'tour operators', 'What each actually runs, and at what group size.'),
});

/** A set is only enumerable — listable in full on one page — inside this band. */
export const MIN_SET = 8;
export const MAX_SET = 150;

/**
 * Every distinct set slug, with the category strings that feed it.
 * @returns {Map<string, {slug:string,title:string,note:string,categories:string[]}>}
 */
export function setsBySlug() {
  const out = new Map();
  for (const [category, spec] of Object.entries(CATEGORY_SETS)) {
    const cur = out.get(spec.slug) ?? { ...spec, categories: [] };
    cur.categories.push(category);
    out.set(spec.slug, cur);
  }
  return out;
}

/** Categories NUM will never build a set page for, and why. Used by the tests. */
export const NEVER = Object.freeze({
  medical: ['Hospital', 'Dentist', 'Pharmacy', 'Medical Supply', 'Medical Spa',
    'Nutritionist', 'Weight Loss Center', 'Hearing Aids', 'Laser Hair Removal',
    'Hair Replacement', 'Skin Care'],
  regulated: ['Cannabis Dispensary', 'Adult Entertainment', 'Betting Center',
    'Nightlife · casino', 'Gun And Ammo', 'Pawn Shop', 'Hunting And Fishing Supplies',
    'Lottery Ticket', 'E Cigarette Store', 'Tobacco Shop', 'Psychic'],
  errands: ['Supermarket', 'Convenience', 'Womens Clothing Store', 'Mens Clothing Store',
    'Childrens Clothing Store', 'Shoe Store', 'Home Goods Store', 'Home Improvement Store',
    'Automotive Parts And Accessories', 'Auto Body Shop', 'Auto Detailing', 'Tire Dealer And Repair',
    'Used Car Dealer', 'Automotive Dealer', 'Appliance Store', 'Mattress Store', 'Flooring Store',
    'Lumber Store', 'Electrical Supply Store', 'Carpet Store', 'Lighting Store', 'Paint Store',
    'Office Equipment', 'Wholesale Store', 'Discount Store', 'Pet Groomer', 'Pet Sitting',
    'Pet Boarding', 'Dry Cleaner', 'Shoe Repair', 'Uniform Store'],
});
