"use client";

// The one copy-to-clipboard control (STYLEGUIDE §Feedback): Copy → Copied
// with a check, announced to readers, back to Copy after two seconds.
// Nine hand-rolled versions used to differ in label, icon and whether
// anyone was told it worked.

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { buttonClass, type ButtonSize, type ButtonVariant } from "./Button";

export function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied",
  variant = "secondary",
  size = "sm",
  iconOnly = false,
  className = "",
  onCopied,
}: {
  /** The text to copy, or a function that produces it on click. */
  text: string | (() => string);
  label?: string;
  copiedLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon only (28px box); the label becomes the tooltip and name. */
  iconOnly?: boolean;
  className?: string;
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function copy() {
    const value = typeof text === "function" ? text() : text;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Older browsers / insecure contexts: a selection fallback.
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    onCopied?.();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }

  const glyph = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
  const Icon = copied ? Check : Copy;
  if (iconOnly) {
    return (
      <button
        type="button"
        onClick={copy}
        data-tt={copied ? copiedLabel : label}
        aria-label={copied ? copiedLabel : label}
        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 ${className}`.trim()}
      >
        <Icon className={glyph} aria-hidden />
        <span className="sr-only" aria-live="polite">{copied ? copiedLabel : ""}</span>
      </button>
    );
  }
  return (
    <button type="button" onClick={copy} className={buttonClass(variant, size, className)}>
      <Icon className={glyph} aria-hidden />
      <span aria-live="polite">{copied ? copiedLabel : label}</span>
    </button>
  );
}
