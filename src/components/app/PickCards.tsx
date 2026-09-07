/**
 * A recommendation, rendered so it can be acted on.
 *
 * ── WHY THIS COMPONENT EXISTS ────────────────────────────────────────────
 *
 * Until 3 Sep 2026 every recommendation Num gave arrived as one paragraph of
 * prose: three names, three reasons, a phone number and a street address run
 * together in a block of text, with no link to any of them. The reply schema
 * had told the model for weeks that "detail belongs in `picks`" — and `picks`
 * had never been built, so it all fell back into the prose field.
 *
 * A guest standing in a city they do not know cannot use that. They cannot
 * tap a phone number inside a sentence, they cannot get directions to a name,
 * and they cannot compare three options written as one line.
 *
 * ── THE RULE THIS ENFORCES ───────────────────────────────────────────────
 *
 * Every place gets a link. `link` is non-optional in the type and guaranteed
 * by the server — a pick whose link could not be built is dropped before it
 * reaches this component. So there is no "no link" branch below, deliberately:
 * this component cannot render a dead end.
 *
 * Nothing here is model-written. Names, links, phones, addresses and opening
 * state all come from the verified directory row.
 */
import type { Pick } from '../../lib/types';
import { webEvent } from '../../lib/track';

const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' };

/** Open in a new tab, and never let a link leak the app's own referrer. */
const REL = 'noopener noreferrer';

function OpenState({ open }: { open: boolean | null | undefined }) {
  // Three states, shown as three things. Unknown stays SILENT rather than
  // guessing: an unverified "open" is the claim that gets somebody a locked
  // door at the end of a long day.
  if (open === true) return <span style={{ color: 'var(--ok, #0e6b45)', fontWeight: 700 }}>Open now</span>;
  if (open === false) return <span style={{ color: 'var(--warn, #9a3412)', fontWeight: 700 }}>Closed now</span>;
  return null;
}

function distance(km: number | null | undefined) {
  if (km == null || !Number.isFinite(km)) return null;
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km} km`;
}

export default function PickCards({ picks }: { picks: Pick[] }) {
  if (!picks?.length) return null;
  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
      {picks.map((p, i) => {
        const meta = [p.category, p.area, distance(p.km), p.rating ? `${p.rating}★` : null].filter(Boolean).join(' · ');
        return (
          <div
            key={p.id ?? `${p.name}-${i}`}
            className="glass"
            style={{ borderRadius: 14, padding: '11px 13px', display: 'grid', gap: 6 }}
          >
            {/* The name IS the link. A separate "View" button next to a name
                is one more thing to read and one more thing to aim at. */}
            <a
              href={p.link}
              target="_blank"
              rel={REL}
              onClick={() => webEvent('pick_link_click', p.link_kind ?? 'link')}
              style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)', textDecoration: 'none', lineHeight: 1.25 }}
            >
              {p.name}
              {p.name_local ? <span style={{ fontWeight: 500, opacity: 0.6 }}> · {p.name_local}</span> : null}
            </a>

            {p.why ? (
              <div style={{ fontSize: 13, lineHeight: 1.45, color: 'var(--color-neutral-600, #555)' }}>{p.why}</div>
            ) : null}

            {(meta || p.open_now != null) && (
              <div style={{ ...row, fontSize: 11.5, color: 'var(--ink-40, #888)' }}>
                {meta ? <span>{meta}</span> : null}
                {meta && p.open_now != null ? <span aria-hidden>·</span> : null}
                <OpenState open={p.open_now} />
              </div>
            )}

            {/* The actions, in the order a traveller needs them: get there,
                call ahead, book. Each is a real target, not a label. */}
            <div style={{ ...row, gap: 8, marginTop: 1 }}>
              <a
                href={p.map ?? p.link}
                target="_blank"
                rel={REL}
                onClick={() => webEvent('pick_map_click')}
                style={pill}
              >
                Directions
              </a>
              {p.tel ? (
                <a href={p.tel} onClick={() => webEvent('pick_call_click')} style={pill}>
                  Call
                </a>
              ) : null}
              {p.link_kind === 'website' ? (
                <a href={p.link} target="_blank" rel={REL} onClick={() => webEvent('pick_link_click', 'website')} style={pill}>
                  Website
                </a>
              ) : null}
            </div>

            {/* The address is shown, not hidden behind the map link: it is what
                a guest reads out to a taxi driver who does not use our map. */}
            {p.address ? (
              <div style={{ fontSize: 11.5, lineHeight: 1.4, color: 'var(--ink-40, #888)' }}>{p.address}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

const pill: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 600,
  padding: '6px 11px',
  borderRadius: 999,
  textDecoration: 'none',
  color: 'var(--ink)',
  background: 'var(--chip-bg, rgba(0,0,0,.05))',
  // A tap target on a phone, held by someone walking.
  minHeight: 32,
  display: 'inline-flex',
  alignItems: 'center',
};
