---
description: Pull the latest design files from the Claude Design project and alert if the app needs changes
---

Check every imported design file for upstream changes and report what needs updating.

1. Read `design-source/registry.json` — it lists every tracked design: its `id`, its
   `sourcePath` in the Claude Design project (`designProjectId` at the root), and its
   stored versions.
2. For each design, fetch the live file with the DesignSync tool
   (`method: get_file`, `projectId` from the registry, `path` = `sourcePath`).
   Save each file's decoded content to the scratchpad (for large results, decode the
   persisted tool output with `jq -r '.content'`; for small ones, Write the content
   exactly as returned — byte fidelity matters).
3. Ingest each: `node scripts/design-check.mjs ingest <id> <scratchpad-file>`.
   - "up to date" → nothing to do for that design.
   - "CHANGED" → a new version folder was created and an alert raised.
4. Run `node scripts/design-check.mjs status` (also: `npm run design:check`). This also
   verifies stored snapshots are untampered and that the vendored
   `src/styles/ds.css` still matches the design system's stylesheet.
5. If `ALERTS.md` exists, summarize each alert for the user: which design changed,
   which sections, and which `src/` files implement them (the alert lists these).
   Offer to implement the changes; after the app is updated and verified, run
   `node scripts/design-check.mjs resolve <alertId>`.

Never edit files inside `design-source/**/v*/` by hand — version snapshots are
immutable (the hash check in `status` will catch it).
