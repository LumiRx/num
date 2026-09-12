// How the app decides whether it can reach somebody.
//
// The address rule is not reimplemented here — it is the Worker's own
// function, re-exported. A sign-up form that accepts "dre@gmail.c" and a
// server that refuses it is a button that looks fine and fails on tap, and
// the person is told nothing useful. One rule, both sides.
export { normaliseEmail } from '../../worker/emailaddr.mjs';
import { normaliseEmail } from '../../worker/emailaddr.mjs';

/** Cheap yes/no for disabling a button while somebody is still typing. */
export const looksLikeEmail = (v: string): boolean => normaliseEmail(v) !== null;
