"use client";

// The composer's macro picker: canned replies from GET
// /api/helpdesk/macros (yours, your teams' and everyone's), filtered as you
// type. Picking one writes its text into the reply with the placeholders
// filled; its field changes (status, priority, team, tags) apply when the
// reply is sent, and the composer says so before then.

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Zap } from "lucide-react";
import { Popover } from "@/components/Popover";
import { LoadingRow } from "@/components/Spinner";
import { SectionEmpty, controlClass } from "@/components/form";
import type { HdMacro } from "@/lib/helpdesk/types";
import { getJson, listOf } from "../api";
import { firstName } from "../ui";

/** The placeholders a macro body may use. */
export const MACRO_PLACEHOLDERS = [
  "{{requester.first_name}}",
  "{{requester.name}}",
  "{{agent.first_name}}",
  "{{agent.name}}",
  "{{ticket.number}}",
  "{{ticket.subject}}",
];

export function fillMacro(body: string, v: { requesterName: string; agentName: string; number: number; subject: string }): string {
  const map: Record<string, string> = {
    "requester.first_name": firstName(v.requesterName),
    "requester.name": v.requesterName,
    "agent.first_name": firstName(v.agentName),
    "agent.name": v.agentName,
    "ticket.number": String(v.number),
    "ticket.subject": v.subject,
  };
  return body.replace(/\{\{\s*([a-z_.]+)\s*\}\}/gi, (m, k: string) => map[k.toLowerCase()] ?? m);
}

let cache: HdMacro[] | null = null;

export function MacroPicker({
  open,
  onClose,
  triggerRef,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  onPick: (m: HdMacro) => void;
}) {
  const [macros, setMacros] = useState<HdMacro[] | null>(cache);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setActive(0);
    requestAnimationFrame(() => input.current?.focus());
    getJson("/api/helpdesk/macros", "Couldn't load the macros.")
      .then((d) => {
        cache = listOf<HdMacro>(d, "macros");
        setMacros(cache);
      })
      .catch((e: Error) => setError(e.message));
  }, [open]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (macros ?? []).filter((m) => !t || m.title.toLowerCase().includes(t) || m.body.toLowerCase().includes(t)).slice(0, 30);
  }, [macros, q]);

  return (
    <Popover open={open} onClose={onClose} triggerRef={triggerRef} role="dialog" label="Macros" side="top" width="w-[min(22rem,calc(100vw-2rem))]" padding="p-2">
      <input
        ref={input}
        type="search"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(shown.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Enter" && shown[active]) {
            e.preventDefault();
            onPick(shown[active]);
          }
        }}
        role="combobox"
        aria-expanded
        aria-controls="desk-macro-list"
        aria-activedescendant={shown[active] ? `desk-macro-${shown[active].id}` : undefined}
        aria-label="Filter macros"
        placeholder="Filter macros…"
        className={controlClass(false, "", true)}
      />
      <div id="desk-macro-list" role="listbox" aria-label="Macros" className="mt-2 max-h-72 overflow-y-auto">
        {error && <p className="px-2 py-3 text-sm text-red-600">{error}</p>}
        {!error && macros === null && <LoadingRow className="py-4" />}
        {macros !== null && shown.length === 0 && (
          <SectionEmpty className="px-2 py-3">
            {macros.length === 0 ? "No macros yet. A helpdesk manager adds them under Settings." : "No macros match your filter."}
          </SectionEmpty>
        )}
        {shown.map((m, i) => (
          <div
            key={m.id}
            id={`desk-macro-${m.id}`}
            role="option"
            aria-selected={i === active}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(m)}
            className={`flex cursor-pointer gap-2 rounded-md px-2 py-1.5 ${i === active ? "bg-compass-50" : ""}`}
          >
            <Zap className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-slate-900">{m.title}</span>
              <span className="line-clamp-2 text-xs text-slate-500">{m.body}</span>
            </span>
          </div>
        ))}
      </div>
    </Popover>
  );
}
