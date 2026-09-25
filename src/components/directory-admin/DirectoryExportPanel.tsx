"use client";

// How the directory looks by default (list columns, opening group-by) and the
// export presets a PDF/CSV starts from. Both are admin choices that every
// user sees before they change anything for themselves.

import { useMemo, useState } from "react";
import { Download, Copy, Plus, Trash2 } from "lucide-react";
import type { DirectoryField } from "@/lib/directory";
import type { ExportPreset } from "@/lib/directory-export-config";
import { availableColumns } from "@/lib/directory-display";
import { Field, Select, TextInput, Toggle } from "@/components/form";
import { toast } from "@/components/Toasts";
import { OrderedKeyList, jsonFetch } from "./shared";

const PRESET_BLANK: Omit<ExportPreset, "id" | "name"> = {
  title: "",
  subtitle: "",
  paper: "letter",
  orientation: "portrait",
  density: "normal",
  logo: true,
  columns: ["name", "title", "department", "phone", "email"],
  group_by: "",
  sort: "name",
  sort_dir: "asc",
  filter: null,
  photos: false,
  pinned_first: false,
  page_numbers: true,
  printed_date: true,
  footer_note: "",
  filename: "",
  office_info: true,
  is_default: false,
};

export function DirectoryExportPanel({
  fields,
  initialListColumns,
  initialGroupBy,
  initialPresets,
}: {
  fields: DirectoryField[];
  initialListColumns: string[];
  initialGroupBy: string;
  initialPresets: ExportPreset[];
}) {
  const available = useMemo(() => availableColumns(fields), [fields]);
  const groupFields = useMemo(() => fields.filter((f) => f.group_by), [fields]);

  // --- list defaults ---
  const [columns, setColumns] = useState(initialListColumns);
  const [groupBy, setGroupBy] = useState(initialGroupBy);
  const [savingList, setSavingList] = useState(false);
  async function saveList() {
    setSavingList(true);
    const r = await jsonFetch("/api/admin/directory/list-columns", { method: "PUT", body: JSON.stringify({ columns, group_by: groupBy }) });
    setSavingList(false);
    if (!r.ok) {
      toast("error", r.data?.error || "Could not save.");
      return;
    }
    toast("ok", "Directory defaults saved.");
  }

  // --- presets ---
  const [presets, setPresets] = useState<ExportPreset[]>(initialPresets);
  const [selected, setSelected] = useState(0);
  const [savingPresets, setSavingPresets] = useState(false);
  const [dirty, setDirty] = useState(false);
  const cur = presets[selected];

  function update(patch: Partial<ExportPreset>) {
    setPresets((ps) => ps.map((p, i) => (i === selected ? { ...p, ...patch } : p)));
    setDirty(true);
  }
  function addPreset(from?: ExportPreset) {
    const base = from ? { ...from, is_default: false } : { ...PRESET_BLANK };
    const name = from ? `${from.name} (copy)` : "New export";
    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}-${presets.length + 1}`;
    setPresets((ps) => [...ps, { ...base, id, name }]);
    setSelected(presets.length);
    setDirty(true);
  }
  function removePreset() {
    if (presets.length <= 1) return;
    if (!confirm(`Delete the "${cur.name}" preset?`)) return;
    const next = presets.filter((_, i) => i !== selected);
    if (!next.some((p) => p.is_default)) next[0] = { ...next[0], is_default: true };
    setPresets(next);
    setSelected(0);
    setDirty(true);
  }
  function makeDefault() {
    setPresets((ps) => ps.map((p, i) => ({ ...p, is_default: i === selected })));
    setDirty(true);
  }
  async function savePresets() {
    setSavingPresets(true);
    const r = await jsonFetch("/api/admin/directory/export-presets", { method: "PUT", body: JSON.stringify({ presets }) });
    setSavingPresets(false);
    if (!r.ok) {
      toast("error", r.data?.error || "Could not save the presets.");
      return;
    }
    setPresets(r.data.presets);
    setDirty(false);
    toast("ok", "Export presets saved.");
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <h3 className="mb-1 font-semibold text-slate-900">Directory defaults</h3>
        <p className="mb-3 text-sm text-slate-500">
          The columns the list shows before a person changes them for themselves, and the field the
          Groups view opens on.
        </p>
        <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
          <OrderedKeyList value={columns} onChange={setColumns} available={available} />
          <Field label="Groups view opens on">
            <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} className="w-full">
              {groupFields.map((f) => (
                <option key={f.key} value={f.key}>{f.label}</option>
              ))}
            </Select>
          </Field>
        </div>
        <button type="button" onClick={saveList} disabled={savingList} className="mt-3 rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60">
          {savingList ? "Saving…" : "Save defaults"}
        </button>
      </div>

      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <h3 className="mb-1 font-semibold text-slate-900">Export presets</h3>
        <p className="mb-3 text-sm text-slate-500">
          What comes out of <strong>Export</strong> on the Directory page: a PDF (or CSV) with these columns,
          sections, paper and branding. One preset is the default; people can also export exactly what they
          have on screen.
        </p>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="w-64">
            <Select value={String(selected)} onChange={(e) => setSelected(Number(e.target.value))} aria-label="Preset">
              {presets.map((p, i) => (
                <option key={p.id} value={i}>
                  {p.name}{p.is_default ? " (default)" : ""}
                </option>
              ))}
            </Select>
          </div>
          <button type="button" onClick={() => addPreset()} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            <span className="inline-flex items-center gap-1.5"><Plus className="h-4 w-4" /> New</span>
          </button>
          <button type="button" onClick={() => addPreset(cur)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            <span className="inline-flex items-center gap-1.5"><Copy className="h-4 w-4" /> Duplicate</span>
          </button>
          <button type="button" onClick={removePreset} disabled={presets.length <= 1} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-40">
            <span className="inline-flex items-center gap-1.5"><Trash2 className="h-4 w-4" /> Delete</span>
          </button>
          {!cur.is_default && (
            <button type="button" onClick={makeDefault} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
              Make default
            </button>
          )}
          <a
            href={`/api/directory/export?preset=${encodeURIComponent(cur.id)}`}
            className={`rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 ${dirty ? "pointer-events-none opacity-40" : ""}`}
            data-tt={dirty ? "Save first to download this preset" : "Download this preset as a PDF"}
            aria-disabled={dirty}
          >
            <span className="inline-flex items-center gap-1.5"><Download className="h-4 w-4" /> Download PDF</span>
          </a>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <Field label="Preset name"><TextInput value={cur.name} onChange={(e) => update({ name: e.target.value })} /></Field>
            <Field label="Document title" help="Blank = “<Company> directory”."><TextInput value={cur.title} onChange={(e) => update({ title: e.target.value })} placeholder="Phone directory" /></Field>
            <Field label="Subtitle"><TextInput value={cur.subtitle} onChange={(e) => update({ subtitle: e.target.value })} placeholder="Internal · updated weekly" /></Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Paper">
                <Select value={cur.paper} onChange={(e) => update({ paper: e.target.value as ExportPreset["paper"] })} className="w-full">
                  <option value="letter">Letter</option>
                  <option value="a4">A4</option>
                  <option value="legal">Legal</option>
                </Select>
              </Field>
              <Field label="Orientation">
                <Select value={cur.orientation} onChange={(e) => update({ orientation: e.target.value as ExportPreset["orientation"] })} className="w-full">
                  <option value="portrait">Portrait</option>
                  <option value="landscape">Landscape</option>
                </Select>
              </Field>
              <Field label="Density">
                <Select value={cur.density} onChange={(e) => update({ density: e.target.value as ExportPreset["density"] })} className="w-full">
                  <option value="compact">Compact</option>
                  <option value="normal">Normal</option>
                  <option value="comfortable">Comfortable</option>
                </Select>
              </Field>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <Toggle label="Workspace logo" checked={cur.logo} onChange={(v) => update({ logo: v })} />
              <Toggle label="Photos" checked={cur.photos} onChange={(v) => update({ photos: v })} />
              <Toggle label="Pinned people first" checked={cur.pinned_first} onChange={(v) => update({ pinned_first: v })} />
              <Toggle label="Page numbers" checked={cur.page_numbers} onChange={(v) => update({ page_numbers: v })} />
              <Toggle label="Printed date" checked={cur.printed_date} onChange={(v) => update({ printed_date: v })} />
              <Toggle label="Office information" help="Closes the PDF with the profile of every office that appears in it — set up under Offices." checked={cur.office_info} onChange={(v) => update({ office_info: v })} />
            </div>
            <Field label="Footer note" help="e.g. “Internal use only — do not distribute”."><TextInput value={cur.footer_note} onChange={(e) => update({ footer_note: e.target.value })} /></Field>
            <Field label="File name" help="Without extension; blank derives one from the title."><TextInput value={cur.filename} onChange={(e) => update({ filename: e.target.value })} placeholder="phone-directory" /></Field>
          </div>
          <div className="space-y-3">
            <Field label="Columns, in order">
              <OrderedKeyList value={cur.columns} onChange={(columns) => update({ columns })} available={available} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Sections by">
                <Select value={cur.group_by} onChange={(e) => update({ group_by: e.target.value })} className="w-full">
                  <option value="">— one list —</option>
                  {groupFields.map((f) => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Sort by">
                <div className="flex gap-1">
                  <Select value={cur.sort} onChange={(e) => update({ sort: e.target.value })} className="w-full">
                    {available.map((c) => (
                      <option key={c.key} value={c.key}>{c.label}</option>
                    ))}
                  </Select>
                  <Select value={cur.sort_dir} onChange={(e) => update({ sort_dir: e.target.value as "asc" | "desc" })} className="w-20" aria-label="Direction">
                    <option value="asc">A→Z</option>
                    <option value="desc">Z→A</option>
                  </Select>
                </div>
              </Field>
            </div>
            <Field label="Only people where" help="e.g. Office = PHX1 for one office's sheet. Leave blank for everyone.">
              <div className="flex gap-1">
                <Select value={cur.filter?.key ?? ""} onChange={(e) => update({ filter: e.target.value ? { key: e.target.value, value: cur.filter?.value ?? "" } : null })} className="w-40" aria-label="Filter field">
                  <option value="">— none —</option>
                  {available.filter((c) => c.key !== "name").map((c) => (
                    <option key={c.key} value={c.key}>{c.label}</option>
                  ))}
                </Select>
                <TextInput className="flex-1" value={cur.filter?.value ?? ""} placeholder="value" disabled={!cur.filter} onChange={(e) => update({ filter: cur.filter ? { ...cur.filter, value: e.target.value } : null })} aria-label="Filter value" />
              </div>
            </Field>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button type="button" onClick={savePresets} disabled={savingPresets || !dirty} className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60">
            {savingPresets ? "Saving…" : "Save presets"}
          </button>
          {dirty && <span className="text-xs text-amber-600">Unsaved changes</span>}
        </div>
      </div>
    </div>
  );
}
