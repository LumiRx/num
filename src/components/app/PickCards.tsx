/**
 * A recommendation, rendered so it can be acted on — and seen.
 *
 * ── WHY THIS COMPONENT EXISTS ────────────────────────────────────────────
 *
 * Until 3 Sep 2026 every recommendation NUM gave arrived as one paragraph of
 * prose: three names, three reasons, a phone number and a street address run
 * together in a block of text, with no link to any of them. The reply schema
 * had told the model for weeks that "detail belongs in `picks`" — and `picks`
 * had never been built, so it all fell back into the prose field.
 *
 * ── THE GRID (19 Sep 2026) ────────────────────────────────────────────────
 *
 * Dre: "add social media and images and grid them out". A list of three
 * text cards is read; a grid of pictures is chosen from — which is what a
 * person deciding where to eat is doing. Two columns, the venue's own photo
 * on top (or a quiet tile with its initial when none is known yet), the name,
 * one line of why, where and how far. Tap a card and it opens: directions,
 * call, the venue's site, its Instagram / TikTok / Facebook, share. Past four
 * the rest fold behind "SHOW n MORE" — the answer stays a screen, not a scroll.
 *
 * Photos and socials arrive from the directory row first and are filled in
 * from the venue's own page after the answer renders (lib/placemedia.ts) —
 * never a stock picture, never a guessed handle.
 *
 * ── THE RULE THIS ENFORCES ───────────────────────────────────────────────
 *
 * Every place gets a link. `link` is non-optional in the type and guaranteed
 * by the server — a pick whose link could not be built is dropped before it
 * reaches this component. So there is no "no link" branch below, deliberately:
 * this component cannot render a dead end.
 *
 * Nothing here is model-written. Names, links, phones, addresses, photos and
 * opening state all come from the verified directory row or the venue's page.
 */
import { useEffect, useState } from 'react';
import { pressable } from '../../lib/a11y';
import { openShareCard } from '../../lib/sharecard';
import { fillMedia } from '../../lib/placemedia';
import type { Pick } from '../../lib/types';
import { webEvent } from '../../lib/track';
import { t } from '../../lib/i18n';

/** Open in a new tab, and never let a link leak the app's own referrer. */
const REL = 'noopener noreferrer';
/** How many show before the fold. Four is two rows — one screen on a phone. */
export const FOLD_AT = 4;

function OpenState({ open }: { open: boolean | null | undefined }) {
  // Three states, shown as three things. Unknown stays SILENT rather than
  // guessing: an unverified "open" is the claim that gets somebody a locked
  // door at the end of a long day.
  if (open == null) return null;
  return (
    <span style={{ ...badge, background: open ? 'var(--ok)' : 'var(--warn)' }}>
      {open ? t('Open now') : t('Closed now')}
    </span>
  );
}

