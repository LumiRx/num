# The three things — and one correction I owe you

---

## 1. Git was never broken. I was wrong.

I said "git is gone, no history, no rollback" four or five times today, and
called it the single biggest risk in the setup. It was not true, and I should
have caught it much earlier.

My shell runs in an isolated Linux VM where **only your connected folder is
mounted**. There is no `/Users` in it at all. So when I ran `ls -d
/Users/dre/Documents/Claude/Projects/NUM/.git` and got "no such directory",
that told me nothing whatsoever about your Mac — it told me my own sandbox
doesn't have a `/Users` folder. I read a boundary of my own environment as a
fact about yours, and then repeated it as a warning.

With that folder connected, here is the actual state:

```
a95b61e commission engine, affiliate tagging, iOS purchase gating
8077887 film 2: Table Tonight — 30s, second-by-second, host-side beat
1dcf1cb reddit: add food and group concepts
```

Four worktrees registered — `app-main`, `num-worker`, `play`, `uptime`. And
everything from today is already committed, because your release script commits
as it ships: `Release v0.8.255`, `Release v0.8.254`, and so on. **You have had a
rollback point at every single deploy today.** Nothing was ever at risk.

I'd rather have told you that this morning than at midnight.

---

## 2. The D1 token — and why you might not need one

I can't create this one for you: it's a token minted in your Cloudflare
dashboard, behind your login. But there are two paths and the second is easier.

**If you want me able to query the database directly** — genuinely useful, it's
the difference between me answering a data question and inferring one from
code — then:

1. Go to **dash.cloudflare.com → My Profile → API Tokens → Create Token**
2. Use the **Edit Cloudflare Workers** template, or a custom token with
   **Account → D1 → Edit**
3. Scope it to your account only, then:

```bash
printf '%s' 'THE-TOKEN' > ~/num-worktrees/.secrets/cf-d1.token
```

```bash
chmod 600 ~/num-worktrees/.secrets/cf-d1.token
```

**If you only want it working for yourself**, this is simpler and needs no
token file at all:

```bash
cd ~/num-worktrees/app-main
npx wrangler login
```

That's a one-time browser sign-in and then `wrangler d1 execute` just works for
you. It won't help me — the credentials land outside the folders I can see —
but if the goal is you being unblocked, it's thirty seconds.

**And in practice I've needed it less than I expected.** Everything I did
today — promoting Alfredo, granting Arroyo, reading the stalled queue, finding
Arroyo's place id — went through the admin API with the key you rotated. The
token is for the questions that don't have an endpoint yet.

---

## 3. The neighbour campaign — built, nothing sent

Ready to run against Arroyo. It finds unclaimed businesses within about a mile
that have a real email, and hands back a batch plus the exact letter that would
go out — so whoever reviews it is reading the words, not approving a number.

```bash
cd ~/num-worktrees/app-main
node scripts/claim.mjs take deploy "neighbour outreach list" --who dre
npm test && npm run build && npm run release:stage && npm run release:ship
node scripts/claim.mjs release deploy --who dre
```

Then say the word and I'll pull the Pasadena batch for you to read.

**What it refuses to do, and why each one is deliberate:**

**No phone numbers. Not one, not masked, not "for reference."** NUM holds
around 1.8 million scraped business numbers with zero consent rows. Texting
them is $500–$1,500 per message under the TCPA and a class action that arrives
with its own member list. A phone field that exists is a phone field somebody
eventually sends to, so there isn't one — and a test asserts the module never
even selects the column.

**Nothing sends.** It produces a list. A blast to thousands of scraped
addresses would burn the sending domain, and the first mail to stop arriving
when a domain burns is the welcome and go-live mail — so a campaign to win new
businesses would quietly break the promise to the ones already signed up.

**Thirty at a time.** Smaller than feels efficient, on purpose: the failure to
guard against isn't sending too few, it's a batch big enough that nobody reads
it.

**Skips robot inboxes and platform addresses** — `noreply@`, `postmaster@`,
anything at booking.com or TripAdvisor. Those are wasted at best and a spam
complaint against your domain at worst.

**One letter per mailbox**, so a chain with nine branches on one address gets
one note about its own street, not nine.

**Nobody is told twice** — the batch is recorded.

**And it refuses to run at all if the anchor hasn't actually claimed their
listing**, because the entire pitch is naming a real neighbour who really
joined.

The letter itself is short, names Arroyo in the subject line, links them to
**their own listing** rather than a marketing page — a business clicks on
itself before it clicks on us — explains that claiming sends a code to the
contact already published on their listing so only they can do it, and offers a
way out in the first sentence they read. No pricing. An introduction that opens
with what we charge is a sale, and gets deleted.

**Two bugs its own tests found while I was writing it:** the platform-domain
filter had a trailing-dot error that let `x@booking.com` straight through the
check built to catch exactly that, and my first "doesn't pitch a plan" test
was so broad it flagged the sentence about a business's *own* prices being read
out — which is the benefit and had to stay.

**3,544 tests green, 0 lint errors.**
