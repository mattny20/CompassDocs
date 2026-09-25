"use client";

// Office profiles: the fields every office describes itself with, and each
// office's values. Both are one document saved together, so the page has one
// Save — the offices come from the Office field's options and from the values
// people actually carry, and an admin can add one nobody is in yet.

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Building2, Plus, Trash2, X } from "lucide-react";
import type { FieldOption } from "@/lib/directory-display";
import {
  DEFAULT_OFFICE_FIELDS,
  MAX_OFFICE_FIELDS,
  profileHasContent,
  slugifyOfficeKey,
  type OfficeConfig,
  type OfficeField,
  type OfficeProfile,
} from "@/lib/directory-offices";
import { Field, SectionEmpty, Textarea, TextInput, Toggle } from "@/components/form";
import { toast } from "@/components/Toasts";
import { jsonFetch } from "./shared";

interface OfficeRow {
  office: string;
  label: string;
  count: number;
}

export function DirectoryOfficesPanel({
  initial,
  officeOptions,
  seen,
}: {
  initial: OfficeConfig;
  /** The Office field's options, in the admin's order. */
  officeOptions: FieldOption[];
  /** Offices people carry, as a profile names them, with head counts. */
  seen: { office: string; count: number }[];
}) {
  const [config, setConfig] = useState<OfficeConfig>(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newOffice, setNewOffice] = useState("");
  const [newField, setNewField] = useState("");

  // Every office the page knows: options first (their order is the export's),
  // then offices people carry without an option, then saved profiles for
  // offices nobody is in any more — those still print if someone returns.
  const rows = useMemo<OfficeRow[]>(() => {
    const out: OfficeRow[] = [];
    const seenKeys = new Set<string>();
    const countOf = (office: string) => seen.find((s) => s.office.toLowerCase() === office.toLowerCase())?.count ?? 0;
    // Shown as the profile's name when one is set, else the option's label,
    // else the value — with the value alongside so "Phoenix" and "PHX1" read
    // as the same office.
    const labelFor = (office: string, optionLabel?: string) => {
      const p = config.profiles.find((x) => x.office.toLowerCase() === office.toLowerCase());
      const name = p?.name.trim() || (optionLabel && optionLabel !== office ? optionLabel : "");
      return name ? `${name} (${office})` : office;
    };
    for (const o of officeOptions) {
      if (o.hidden) continue;
      seenKeys.add(o.value.toLowerCase());
      out.push({ office: o.value, label: labelFor(o.value, o.label), count: countOf(o.value) });
    }
    for (const s of [...seen].sort((a, b) => b.count - a.count)) {
      if (seenKeys.has(s.office.toLowerCase())) continue;
      seenKeys.add(s.office.toLowerCase());
      out.push({ office: s.office, label: labelFor(s.office), count: s.count });
    }
    for (const p of config.profiles) {
      if (seenKeys.has(p.office.toLowerCase())) continue;
      seenKeys.add(p.office.toLowerCase());
      out.push({ office: p.office, label: labelFor(p.office), count: 0 });
    }
    return out;
  }, [officeOptions, seen, config.profiles]);

  const [selected, setSelected] = useState<string>(rows[0]?.office ?? "");
  const current = rows.find((r) => r.office.toLowerCase() === selected.toLowerCase()) ?? rows[0];
  const profile: OfficeProfile =
    config.profiles.find((p) => p.office.toLowerCase() === (current?.office ?? "").toLowerCase()) ??
    { office: current?.office ?? "", name: "", values: {} };

  function setProfile(next: OfficeProfile) {
    setConfig((c) => {
      const others = c.profiles.filter((p) => p.office.toLowerCase() !== next.office.toLowerCase());
      return { ...c, profiles: [...others, next] };
    });
    setDirty(true);
  }
  function clearProfile(office: string) {
    if (!confirm(`Clear everything entered for ${office}?`)) return;
    setConfig((c) => ({ ...c, profiles: c.profiles.filter((p) => p.office.toLowerCase() !== office.toLowerCase()) }));
    setDirty(true);
  }
  function addOffice() {
    const v = newOffice.trim();
    if (!v) return;
    if (rows.some((r) => r.office.toLowerCase() === v.toLowerCase())) {
      setSelected(v);
      setNewOffice("");
      return;
    }
    setProfile({ office: v, name: "", values: {} });
    setSelected(v);
    setNewOffice("");
  }

  function setFields(fields: OfficeField[]) {
    setConfig((c) => ({ ...c, fields }));
    setDirty(true);
  }
  function updateField(i: number, patch: Partial<OfficeField>) {
    const next = [...config.fields];
    next[i] = { ...next[i], ...patch };
    setFields(next);
  }
  function moveField(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= config.fields.length) return;
    const next = [...config.fields];
    [next[i], next[j]] = [next[j], next[i]];
    setFields(next);
  }
  function removeField(i: number) {
    const f = config.fields[i];
    const filled = config.profiles.filter((p) => (p.values[f.key] ?? "").trim()).length;
    if (filled && !confirm(`Remove “${f.label}”? ${filled} office${filled === 1 ? " has" : "s have"} a value for it.`)) return;
    setFields(config.fields.filter((_, j) => j !== i));
  }
  function addField() {
    const label = newField.trim();
    if (!label || config.fields.length >= MAX_OFFICE_FIELDS) return;
    let key = slugifyOfficeKey(label) || "field";
    let n = 2;
    while (config.fields.some((f) => f.key === key)) key = `${slugifyOfficeKey(label)}_${n++}`;
    setFields([...config.fields, { key, label, multiline: false }]);
    setNewField("");
  }

  async function save() {
    setSaving(true);
    const r = await jsonFetch("/api/admin/directory/offices", { method: "PUT", body: JSON.stringify(config) });
    setSaving(false);
    if (!r.ok) {
      toast("error", r.data?.error || "Could not save the offices.");
      return;
    }
    setConfig(r.data);
    setDirty(false);
    toast("ok", "Offices saved.");
  }

  const filledCount = config.profiles.filter((p) => profileHasContent(p, config.fields)).length;

  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-500">
        What each office is, beyond the people in it: the address, the main line and fax, where to park, the shared
        rooms and mailboxes. A PDF export closes with a block for every office that appears in it — the Phoenix
        sheet carries the Phoenix details without anyone typing them into the preset. Offices come from the{" "}
        <span className="font-medium">Office</span> field: its options first, then whatever people carry.
      </p>

      <div className="rounded-xl border border-slate-200 bg-surface shadow-xs">
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
            <Building2 className="h-4 w-4 text-compass-600" aria-hidden /> Offices
          </h3>
          <span className="text-xs text-slate-400">
            {rows.length} office{rows.length === 1 ? "" : "s"} · {filledCount} with details
          </span>
        </div>
        {rows.length === 0 ? (
          <SectionEmpty className="px-4 py-6">
            No offices yet — give the Office field options, put an office on a person, or add one below.
          </SectionEmpty>
        ) : (
          <div className="grid lg:grid-cols-[16rem_1fr]">
            <ul className="border-b border-slate-100 lg:border-b-0 lg:border-r" role="list">
              {rows.map((r) => {
                const p = config.profiles.find((x) => x.office.toLowerCase() === r.office.toLowerCase());
                const filled = p ? profileHasContent(p, config.fields) : false;
                const active = current?.office.toLowerCase() === r.office.toLowerCase();
                return (
                  <li key={r.office}>
                    <button
                      type="button"
                      onClick={() => setSelected(r.office)}
                      aria-current={active ? "true" : undefined}
                      className={`flex w-full items-center gap-2 px-4 py-2 text-left text-sm ${
                        active ? "bg-compass-50 text-compass-700" : "text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate font-medium">{r.label}</span>
                      <span className="text-xs text-slate-400">{r.count ? `${r.count}` : ""}</span>
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${filled ? "bg-emerald-500" : "bg-slate-300"}`}
                        data-tt={filled ? "Has details" : "Nothing entered yet"}
                        aria-label={filled ? "Has details" : "Nothing entered yet"}
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
            {current && (
              <div className="space-y-3 p-4">
                <div className="flex flex-wrap items-end justify-between gap-2">
                  <div className="w-64">
                    <Field label="Shown as" help="Blank uses the option label, else the value.">
                      <TextInput value={profile.name} placeholder={current.label} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
                    </Field>
                  </div>
                  <p className="text-xs text-slate-400">
                    {current.count ? `${current.count} ${current.count === 1 ? "person" : "people"} in ${current.office}` : `Nobody is in ${current.office} right now`}
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {config.fields.map((f) => (
                    <div key={f.key} className={f.multiline ? "sm:col-span-2" : ""}>
                      <Field label={f.label}>
                        {f.multiline ? (
                          <Textarea
                            rows={3}
                            value={profile.values[f.key] ?? ""}
                            onChange={(e) => setProfile({ ...profile, values: { ...profile.values, [f.key]: e.target.value } })}
                          />
                        ) : (
                          <TextInput
                            value={profile.values[f.key] ?? ""}
                            onChange={(e) => setProfile({ ...profile, values: { ...profile.values, [f.key]: e.target.value } })}
                          />
                        )}
                      </Field>
                    </div>
                  ))}
                </div>
                {profileHasContent(profile, config.fields) && (
                  <button type="button" onClick={() => clearProfile(current.office)} className="text-xs font-medium text-slate-500 hover:text-red-600">
                    <span className="inline-flex items-center gap-1"><Trash2 className="h-3.5 w-3.5" /> Clear this office</span>
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            addOffice();
          }}
          className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-4 py-3"
        >
          <div className="w-64">
            <TextInput value={newOffice} onChange={(e) => setNewOffice(e.target.value)} placeholder="An office nobody is in yet" aria-label="New office" />
          </div>
          <button type="submit" className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            <span className="inline-flex items-center gap-1.5"><Plus className="h-4 w-4" /> Add office</span>
          </button>
        </form>
      </div>

      <div className="rounded-xl border border-slate-200 bg-surface shadow-xs">
        <div className="border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-800">Office fields</h3>
          <p className="mt-0.5 text-xs text-slate-400">
            What every office describes itself with, in the order the PDF prints them. Multi-line fields take a whole
            row — addresses, parking notes, room lists.
          </p>
        </div>
        <ul className="divide-y divide-slate-100" role="list">
          {config.fields.map((f, i) => (
            <li key={f.key} className="flex flex-wrap items-center gap-3 px-4 py-2">
              <div className="w-56">
                <TextInput value={f.label} onChange={(e) => updateField(i, { label: e.target.value })} aria-label={`Label for ${f.key}`} />
              </div>
              <span className="font-mono text-[11px] text-slate-400">{f.key}</span>
              <Toggle label="Multi-line" checked={f.multiline} onChange={(v) => updateField(i, { multiline: v })} />
              <span className="ml-auto flex items-center gap-1">
                <button type="button" onClick={() => moveField(i, -1)} disabled={i === 0} className="rounded-sm p-1 text-slate-400 hover:text-slate-600 disabled:opacity-30" data-tt="Move up" aria-label={`Move ${f.label} up`}>
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button type="button" onClick={() => moveField(i, 1)} disabled={i === config.fields.length - 1} className="rounded-sm p-1 text-slate-400 hover:text-slate-600 disabled:opacity-30" data-tt="Move down" aria-label={`Move ${f.label} down`}>
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
                <button type="button" onClick={() => removeField(i)} disabled={config.fields.length <= 1} className="rounded-sm p-1 text-slate-400 hover:text-red-600 disabled:opacity-30" data-tt="Remove" aria-label={`Remove ${f.label}`}>
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            </li>
          ))}
        </ul>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            addField();
          }}
          className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-4 py-3"
        >
          <div className="w-64">
            <TextInput value={newField} onChange={(e) => setNewField(e.target.value)} placeholder="New field, e.g. Mail stop" aria-label="New office field" />
          </div>
          <button type="submit" disabled={config.fields.length >= MAX_OFFICE_FIELDS} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40">
            <span className="inline-flex items-center gap-1.5"><Plus className="h-4 w-4" /> Add field</span>
          </button>
          {config.fields.length === 0 && (
            <button type="button" onClick={() => setFields([...DEFAULT_OFFICE_FIELDS])} className="text-xs font-medium text-compass-600 hover:underline">
              Restore the default fields
            </button>
          )}
        </form>
      </div>

      <div className="flex items-center gap-3">
        <button type="button" onClick={save} disabled={saving || !dirty} className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60">
          {saving ? "Saving…" : "Save offices"}
        </button>
        {dirty ? <span className="text-xs text-amber-600">Unsaved changes</span> : <span className="text-xs text-slate-400">Saved</span>}
      </div>
    </div>
  );
}
