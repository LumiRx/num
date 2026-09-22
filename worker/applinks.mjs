// The two small files that let a phone open the Num APP for a Num link.
//
// Without them, a friend's QR scanned with the camera opens Safari or Chrome,
// even when the scanner has the app installed. The browser is a different
// place with its own storage, so the friend add either landed on the wrong
// account or waited on a code nobody noticed. That was the 21 Sep 2026 bug:
// "it took me into the chat, it never added them as a friend."
//
// iOS reads apple-app-site-association; Android reads assetlinks.json. Only
// the share paths are claimed: /c/ (connect), /i/ (invite), /r/ (referral).
// Everything else on app.itsnum.com keeps opening in the browser as before.

// Team id from ios/App/App.xcodeproj (DEVELOPMENT_TEAM) + the permanent app id.
export const IOS_APP_ID = '6X2UDX3SUP.com.itsnum.app';
export const ANDROID_PACKAGE = 'com.itsnum.app';
export const LINK_PATHS = ['/c/*', '/i/*', '/r/*'];

export function appleAppSiteAssociation() {
  return {
    applinks: {
      details: [{
        appIDs: [IOS_APP_ID],
        components: LINK_PATHS.map((p) => ({ '/': p })),
      }],
    },
  };
}

/**
 * Android verifies the app by its signing certificate. Until the release
 * key's SHA-256 is set as ANDROID_CERT_SHA256 this answers an empty list,
 * which is the honest answer: Android then keeps opening links in the
 * browser, exactly as it does today, instead of trusting a guessed key.
 */
export function assetLinks(env) {
  const prints = String(env?.ANDROID_CERT_SHA256 ?? '')
    .split(',').map((s) => s.trim()).filter((s) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i.test(s));
  if (!prints.length) return [];
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: prints },
  }];
}

/** Answers the two well-known paths, or null for anything else. */
export function handleAppLinks(url, env) {
  const body =
    url.pathname === '/.well-known/apple-app-site-association' || url.pathname === '/apple-app-site-association'
      ? appleAppSiteAssociation()
      : url.pathname === '/.well-known/assetlinks.json'
        ? assetLinks(env)
        : null;
  if (!body) return null;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });
}
