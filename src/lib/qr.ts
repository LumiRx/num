// The QR encoder, re-exported.
//
// The implementation moved to worker/qr.mjs on 12 Sep 2026 and this file is
// deliberately a one-line pass-through. The reason is a bug that had not
// happened yet but was going to: the business console is server-rendered HTML
// from the Worker, so a venue's printable code has to be drawn with no browser
// in the picture. The Worker cannot import a .ts file (its tests are plain
// node running .mjs), so the choice was one encoder in a place both sides can
// reach, or two encoders that can quietly disagree about a mask and produce a
// code that scans on one screen and not the other.
//
// Nothing about the encoding changed. worker/qr.test.mjs pins the matrix.
export { qrMatrix, qrSvg } from '../../worker/qr.mjs';
