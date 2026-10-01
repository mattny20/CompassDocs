"use client";

// The one floating panel (STYLEGUIDE §Overlays and modals): a menu, a
// column picker, a QR card, the notifications dropdown. Anchored to its
// trigger (the parent is `relative`), the floating elevation tier, closes
// on outside click and on Escape through the overlay stack (so a palette
// opened on top owns Escape, and one keypress never closes two layers),
// and hands focus back to the trigger. The caller renders the trigger and
// owns `open`; the trigger should carry aria-expanded and aria-haspopup.
//
//   <div className="relative">
//     <button ref={btn} aria-expanded={open} aria-haspopup="menu" onClick=…>Export</button>
//     <Popover open={open} onClose={() => setOpen(false)} triggerRef={btn} role="menu" label="Export" align="end" width="w-64">
//       …
//     </Popover>
//   </div>

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { pushOverlay, bindEscapeDispatcher } from "@/lib/overlay-stack";

export function Popover({
  open,
  onClose,
  triggerRef,
  role = "dialog",
  label,
  align = "start",
  side = "bottom",
  width = "w-64",
  padding = "p-1",
  className = "",
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** The control that opened it; focus returns here on Escape. */
  triggerRef?: RefObject<HTMLElement | null>;
  role?: "dialog" | "menu" | "listbox" | "group";
  /** The accessible name of the panel. */
  label: string;
  /** Which edge of the trigger the panel hangs from. */
  align?: "start" | "end";
  side?: "bottom" | "top";
  width?: string;
  padding?: string;
  className?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const unbind = bindEscapeDispatcher();
    const pop = pushOverlay(() => {
      onClose();
      triggerRef?.current?.focus();
    });
    function onPointer(e: MouseEvent) {
      const t = e.target as Node;
      if (panel.current?.contains(t)) return;
      if (triggerRef?.current?.contains(t)) return;
      onClose();
    }
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      pop();
      unbind();
    };
  }, [open, onClose, triggerRef]);

  if (!open) return null;
  const pos = `${side === "top" ? "bottom-full mb-1" : "top-full mt-1"} ${align === "end" ? "right-0" : "left-0"}`;
  return (
    <div
      ref={panel}
      role={role}
      aria-label={label}
      className={`absolute z-30 ${pos} ${width} ${padding} rounded-lg border border-slate-200 bg-surface shadow-float ${className}`.trim()}
    >
      {children}
    </div>
  );
}

/** A menu row inside a Popover with role="menu". */
export function MenuItem({
  children,
  icon,
  danger = false,
  className = "",
  ...rest
}: {
  children: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  className?: string;
} & Omit<React.ComponentProps<"button">, "children" | "className">) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm disabled:opacity-50 ${
        danger ? "text-red-600 hover-danger" : "text-slate-700 hover:bg-slate-50"
      } ${className}`.trim()}
      {...rest}
    >
      {icon && (
        <span className="shrink-0 text-slate-400 [&>svg]:h-4 [&>svg]:w-4" aria-hidden>
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

/** A hairline between menu groups. */
export function MenuSeparator() {
  return <div role="separator" className="my-1 border-t border-slate-100" />;
}
