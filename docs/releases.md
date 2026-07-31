# Releasing without taking the app down

Cloudflare keeps every upload as a **version**. A version that is uploaded is
not live — it gets its own preview URL that only you know. Traffic only moves
when you say so, and moving it back is one command.

```bash
npm run release:stage "what changed"   # build + upload. NOT live. Prints a preview URL.
npm run release:ship                   # send 100% of traffic to it
npm run release:ship 10                # or 10% first, rest stays on the old one
npm run release:rollback               # back to the previous version, instantly
npm run release                        # what is live, what is uploaded, local version
```

`stage` bumps the patch version (`BUMP=minor` for a minor), stamps it into the
bundle, writes a `CHANGELOG.md` entry with the commit, and remembers the upload
id so `ship` needs no interactive picker.

## Why two steps

The old flow was `wrangler deploy`, which builds and goes live in one motion —
so a mistake is live before anyone has looked at it. Staging means the new build
runs on a real URL, against the real database, with zero users on it. Check it,
then move traffic.

`ship 10` is the one to use for anything risky. Ten percent of traffic on the
new version means a bad release affects one person in ten for a minute, not
everybody.

## Knowing what a phone is actually running

`GET /api/version` returns the version the Worker is on. The app carries its own
stamp from build time and compares the two — the profile screen shows
`Num v0.8.1 · 5125ad1 · 2026-07-31 01:12`, and if the server is ahead it offers
**"v0.8.2 IS OUT — TAP TO UPDATE"**.

This exists because "the user is seeing the old copy" is otherwise pure
guesswork. It happened: a phone kept showing two-day-old welcome copy after
several deploys, and without a version on screen there was no way to tell a
stale cache from a failed deploy. Now there is.

## If something is wrong

```bash
npm run release:rollback
```

Traffic returns to the previous version immediately. Fix it, `stage` again.
