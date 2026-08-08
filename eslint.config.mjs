// Correctness only. No style rules, ever.
//
// This file exists because of one word: `asked: userText` in worker/index.mjs,
// in a scope where the variable was named `lastUser`. A ReferenceError fired
// on every big-lane request AFTER the model had produced a good answer, the
// catch replaced the answer with the fallback, and for two days it looked like
// a quota outage. Brains were healthy the whole time.
//
// `no-undef` catches that class of bug in milliseconds, before deploy, every
// time. That is the entire mandate. Style belongs to whoever is writing;
// adding formatting opinions here would bury the one rule that matters under
// a hundred that don't, and the first noisy run would get this file deleted.
import globals from 'globals';

export default [
  {
    files: ['worker/**/*.mjs', 'scripts/**/*.mjs', 'server/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
        // Workers runtime globals that are not in the node set.
        Response: 'readonly',
        Request: 'readonly',
        fetch: 'readonly',
        caches: 'readonly',
        crypto: 'readonly',
        WebSocketPair: 'readonly',
        HTMLRewriter: 'readonly',
      },
    },
    rules: {
      // The rule this file exists for.
      'no-undef': 'error',
      // Its close relatives — each one is a bug, never a preference.
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-self-assign': 'error',
      'no-unsafe-negation': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-const-assign': 'error',
      'no-func-assign': 'error',
      'no-import-assign': 'error',
      'no-async-promise-executor': 'error',
      'no-compare-neg-zero': 'error',
      'no-cond-assign': 'error',
      'no-constant-binary-expression': 'error',
    },
  },
];
