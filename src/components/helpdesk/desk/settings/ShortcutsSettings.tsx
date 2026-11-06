"use client";

// Desk settings → Shortcuts (1.19.1, mock-up #7): the four ways to start a
// request from elsewhere in CompassDocs (agent E's triggers) and the request
// type each opens, or Hidden (the trigger does not render). Automatic is
// 1.19.0's rule, named with the type it picks today. Request access offers
// only "Request access" types: only those may carry a space (S1).
//
// A grid list rather than a <table>: on a phone each shortcut stacks (name,
// where people see it, the choice) instead of scrolling sideways.

import { useEffect, useState } from "react";
import { Link as LinkIcon } from "lucide-react";
import { CARD_CLASS } from "@/components/Card";
import { Select } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { SaveRow } from "@/components/SaveRow";
import { LoadingRow } from "@/components/Spinner";
import { TABLE_HEAD_ROW } from "@/components/Table";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import { HD_SHORTCUT_ROWS, shortcutTypeLabel } from "@/lib/helpdesk/shortcuts-shared";
import type { HdShortcutKey, HdShortcuts, HdShortcutTypeOption } from "@/lib/helpdesk/shortcuts-shared";
import { getJson, sendJson } from "../api";

interface View {
  shortcuts: HdShortcuts;
  types: HdShortcutTypeOption[];
  automatic: Record<HdShortcutKey, number | null>;
}

const toValue = (c: HdShortcuts[HdShortcutKey]) => (c === null ? "auto" : String(c));
const fromValue = (v: string): HdShortcuts[HdShortcutKey] => (v === "auto" ? null : v === "hidden" ? "hidden" : Number(v));

export function ShortcutsSettings() {
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<HdShortcuts | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const snap = JSON.stringify(draft);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(snap);
  useLeaveGuard(dirty, hasUnsavedChanges);

  useEffect(() => {
    getJson<View>("/api/helpdesk/admin/shortcuts", "Couldn't load the shortcuts.")
      .then((d) => {
        setView(d);
        setDraft(d.shortcuts);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error && !view) {
    return (
      <PageContainer>
        <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>
      </PageContainer>
    );
  }
  if (!view || !draft) {
    return (
      <PageContainer>
        <LoadingRow className="py-10" />
      </PageContainer>
    );
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      const d = await sendJson<View>("/api/helpdesk/admin/shortcuts", "PUT", draft, "Couldn't save the shortcuts.");
      setView(d);
      setDraft(d.shortcuts);
      markClean(JSON.stringify(d.shortcuts));
      toast("ok", "Shortcuts saved.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const byId = new Map(view.types.map((t) => [t.id, t]));
  return (
    <PageContainer>
      <PageHeader
        icon={<LinkIcon />}
        title="Shortcuts"
        subtitle="Ways to start a request from elsewhere in CompassDocs, and the request type each one opens."
      />
      <div className={CARD_CLASS}>
        <div className={`hidden gap-4 px-5 py-3 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1.6fr)] ${TABLE_HEAD_ROW}`} aria-hidden>
          <span>Shortcut</span>
          <span>Where people see it</span>
          <span>Opens</span>
        </div>
        <ul aria-label="Shortcuts">
          {HD_SHORTCUT_ROWS.map((row) => {
            const value = draft[row.key];
            const auto = view.automatic[row.key];
            const autoType = auto ? byId.get(auto) : undefined;
            const options = view.types.filter((t) => t.active && (row.key !== "space_access" || t.access));
            const chosen = typeof value === "number" ? byId.get(value) : undefined;
            const missing = typeof value === "number" && !options.some((t) => t.id === value);
            return (
              <li
                key={row.key}
                className="grid gap-1.5 border-b border-slate-100 px-5 py-3.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1.6fr)] sm:items-center sm:gap-4"
              >
                <span className="text-sm font-semibold text-slate-900">{row.label}</span>
                <span className="text-sm text-slate-500">{row.where}</span>
                <Select
                  aria-label={`${row.label} opens`}
                  value={toValue(value)}
                  onChange={(e) => {
                    markDirty();
                    setDraft({ ...draft, [row.key]: fromValue(e.target.value) });
                  }}
                >
                  <option value="auto">{autoType ? `Automatic: ${shortcutTypeLabel(autoType)}` : "Automatic: a general request"}</option>
                  {options.map((t) => (
                    <option key={t.id} value={t.id}>
                      {shortcutTypeLabel(t)}
                    </option>
                  ))}
                  {missing && (
                    <option value={String(value)}>{chosen ? `${shortcutTypeLabel(chosen)} (no longer offered)` : "A request type that was deleted"}</option>
                  )}
                  <option value="hidden">Hidden</option>
                </Select>
              </li>
            );
          })}
        </ul>
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Each shortcut fills in where it came from (the page, policy, space or link). Turn a shortcut off by choosing &ldquo;Hidden&rdquo;.
      </p>
      <SaveRow dirty={dirty} busy={busy} onSave={save} label="Save shortcuts" />
    </PageContainer>
  );
}
