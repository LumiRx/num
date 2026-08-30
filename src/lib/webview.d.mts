/**
 * Types for webview.mjs.
 *
 * The implementation is plain .mjs on purpose: detection there is a pure
 * function of a user-agent string, so node:test can exercise it directly
 * against real strings from Reddit, Instagram and LINE. The platform branches
 * in native.ts have to settle for asserting against source text because a
 * jsdom run cannot be capacitor://localhost; this one does not, and should not
 * give that up for the sake of being written in TypeScript.
 */

export interface InAppSignature {
  name: string;
  re: RegExp;
}

export interface WebviewState {
  /** True when we are inside another app's browser. */
  inApp: boolean;
  /** The app whose browser it is, when we can name it. */
  name: string | null;
  /** Whether a home-screen install can actually be completed from here. */
  canInstallHere: boolean;
  reason: 'standalone' | 'named' | 'ios-webview' | 'browser';
}

export interface EscapeCard {
  name: string | null;
  eyebrow: string;
  heading: string;
  body: string;
  steps: string[];
}

export interface DetectOptions {
  /**
   * The real answer from the display-mode media query or navigator.standalone.
   * Required in spirit: on iOS an installed PWA and a WKWebView send the same
   * user agent, so this is the only thing keeping an installed user from being
   * told to go and install.
   */
  standalone?: boolean;
}

export declare const IN_APP_SIGNATURES: InAppSignature[];
export declare function namedInAppBrowser(ua: string | undefined | null): string | null;
export declare function looksLikeIosWebView(ua: string | undefined | null): boolean;
export declare function detectInAppBrowser(
  ua: string | undefined | null,
  opts?: DetectOptions,
): WebviewState;
export declare function escapeInstruction(
  ua: string | undefined | null,
  opts?: DetectOptions,
): EscapeCard | null;
