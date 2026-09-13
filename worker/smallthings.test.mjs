// The small connections — the things a concierge does that a booking platform
// cannot. Dre, 13 Sep 2026: "lets work through the small connections we can do
// for people."
//
// Four specialists: the bad night, the first hour, who is with you, everyday
// errands. What is asserted here is ROUTING and RESTRAINT — that the right
// brief is chosen, that the commercial briefs cannot swallow an urgent request,
// and that the briefs forbid the specific confident-wrong answers each domain
// invites.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickSpecialist, specialistBrief } from './specialists.mjs';

const brief = (id) => specialistBrief(id) ?? '';
const index = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');

describe('the bad night routes before anything commercial', () => {
  test('illness, injury and pharmacies reach the urgent brief', () => {
    for (const q of ['pharmacy open now', 'i need a chemist', 'where is the nearest hospital',
      'i think i have food poisoning', 'is there a dentist open', 'i need a doctor who speaks english']) {
      assert.equal(pickSpecialist(q), 'urgent', q);
    }
  });

  test('a lost passport, phone or wallet reaches it too', () => {
    for (const q of ['i lost my passport', 'my phone was stolen', 'lost my wallet',
      'left my bag in the taxi', 'i left my laptop in the room', 'where is the embassy']) {
      assert.equal(pickSpecialist(q), 'urgent', q);
    }
  });

  test('"i need a chemist" does NOT land in the spa brief', () => {
    // wellness matches on massage/barber/spa. An urgent request routed to the
    // relaxation specialist is the single most tone-deaf failure available here.
    assert.notEqual(pickSpecialist('i need a chemist'), 'wellness');
    assert.notEqual(pickSpecialist('pharmacy open now'), 'wellness');
  });

  test('a bag left in a taxi is not a request for a taxi', () => {
    assert.equal(pickSpecialist('left my bag in the taxi'), 'urgent');
    assert.equal(pickSpecialist('get me a car to the airport'), 'ride');
  });

  test('the brief forbids diagnosing and forbids remembered numbers', () => {
    const b = brief('urgent');
    assert.match(b, /NEVER state an emergency number from memory/i);
    assert.match(b, /not a doctor/i);
    assert.match(b, /No diagnosis/i);
    assert.match(b, /emergency number FIRST/i, 'danger must come before everything else in the reply');
  });

  test('the brief orders a lost passport correctly — police report before embassy', () => {
    const b = brief('urgent');
    assert.ok(b.indexOf('police report') < b.indexOf('embassy'),
      'the embassy asks for the police report, so it cannot come second');
  });
});

describe('the first hour', () => {
  test('it catches the six decisions that decide day one', () => {
    for (const q of ['where do i get a sim card', 'esim before i land', 'where to change money',
      'which atm', 'what plug do i need', 'can i drink the tap water', 'do i tip here',
      'is it a public holiday']) {
      assert.equal(pickSpecialist(q), 'arrival', q);
    }
  });

  test('it refuses to invent a rate, and warns about the currency-conversion trick', () => {
    const b = brief('arrival');
    assert.match(b, /Never invent an exchange rate/i);
    assert.match(b, /home currency/i, 'declining the machine’s own conversion is the one that costs real money');
  });

  test('it will not promise a holiday date it is unsure of', () => {
    assert.match(brief('arrival'), /not sure rather than guessing/i);
  });
});

describe('who is with you', () => {
  test('access, children, pets and dietary needs route here', () => {
    for (const q of ['wheelchair access at that restaurant', 'is it step free', 'travelling with my dog',
      'we have a baby, is there a high chair', 'somewhere with a cot', 'i have a nut allergy',
      'halal near me', 'my mum cannot manage stairs']) {
      assert.equal(pickSpecialist(q), 'access', q);
    }
  });

  test('it refuses to call a place accessible without checking', () => {
    const b = brief('access');
    assert.match(b, /NEVER SAY IT IS FINE IF YOU HAVE NOT CHECKED/i);
    assert.match(b, /offer to ring and ask/i, 'the phone call is the actual service');
  });

  test('it answers the barrier rather than the label', () => {
    assert.match(brief('access'), /ANSWER THE ACTUAL BARRIER, NOT THE LABEL/i);
  });

  test('it offers the allergy phrase in the local script', () => {
    // Worth more than any amount of filtered listings.
    assert.match(brief('access'), /local script/i);
  });
});

describe('everyday errands', () => {
  test('laundry, barbers, repairs, printing and parcels route here', () => {
    for (const q of ['same day laundry', 'dry cleaning', 'barber near me', 'fix my phone screen',
      'somewhere to print', 'post office to send a parcel', 'i need a locksmith', 'left luggage']) {
      assert.equal(pickSpecialist(q), 'errand', q);
    }
  });

  test('the answer is a place PLUS a turnaround', () => {
    assert.match(brief('errand'), /TURNAROUND/);
  });

  test('it hands off to the errand runner rather than making them go', () => {
    assert.match(brief('errand'), /post it as an errand/i);
  });
});

describe('the commercial specialists still work', () => {
  test('nothing above has swallowed tables, rides, food or wellness', () => {
    assert.equal(pickSpecialist('book me a table for 4'), 'table');
    assert.equal(pickSpecialist('get me a car to the airport'), 'ride');
    assert.equal(pickSpecialist('order pad thai to my hotel'), 'food');
    assert.equal(pickSpecialist('massage for my back'), 'wellness');
  });

  test('an ordinary sentence still reaches no specialist at all', () => {
    for (const q of ['hello', 'what can you do', 'tell me about bangkok']) {
      assert.equal(pickSpecialist(q), null, q);
    }
  });
});

describe('the emergency line is handed to the model, not left to it', () => {
  test('index.mjs pushes the verified line when somebody asks', () => {
    assert.match(index, /VERIFIED EMERGENCY LINE/);
    assert.match(index, /asksEmergency\(/, 'nothing decides when to push it');
    assert.match(index, /emergencyLine\(/, 'the line is not read from the table');
  });

  test('it is pushed ONLY when asked — never appended to every turn', () => {
    // Anchor on the guard and look FORWARD. Anchoring on the string finds the
    // comment above it, which explains the guard rather than being it.
    const guard = index.indexOf("if (asksEmergency(userText");
    assert.ok(guard > 0, 'there is no asksEmergency guard at all');
    const pushed = index.indexOf('VERIFIED EMERGENCY LINE', guard);
    assert.ok(pushed > guard && pushed - guard < 400,
      'the push is not inside the guard — every turn would carry emergency numbers');
  });

  test('the model is told to reproduce it exactly, not paraphrase it', () => {
    assert.match(index, /reproduce this exactly/i);
    assert.match(index, /never substitute one you remember/i);
  });
});
