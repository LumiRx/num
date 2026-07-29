// Shared keyboard/screen-reader affordances for the design's div-based
// controls. Spread pressable(fn) onto any clickable element; pass a role to
// override the default 'button' (e.g. 'tab', 'checkbox').
import type { AriaRole, KeyboardEvent, SyntheticEvent } from 'react';

export function pressable(onActivate: (e: SyntheticEvent) => void, role: AriaRole = 'button') {
  return {
    role,
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); // Space must not scroll the page
        onActivate(e);
      }
    },
  };
}
