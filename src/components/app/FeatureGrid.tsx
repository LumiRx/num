// TODAY's launcher: every feature as a cover with a button. Two columns on a
// phone, each tile a photograph darkened at the foot so the words read, the
// name and one line of promise, and a single button that opens its page.
//
// Why covers and not icons: a guest decides in a glance whether a tile is for
// them, and "Plane, car or boat" over an aerial of a yacht is understood
// before it is read. The photographs are Pexels, free licence, no faces, no
// brands — app-public/covers/CREDITS.md.
import { FEATURES, openFeature } from '../../lib/features';
import { pressable } from '../../lib/a11y';
import { t } from '../../lib/i18n';
import { tileCover } from '../../lib/features';

export default function FeatureGrid() {
  return (
    <div style={{ padding: '4px 12px 8px' }}>
      <div style={{ fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--color-accent)', padding: '6px 2px 10px' }}>
        {t('EVERYTHING NUM DOES')}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {FEATURES.map((f, n) => (
          <div
            key={f.id}
            {...pressable(() => openFeature(f.id))}
            aria-label={`${t(f.title)} — ${t(f.cta)}`}
            className="press tap"
            style={{
              position: 'relative', cursor: 'pointer', borderRadius: 'var(--r-md)', overflow: 'hidden',
              aspectRatio: '4 / 5', background: 'var(--field-bg)', border: '1px solid var(--ink-08)',
              display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
            }}
          >
            {/* THE TILE GETS THE TILE-SIZED FILE (18 Sep 2026).
                The covers were 900px wide and the page cover is full width, so
                on a 3× phone they were being upscaled — soft tiles, and the
                worst of them looked broken. They are 1600px now, with a 640px
                cut beside each one for the grid: sharp at both sizes, and the
                twelve tiles on this screen weigh 428 KB between them instead
                of 2 MB. srcSet lets a 2× phone take the small one and a 3×
                phone the large, which is the whole point of having both. */}
            <img
              src={tileCover(f.cover)}
              srcSet={`${tileCover(f.cover)} 640w, ${f.cover} 1280w`}
              sizes="(max-width: 480px) 50vw, 240px"
              alt=""
              // The first two rows are above the fold on every phone; asking
              // the browser to be lazy about them only adds its own delay. The
              // rest wait for the scroll.
              loading={n < 4 ? 'eager' : 'lazy'}
              fetchPriority={n < 2 ? 'high' : 'auto'}
              decoding="async"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
            />
            {/* The foot is darkened, not the whole picture: the photograph is
                the reason the tile works, and a flat overlay would kill it. */}
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,.08) 0%, rgba(0,0,0,.18) 32%, rgba(0,0,0,.55) 62%, rgba(0,0,0,.82) 100%)' }} />
            <div style={{ position: 'relative', padding: '0 12px 12px', color: '#fff', display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 9.5, letterSpacing: '.14em', fontWeight: 800, opacity: 0.85 }}>{t(f.kicker)}</div>
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 16, lineHeight: 1.15, letterSpacing: '-.01em' }}>{t(f.title)}</div>
              {/* The BLURB, not the promise (18 Sep 2026: "each one doesn't
                  finish the sentence, it goes to ..."). Under 50 characters,
                  so two lines at this width hold the whole thought; the
                  clamp stays only as a guard for a long translation. */}
              <div style={{ fontSize: 11.5, lineHeight: 1.4, opacity: 0.88, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{t(f.blurb)}</div>
              <div
                style={{
                  marginTop: 4, alignSelf: 'start', borderRadius: 999, padding: '8px 12px',
                  background: 'rgba(255,255,255,.92)', color: '#111', fontSize: 11, fontWeight: 800, letterSpacing: '.05em',
                  justifySelf: 'start',
                }}
              >
                {t(f.cta)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
