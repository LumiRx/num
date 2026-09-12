/** Types for the shared address rule (worker/emailaddr.mjs). */

/** The address, trimmed and lowercased — or null if we could not send to it. */
export function normaliseEmail(raw: unknown): string | null;
