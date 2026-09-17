// The translatable-literal marker, on its own so that modules the store
// depends on (data.ts) can mark strings without importing the store.
// Identity at runtime; scripts/i18n-catalog.mjs collects T('…') like t('…').
export const T = (en: string): string => en;
