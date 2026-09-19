// YOUR HATS — and the one code each of them carries.
//
// Dre, 11 Sep 2026: a member who also owns a business or hosts should reach
// that dashboard from inside their own app, and "each needs a qr cods and a
// referral link so we can keep the connection between all of them and whos
// meeting who."
//
// One account, many hats: the member IS the identity, and a business or host
// is something they own (worker/identity.mjs). So this is a read, not a second
// login — the switch appears only for hats the server says are theirs.
//
// The QR and the link are the SAME code. Issuing one code for "scan me" and
// another for "refer me" would give one relationship two attribution paths,
// and the day they disagree nobody can say which was right.
import { useEffect, useMemo, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { qrSvg } from '../../lib/qr';
import { pretty } from '../../lib/links';
import { shareNative } from '../../lib/services';
import { myIdentities, myConnections, linkMyAccounts, linkMyHost } from '../../lib/social';
import type { LinkedHat } from '../../lib/social';
import { ChevronRightIcon, CopyIcon, ShareIcon, UsersIcon } from '../../lib/icons';
import { t } from '../../lib/i18n';
import { T } from '../../lib/i18nmark';

type Hat = { type: string; id: string; name: string | null; code: string | null; link: string | null };
type Met = {
  to_type: string; to_id: string; name: string | null; via: string;
  place: string | null; times: number; last_met_at: string;
};

const card: React.CSSProperties = { margin: '10px 12px', borderRadius: 'var(--r-lg)', padding: 14 };
const kicker: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--ink-40)' };

/** What we call each hat to a human. The server's word is a type, not a label. */
const LABEL: Record<string, string> = { member: T('You'), business: T('Business'), host: T('VIP host'), ambassador: T('Ambassador') };

const when = (iso: string): string => {
  const d = new Date(String(iso).replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

/**
 * "I own a business / I'm a host / I'm an ambassador" — the way in for
 * someone whose other account was created before this existed.
 *
 * Shown only when there is something left to link, because an offer to link
 * something you already linked reads as the app not knowing what it has.
 *
 * ONE BUTTON. Dre, 19 Sep 2026: "the number and email that's connected
 * connects the businesses they have. same thing for hosts and ambassadors.
 * when they link it we need to take them to their mobile dashboard." So the
 * control asks for nothing: the server matches every contact NUM has
 * verified for this member — the number it texted, the address it mailed —
 * against every business, host and ambassador record, and links all of
 * them. Anything a person could read off a signboard is not proof, and the
 * client is given no way to send one.
 *
 * The host console key stays as a second door, for a host who has not yet
 * verified their email in the app.
 *
 * AND THEN IT GOES SOMEWHERE. A business that just linked opens its
 * dashboard (BusinessSheet). A host or ambassador has no in-app dashboard
 * yet — the web console is theirs — so the newly linked hat is opened on
 * this card, code and share button showing, rather than a message that
 * promises a screen that does not exist.
 */
function LinkAccounts({ hats, onLinked }: { hats: Hat[]; onLinked: (linked: LinkedHat[]) => void }) {
  const hasBusiness = hats.some((h) => h.type === 'business');
  const hasHost = hats.some((h) => h.type === 'host');
  const hasAmbassador = hats.some((h) => h.type === 'ambassador');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [key, setKey] = useState('');

  if (hasBusiness && hasHost && hasAmbassador) return null;

  const run = async (what: 'all' | 'host') => {
    setBusy(what);
    setMsg(null);
    if (what === 'host') {
      const out = await linkMyHost(key);
      setBusy(null);
      if (out.ok) {
        setMsg(t('Linked. Your host dashboard is above.'));
        setKey('');
        setKeyOpen(false);
        onLinked([{ type: 'host', id: '', name: null }]);
        return;
      }
      setMsg(out.error ?? 'That didn\u2019t link — tell us at info@itsnum.com and we\u2019ll do it by hand.');
      return;
    }
    const out = await linkMyAccounts();
    setBusy(null);
    if (out.ok && out.linked.length) {
      const names = out.linked.map((l) => l.name ?? LABEL[l.type] ?? l.type);
      setMsg(names.length === 1 ? `Linked ${names[0]}.` : `Linked ${names.length}: ${names.join(', ')}.`);
      onLinked(out.linked);
      return;
    }
    if (out.ok && out.taken.length) {
      setMsg(t('That\u2019s already linked to another NUM account. If it\u2019s yours, tell us at info@itsnum.com.'));
      return;
    }
    setMsg(out.error ?? 'Nothing found on your verified number or email. Verify the one your business or host account uses, then try again.');
  };

  const btn: React.CSSProperties = {
    cursor: 'pointer', borderRadius: 999, padding: '11px 14px', textAlign: 'center',
    fontSize: 11.5, fontWeight: 800, letterSpacing: '.06em', minHeight: 44,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };

  return (
    <div style={{ marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--ink-08)' }}>
      <div style={kicker}>{t('ALREADY ON NUM ANOTHER WAY?')}</div>
      <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 5, lineHeight: 1.5 }}>{t('If you claimed a business listing, run as a VIP host or are a NUM ambassador, bring it in here and you manage it from this app — same account, separate dashboard.')}</div>

      <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
        <div
          {...pressable(() => { if (!busy) void run('all'); })}
          className="press"
          style={{ ...btn, background: 'var(--grad-accent)', color: '#fff' }}
        >
          {busy === 'all' ? '\u2026' : t('LINK MY ACCOUNTS')}
        </div>
        {!hasHost && !keyOpen && (
          <div
            {...pressable(() => setKeyOpen(true))}
            className="glass press"
            style={{ ...btn }}
          >
            LINK MY HOST ACCOUNT
          </div>
        )}
        {!hasHost && keyOpen && (
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={key}
              onChange={(e) => setKey(e.target.value.trim())}
              placeholder={t('Host console key')}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              style={{
                flex: 1, minWidth: 0, height: 44, borderRadius: 12, border: '1px solid var(--ink-12)',
                padding: '0 12px', fontSize: 16, background: 'var(--field-bg)', color: 'var(--color-text)',
                fontFamily: 'var(--font-body)', outline: 'none',
              }}
            />
            <div
              {...pressable(() => { if (!busy && key) void run('host'); })}
              className="press"
              style={{
                ...btn, padding: '0 18px',
                background: key ? 'var(--grad-accent)' : 'var(--ink-12)',
                color: key ? '#fff' : 'var(--ink-60)',
              }}
            >
              {busy === 'host' ? '\u2026' : t('LINK')}
            </div>
          </div>
        )}
      </div>

      {msg && (
        <div style={{ marginTop: 9, fontSize: 11.5, lineHeight: 1.5, color: 'var(--ink-60)' }}>{msg}</div>
      )}
      <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 8, lineHeight: 1.5 }}>{t('Everything links by the number and email NUM has already verified for you — nothing to type. A host can also link with the key from the host console.')}</div>
    </div>
  );
}

