"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href],area[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

interface DialogOpts {
  /** Handle Escape → close. Set false when the consumer already wires its own Escape. */
  escape?: boolean;
  /** Run only while the dialog is open. Default true (for overlays that mount per open). */
  active?: boolean;
}

/**
 * Accessible-dialog plumbing for an overlay: traps Tab focus inside the panel, moves focus into it
 * on open, restores focus to the trigger on close, and (optionally) closes on Escape. Attach the
 * returned ref to the panel element and give it `role="dialog" aria-modal="true" tabIndex={-1}`.
 */
export function useDialog<T extends HTMLElement = HTMLDivElement>(
  onClose: () => void,
  opts: DialogOpts = {}
) {
  const { escape = true, active = true } = opts;
  const ref = useRef<T>(null);
  // keep the latest onClose without re-running the effect each render (inline arrows change identity)
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    const prevFocus = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);

    // move focus into the dialog (first field, else the panel itself)
    (focusables()[0] ?? node).focus({ preventScroll: true });

    function onKey(e: KeyboardEvent) {
      if (escape && e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (!f.length) {
        e.preventDefault();
        return;
      }
      const first = f[0];
      const last = f[f.length - 1];
      const active2 = document.activeElement;
      if (e.shiftKey && (active2 === first || active2 === node)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active2 === last) {
        e.preventDefault();
        first.focus();
      }
    }

    node.addEventListener("keydown", onKey);
    return () => {
      node.removeEventListener("keydown", onKey);
      prevFocus?.focus?.({ preventScroll: true });
    };
  }, [active, escape]);

  return ref;
}
