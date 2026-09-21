// Scanning somebody else's Num code, from inside the app.
//
// ── WHY THIS IS NOW THE MAIN PATH, NOT A CONVENIENCE (21 Sep 2026) ────────
//
// Most people use Num as a home-screen web app (PWA) until the store app is
// ready. On iPhone the phone's camera app CANNOT open a home-screen web app:
// it always opens Safari, and Safari keeps a separate Num with its own
// storage. So a friend's QR scanned with the camera landed in the wrong
// place, and the friend add waited on a code nobody noticed.
//
// Scanning from inside Num sidesteps all of it: the scan happens where the
// account already is, so the friend is added on the spot.
//
// Two decoders. Android Chrome has BarcodeDetector built in and it is the
// fastest. iPhone Safari does not, so jsQR (a small, pure-JavaScript decoder,
// Apache-2.0) is loaded ONLY when someone opens the scanner. It costs nothing
// to anybody who never scans.

import { store } from './store';
import { completePendingLinks } from './social';

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

const detectorCtor = (): BarcodeDetectorCtor | null =>
  (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector ?? null;

/** Can we scan in-app? Anywhere with a camera: jsQR covers iPhone. */
export const scanSupported = (): boolean => !!navigator.mediaDevices?.getUserMedia;

/**
 * Pull a code out of whatever the camera read.
 *
 * Accepts both shapes a Num code can take, because both exist in the wild: the
 * short path we mint today (`/c/mem_x`) and the query form the Worker redirects
 * it to (`/?c=mem_x`), which is what a screenshot of an already-opened link
 * carries. Anything that is not a Num connect link returns null so the caller
 * can say so rather than silently doing nothing.
 */
export function memberIdFrom(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const q = url.searchParams.get('c');
  if (q) return q.slice(0, 40);
  const path = /^\/c\/([A-Za-z0-9_-]{1,64})\/?$/.exec(url.pathname);
  return path ? path[1].slice(0, 40) : null;
}

export interface ScanHandle {
  stop(): void;
}

/**
 * Open the back camera, watch for a Num code, connect on the first hit.
 *
 * Stops itself on success — a scanner that keeps running after it worked reads
 * as if it did not. The caller gets `stop()` for the cancel/unmount path.
 */
export async function startScan(
  video: HTMLVideoElement,
  on: { found: (name: string) => void; error: (message: string) => void },
): Promise<ScanHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    on.error('This browser can’t use the camera — open your phone’s camera app on the code instead.');
    return { stop: () => {} };
  }

  let stream: MediaStream;
  try {
    // `environment` is the back camera. Without it a phone opens the selfie
    // camera, which cannot see a code held up by the person opposite you.
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    on.error('I need camera access to scan. Allow it for Num in your phone’s settings and try again.');
    return { stop: () => {} };
  }

  video.srcObject = stream;
  video.setAttribute('playsinline', 'true'); // iOS refuses to inline-play without it
  video.muted = true;
  await video.play().catch(() => {});

  const read = await makeReader();
  let live = true;
  let timer = 0;

  const stop = () => {
    live = false;
    clearTimeout(timer);
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };

  // Guard against acting on the same code repeatedly while it sits in frame.
  let handled = false;

  const tick = async () => {
    if (!live) return;
    try {
      for (const raw of await read(video)) {
        const id = memberIdFrom(raw);
        if (!id || handled) continue;
        handled = true;
        stop();
        // Same finishing path as a link or a sign-in: one place decides
        // between a member id and an identity code, and adds the friend.
        store.set({ connectTo: id });
        await completePendingLinks();
        on.found(id);
        return;
      }
    } catch {
      /* a dropped frame is not an error worth surfacing — keep looking */
    }
    // About seven looks a second: quick enough to feel instant, gentle
    // enough not to cook the battery while someone lines the code up.
    timer = window.setTimeout(() => void tick(), 140);
  };
  void tick();

  return { stop };
}

type Reader = (video: HTMLVideoElement) => Promise<string[]>;

async function makeReader(): Promise<Reader> {
  const Ctor = detectorCtor();
  if (Ctor) {
    try {
      const detector = new Ctor({ formats: ['qr_code'] });
      return async (v) => (await detector.detect(v)).map((h) => h.rawValue);
    } catch { /* fall through to jsQR */ }
  }
  const jsQR = (await import('jsqr')).default;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async (v) => {
    if (!ctx || !v.videoWidth) return [];
    // Scaled down: a QR held at arm's length reads fine at 640px, and a
    // full 4K frame would take long enough per look to feel frozen.
    const scale = Math.min(1, 640 / v.videoWidth);
    canvas.width = Math.round(v.videoWidth * scale);
    canvas.height = Math.round(v.videoHeight * scale);
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    return hit?.data ? [hit.data] : [];
  };
}
