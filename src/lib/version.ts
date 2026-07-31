// What this copy of the app actually is. Stamped at build time by vite.config.
//
// It exists because "the user is seeing the old copy" is impossible to diagnose
// without it — a version on screen turns a guess into a fact.
declare const __NUM_VERSION__: string;
declare const __NUM_SHA__: string;
declare const __NUM_BUILT__: string;

export const VERSION = typeof __NUM_VERSION__ === 'string' ? __NUM_VERSION__ : 'dev';
export const SHA = typeof __NUM_SHA__ === 'string' ? __NUM_SHA__ : 'dev';
export const BUILT = typeof __NUM_BUILT__ === 'string' ? __NUM_BUILT__ : '';

export const versionLine = `v${VERSION} · ${SHA} · ${BUILT}`;

/**
 * Ask the server which version IT is on. If the two disagree, this phone is
 * running a cached copy — which is exactly the bug that had someone reading
 * two-day-old welcome copy.
 */
export async function checkForUpdate(): Promise<{ stale: boolean; server: string } | null> {
  try {
    const res = await fetch('/api/version', { cache: 'no-store' });
    if (!res.ok) return null;
    const { version } = (await res.json()) as { version: string };
    return { stale: !!version && version !== VERSION, server: version };
  } catch {
    return null;
  }
}
