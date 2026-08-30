/**
 * What KIND of place is this, when the category just says "hotel"?
 *
 * ── WHY ──────────────────────────────────────────────────────────────────
 *
 * The UK slice of the directory holds 4,666 rows whose category contains
 * "hotel". Sampling them turned up Bath Spa University accommodation, halls of
 * residence run by student-housing operators, an NHS staff residence, hostels,
 * self-catering cottages, Airbnb listings and one outright spam domain.
 *
 * Recommending a hall of residence to a traveller looking for a hotel is the
 * kind of mistake that ends the conversation — and it is worse than returning
 * nothing, because it looks like NUM does not know what a hotel is.
 *
 * ── WHY A LABEL AND NOT A DELETE ─────────────────────────────────────────
 *
 * These rows are not wrong, they are mis-shelved. A student residence IS a
 * real place; somebody may genuinely search for it by name. Deleting loses
 * data we paid to collect and cannot get back, and a delete cannot be reviewed
 * later when a rule turns out to be too broad. So every row gets a `stay_kind`
 * and the CALLER decides what to show — which also means one bad rule is a
 * re-run, not an incident.
 *
 * Apartments and short-lets stay in. A serviced apartment is a legitimate
 * answer to "where do I stay in Bath"; a hall of residence is not.
 */

/** The only values this ever writes. Anything else is a bug. */
export const STAY_KINDS = Object.freeze([
  'hotel',      // the default, and what a concierge offers unqualified
  'apartment',  // serviced apartments, self-catering, short lets — offerable
  'student',    // halls of residence, university accommodation — NOT offerable
  'hostel',     // dorms — offerable, but only when someone asks for one
  'other',      // institutional, retail, or unclassifiable
]);

/** Domains that are never a bookable stay for a traveller. */
const INSTITUTIONAL = /\.ac\.uk|\.nhs\.uk|\.gov\.uk|\.sch\.uk|\.edu\b/i;

/** Student-housing operators. Their sites do not say "student" in the name. */
const STUDENT_OPERATORS =
  /nowstudents|unitestudents|iqstudent|student\.com|studentroost|hostmaker-student|collegiate-ac|fresh-student/i;

const STUDENT_WORDS =
  /\b(hall of residence|halls of residence|student|university|campus accommodation|residence hall)\b/i;

const HOSTEL_WORDS = /\b(hostel|backpacker|bunkhouse|yha)\b/i;

/**
 * Serviced-apartment operators whose brand name says nothing about what they
 * are. Every one of these appeared in the Bath or Edinburgh sample as a row
 * categorised "hotel": SACO, Staycity, Roomzzz, Fountain Court, Cheval,
 * Supercity, Fraser Suites. Misreading one as a hotel is harmless — both are
 * offerable — but the label is what lets a concierge say "a serviced
 * apartment" instead of "a hotel", which is the difference between a useful
 * answer and a small lie.
 */
const APARTMENT_OPERATORS =
  /sacoapartments|staycity|roomzzz|fountaincourtapartments|chevalcollection|supercityuk|frasershospitality|edinburghcitysuites/i;

const APARTMENT_WORDS =
  /\b(apartment|apartments|aparthotel|apart-hotel|serviced|self[- ]catering|holiday (let|home|cottage|rental)|cottage|villa rental|short let)\b/i;

/**
 * Classify one row.
 *
 * Order matters and is deliberate: institutional beats everything, because a
 * university's own domain is the strongest possible signal and outranks a name
 * that happens to read like a hotel ("Woodland Court"). Hostel beats apartment
 * because "hostel apartments" is a hostel. Apartment beats hotel because
 * "Fountain Court Apartments" is not a hotel even though the row says so.
 *
 * @param {{name?, website?, category?}} row
 * @returns {'hotel'|'apartment'|'student'|'hostel'|'other'}
 */
export function stayKind(row = {}) {
  const name = String(row.name ?? '');
  const site = String(row.website ?? '');
  const cat = String(row.category ?? '');
  const hay = `${name} ${cat}`;

  // A university or hospital domain is not a traveller's stay, whatever the
  // listing is called. This is the rule that catches "Woodland Court" and
  // "Bernard Ireland House", neither of which reads as student housing.
  if (INSTITUTIONAL.test(site)) return 'student';
  if (STUDENT_OPERATORS.test(site)) return 'student';
  if (STUDENT_WORDS.test(hay)) return 'student';

  if (HOSTEL_WORDS.test(hay)) return 'hostel';
  if (APARTMENT_WORDS.test(hay) || APARTMENT_OPERATORS.test(site)) return 'apartment';
  return 'hotel';
}

/**
 * What a concierge may offer when somebody asks for somewhere to stay without
 * naming a type. Hostels are real and fine — they are simply not what "book me
 * a hotel" means, and offering one unasked reads as a downgrade.
 */
export const OFFERABLE_UNASKED = Object.freeze(['hotel', 'apartment']);

/** True when this row may be offered for a plain "where do I stay" ask. */
export const offerable = (row) => OFFERABLE_UNASKED.includes(stayKind(row));