export default function IdentityCard() {
  const me = useApp((s) => s.me);
  const [hats, setHats] = useState<Hat[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [met, setMet] = useState<Met[] | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!me) return;
    void myIdentities().then(setHats);
  }, [me]);

  const chosen = useMemo(() => (hats ?? []).find((h) => `${h.type}:${h.id}` === open) ?? null, [hats, open]);

  useEffect(() => {
    if (!chosen) { setMet(null); return; }
    setMet(null);
    void myConnections(chosen.type, chosen.id).then(setMet);
  }, [chosen]);

  if (!me) return null;
  // Until the server answers, show nothing rather than an empty shell that
  // implies the member has no hats.
  if (!hats?.length) return null;

  const svg = chosen?.link ? qrSvg(chosen.link, { size: 200, dark: 'var(--ink)', light: 'transparent' }) : null;

  return (
    <div className="glass" style={{ ...card }}>
      <div style={kicker}>{t('YOUR CODES')}</div>
      <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 5, lineHeight: 1.5 }}>{t('One code each. Scanning it or opening the link does the same thing, so it counts once however someone found you.')}</div>

      <div style={{ marginTop: 11, display: 'grid', gap: 7 }}>
        {hats.map((h) => {
          const key = `${h.type}:${h.id}`;
          const isOpen = open === key;
          return (
            <div key={key}>
              <div
                {...pressable(() => setOpen(isOpen ? null : key))}
                role="button"
                aria-expanded={isOpen}
                aria-label={`${LABEL[h.type] ?? h.type} code`}
                style={{
                  cursor: 'pointer', minHeight: 44, padding: '10px 13px', borderRadius: 'var(--r-md, 12px)',
                  border: '1px solid var(--line, rgba(0,0,0,.08))',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                  background: isOpen ? 'var(--field-bg)' : 'transparent',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ ...kicker, fontSize: 9.5 }}>{t(LABEL[h.type] ?? h.type)}</div>
                  <div style={{ fontSize: 13, fontWeight: 700, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {h.name ?? me.name ?? 'Your code'}
                  </div>
                </div>
                <ChevronRightIcon size={16} />
              </div>

              {isOpen && (
                <div style={{ padding: '11px 2px 2px' }}>
                  {svg ? (
                    <div
                      style={{ display: 'flex', justifyContent: 'center', padding: 13, background: 'var(--field-bg)', borderRadius: 'var(--r-md)', border: '1px solid var(--ink-08)' }}
                      dangerouslySetInnerHTML={{ __html: svg }}
                    />
                  ) : (
                    <div style={{ fontSize: 11.5, color: 'var(--ink-60)' }}>{t('No code yet — reopen this in a moment.')}</div>
                  )}

                  {h.link && (
                    <>
                      <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 10, wordBreak: 'break-all' }}>
                        {pretty(h.link)}
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
                        <div
                          {...pressable(() => {
                            navigator.clipboard?.writeText(h.link ?? '').then(
                              () => { setCopied(true); setTimeout(() => setCopied(false), 1600); },
                              () => {},
                            );
                          })}
                          style={{ cursor: 'pointer', flex: 1, minHeight: 44, borderRadius: 999, border: '1px solid var(--ink-12)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 11, fontWeight: 800, letterSpacing: '.05em' }}
                        >
                          <CopyIcon size={13} /> {copied ? t('COPIED') : t('COPY LINK')}
                        </div>
                        <div
                          {...pressable(() => void shareNative({
                            title: h.name ?? 'NUM',
                            text: h.type === 'member'
                              ? t('Connect with me on NUM.')
                              : `Find ${h.name ?? 'us'} on NUM.`,
                            url: h.link ?? '',
                          }))}
                          style={{ cursor: 'pointer', flex: 1, minHeight: 44, borderRadius: 999, border: '1px solid var(--ink-12)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 11, fontWeight: 800, letterSpacing: '.05em' }}
                        >
                          <ShareIcon size={13} />{' '}{t('SHARE')}</div>
                      </div>
                    </>
                  )}

                  {/* Only a claimed business has a console to open, so the
                      switch appears only for that hat. A host's dashboard is
                      still web-only — no button here would pretend otherwise. */}
                  {h.type === 'business' && (
                    <div
                      {...pressable(() => store.set({ businessOpen: true }))}
                      style={{ cursor: 'pointer', marginTop: 9, minHeight: 44, borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, letterSpacing: '.06em' }}
                    >
                      OPEN BUSINESS DASHBOARD
                    </div>
                  )}

                  <div style={{ ...kicker, marginTop: 15, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <UsersIcon size={12} /> WHO YOU&rsquo;VE CONNECTED WITH
                  </div>
                  {met === null ? (
                    <div style={{ fontSize: 11.5, color: 'var(--ink-40)', marginTop: 7 }}>Looking&hellip;</div>
                  ) : met.length === 0 ? (
                    <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 7, lineHeight: 1.5 }}>
                      Nobody yet. When someone scans this code you&rsquo;ll both see it here.
                    </div>
                  ) : (
                    <div style={{ marginTop: 7, display: 'grid', gap: 5 }}>
                      {met.map((m) => (
                        <div key={`${m.to_type}:${m.to_id}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12 }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {m.name ?? 'Someone'}
                            {m.place ? <span style={{ color: 'var(--ink-40)' }}> · {m.place}</span> : null}
                          </span>
                          <span style={{ color: 'var(--ink-40)', flex: 'none' }}>
                            {when(m.last_met_at)}{m.times > 1 ? ` · ${m.times}×` : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <LinkAccounts
        hats={hats ?? []}
        onLinked={(linked) => {
          void myIdentities().then((fresh) => {
            setHats(fresh);
            // Take them where they were going. A business has a dashboard in
            // this app; a host or ambassador does not yet, so the hat opens
            // here with its code — nothing promised that is not built.
            const biz = linked.find((l) => l.type === 'business');
            if (biz) { store.set({ businessOpen: true }); return; }
            const first = linked[0];
            const hat = first ? fresh.find((h) => h.type === first.type && (!first.id || h.id === first.id)) : null;
            if (hat) setOpen(`${hat.type}:${hat.id}`);
          });
        }}
      />
    </div>
  );
}
