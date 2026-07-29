// Shared keyboard/screen-reader affordances for the design's div-based
// controls. Spread pressable(fn) onto any clickable element; pass a role to
// override the default 'button' (e.g. 'tab', 'checkbox').
import { useEffect, useRef } from 'react';
import type { AriaRole, KeyboardEvent, RefObject, SyntheticEvent } from 'react';

/** Dialog focus per the WAI-ARIA pattern: when `open` turns true, remember the
 *  invoking element and move focus to the first control inside `ref` (or `ref`
 *  itself when it is the control, like the voice overlay); when it turns false
 *  or the dialog unmounts, hand focus back to the invoker. Rings stay
 *  keyboard-only — programmatic focus after a mouse tap doesn't match
 *  :focus-visible, so nothing changes visually for touch/mouse use. */
export function useDialogFocus(open: boolean, ref: RefObject<HTMLElement>) {
  const invoker = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    invoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The sheets transition visibility, and until the transition's first frame
    // the control still computes hidden and focus() silently no-ops — so retry
    // each frame until focus sticks, then stop.
    let raf = 0;
    const tryFocus = () => {
      const el = ref.current;
      if (!el) return;
      const first = el.matches('[tabindex="0"]') ? el : el.querySelector<HTMLElement>('[tabindex="0"], input');
      first?.focus();
      if (document.activeElement !== first) raf = requestAnimationFrame(tryFocus);
    };
    raf = requestAnimationFrame(tryFocus);
    return () => {
      cancelAnimationFrame(raf);
      if (invoker.current?.isConnected) invoker.current.focus();
      invoker.current = null;
    };
  }, [open, ref]);
}

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
