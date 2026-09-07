# Alfredo signs in — and businesses get told to put NUM on their phone

---

## 1 · Your command failed because `$ADMIN_KEY` is empty

That's it. Nothing subtle.

```
-d '{"key":"'"$ADMIN_KEY"'","who":"dre"}'
```

`$ADMIN_KEY` isn't set in your shell, so that sent `{"key":""}`. The session
call returned 401, `$TOKEN` became empty, and the *second* curl reported the
only error you could see — `unauthorized` — which was never about the promote
call at all.

Set it up once, properly, and you never type it again:

```bash
mkdir -p ~/num-worktrees/.secrets
printf '%s' 'your-admin-key' > ~/num-worktrees/.secrets/admin.key   # printf, not echo
chmod 600 ~/num-worktrees/.secrets/admin.key

cd ~/num-worktrees/app-main
node scripts/promote-submission.mjs --check
```

`printf`, not `echo` — `echo` adds a newline and the comparison is exact. The
script strips one anyway and warns you, but now you know why.

**Still rotate the key.** The earlier paste put it in this transcript and in
your shell history.

---

## 2 · "He's already signed up" — you were right, and we weren't serving that

Here's what promotion used to do: create the listing, and stop. `places.status`
stayed `unclaimed`. No business account. No ownership.

So Alfredo — who filled in your form weeks ago — would have come back, typed
his own name into a search box, found his own listing, and claimed it from
scratch. **Retyping what he'd already told us, to prove he was the person who
told us.** You were right that that's wrong.

Promotion now takes `--owner`, which says: *I have read this submission and I'm
satisfied the person who sent it is the business.* That's the human check the
whole flow was waiting for — a self-submitted listing has no already-published
contact to send a code to, because the submitter supplied every contact on it.
A person vouching is what replaces it.

It creates his account, records the ownership, carries his original signup
across, and hands you back a **one-tap sign-in link** — one use, fourteen days.

```bash
cd ~/num-worktrees/app-main
node scripts/promote-submission.mjs sub_bf6ad9efffa7bdeb9c1b 34.0443 -118.2507 los-angeles --owner
```

It prints the link. That's what goes in the text.

**One thing I was careful about.** The ownership is recorded as
`method: 'admin_promote'` — never `sms` or `email`. Those two mean a one-time
code reached a contact that was *already published* on the listing, which is
the entire reason claiming can't be used to hijack a business. This is a weaker
and different fact: a named person vouched. If the two ever recorded the same
way, the strong one would quietly stop being checkable. `--owner` also refuses
to run without a name attached — an assertion with nobody's name on it isn't an
assertion.

---

## 3 · The text

> Alfredo — Dre. You're live on NUM, and your account's already set up from
> when you signed up — nothing to fill in again. This link signs you straight
> in: **[paste the link]**
>
> Two things and you're taking orders: add what you sell with prices, and set
> your delivery area. Ten minutes.
>
> Send me your email too — order alerts go there and I don't have one for you.

Still send it from your phone. You have his OK so consent isn't the question —
carriers are. 10DLC prohibits cannabis-related messaging and NUM's number
carries every sign-in code in the product.

---

## 4 · Businesses get asked to put NUM on their phone

New card on the business dashboard. The reason comes first, because "Add to
Home Screen" with no reason given is a step everybody skips:

> **This page is for setting things up. Orders have to reach you where you are
> — and a browser tab cannot ring.** Add NUM to your home screen and every
> request arrives as a notification, with the guest, the address and the total,
> wherever you happen to be standing.

That's not a slogan, it's the actual mechanism: **web push doesn't work from a
browser tab on iOS.** An owner reading their dashboard in Safari finds out
about an order when they next happen to look — which, for a hungry guest still
deciding, is too late.

Three decisions worth knowing about:

**It asks instead of detecting.** The console renders on a server and can't see
anyone's home screen. More to the point, the owner is usually reading it on a
laptop while the phone that needs the app is in their pocket — detecting the
laptop would answer a question about the wrong device. So it asks, and believes
the answer.

**"Not now" is remembered against the business, not the browser.** Dismiss it
on the laptop and it stays dismissed on the tablet tomorrow. A cookie would ask
again there, which is how a prompt becomes noise.

**Never having asked is not the same as "they haven't installed it."** No row
means unknown, not false — the same rule the readiness model already runs on
everything else. Otherwise a number nobody measured ends up in a dashboard.

The iOS steps name Safari explicitly, because Add to Home Screen doesn't exist
in Chrome on iOS and an owner who tries it there concludes the product is
broken rather than that they used the wrong browser.

---

## Deploy

```bash
cd ~/num-worktrees/app-main
node scripts/claim.mjs take deploy "promote-as-owner + biz install prompt + partner SMS opt-in" --who dre

npm test                      # 3,372 green, 0 lint errors
npm run build
npm run release:stage
npm run release:ship

# The host opt-in lives on the growth worker — separate bundle, separate deploy
npx wrangler deploy --config growth/wrangler.jsonc

node scripts/claim.mjs release deploy --who dre
```

Then:

```bash
node scripts/promote-submission.mjs sub_bf6ad9efffa7bdeb9c1b 34.0443 -118.2507 los-angeles --owner
```

---

## Still open

- **Rotate `ADMIN_KEY`.**
- **Git is still broken here.** `.git` points at
  `/Users/dre/Documents/Claude/Projects/NUM/.git/worktrees/app-main` and that
  directory is gone. No history, no rollback, for either session. Where did
  that folder move to? I won't guess — repointing a worktree is destructive if
  I'm wrong.
- **Alfredo's email.** Claim 16 has name and phone, `email` is NULL.
- **Verify the DCC licence** at search.cannabis.ca.gov before delivery goes on.
- **Want the app-on-phone status as a readiness item?** It'd show you, in the
  admin dashboard, which businesses can actually receive an order right now.
  Small addition; say the word.
