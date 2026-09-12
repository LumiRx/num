// Types for the one QR encoder (worker/qr.mjs).
//
// The implementation is plain JavaScript because the Worker imports it too,
// and the Worker's test runner is node running .mjs directly. This file is how
// the TypeScript side of the app sees it — see the note at the top of qr.mjs.

/** Encode `text` and return the module matrix (1 = dark). */
export function qrMatrix(text: string): { size: number; modules: (row: number, col: number) => number };

/** The QR as an inline SVG string. */
export function qrSvg(
  text: string,
  opts?: { size?: number; margin?: number; dark?: string; light?: string },
): string;
