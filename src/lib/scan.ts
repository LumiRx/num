// Scanning somebody else's Num code, from inside the app.
//
// Worth being clear about why this is a convenience rather than the main path:
// every code Num shows is a plain https link, so the phone's OWN camera app
// already scans it and opens it correctly. That is the route most people take
// and it needs no code from us.
//
// This exists for the case where the camera app is not the obvious move —
// someone already inside Num, looking at their own code, who wants to scan
// back. On Android that is a genuinely better flow. On iPhone it is not
// available at all: Safari has no BarcodeDetector, and shipping a QR *decoder*
// is a different order of problem from the encoder in qr.ts (binarisation,
// perspective correction and error correction, versus laying out a matrix we
// already know). So we detect support honestly and point iPhone users at the
// camera app, which does the job perfectly.

import { connectByCode } from './social';

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

const detectorCtor = (): BarcodeDetectorCtor | null =>
  (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector ?? null;

/** Can we scan in-app at all? False on iOS Safari — see the note above. */
export const scanSupported = (): boolean => !!detectorCtor() && !!navigator.mediaDevices?.getUserMedia;

/**
 * Pull a member id out of whatever the camera read.
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
  const Ctor = detectorCtor();
  if (!Ctor || !navigator.mediaDevices?.getUserMedia) {
    on.error('This browser can’t scan in-app — use your phone’s camera app on the code instead.');
    return { stop: () => {} };
  }

  let stream: MediaStream;
  try {
    // `environment` is the back camera. Without it a phone opens the selfie
    // camera, which cannot see a code held up by the person opposite you.
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    on.error('I need camera access to scan — you can allow it in your browser settings.');
    return { stop: () => {} };
  }

  video.srcObject = stream;
  video.setAttribute('playsinline', 'true'); // iOS refuses to inline-play without it
  await video.play().catch(() => {});

  const detector = new Ctor({ formats: ['qr_code'] });
  let live = true;
  let raf = 0;

  const stop = () => {
    live = false;
    cancelAnimationFrame(raf);
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };

  // Guard against announcing the same code repeatedly while it sits in frame.
  let handled = false;

  const tick = async () => {
    if (!live) return;
    try {
      const hits = await detector.detect(video);
      for (const hit of hits) {
        const id = memberIdFrom(hit.rawValue);
        if (!id || handled) continue;
        handled = true;
        stop();
        await connectByCode(id);
        on.found(id);
        return;
      }
    } catch {
      /* a dropped frame is not an error worth surfacing — keep looking */
    }
    raf = requestAnimationFrame(() => void tick());
  };
  raf = requestAnimationFrame(() => void tick());

  return { stop };
}
