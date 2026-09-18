// EVERY PLACE A LINK CAN GO, IN ONE FILE.
//
// 18 Sep 2026: "the share button is so blocky and ugly and confusing, let's
// add sharing for IG and all the social platforms, the QR code is great, the
// layout needs to be better." The old sheet had one big button, a copy row
// and an X link — three ways to do one thing, and none of them the way people
// actually share, which is "into the app I already have open".
//
// This module is the list of destinations and exactly how each is reached.
// The sheet draws it; nothing about a platform lives in a component.
//
// TWO KINDS OF LINK, AND WHY IT MATTERS. A CONNECT link (/c/<id>) attaches
// whoever opens it to the member — right for a friend, wrong for a public
// post, where any stranger scrolling past would end up attached to a named
// person's account. So a private channel (WhatsApp, Messages, the system
// sheet) carries the connect link and a public one (Instagram, X, Facebook)
// carries the referral link: the member is still credited for anyone who
// joins, and nobody is auto-connected by a post.
//
// INSTAGRAM HAS NO SHARE URL. There is no web intent that prefills a post or
// a story with text; the app opens and that is all. So the honest move is the
// one people already make by hand: the caption and the link go on the
// clipboard, Instagram opens, and the sheet says "paste it". Anything that
// claims to post to Instagram for you is either lying or asking for the
// account password.
//
// EVERYTHING HERE IS AN <a href> OR A COPY, NEVER AN API CALL. Nothing is
// posted by NUM and nothing is posted without the person reading it first.

export type Channel = 'instagram' | 'whatsapp' | 'messages' | 'x' | 'facebook' | 'copy' | 'more';

export interface ShareLinks {
  /** Attaches the opener to the member. Private channels only. */
  connect: string;
  /** Credits the member, connects nobody. Public channels. Null when the
   *  member has no referral code yet — and then no public tile is offered,
   *  because the only other link would auto-connect strangers. */
  referral: string | null;
  /** The sentence that goes with the link, in the member's voice — no link in it. */
  line: string;
}

export interface Destination {
  id: Channel;
  label: string;
  /** How it is reached: a URL to open, or an instruction the sheet performs. */
  kind: 'href' | 'copy' | 'system' | 'copy-then-open';
  href?: (l: ShareLinks) => string;
  /** For copy-then-open: the text that goes on the clipboard first. */
  clip?: (l: ShareLinks) => string;
  /** What the sheet says after a copy-then-open, so nobody is left guessing. */
  after?: string;
  /** Public channels get the referral link; the rest the connect link. */
  public: boolean;
}

const enc = encodeURIComponent;

/** A private message carries the connect link; a public caption the referral. */
export const privateText = (l: ShareLinks): string => `${l.line} ${l.connect}`;
export const publicCaption = (l: ShareLinks): string => `${l.line} ${l.referral ?? ''}`.trim();

/** The tiles this member may see: every private one, and the public ones only with a referral code. */
export const offered = (l: ShareLinks): readonly Destination[] => DESTINATIONS.filter((d) => !d.public || !!l.referral);

export const DESTINATIONS: readonly Destination[] = [
  {
    id: 'instagram', label: 'Instagram', kind: 'copy-then-open', public: true,
    clip: publicCaption,
    href: () => 'https://www.instagram.com/',
    after: 'Caption copied — paste it into your story or post.',
  },
  {
    id: 'whatsapp', label: 'WhatsApp', kind: 'href', public: false,
    href: (l) => `https://wa.me/?text=${enc(privateText(l))}`,
  },
  {
    id: 'messages', label: 'Messages', kind: 'href', public: false,
    // `sms:?&body=` is the one form both iOS and Android honour.
    href: (l) => `sms:?&body=${enc(privateText(l))}`,
  },
  {
    id: 'x', label: 'X', kind: 'href', public: true,
    href: (l) => `https://twitter.com/intent/tweet?text=${enc(l.line)}&url=${enc(l.referral ?? '')}`,
  },
  {
    id: 'facebook', label: 'Facebook', kind: 'href', public: true,
    href: (l) => `https://www.facebook.com/sharer/sharer.php?u=${enc(l.referral ?? '')}`,
  },
  { id: 'copy', label: 'Copy link', kind: 'copy', public: false, clip: (l) => l.connect },
  { id: 'more', label: 'More', kind: 'system', public: false },
];

/** Which link a destination carries — the rule above, as a function. */
export const linkFor = (d: Destination, l: ShareLinks): string | null => (d.public ? l.referral : l.connect);