function distance(km: number | null | undefined) {
  if (km == null || !Number.isFinite(km)) return null;
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km} km`;
}

/** A soft tile carrying the place's initial — never a stock photo pretending to be the place. */
function Tile({ name, tall }: { name: string; tall: boolean }) {
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <div aria-hidden style={{ ...imgBox(tall), background: `linear-gradient(135deg, hsl(${hue} 42% 90%), hsl(${(hue + 40) % 360} 38% 82%))`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 30, color: `hsl(${hue} 30% 36%)`, opacity: 0.7 }}>{[...name.trim()][0]?.toUpperCase() ?? '·'}</span>
    </div>
  );
}

const imgBox = (tall: boolean): React.CSSProperties => ({
  width: '100%', aspectRatio: tall ? '16 / 9' : '4 / 3', borderRadius: '12px 12px 0 0', overflow: 'hidden', position: 'relative',
});

const badge: React.CSSProperties = {
  fontSize: 10, fontWeight: 800, letterSpacing: '.04em', color: 'var(--on-accent)', padding: '3px 7px', borderRadius: 999, lineHeight: 1.3,
};

function Card({ p, i, single }: { p: Pick; i: number; single: boolean }) {
  const [open, setOpen] = useState(false);
  const meta = [p.area, distance(p.km)].filter(Boolean).join(' · ');
  const socials = [
    p.instagram ? { label: 'Instagram', href: p.instagram, ev: 'instagram' } : null,
    p.tiktok ? { label: 'TikTok', href: p.tiktok, ev: 'tiktok' } : null,
    p.facebook ? { label: 'Facebook', href: p.facebook, ev: 'facebook' } : null,
  ].filter(Boolean) as Array<{ label: string; href: string; ev: string }>;
  return (
    <div
      className="glass lift rise-in"
      // An open card takes the whole row: the action pills need the width, and
      // a card that grows in place drags its neighbour's layout with it.
      style={{ borderRadius: 14, overflow: 'hidden', display: 'flex', flexDirection: 'column', animationDelay: `${i * 45}ms`, gridColumn: single || open ? '1 / -1' : undefined }}
    >
      {/* The picture is the door: tapping it opens the card. */}
      <div {...pressable(() => { setOpen((o) => !o); webEvent('pick_expand', open ? 'close' : 'open'); })} aria-expanded={open} style={{ cursor: 'pointer', position: 'relative' }}>
        {p.photo ? (
          <div style={imgBox(single || open)}>
            <img src={p.photo} alt="" loading="lazy" referrerPolicy="no-referrer" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          </div>
        ) : <Tile name={p.name} tall={single || open} />}
        <div style={{ position: 'absolute', top: 8, left: 8, right: 8, display: 'flex', justifyContent: 'space-between', gap: 6 }}>
          <OpenState open={p.open_now} />
          {p.rating ? <span style={{ ...badge, background: 'var(--scrim)', marginLeft: 'auto' }}>{p.rating}★</span> : null}
        </div>
      </div>

      <div style={{ padding: '9px 10px 10px', display: 'grid', gap: 4, alignContent: 'start' }}>
        {/* The name IS the link. A separate "View" button next to a name
            is one more thing to read and one more thing to aim at. */}
        <a
          href={p.link}
          target="_blank"
          rel={REL}
          onClick={() => webEvent('pick_link_click', p.link_kind ?? 'link')}
          style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', textDecoration: 'none', lineHeight: 1.25, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
        >
          {p.name}
          {p.name_local ? <span style={{ fontWeight: 500, opacity: 0.6 }}> · {p.name_local}</span> : null}
        </a>
        {p.why ? (
          <div style={{ fontSize: 12, lineHeight: 1.4, color: 'var(--color-neutral-600)', display: '-webkit-box', WebkitLineClamp: open ? 6 : 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.why}</div>
        ) : null}
        {(meta || p.category) && (
          <div style={{ fontSize: 11, color: 'var(--ink-40)', lineHeight: 1.35 }}>{[p.category, meta].filter(Boolean).join(' · ')}</div>
        )}

        {open && (
          <div className="rise-in" style={{ display: 'grid', gap: 8, marginTop: 4 }}>
            {/* The actions, in the order a traveller needs them: get there,
                call ahead, see it, share it. Each is a real target, not a label. */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <a href={p.map ?? p.link} target="_blank" rel={REL} onClick={() => webEvent('pick_map_click')} style={pill}>{t('Directions')}</a>
              {p.tel ? <a href={p.tel} onClick={() => webEvent('pick_call_click')} style={pill}>{t('Call')}</a> : null}
              {p.website || p.link_kind === 'website' ? (
                <a href={p.website ?? p.link} target="_blank" rel={REL} onClick={() => webEvent('pick_link_click', 'website')} style={pill}>{t('Website')}</a>
              ) : null}
              {socials.map((s) => (
                <a key={s.ev} href={s.href} target="_blank" rel={REL} onClick={() => webEvent('pick_social_click', s.ev)} style={{ ...pill, color: 'var(--color-accent-700)' }}>{s.label}</a>
              ))}
              {/* SHARE — the missing half of an idea.
                  NUM suggests three places and the person reading them is
                  usually deciding on behalf of four people. This puts one on
                  the plan as an idea, or in a friend's chat, without leaving
                  the thread. */}
              <span
                {...pressable(() => openShareCard({
                  kind: 'idea',
                  title: p.name,
                  summary: [p.name, p.why, p.address].filter(Boolean).join(' — '),
                  place: p.address ?? p.area ?? null,
                  link: p.link,
                }))}
                role="button"
                tabIndex={0}
                style={{ ...pill, cursor: 'pointer' }}
              >
                {t('Share')}
              </span>
            </div>
            {/* The address is shown, not hidden behind the map link: it is what
                a guest reads out to a taxi driver who does not use our map. */}
            {p.address ? <div style={{ fontSize: 11.5, lineHeight: 1.4, color: 'var(--ink-40)' }}>{p.address}</div> : null}
            {p.photo && p.photo_attr ? <div style={{ fontSize: 9.5, color: 'var(--ink-40)' }}>{t('Photo')}: {p.photo_attr}</div> : null}
          </div>
        )}
      </div>
    </div>
  );
}

export default function PickCards({ picks, msgIndex }: { picks: Pick[]; msgIndex?: number }) {
  const [all, setAll] = useState(false);
  // Fill the pictures and socials this message is missing, once it is on screen.
  useEffect(() => { if (msgIndex != null) void fillMedia(msgIndex); }, [msgIndex, picks.length]);
  if (!picks?.length) return null;
  const shown = all ? picks : picks.slice(0, FOLD_AT);
  const single = picks.length === 1;
  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: single ? '1fr' : '1fr 1fr', gap: 8, alignItems: 'start' }}>
        {shown.map((p, i) => <Card key={p.id ?? `${p.name}-${i}`} p={p} i={i} single={single} />)}
      </div>
      {picks.length > FOLD_AT && !all && (
        <div
          {...pressable(() => { setAll(true); webEvent('pick_show_more', String(picks.length - FOLD_AT)); })}
          className="tap press"
          style={{ ...pill, justifyContent: 'center', width: '100%', fontWeight: 800, letterSpacing: '.08em', fontSize: 11 }}
        >
          {t('SHOW {n} MORE', { n: picks.length - FOLD_AT })}
        </div>
      )}
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
  background: 'var(--field-bg)',
  border: '1px solid var(--ink-12)',
  // A tap target on a phone, held by someone walking. 44 is Apple's floor and
  // this row is used one-handed, in the street, by someone already moving.
  minHeight: 44,
  display: 'inline-flex',
  alignItems: 'center',
  boxSizing: 'border-box',
};
