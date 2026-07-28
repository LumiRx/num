# NUM Concierge

Interactive prototype of the **NUM concierge app** — chat thread, plan/calendar,
memory, stars wallet, share and payment sheets, voice overlay, and the
disruption-recovery demo flow.

Built with Vite + React 18 + TypeScript. All concierge behavior is currently
**scripted demo logic**; the app is structured so a real NUM AI backend can be
plugged in without touching the UI.

## Quick start

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

Two presentation modes:

- **Prototype canvas** (desktop-width viewport): the poster header, the app in
  an iPhone frame, the lock screen (Live Activity) beside it, and the v0.8
  release notes — mirroring the original design canvas.
- **Standalone app** (viewport narrower than 720px, or append `?app` to the
  URL): the Num app runs full-bleed as a real app, no frame.

Other scripts:

```bash
npm run build     # type-check + production build (dist/)
npm run preview   # serve the production build locally
```

## Project structure

```
src/
  components/
    app/          # App screens: ConciergeApp, ThreadView, PlanView,
                  # MemoryView, sheets (Calendar/Share/Wallet), overlays
    canvas/       # PrototypeCanvas (desktop presentation) + LockScreen
                  # (the Live Activity lock screen)
    device/       # IOSDevice — iPhone frame (bezel, dynamic island,
                  # status bar), ported from design-source/ios-frame.jsx
  lib/
    concierge.ts  # The concierge engine (scripted demo flows) ← AI seam
    store.ts      # App state store + useApp hook
    data.ts       # Seed data (bookings, messages, chips)
    derive.ts     # Derived/computed helpers
    types.ts      # Shared types (Msg, Booking, Chip, …)
  styles/         # Design system (ds.css) + app styles (app.css)
design-source/    # Original design artifacts the prototype was ported from
```

## Connecting the real NUM AI

`src/lib/concierge.ts` is the seam. Its public surface (`sendChip`,
`openVoice`, `payBill`, `buyPack`, …) is what the UI calls; today those
functions return scripted replies with fake typing delays. To wire up the real
backend, replace the scripted bodies with calls to the NUM AI service and push
results into the store — the UI reads everything from `store`/`useApp` and
needs no changes.

## Contributing

- Branch from `main`, open a pull request for review — please don't push
  directly to `main`.
- `npm run build` must pass (it runs the TypeScript check) before merging.
- `node_modules/`, `dist/`, and `.env*` are git-ignored — never commit
  secrets or API keys.
