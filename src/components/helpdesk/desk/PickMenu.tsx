"use client";

// A picker menu (STYLEGUIDE §Overlays and modals, "A picker menu"): one
// choice among a few, as a Popover role="menu" of menuitemradio rows, the
// chosen one aria-checked with a Check. The desk uses it for a ticket's
// status, priority, team and assignee, the queue's sort and the
// availability menu. The trigger is passed in as a render function so each
// place keeps its own look (a pill for status, a property row, plain text
// for sort) while the menu stays one recipe.

import { useRef, useState, type ReactNode, type RefObject } from "react";
import { Check } from "lucide-react";
import { Popover } from "@/components/Popover";

export interface PickOption<T extends string | number> {
  value: T;
  label: string;
  /** One short line under the label. */
  hint?: string;
  /** A leading glyph (a priority dot, an avatar). */
  icon?: ReactNode;
}

export function PickMenu<T extends string | number>({
  label,
  value,
  options,
  onPick,
  trigger,
  align = "end",
  width = "w-60",
  footer,
}: {
  /** The menu's accessible name ("Priority"). */
  label: string;
  value: T | null;
  options: PickOption<T>[];
  onPick: (value: T) => void;
  /** Renders the trigger; spread `props` onto a <button>. */
  trigger: (props: {
    ref: RefObject<HTMLButtonElement | null>;
    onClick: () => void;
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
  }) => ReactNode;
  align?: "start" | "end";
  width?: string;
  /** Extra rows under the options (a MenuSeparator and MenuItems). */
  footer?: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  function pick(v: T) {
    setOpen(false);
    ref.current?.focus();
    if (v !== value) onPick(v);
  }

  return (
    <div className="relative">
      {trigger({ ref, onClick: () => setOpen((o) => !o), "aria-haspopup": "menu", "aria-expanded": open })}
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={ref}
        role="menu"
        label={label}
        align={align}
        width={width}
        className="mt-1 max-h-80 overflow-y-auto"
      >
        {options.map((o) => {
          const on = o.value === value;
          return (
            <button
              key={String(o.value)}
              type="button"
              role="menuitemradio"
              aria-checked={on}
              onClick={() => pick(o.value)}
              className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition ${
                on ? "bg-compass-50 text-compass-700" : "text-slate-700 hover:bg-slate-50"
              }`}
            >
              {o.icon && <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">{o.icon}</span>}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{o.label}</span>
                {o.hint && <span className="block truncate text-xs text-slate-500">{o.hint}</span>}
              </span>
              {on && <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
            </button>
          );
        })}
        {footer?.(() => setOpen(false))}
      </Popover>
    </div>
  );
}
