"use client";

// The editor for every part (1.19.0): markdown in a plain textarea with an
// Insert tag menu above it that puts {{tag}} at the caret. A textarea keeps
// what is stored byte for byte (the doc editor re-serialised a body's
// markdown on load), and its two toolbars would dwarf a header or footer.

import { useRef } from "react";
import { Textarea } from "@/components/form";
import type { TagDef } from "./types";

export function MarkdownWithTags({
  id,
  value,
  onChange,
  tags,
  invalid,
  describedBy,
  readOnly,
  labelledBy,
  rows = 4,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  tags: TagDef[];
  invalid?: boolean;
  describedBy?: string;
  readOnly?: boolean;
  labelledBy: string;
  rows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  function insert(tag: string) {
    const el = ref.current;
    const text = `{{${tag}}}`;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + text + value.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + text.length, start + text.length);
    });
  }

  return (
    <div className="space-y-2">
      {!readOnly && (
        <select
          value=""
          onChange={(e) => e.target.value && insert(e.target.value)}
          aria-label="Insert tag"
          data-tt="Insert a tag at the cursor: replaced with the real value when each email is sent"
          data-tt-wrap=""
          className="h-8 max-w-full rounded-md border border-slate-200 bg-surface px-2 text-xs text-slate-600 hover:bg-slate-50"
        >
          <option value="">Insert tag…</option>
          {tags.map((t) => (
            <option key={t.tag} value={t.tag}>
              {t.label}
            </option>
          ))}
        </select>
      )}
      <Textarea
        ref={ref}
        id={id}
        rows={rows}
        value={value}
        readOnly={readOnly}
        spellCheck
        aria-labelledby={labelledBy}
        hasError={invalid}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-xs"
      />
    </div>
  );
}
