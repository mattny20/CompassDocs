"use client";

// CSV import in three steps that each show their work: pick a file (or
// paste), map its columns to fields, see what every row would do, apply.
// Nothing is written until the last button.

import { useState } from "react";
import { Upload, FileSpreadsheet, ChevronDown, ChevronRight } from "lucide-react";
import type { DirectoryField } from "@/lib/directory";
import { Field, Select, Textarea } from "@/components/form";
import { toast } from "@/components/Toasts";
import { jsonFetch } from "./shared";

interface Column {
  index: number;
  header: string;
  target: string;
  sample: string;
}
interface RowPlan {
  row: number;
  action: "create" | "update" | "skip" | "error";
  name: string;
  email: string;
  changes?: string[];
  reason?: string;
}
interface Plan {
  columns: Column[];
  rows: RowPlan[];
  counts: { create: number; update: number; skip: number; error: number };
}

const BUILTIN = [
  { key: "name", label: "Name" }, { key: "title", label: "Title" }, { key: "department", label: "Department" }, { key: "email", label: "Email" },
  { key: "phone", label: "Phone" }, { key: "mobile", label: "Mobile" }, { key: "office", label: "Office" },
];

export function DirectoryImportPanel({ fields, onImported }: { fields: DirectoryField[]; onImported: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const [columns, setColumns] = useState<Column[] | null>(null);
  const [rowCount, setRowCount] = useState(0);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Plan["counts"] | null>(null);
  const [filter, setFilter] = useState<"all" | RowPlan["action"]>("all");

  const targets = [
    ...BUILTIN,
    ...fields.filter((f) => !f.builtin).map((f) => ({ key: f.key, label: f.kind === "people" ? `${f.label} (names or emails)` : f.label })),
    ...fields.filter((f) => f.builtin && f.kind === "people").map((f) => ({ key: f.key, label: `${f.label} (names or emails)` })),
  ];

  async function readFile(file: File) {
    const text = await file.text();
    setCsv(text);
    await analyze(text);
  }
  async function analyze(text = csv) {
    if (!text.trim()) return;
    setBusy(true);
    setPlan(null);
    setDone(null);
    const r = await jsonFetch("/api/admin/directory/import", { method: "POST", body: JSON.stringify({ csv: text, mode: "analyze" }) });
    setBusy(false);
    if (!r.ok) {
      toast("error", r.data?.error || "Could not read that file.");
      return;
    }
    setColumns(r.data.columns);
    setRowCount(r.data.rowCount);
    const m: Record<string, string> = {};
    for (const c of r.data.columns as Column[]) if (c.target) m[String(c.index)] = c.target;
    setMapping(m);
  }
  async function run(mode: "plan" | "apply") {
    setBusy(true);
    const r = await jsonFetch("/api/admin/directory/import", { method: "POST", body: JSON.stringify({ csv, mode, mapping }) });
    setBusy(false);
    if (!r.ok) {
      toast("error", r.data?.error || "The import failed.");
      return;
    }
    if (mode === "plan") {
      setPlan(r.data);
      setFilter("all");
    } else {
      setDone(r.data.counts);
      setPlan(null);
      toast("ok", `Imported: ${r.data.counts.create} added, ${r.data.counts.update} updated.`);
      await onImported();
    }
  }
  function reset() {
    setCsv("");
    setColumns(null);
    setMapping({});
    setPlan(null);
    setDone(null);
  }

  const hasName = Object.values(mapping).includes("name") || Object.values(mapping).includes("email");
  const shownRows = plan ? plan.rows.filter((r) => filter === "all" || r.action === filter) : [];

  return (
    <div className="rounded-xl border border-slate-200 bg-surface shadow-xs">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-4 py-3 text-left">
        <FileSpreadsheet className="h-4 w-4 text-compass-600" aria-hidden />
        <span className="text-sm font-semibold text-slate-800">Import from CSV</span>
        <span className="text-xs text-slate-500">the export's format, or any spreadsheet with a name or email column</span>
        <span className="ml-auto text-slate-500">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-slate-100 p-4">
          {!columns && (
            <div className="grid gap-3 lg:grid-cols-[auto_1fr]">
              <label className="inline-flex h-fit cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
                <Upload className="h-4 w-4" /> Choose a CSV file
                <input type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} />
              </label>
              <Field label="Or paste it" help="First row is the header. Commas, semicolons or tabs.">
                <Textarea rows={4} value={csv} onChange={(e) => setCsv(e.target.value)} className="font-mono text-xs" placeholder={"Name,Title,Email,Phone,Office\nJane Smith,Partner,jane@firm.com,602-555-0100,PHX1"} />
                <button type="button" onClick={() => analyze()} disabled={busy || !csv.trim()} className="mt-2 rounded-lg bg-compass-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60">
                  Read columns
                </button>
              </Field>
            </div>
          )}

          {columns && !done && (
            <>
              <div>
                <p className="mb-2 text-sm text-slate-600">
                  {rowCount} {rowCount === 1 ? "row" : "rows"}. Say what each column is; columns set to <em>ignore</em> are skipped. Rows match people by email, then by exact name; a match updates them, the rest are added as manual entries.
                </p>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {columns.map((c) => (
                    <div key={c.index} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-800">{c.header || `Column ${c.index + 1}`}</p>
                        <p className="truncate text-xs text-slate-500">{c.sample || "—"}</p>
                      </div>
                      <div className="w-44">
                        <Select value={mapping[String(c.index)] ?? ""} onChange={(e) => setMapping({ ...mapping, [String(c.index)]: e.target.value })} aria-label={`Target for ${c.header}`}>
                          <option value="">— ignore —</option>
                          {targets.map((t) => (
                            <option key={t.key} value={t.key}>{t.label}</option>
                          ))}
                        </Select>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={() => run("plan")} disabled={busy || !hasName} className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60">
                  {busy ? "Checking…" : "Check what would happen"}
                </button>
                <button type="button" onClick={reset} className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">Start over</button>
                {!hasName && <span className="text-xs ink-warn">Map a Name or Email column first.</span>}
              </div>
            </>
          )}

          {plan && (
            <div className="rounded-lg border border-slate-200">
              <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-3 py-2 text-sm">
                <span className="font-medium text-slate-800">
                  {plan.counts.create} to add · {plan.counts.update} to update · {plan.counts.skip} unchanged · {plan.counts.error} {plan.counts.error === 1 ? "problem" : "problems"}
                </span>
                <div className="ml-auto w-40">
                  <Select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label="Show rows">
                    <option value="all">All rows</option>
                    <option value="create">To add</option>
                    <option value="update">To update</option>
                    <option value="skip">Unchanged</option>
                    <option value="error">Problems</option>
                  </Select>
                </div>
              </div>
              <div className="max-h-80 overflow-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-3 py-1.5">Row</th>
                      <th className="px-3 py-1.5">Person</th>
                      <th className="px-3 py-1.5">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownRows.slice(0, 500).map((r) => (
                      <tr key={r.row} className="border-t border-slate-50">
                        <td className="px-3 py-1.5 text-slate-500">{r.row}</td>
                        <td className="px-3 py-1.5 text-slate-800">
                          {r.name || <span className="text-slate-500">(no name)</span>}
                          {r.email ? <span className="text-slate-500"> · {r.email}</span> : null}
                        </td>
                        <td className="px-3 py-1.5">
                          {r.action === "create" && <span className="text-emerald-700">Add</span>}
                          {r.action === "update" && <span className="text-compass-700">Update: {(r.changes ?? []).join(", ")}</span>}
                          {r.action === "skip" && <span className="text-slate-500">{r.reason ?? "Unchanged"}</span>}
                          {r.action === "error" && <span className="text-red-600">{r.reason}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center gap-3 border-t border-slate-100 px-3 py-2">
                <button type="button" onClick={() => run("apply")} disabled={busy || plan.counts.create + plan.counts.update === 0} className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60">
                  {busy ? "Importing…" : `Import ${plan.counts.create + plan.counts.update} ${plan.counts.create + plan.counts.update === 1 ? "person" : "people"}`}
                </button>
                <span className="text-xs text-slate-500">Rows with problems are left out; fix the file and check again.</span>
              </div>
            </div>
          )}

          {done && (
            <div className="flex flex-wrap items-center gap-3 text-sm text-slate-700">
              <span>Done — {done.create} added, {done.update} updated, {done.skip} unchanged, {done.error} left out.</span>
              <button type="button" onClick={reset} className="text-compass-600 hover:underline">Import another file</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
