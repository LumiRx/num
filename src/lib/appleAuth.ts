// Sign in with Apple — the thin web half.
//
// The native half is ios/App/App/SignInWithApple.swift. This file only calls
// it, hands the resulting token to our own Worker, and returns what the Worker
// says. It deliberately holds no logic about whether a sign-in is valid:
// that question is answered in worker/appleauth.mjs against Apple's published
// keys, because a client that could answer it could also lie about it.
import { apiUrl } from './apibase';
import { nativePlatform } from './native';
import type { Member } from './types';

type AppleAuth = {
  identityToken: string;
  user: string;
  name?: string;
  email?: string;
};

type Bridge = {
  Plugins?: { SignInWithApple?: { authorize: () => Promise<AppleAuth> } };
};

const plugin = () =>
  (globalThis as unknown as { Capacitor?: Bridge }).Capacitor?.Plugins?.SignInWithApple ?? null;

/**
 * Whether to offer the button at all.
 *
 * iOS only, and only when the native plugin actually answered. Showing an
 * Apple button that cannot work is worse than not showing one — and on the
 * web there is no ASAuthorization to call.
 */
export const canSignInWithApple = (): boolean => nativePlatform() === 'ios' && !!plugin();

export type AppleSignInResult =
  | { ok: true; me: Member }
  | { ok: false; cancelled: boolean; message: string };

/**
 * Run the whole flow: native sheet → identity token → our Worker.
 *
 * `me` is the device's current anonymous member, passed so a guest who has
 * already been using Num keeps their account instead of being handed a new
 * empty one the moment they sign in.
 */
export async function signInWithApple(currentMemberId?: string | null): Promise<AppleSignInResult> {
  const p = plugin();
  if (!p) return { ok: false, cancelled: false, message: 'Apple sign-in is not available on this device.' };

  let auth: AppleAuth;
  try {
    auth = await p.authorize();
  } catch (err) {
    // A cancel is a decision, not a failure. The caller shows nothing.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, cancelled: /cancel/i.test(message), message };
  }

  const res = await fetch(apiUrl('/api/social/apple'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      identity_token: auth.identityToken,
      // Apple returns the name exactly once, on the first authorization ever
      // for this Apple ID. Forward it whenever present; the server stores it
      // on first sight because there is no second chance to ask.
      name: auth.name,
      me: currentMemberId ?? undefined,
    }),
  });

  const body = (await res.json().catch(() => ({}))) as { me?: Member; error?: string };
  if (!res.ok || !body.me) {
    return { ok: false, cancelled: false, message: body.error ?? 'That sign-in could not be completed.' };
  }
  return { ok: true, me: body.me };
}
