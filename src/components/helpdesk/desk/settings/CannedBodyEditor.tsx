"use client";

// The canned response text editor (1.19.2, agent W4; design d2): plain text
// in which each placeholder ({{requester.first_name}} …) shows as a chip
// ("requester first name") that moves and deletes as one piece. The value
// stays plain text with {{tags}}: the editor draws it, and reads it back on
// every input. A placeholder typed or pasted by hand turns into a chip when
// the box loses focus. Pasting keeps the text only.
//
// A contenteditable with role="textbox" aria-multiline; the chips are
// contenteditable="false" spans carrying data-ph. Enter is a line break.

import { useEffect, useImperativeHandle, useRef, type MutableRefObject } from "react";
import { Plus } from "lucide-react";
import { chipClass } from "@/components/Chip";
import { controlClass } from "@/components/form";
import { CANNED_PLACEHOLDERS, placeholderLabel, splitPlaceholders } from "@/lib/helpdesk/canned-shared";

const CHIP = chipClass("neutral", "md", "mx-0.5 align-baseline select-all");

function chipNode(tag: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.contentEditable = "false";
  span.dataset.ph = tag;
  span.className = CHIP;
  span.textContent = placeholderLabel(tag);
  return span;
}

/** The value as nodes: text, and a chip per known placeholder. */
function build(value: string): Node[] {
  return splitPlaceholders(value).map((p) => ("tag" in p ? chipNode(p.tag) : document.createTextNode(p.text)));
}

/** Read the box back as plain text with {{tags}}. Line breaks: "\n" in text, <br>, and block elements a browser may add. */
function serialize(root: Node): string {
  let out = "";
  const walk = (n: Node) => {
    n.childNodes.forEach((c, i) => {
      if (c.nodeType === Node.TEXT_NODE) out += c.textContent ?? "";
      else if (c instanceof HTMLElement) {
        if (c.dataset.ph) out += `{{${c.dataset.ph}}}`;
        else if (c.tagName === "BR") {
          // A browser's trailing <br> placeholder at the very end is not a line.
          if (!(i === n.childNodes.length - 1 && n === root && out.endsWith("\n"))) out += "\n";
        } else if (c.tagName === "DIV" || c.tagName === "P") {
          if (out && !out.endsWith("\n")) out += "\n";
          walk(c);
        } else walk(c);
      }
    });
  };
  walk(root);
  return out.replace(/\u00a0/g, " ").replace(/\u200b/g, "");
}

export function CannedBodyEditor({
  value,
  onChange,
  readOnly = false,
  labelledBy,
  describedBy,
  invalid = false,
  handle,
}: {
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
  labelledBy: string;
  describedBy?: string;
  invalid?: boolean;
  /** insert(tag): put a placeholder chip at the caret (the buttons under the box). */
  handle?: MutableRefObject<{ insert: (tag: string) => void } | null>;
}) {
  const box = useRef<HTMLDivElement>(null);
  /** The value the box shows now; a different one from outside is redrawn. */
  const shown = useRef<string | null>(null);
  /** The last caret inside the box, for the placeholder buttons. */
  const lastRange = useRef<Range | null>(null);

  useEffect(() => {
    if (!box.current || value === shown.current) return;
    box.current.replaceChildren(...build(value));
    shown.current = value;
  }, [value]);

  function sync() {
    if (!box.current) return;
    const v = serialize(box.current);
    shown.current = v;
    onChange(v);
  }

  function remember() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && box.current?.contains(sel.anchorNode)) lastRange.current = sel.getRangeAt(0).cloneRange();
  }

  useImperativeHandle(handle, () => ({
    insert(tag: string) {
      const el = box.current;
      if (!el || readOnly) return;
      el.focus();
      const sel = window.getSelection();
      let range = lastRange.current && el.contains(lastRange.current.startContainer) ? lastRange.current : null;
      if (!range) {
        range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
      }
      range.deleteContents();
      const chip = chipNode(tag);
      range.insertNode(chip);
      // A zero-width space after the chip gives the caret somewhere to stand (serialize drops it).
      const space = document.createTextNode("\u200b");
      chip.after(space);
      const after = document.createRange();
      after.setStart(space, 1);
      after.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(after);
      lastRange.current = after.cloneRange();
      sync();
    },
  }));

  return (
    <div
      ref={box}
      role="textbox"
      aria-multiline="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      aria-readonly={readOnly || undefined}
      contentEditable={!readOnly}
      suppressContentEditableWarning
      spellCheck
      tabIndex={0}
      onInput={sync}
      onKeyUp={remember}
      onMouseUp={remember}
      onBlur={() => {
        remember();
        // Hand-typed or pasted {{tags}} become chips.
        if (box.current && /\{\{/.test(box.current.textContent ?? "")) {
          box.current.replaceChildren(...build(value));
          shown.current = value;
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          document.execCommand("insertLineBreak");
        }
      }}
      onPaste={(e) => {
        e.preventDefault();
        const text = e.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
        document.execCommand("insertText", false, text);
      }}
      className={controlClass(invalid, `min-h-28 whitespace-pre-wrap break-words py-2.5 leading-7 text-slate-800 ${readOnly ? "bg-slate-50 text-slate-600" : ""}`)}
    />
  );
}

/** The placeholder chips to insert, under the editor. */
export function PlaceholderButtons({ onInsert }: { onInsert: (tag: string) => void }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Insert a placeholder">
      <span className="text-xs text-slate-500">Insert:</span>
      {CANNED_PLACEHOLDERS.map((p) => (
        <button
          key={p.tag}
          type="button"
          // Keep the caret in the editor.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onInsert(p.tag)}
          className={chipClass("neutral", "md", "cursor-pointer hover:bg-slate-200")}
        >
          <Plus className="h-3 w-3" aria-hidden />
          {p.label}
        </button>
      ))}
    </div>
  );
}
