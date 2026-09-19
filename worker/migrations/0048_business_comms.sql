-- 0044 - talking to a business, in both directions, on the record.
--
-- WHY THIS EXISTS
-- NUM sent 3,538 invitations. 668 were opened, 77 businesses reached the claim
-- page, 9 filled the form, and 2 were ever verified. The one substantive reply
-- anybody can point to - Hugo's Restaurant, four Los Angeles sites, asking two
-- precise questions - reached NUM as a screenshot pasted into a chat window.
--
-- That was not bad luck. Invitations went out with Reply-To pointing at
-- info@thatislumi.com: another company's domain, one person's mailbox. A
-- business that answered was writing somewhere this system could not see, and
-- nothing here ever learned they had replied.
--
-- These tables are the record that was missing. A thread per business contact,
-- every message in both directions on it, and a note of which follow-ups have
-- been sent so nobody is written to twice.

-- One conversation with one business contact.
--
-- reply_key is what makes a reply route itself: outbound mail carries
-- Reply-To: reply+<key>@itsnum.com, and the inbound Email Worker reads the key
-- back out. It is an identifier and NOT a credential - landing a message in a
-- thread is all it can do, and inbound is treated as untrusted regardless.
--
-- Keyed on the ADDRESS rather than the business, because the address is what a
-- mail server gives us and the only thing present on both sides of the
-- conversation. Everything else is attached as it becomes known.
CREATE TABLE IF NOT EXISTS num_biz_threads (
  id            TEXT PRIMARY KEY,
  reply_key     TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL,
  contact_name  TEXT,
  business_name TEXT,
  lead_id       TEXT,
  place_id      TEXT,
  business_id   TEXT,
  invite_token  TEXT,
  dest          TEXT,
  country       TEXT,
  state         TEXT NOT NULL DEFAULT 'invited',
  owner         TEXT,
  needs_reply   INTEGER NOT NULL DEFAULT 0,
  closed_at     TEXT,
  last_in_at    TEXT,
  last_out_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bizthread_email ON num_biz_threads(email);
CREATE INDEX IF NOT EXISTS idx_bizthread_open  ON num_biz_threads(needs_reply, last_in_at DESC);
CREATE INDEX IF NOT EXISTS idx_bizthread_biz   ON num_biz_threads(business_id);
CREATE INDEX IF NOT EXISTS idx_bizthread_place ON num_biz_threads(place_id);

-- Every message, both directions.
--
-- matched_by records HOW an inbound message was attributed to this thread -
-- 'key', 'headers', 'address' or 'unmatched' - because those are not equally
-- trustworthy. Matching on the From address alone is a guess, and two people
-- at one restaurant will land it wrong sometimes, so it is shown and not hidden.
--
-- state carries a draft through to a send. A draft is not an answer and never
-- clears a thread's needs_reply - only a message that actually left does.
-- Declined drafts are kept, because they are the only honest record of what
-- the drafting agent gets wrong.
CREATE TABLE IF NOT EXISTS num_biz_messages (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
  channel      TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','sms','note')),
  from_addr    TEXT,
  to_addr      TEXT,
  subject      TEXT,
  body         TEXT,
  message_id   TEXT,
  in_reply_to  TEXT,
  provider_id  TEXT,
  matched_by   TEXT,
  state        TEXT NOT NULL DEFAULT 'received'
               CHECK (state IN ('received','draft','approved','sent','failed','declined')),
  drafted_by   TEXT,
  approved_by  TEXT,
  approved_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bizmsg_thread ON num_biz_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bizmsg_state  ON num_biz_messages(state, created_at);
-- Mail is delivered at least once. A retried webhook or a doubled delivery
-- must be a no-op, not a second row in somebody's conversation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bizmsg_msgid
  ON num_biz_messages(message_id) WHERE message_id IS NOT NULL;

-- Which one-time follow-ups have gone to whom.
--
-- Its own table rather than a flag on num_invites, because "have we already
-- written to this person about this" must stay answerable even if the invite
-- row is rewritten, and because there will be more than one kind of follow-up.
-- The composite primary key is the once-ever guarantee.
CREATE TABLE IF NOT EXISTS num_biz_followups (
  email       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  thread_id   TEXT,
  provider_id TEXT,
  sent_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (email, kind)
);
