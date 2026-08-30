-- 0002 — the passenger record. Government-identity-adjacent PII, held by Num.
--
-- WHY THIS FILE IS NUMBERED WHEN MOST OF worker/ IS NOT
-- Num's schema normally arrives through worker/social.sql plus lazy ALTERs that
-- swallow their own errors (worker/social.mjs:88-121). That is right for a
-- nullable display column and wrong for a table holding a full legal name, a
-- date of birth, a gender marker and a passport number. A half-applied identity
-- table that kept serving is worse than one that refused to start, so this file
-- is applied by an explicit ensurePassengers() that fails closed.
--
-- The reasoning and the precedent are HQ/divisions/num/CONSENT_ARCHITECTURE.md
-- §6.1, which introduced the numbered sequence and reserved 0001 for
-- 0001_consent.sql. 0001 is NOT in this repository yet — the consent spec is
-- approved and unbuilt. This file takes 0002 rather than 0001 so that when the
-- consent tables land they land where the document says they land.
--
-- worker/passengers.mjs inlines these statements verbatim, because a Worker has
-- no filesystem. THIS FILE IS THE READABLE COPY AND THE ONE TO EDIT FIRST;
-- worker/passengers.test.mjs fails if the two ever disagree.
--
-- ── WHAT MAY NEVER HAPPEN TO THIS TABLE ─────────────────────────────────
-- No row, column or value from num_passengers may cross to 5arz, to AiR, or to
-- any other party. There is no consent scope that authorises it — the five
-- scopes in CONSENT_ARCHITECTURE.md §2.2 are about proof-of-human, and a
-- passport number has no bearing on whether somebody is a human. The rule is
-- enforced in code by assertNoPassengerData() at every crossing site, not by
-- this comment. See HQ/divisions/num/PASSENGER_RECORD_MODEL.md §3.

CREATE TABLE IF NOT EXISTS num_passengers (
  id                  TEXT PRIMARY KEY,          -- pax_<uuid>, minted by Num
  member_id           TEXT NOT NULL,             -- num_members.id — the owner of the record
  -- Whether this record is the member themselves or somebody they travel with.
  -- A companion is routinely a person who will never install Num, exactly as
  -- num_item_attendees already assumes for a dinner table.
  is_self             INTEGER NOT NULL DEFAULT 0 CHECK (is_self IN (0,1)),
  -- The traveller's own label for the record, so a list of four passports is
  -- readable. Never sent to Duffel.
  label               TEXT,

  -- ── everything Duffel's create-order requires, per passenger ──────────
  -- https://duffel.com/docs/api/orders/create-order
  -- required: id given_name family_name gender title born_on email phone_number
  -- `id` there is Duffel's per-offer passenger id (pas_…). It is minted by the
  -- offer request, is valid only for that offer, and is deliberately NOT stored
  -- here: a stored pas_ id would be a stale id that produces a 422 nobody can
  -- explain.
  title               TEXT NOT NULL CHECK (title IN ('mr','ms','mrs','miss','dr')),
  given_name          TEXT NOT NULL,
  family_name         TEXT NOT NULL,
  born_on             TEXT NOT NULL,             -- YYYY-MM-DD, ISO 8601 date
  gender              TEXT NOT NULL CHECK (gender IN ('m','f')),
  email               TEXT NOT NULL,
  phone_number        TEXT NOT NULL,             -- E.164, via claim/verify.mjs#normalisePhone

  -- ── the infant rule ───────────────────────────────────────────────────
  -- "Infant passengers, with an age of 0 or 1, must be associated with an adult
  -- passenger." Duffel expresses that by putting the INFANT's id on the ADULT's
  -- infant_passenger_id. Stored the other way round — pointing from the infant
  -- at their responsible adult — because that is the direction the traveller
  -- thinks in, and because an adult may be responsible for at most one infant,
  -- which a unique index on this column can enforce and the Duffel direction
  -- cannot.
  travels_with_id     TEXT,                      -- num_passengers.id of the responsible adult

  -- ── identity documents, only when the airline demands them ────────────
  -- Duffel: "If the offer's passenger_identity_documents_required is set to
  -- true, then a passport document must be provided." All three columns are
  -- required together or not at all — Duffel's identity-document object
  -- requires type, unique_identifier, issuing_country_code and expires_on.
  passport_number     TEXT,
  passport_country    TEXT,                      -- ISO 3166-1 alpha-2
  passport_expires_on TEXT,                      -- YYYY-MM-DD

  -- ── loyalty ───────────────────────────────────────────────────────────
  -- Loyalty accounts are sent at OFFER REQUEST time, not at create-order — the
  -- create-order passenger schema has no loyalty field at all. Stored here so a
  -- search can carry them; sending them additionally requires given_name and
  -- family_name on the offer request, which is why they live on this row.
  loyalty_airline     TEXT,                      -- IATA code, e.g. BA
  loyalty_account     TEXT,

  -- ── retention ─────────────────────────────────────────────────────────
  -- deleted_at is the soft delete: the traveller's "remove this" is instant to
  -- them and reversible for a fixed window, because an accidental deletion the
  -- night before a flight is a worse outcome than 30 more days of storage.
  -- purge_after is the hard stop, and it is a column rather than a policy so
  -- that a sweep can be written against the row instead of against a wiki page.
  deleted_at          TEXT,
  purge_after         TEXT,
  last_used_at        TEXT,                      -- last time this record built a Duffel payload
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_num_passengers_member ON num_passengers (member_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_num_passengers_purge  ON num_passengers (purge_after);
-- One "this is me" record per member. A second one means two legal names on one
-- account, which is either a mistake or the beginning of a fraud.
CREATE UNIQUE INDEX IF NOT EXISTS idx_num_passengers_self ON num_passengers (member_id)
  WHERE is_self = 1 AND deleted_at IS NULL;
-- An adult may carry at most one lap infant. Duffel: "All infants must have
-- unique responsible adults."
CREATE UNIQUE INDEX IF NOT EXISTS idx_num_passengers_infant ON num_passengers (travels_with_id)
  WHERE travels_with_id IS NOT NULL AND deleted_at IS NULL;
