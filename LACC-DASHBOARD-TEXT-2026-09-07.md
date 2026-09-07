# Alfredo's dashboard link — and the two commands before it

---

## ⚠️ First: rotate the admin key

You pasted `ADMIN_KEY` into the chat window. It is now in this transcript, and
in `~/.zsh_history` on your Mac. Neither of those can be un-written.

```bash
cd ~/num-worktrees/app-main
npx wrangler secret put ADMIN_KEY --config wrangler.app.jsonc   # type a new one

mkdir -p ~/num-worktrees/.secrets
printf '%s' 'the-new-key' > ~/num-worktrees/.secrets/admin.key   # printf, not echo
chmod 600 ~/num-worktrees/.secrets/admin.key

# and clear it out of your shell history
history -d $(history | grep -n 'admin/session' | head -1 | cut -d: -f1) 2>/dev/null
```

From now on nothing needs you to type it. `scripts/promote-submission.mjs`
reads it from that file.

---

## Why your command said "unauthorized"

It wasn't the promote call. `$TOKEN` came back empty, so the second curl sent
`X-Admin-Session: null` and got the only error you saw.

Three different things produce that exact output, and two of them are not
authorisation problems at all:

| What actually happened | What you saw |
|---|---|
| The key doesn't match the Worker's `ADMIN_KEY` | `unauthorized` |
| Rate limited — the admin door allows 8 tries a minute | `unauthorized` |
| The submission id isn't in the queue | `unauthorized` |

`/api/admin/why` confirms an `ADMIN_KEY` **is** set on the Worker, so it's one
of the first two. The new script tells you which:

```bash
cd ~/num-worktrees/app-main
node scripts/promote-submission.mjs --check
```

---

## Then — one command

```bash
node scripts/promote-submission.mjs sub_bf6ad9efffa7bdeb9c1b 34.0443 -118.2507 los-angeles
```

That creates the listing. Alfredo can sign in the moment it finishes.

---

## The text

> Alfredo — Dre. You're live on NUM. Your dashboard is at
> **itsnum.com/business** — search your name, we'll text you a code, and you're
> in.
>
> Two things and you're taking orders: add what you sell with prices, and set
> your delivery area. Ten minutes.
>
> Send me your email too — order alerts go there and I don't have one for you.

Short on purpose. Three asks is the most a first text can carry, and "what's
your email" is the one that unblocks everything automatic afterwards.

**Want a link that signs him in with no code?** NUM can mint those — one use,
14 days, already built (`worker/bizsignin.mjs`) and already used by the welcome
and go-live emails. What's missing is an admin route to mint one on demand, so
it'd need a small route plus a deploy. Worth it if you're onboarding a run of
businesses by hand; not worth a deploy for one. Your call.

**Send it from your phone.** You have Alfredo's OK, so consent isn't the issue
— carriers are. US 10DLC prohibits cannabis-related messaging, and NUM's number
carries every sign-in code in the product. Your phone, person to person, costs
nothing and risks nothing.

---

## Kansas

You said their business address differs from operations, and they run in LA and
Kansas. That explains the geocoding: **"608 S Main Street" was never wrong — it
named two real places**, and one of them is theirs. The fix I shipped this
morning now catches exactly that and asks *"Winfield, Kansas or Los Angeles,
California?"* instead of picking one.

**What Kansas does not change: nothing about what NUM offers there.** Kansas has
no legal adult-use or medical cannabis market, and their California DCC licence
is good in California. The gate is already correct — it's keyed to where the
*guest* is, and there is no Kansas destination — but I've pinned it with a test,
because the day someone adds Wichita to NUM for perfectly good reasons, this is
what would quietly break. Whatever they run in Kansas, NUM can't carry it as
cannabis delivery.

If Kansas is a *different* business (or a non-cannabis one), it's a second
listing under the same phone. NUM already supports one owner holding several —
that part needs no work.

---

## Text updates at signup — built

You asked that businesses and hosts opt in to texts when they sign up. Done,
and it turned up a live bug on the way.

**Hosts have had that checkbox since migration 0013. It was wired to nothing.**
Ticking it set a boolean no sender ever read. Every sender in NUM asks the
consent register first and refuses to send when there's no row — correctly — so
every host who ticked "text me when a request comes in" got nothing, and had no
way to know. It has been that way for about a year.

What's there now:

- **One sentence, shown and recorded.** The words next to the checkbox are the
  words written into the consent register. They were two separate strings on
  the host page; a test now pins them identical across both workers, because
  two copies of a legal disclosure that are allowed to differ will.
- **Never pre-ticked.** A pre-checked box is not consent, and it builds a list
  of people who didn't agree — which doesn't convert either.
- **Ticking without a number is refused**, and says which field. That was
  already showing up in the host integrity report as live drift.
- **Unticking travels.** Turning texts off on a dashboard now revokes in the
  register, so a different sender can't still reach them.
- **Businesses have it at all**, for the first time — on the add-your-business
  form, recorded against the submission.

**One thing I did not do, deliberately.** I did not backfill consent rows for
the hosts who already ticked the old box. I don't know what wording they were
shown, and writing today's sentence against last year's tick would be
manufacturing evidence — the exact thing the register exists to prevent. They
get asked again next time they save their profile.

**One thing worth your call:** the growth worker overwrites `consent_text` and
`created_at` when someone re-consents; the app worker preserves the original.
Opposite rules, one register. The app worker's is the right one for evidence —
you want to be able to show what they first agreed to. I left growth alone
rather than change the public `/sms/` flow without asking.

---

## Also

**Git is broken in this worktree.** `.git` points at
`/Users/dre/Documents/Claude/Projects/NUM/.git/worktrees/app-main`, and that
directory is gone. No commits, no history, no rollback — for either session. I
haven't touched it; repointing a worktree is destructive if I guess wrong about
where the real repo went. Where did that folder move to?

**The claim system dropped my lock mid-work, and that's my bug.** I took the
edit claim at 18:56 and worked past twenty minutes; claims go stale after
twenty so a crashed session can't block forever, and `cowork-connections`
correctly took it out from under me. `renew` exists — nothing calls it, and I
didn't. Nothing was lost this time (I checked every file I touched), but the
lock is currently theatre for any pass longer than a coffee break. It needs to
either renew itself or warn before it lapses. Want me to fix it?

**A test was wrong, not the flyer.** That new one-pager failed four nav tests
because it has three "Never" cards styled `class="nv"`, and the nav test used
that bare two-letter string to detect the site navigation. It now looks for
`<nav class="nv">`. Fixed, and the flyer is registered as print artwork like
the other two.

**3,327 tests green, 0 lint errors.** Nothing deployed.
