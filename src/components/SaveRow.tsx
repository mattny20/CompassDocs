"use client";

// The one Save row (STYLEGUIDE §Forms). Disabled while there is nothing to
// save, says "Unsaved changes" while there is, "Saved" for a moment after,
// answers Ctrl/⌘+S, and pins to the bottom of the viewport only while
// dirty — so Save is never three screens away and never in the way.
// Pair with useUnsavedChanges() and useLeaveGuard() from lib/use-unsaved.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Button } from "./Button";

function useMac(): boolean {
  const [mac, setMac] = useState(false);
  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.platform));
  }, []);
  return mac;
}

/** The state text beside a Save button: "Unsaved changes ⌘S", then "Saved". */
export function UnsavedHint({
  dirty,
  saved = false,
  shortcut = true,
  className = "",
}: {
  dirty: boolean;
  saved?: boolean;
  shortcut?: boolean;
  className?: string;
}) {
  const mac = useMac();
  return (
    <span className={`inline-flex items-center gap-2 text-xs ${className}`.trim()} aria-live="polite">
      {dirty ? (
        <>
          <span className="ink-warn">Unsaved changes</span>
          {shortcut && (
            <kbd className="rounded-sm border border-slate-200 bg-canvas px-1.5 py-0.5 font-sans text-2xs text-slate-500">
              {mac ? "⌘" : "Ctrl"} S
            </kbd>
          )}
        </>
      ) : saved ? (
        <span className="inline-flex items-center gap-1 text-slate-500">
          <Check className="h-3.5 w-3.5" aria-hidden /> Saved
        </span>
      ) : null}
    </span>
  );
}

/** "Saved" for a moment after dirty flips back to false — the save that
 *  just happened, not the mount. */
export function useJustSaved(dirty: boolean, busy: boolean): boolean {
  const [saved, setSaved] = useState(false);
  const wasDirty = useRef(false);
  useEffect(() => {
    if (wasDirty.current && !dirty && !busy) {
      setSaved(true);
      wasDirty.current = false;
      const t = setTimeout(() => setSaved(false), 4000);
      return () => clearTimeout(t);
    }
    if (dirty) wasDirty.current = true;
  }, [dirty, busy]);
  return saved;
}

/** Ctrl/⌘+S → onSave while `enabled`. The browser's Save-page dialog never
 *  appears while a form on the page can take the keystroke. */
export function useSaveShortcut(enabled: boolean, onSave: () => void): void {
  const ref = useRef(onSave);
  ref.current = onSave;
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        ref.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

export function SaveRow({
  dirty,
  busy = false,
  onSave,
  label = "Save changes",
  busyLabel = "Saving…",
  disabled = false,
  allowPristine = false,
  sticky = true,
  shortcut = true,
  children,
  className = "",
}: {
  dirty: boolean;
  busy?: boolean;
  onSave: () => void;
  label?: ReactNode;
  busyLabel?: ReactNode;
  /** Something else forbids saving (a field is invalid). */
  disabled?: boolean;
  /** The action is also a re-apply (Domain "Save & apply"): stays enabled while pristine. */
  allowPristine?: boolean;
  /** Pin to the bottom of the viewport while dirty. */
  sticky?: boolean;
  /** Answer Ctrl/⌘+S while dirty. */
  shortcut?: boolean;
  /** Secondary controls on the same row (Cancel, Test connection). */
  children?: ReactNode;
  className?: string;
}) {
  const canSave = !busy && !disabled && (dirty || allowPristine);
  const saved = useJustSaved(dirty, busy);
  useSaveShortcut(shortcut && dirty && canSave, onSave);

  const pinned = sticky && dirty;
  return (
    <div
      className={`flex flex-wrap items-center gap-3 ${
        pinned ? "sticky bottom-3 z-20 rounded-xl border border-slate-200 bg-surface px-4 py-3 shadow-float" : ""
      } ${className}`.trim()}
    >
      <Button variant="primary" busy={busy} disabled={!canSave} onClick={onSave}>
        {busy ? busyLabel : label}
      </Button>
      {children}
      <UnsavedHint dirty={dirty} saved={saved} shortcut={shortcut} className="ml-auto" />
    </div>
  );
}
