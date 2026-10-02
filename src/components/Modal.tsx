"use client";

// The one modal (STYLEGUIDE §Overlays and modals). Everything a modal owes
// the page comes from useModalOverlay — a layer on the LIFO overlay stack
// (Escape reaches only the top-most one), an inert + aria-hidden
// background, a scroll lock, focus handed back — plus, here, a focus trap,
// initial focus, the scrim, and a portal to <body> so no ancestor
// transform or overflow can clip it. The dialogs (components/Dialog), the
// lightbox, the video theater, the video dialog and the analytics
// drill-down are all this component.
//
//   <Modal open={open} onClose={close} label="Insert video" className="w-full max-w-md …">
//     …
//   </Modal>
//
// Initial focus goes to the first element carrying data-autofocus, else
// the first focusable element, else the panel. `layout="fill"` hands the
// whole viewport to the child (the lightbox pans on it).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useModalOverlay } from "./overlay/useModalOverlay";

export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  label,
  labelledBy,
  describedBy,
  layout = "center",
  scrim = "cmd-scrim",
  closeOnBackdrop = true,
  className = "",
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** The accessible name — or pass `labelledBy` with the id of the heading. */
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  /** center: a card in the middle; fill: the child owns the viewport. */
  layout?: "center" | "fill";
  /** Scrim classes; hard-coded colours only (a themed slate would invert). */
  scrim?: string;
  closeOnBackdrop?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useModalOverlay(open, onClose, { panelRef: panel });

  useEffect(() => {
    if (!open) return;
    const el = panel.current;
    if (!el) return;
    const target =
      el.querySelector<HTMLElement>("[data-autofocus]") ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el;
    // After the portal paints.
    const id = requestAnimationFrame(() => target.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
    // `mounted` matters: the first render returns null (no portal before
    // hydration), so the panel only exists once it flips.
  }, [open, mounted]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Tab" || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (n) => n.offsetParent !== null || n === document.activeElement
    );
    if (items.length === 0) {
      e.preventDefault();
      panel.current.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  if (!open || !mounted) return null;
  const fill = layout === "fill";
  return createPortal(
    <div
      className={`${scrim} fixed inset-0 z-50 ${fill ? "" : "flex items-center justify-center p-4"}`}
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`outline-hidden ${fill ? "h-full w-full" : ""} ${className}`.trim()}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
