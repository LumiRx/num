// Telling a hotel from a hall of residence.
//
// Every fixture below is a REAL row from the UK slice of the directory, found
// by sampling the 4,666 places whose category contains "hotel". The category
// alone said "hotel" for all of them.
//
// The failure this prevents is specific: NUM answering "where should I stay in
// Bath" with University of Bath accommodation. That is worse than returning
// nothing, because it reads as NUM not knowing what a hotel is.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stayKind, offerable, STAY_KINDS, OFFERABLE_UNASKED } from './staykind.mjs';

describe('real rows that must NOT be offered as hotels', () => {
  const STUDENT = [
    ['Woodland Court, University of Bath', 'http://www.woodlandcourt.org.uk/'],
    ['Bernard Ireland House', 'http://www.ruh.nhs.uk/occupationalhealth'],
    ['Avon Studios', 'https://nowstudents.co.uk/location/bath/avon-studios/'],
    ['Thornbank Gardens', 'https://www.bath.ac.uk/student-accommodation/thornbank-gardens'],
    ['Carpenter House', 'http://www.bath.ac.uk/study/ug/accommodation/types/city/carpenter-house'],
    ['Weston Lodge', 'http://www.bathnes.gov.uk'],
  ];
  for (const [name, website] of STUDENT) {
    test(`${name.slice(0, 34)} → student`, () => {
      assert.equal(stayKind({ name, website }), 'student');
      assert.equal(offerable({ name, website }), false);
    });
  }

  test('an institutional domain beats a hotel-sounding name', () => {
    // "Woodland Court" and "Bernard Ireland House" read like country houses.
    // Only the domain gives them away, so the domain has to win.
    assert.equal(stayKind({ name: 'Woodland Court', website: 'http://x.ac.uk' }), 'student');
    assert.equal(stayKind({ name: 'The Grand Hotel', website: 'https://accom.ac.uk/grand' }), 'student');
  });

  test('a student operator is caught even when nothing says student', () => {
    assert.equal(stayKind({ name: 'Avon Studios', website: 'https://nowstudents.co.uk/x' }), 'student');
    assert.equal(stayKind({ name: 'Kelvin Court', website: 'https://www.iqstudentaccommodation.com/x' }), 'student');
  });
});

describe('real rows that stay in', () => {
  test('genuine hotels classify as hotels', () => {
    for (const [name, website] of [
      ['The Royal Crescent Hotel', 'https://www.royalcrescent.co.uk/'],
      ['Haringtons Hotel', 'https://www.haringtonshotel.co.uk/'],
      ['The Bath Priory', 'https://www.thebathpriory.co.uk/'],
      ['House of Gods', 'https://www.houseofgodshotel.com/'],
      ['Nira Caledonia', 'https://niracaledonia.com/en/'],
    ]) assert.equal(stayKind({ name, website }), 'hotel', name);
  });

  test('apartments and short lets are offerable — just not hotels', () => {
    // A serviced apartment is a real answer to "where do I stay in Bath".
    for (const name of [
      'Fountain Court Apartments - Morrison', 'Holyrood Aparthotel',
      'Marmaduke House, Bath Holiday Cottage',
      'Beau Street Apartments', 'The Place, Bath - luxury holiday rental apartment',
    ]) {
      assert.equal(stayKind({ name }), 'apartment', name);
      assert.equal(offerable({ name }), true, `${name} was excluded`);
    }
  });

  test('a serviced-apartment operator is caught by its domain', () => {
    // SACO, Staycity, Roomzzz, Cheval and Fountain Court all appeared in the
    // real sample as rows categorised "hotel". Nothing in the NAME says
    // apartment — only the operator's domain does.
    for (const [name, website] of [
      ['SACO Bath - St. James’s Parade', 'http://bath.sacoapartments.com/'],
      ['Staycity Edinburgh', 'https://www.staycity.com/edinburgh/west-end/'],
      ['Roomzzz Aparthotel', 'https://www.roomzzz.com/aparthotels/edinburgh'],
      ['Cheval Old Town Chambers', 'https://www.chevalcollection.com/cheval-old-town-chambers/'],
      ['Forth House', 'https://www.supercityuk.com/edinburgh/'],
      ['Fraser Suites Edinburgh', 'https://edinburgh.frasershospitality.com/'],
    ]) {
      assert.equal(stayKind({ name, website }), 'apartment', name);
      assert.equal(offerable({ name, website }), true);
    }
  });

  test('Airbnb listings stay in — they are a real place to sleep', () => {
    // Deliberate: an Airbnb is a legitimate answer, unlike a hall of residence.
    assert.equal(offerable({ name: 'Central Bath flat', website: 'https://www.airbnb.co.uk/rooms/23728291' }), true);
  });

  test('hostels are labelled, not deleted', () => {
    for (const name of ['Edinburgh Backpackers Hostel', 'YHA Bath', 'Kipps Bunkhouse'])
      assert.equal(stayKind({ name }), 'hostel', name);
    // Real, and fine — just not what "book me a hotel" means. Offering one
    // unasked reads to a guest as a downgrade.
    assert.equal(offerable({ name: 'YHA Bath' }), false);
  });
});

describe('the rules themselves', () => {
  test('precedence: institutional > student > hostel > apartment > hotel', () => {
    assert.equal(stayKind({ name: 'Student Apartments', website: 'https://x.ac.uk' }), 'student');
    assert.equal(stayKind({ name: 'Student Apartments' }), 'student');
    assert.equal(stayKind({ name: 'Hostel Apartments' }), 'hostel', 'hostel apartments is a hostel');
    assert.equal(stayKind({ name: 'Riverside Apartments' }), 'apartment');
  });

  test('it never invents a kind, and never throws', () => {
    for (const row of [undefined, {}, { name: null }, { website: 123 }, { name: '<script>' }]) {
      const k = stayKind(row);
      assert.ok(STAY_KINDS.includes(k), `invented kind: ${k}`);
    }
  });

  test('an unknown row defaults to hotel, not to excluded', () => {
    // Failing OPEN is right here. A real hotel wrongly hidden loses a booking
    // and nobody ever finds out; a hall wrongly shown is visible and fixable.
    assert.equal(stayKind({ name: 'Combe Grove Manor' }), 'hotel');
    assert.equal(offerable({ name: 'Something Unclassifiable' }), true);
  });

  test('the offerable set is exactly hotels and apartments', () => {
    assert.deepEqual([...OFFERABLE_UNASKED], ['hotel', 'apartment']);
  });

  test('"college" in a hotel name does not make it student housing', () => {
    // Guardrail against the obvious over-broad rule. Edinburgh has hotels on
    // College Street; Oxford has The College Hotel.
    assert.equal(stayKind({ name: 'College Street Hotel' }), 'hotel');
  });
});
