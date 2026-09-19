// WHO THE INVITE LIST MUST NOT EMAIL, AND WHO IT MUST NOT DROP.
//
// Two rules that both read the email domain, and both of which are one wrong
// entry away from doing damage in opposite directions.
//
// 1. CHAIN_DOMAINS. Until 19 Sep excludeReason read only the category and the
//    name, so occonnellt@dominos.com tripped nothing and eleven Domino's staff
//    were invited to claim a NUM listing. That bucket bounced at 25%.
//
// 2. FREEMAIL_DOMAINS. The freemail set is matched on the first label, which
//    is what makes it work worldwide — but American ISP mail does not reduce
//    to a known label, so sbcglobal.net and att.net were read as private
//    company domains. 70 independents on their home ISP address.
//
// The danger in rule 1 is the mirror of rule 2: set the threshold too low and
// it deletes exactly the small multi-venue operators the list exists to find.
// The tests below hold both ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// The same two imports invitecron.mjs uses.
import { isFreemail, excludeReason } from './invite_gen.mjs';

test('American consumer ISP mail is freemail, not a company domain', () => {
  for (const d of ['sbcglobal.net', 'att.net', 'earthlink.net', 'pacbell.net',
                   'verizon.net', 'comcast.net', 'cox.net', 'charter.net',
                   'roadrunner.com', 'juno.com', 'rogers.com', 'shaw.ca']) {
    assert.equal(isFreemail(d), true, `${d} should be freemail`);
  }
});

test('the worldwide first-label matching still works', () => {
  for (const d of ['gmail.com', 'hotmail.co.uk', 't-online.de', 'yahoo.fr',
                   'seznam.cz', 'libero.it', 'sapo.pt', 'naver.com']) {
    assert.equal(isFreemail(d), true, `${d} should be freemail`);
  }
});

test('a real business domain is not freemail — including the risky words', () => {
  // These are why the US ISPs are matched whole rather than by first label.
  // In a TRAVEL directory "charter", "cox" and "frontier" are plausible
  // business names, and reading them as freemail would misfile real venues.
  for (const d of ['accor.com', 'auchan.pt', 'gjelina.com', 'hugosrestaurant.com',
                   'charter-yachts.com', 'coxandsons.co.uk', 'frontierlodge.com',
                   'shawbrothers.ie', 'attic-bar.com']) {
    assert.equal(isFreemail(d), false, `${d} should NOT be freemail`);
  }
});

test('the eleven Domino\'s staff who started all this are now excluded', () => {
  // The motivating case, and the one the first version of the rule missed:
  // every Domino's branch is called "Domino's", so counting distinct business
  // names per domain sees 2 and shrugs. It takes the franchise rule — many
  // leads, almost no name variety — to catch a franchise at all.
  assert.equal(
    excludeReason({ name: "Domino's Pizza", category: 'Pizza restaurant', email: 'occonnellt@dominos.com' }),
    'chain head office');
});

test('franchises are excluded even though every branch shares one name', () => {
  const franchises = [
    { name: 'Chipotle Mexican Grill', category: 'Mexican restaurant', email: 'x@chipotle.com' },
    { name: 'Taco Bell', category: 'Fast food restaurant', email: 'x@tacobell.com' },
    { name: "McDonald's", category: 'Fast food restaurant', email: 'x@mcdonalds.com' },
    { name: 'KFC', category: 'Chicken restaurant', email: 'dannyh@kentuckyfriedchicken.com' },
    { name: 'Costa Coffee', category: 'Coffee shop', email: 'x@costacoffee.co.uk' },
    { name: 'Lidl', category: 'Supermarket', email: 'x@lidl.hu' },
  ];
  for (const lead of franchises) {
    assert.equal(excludeReason(lead), 'chain head office', `${lead.email} should be excluded`);
  }
});

test('groups are excluded where the venues are all named differently', () => {
  const groups = [
    { name: 'Hotel NH Roma Centro', category: 'Hotel', email: 'x@nh-hotels.com' },
    { name: 'Beehive Inn', category: 'Pub', email: 'x@greeneking.co.uk' },
    { name: 'Templo de Debod', category: 'Tourist attraction', email: 'x@madrid.es' },
    { name: 'Pinacoteca di Brera', category: 'Museum', email: 'x@beniculturali.it' },
  ];
  for (const lead of groups) {
    assert.equal(excludeReason(lead), 'chain head office', `${lead.email} should be excluded`);
  }
});

test('a small operator with several venues is NOT excluded', () => {
  // The whole reason the threshold is ten. mokumbootverhuur.nl has six names
  // behind it and is one Amsterdam boat-rental business with several moorings;
  // athens-smartstay.com has five and is a small apartment host. Both are
  // exactly the customer this list exists to find.
  const keepers = [
    { name: 'Mokumboot Amsterdam Amstel', category: 'Boat rental service', email: 'info@mokumbootverhuur.nl' },
    { name: 'Athens Central Station SmArt Stay', category: 'Apartment', email: 'info@athens-smartstay.com' },
    { name: "Gjelina", category: 'Restaurant', email: 'robert@gjelina.com' },
    { name: "Jim Burgers", category: 'Restaurant', email: 'jimsburger@pacbell.net' },
  ];
  for (const lead of keepers) {
    assert.equal(excludeReason(lead), null, `${lead.email} must still be invited`);
  }
});

test('a lead with no email at all does not throw', () => {
  assert.equal(excludeReason({ name: 'Somewhere', category: 'Restaurant' }), null);
  assert.equal(excludeReason({ name: 'Somewhere', category: 'Restaurant', email: '' }), null);
  assert.equal(excludeReason({ name: 'Somewhere', category: 'Restaurant', email: 'not-an-email' }), null);
});

test('the existing category and name rules still fire', () => {
  assert.equal(excludeReason({ name: 'St Marys', category: 'Church' }), 'worship');
  assert.equal(excludeReason({ name: 'Bath Dental Practice', category: 'Dentist' }), 'medical');
});
