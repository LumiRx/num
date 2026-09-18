// "Look into it" — the long answer, for the questions one turn cannot hold.
//
// An ordinary turn answers one question from one gather in a few seconds.
// This is for the briefs people actually arrive with: "three days in Phuket
// with a five-year-old and a grandmother who can't walk far", "compare Ari,
// Thonglor and Ekkamai for a month of working remotely". Several questions
// wearing one coat, and constraints that DISQUALIFY rather than rank.
//
// It takes 15–60 seconds, so the sheet is built around waiting rather than
// hiding the wait: the guest sees the sub-questions NUM decided to research
// the moment they exist, can close the app entirely, and gets a push when it
// lands. Nothing here pretends to be fast.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { XIcon, SparklesIcon } from '../../lib/icons';
import { startResearch, stopWatchingResearch } from '../../lib/research';
import { t } from '../../lib/i18n';

const field: React.CSSProperties = {
  width: '100%', minHeight: 92, borderRadius: 14, border: '1px solid var(--ink-12)', padding: '12px 14px',
  fontSize: 16, background: 'var(--field-bg)', outline: 'none', fontFamily: 'var(--font-body)',
  color: 'var(--color-text)', resize: 'none', lineHeight: 1.5,
};
const button: React.CSSProperties = {
  cursor: 'pointer', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700,
  fontSize: 12, letterSpacing: '.06em', padding: '14px 16px', textAlign: 'center', minHeight: 44,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const label: React.CSSProperties = {
  fontSize: 10.5, letterSpacing: '.13em', fontWeight: 800, color: 'var(--ink-55)', textTransform: 'uppercase',
};

/** Examples, not placeholders — the shape of brief this is for. */
const EXAMPLES = [
  'Three days in Phuket with a five-year-old and a grandmother who cannot walk far',
  'Compare Ari, Thonglor and Ekkamai for a month of working remotely',
  'Dinner for eight on Saturday at nine, two vegans, one who hates seafood',
];

export default function ResearchSheet() {
  const open = useApp((s) => s.researchOpen);
  const run = useApp((s) => s.research);
  const busy = useApp((s) => s.researchBusy);
  const error = useApp((s) => s.researchError);
  const left = useApp((s) => s.researchLeft);
  const place = useApp((s) => s.place);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(open, ref);
  const [brief, setBrief] = useState('');

  // Polling costs a request every three seconds. It has no business running
  // while nobody is looking at the result — the push is what carries a run
  // the guest walked away from.
  useEffect(() => { if (!open) stopWatchingResearch(); }, [open]);

  if (!open) return null;
  const close = () => store.set({ researchOpen: false });
  const waiting = run?.state === 'queued' || run?.state === 'running';

  const go = async () => {
    const b = brief.trim();
    if (b.length < 12 || busy) return;
    await startResearch(b);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('Look into it')}
      ref={ref}
      // Without this class the sheet gets position and z-index from sheetBase
      // and NOTHING else — no background. It shipped transparent in 0.8.353:
      // the thread's messages read straight through the brief field. The glass
      // IS the background in this app; every other dialog sheet carries it.
      className="glass-strong sheet-in"
      style={{ ...sheetBase, zIndex: 60 }}
    >
      <div style={grabberStyle} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 16px 10px' }}>
        <div style={{ fontSize: 11, letterSpacing: '.16em', fontWeight: 800 }}>
          {t('LOOK INTO IT')}{' '}
          <span style={{ fontWeight: 400, opacity: 0.5 }}>· {t('the long answer')}</span>
        </div>
        <div
          {...pressable(close)}
          aria-label={t('Close')}
          className="glass press"
          style={{ cursor: 'pointer', width: 44, height: 44, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <XIcon size={15} />
        </div>
      </div>

      <div style={{ padding: '0 16px 20px', overflowY: 'auto', maxHeight: '72vh' }}>
        {!run && (
          <>
            <div style={{ fontSize: 14.5, lineHeight: 1.55, color: 'var(--ink-70)', marginBottom: 12 }}>
              {t('Give me the whole thing — everyone coming, what has to be true, what you would rather avoid. I will take a minute and check real places against it.')}
            </div>
            <textarea
              style={field}
              value={brief}
              onChange={(e) => setBrief(e.target.value.slice(0, 600))}
              placeholder={place ? t('What should I look into?') : t('Tell me where first, then what to look into')}
              aria-label={t('What should I look into?')}
            />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, margin: '10px 0 4px' }}>
              {EXAMPLES.map((ex) => (
                <div
                  key={ex}
                  {...pressable(() => setBrief(ex))}
                  className="glass press"
                  style={{ cursor: 'pointer', borderRadius: 999, padding: '9px 12px', fontSize: 12.5, minHeight: 44, display: 'flex', alignItems: 'center' }}
                >
                  {ex}
                </div>
              ))}
            </div>
            {error && (
              <div style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--ink-70)', margin: '12px 0 0' }}>{error}</div>
            )}
            <div {...pressable(go)} style={{ ...button, marginTop: 14, opacity: brief.trim().length < 12 || busy ? 0.55 : 1 }}>
              <SparklesIcon size={14} />
              <span style={{ marginLeft: 7 }}>{busy ? t('STARTING…') : t('LOOK INTO IT')}</span>
            </div>
            {typeof left === 'number' && (
              <div style={{ ...label, marginTop: 10, textAlign: 'center' }}>
                {left} {t('left this month')}
              </div>
            )}
          </>
        )}

        {run && (
          <>
            <div style={{ fontSize: 15, lineHeight: 1.5, fontWeight: 650, marginBottom: 10 }}>{run.brief}</div>

            {waiting && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13.5, color: 'var(--ink-70)' }}>
                  <span className="dots" aria-hidden="true">•••</span>
                  {t('Working on it. This takes a minute — you can close NUM, I will ping you.')}
                </div>
                {/* The sub-questions appear as soon as the server has them,
                    which is well before the answer. Showing the shape of the
                    work is the difference between a wait and a blank. */}
                {run.questions.length > 0 && (
                  <div style={{ marginTop: 14 }}>
                    <div style={label}>{t('WHAT I AM CHECKING')}</div>
                    {run.questions.map((q) => (
                      <div key={q.q} style={{ fontSize: 13.5, lineHeight: 1.5, margin: '7px 0', color: 'var(--ink-70)' }}>· {q.q}</div>
                    ))}
                  </div>
                )}
              </>
            )}

            {run.state === 'done' && run.answer && (
              <div style={{ fontSize: 14.8, lineHeight: 1.62, whiteSpace: 'pre-wrap' }}>{run.answer}</div>
            )}

            {run.state === 'empty' && (
              <div style={{ fontSize: 14.5, lineHeight: 1.6, color: 'var(--ink-70)' }}>{run.answer}</div>
            )}

            {run.state === 'failed' && (
              <div style={{ fontSize: 14.5, lineHeight: 1.6, color: 'var(--ink-70)' }}>
                {t('That one stopped before it finished, and it has not been counted against your month. Worth trying again.')}
              </div>
            )}

            {/* NEVER HIDDEN. `unmet` is what the evidence could not settle and
                any venue NUM could not find in its own directory. An answer
                that quietly drops those is the answer this feature exists not
                to give — see the honesty rules in worker/research.mjs. */}
            {run.unmet.length > 0 && (
              <div style={{ marginTop: 16, padding: '12px 14px', borderRadius: 14, background: 'var(--ink-04)', border: '1px solid var(--ink-12)' }}>
                <div style={label}>{t('WHAT I COULD NOT CONFIRM')}</div>
                {run.unmet.map((u) => (
                  <div key={u} style={{ fontSize: 13.3, lineHeight: 1.5, marginTop: 6, color: 'var(--ink-70)' }}>{u}</div>
                ))}
              </div>
            )}

            {run.state !== 'queued' && run.state !== 'running' && (
              <div style={{ display: 'flex', gap: 9, marginTop: 16 }}>
                <div
                  {...pressable(() => { store.set({ research: null, researchError: null }); setBrief(''); })}
                  className="glass press"
                  style={{ ...button, background: 'transparent', color: 'var(--color-text)', flex: 1 }}
                >
                  {t('ASK SOMETHING ELSE')}
                </div>
              </div>
            )}

            {run.places.length > 0 && (
              <div style={{ ...label, marginTop: 14, textAlign: 'center' }}>
                {t('checked against')} {run.places.length} {t('real places')}
                {run.ms ? ` · ${Math.round(run.ms / 1000)}s` : ''}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
