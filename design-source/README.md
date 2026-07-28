# design-source — versioned design imports

Every file submitted from the Claude Design project
([d7604087…](https://claude.ai/design/p/d7604087-d1cd-4267-92bc-f01cadabe8dd))
is stored here as an immutable, versioned snapshot, categorized by what it is:

```
screens/concierge/v1/Concierge.dc.html   the app screen designs
frames/ios-frame/v1/ios-frame.jsx        device-frame starters
ds/modernist/v1/…                        the design system (stylesheet, guide,
                                         bundle, manifest, adherence config)
runtime/support/v1/support.js            the dc-runtime (reference only)
registry.json                            every design, its versions + hashes,
                                         and the alert log
mapping.json                             design sections → the src/ files that
                                         implement them (drives alerts)
```

## Rules

- **Snapshots are immutable.** Never edit anything under a `v*/` folder —
  `npm run design:check` hash-verifies every snapshot and fails on tampering.
- **New versions come from ingest**, not by hand: when a design changes
  upstream, `node scripts/design-check.mjs ingest <id> <file>` records the next
  `v<N+1>` and raises an alert in `ALERTS.md` naming the sections that changed
  and the `src/` files to review.
- **Checking for changes**: run the `/design-check` command in Claude Code — it
  fetches every tracked file from the design project, ingests them, and reports
  what (if anything) needs updating in the app. `npm run design:check` alone
  verifies local integrity, vendored-copy drift, and lists open alerts.
- After the app is updated for an alert, close it:
  `node scripts/design-check.mjs resolve <alertId>`.
