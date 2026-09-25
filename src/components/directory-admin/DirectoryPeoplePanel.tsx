"use client";

// The people in the directory: add one by hand, edit anyone (synced rows
// keep their provider's columns read-only and take manual values on top),
// pin, hide, link. One page of the directory settings.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Pin, ArrowUp, ArrowDown } from "lucide-react";
import { EntityPicker } from "@/components/EntityPicker";
import { Field, TextInput } from "@/components/form";
import { toast } from "@/components/Toasts";
import type { DirectoryPerson, DirectoryField, LinkRow } from "@/lib/directory";
import { jsonFetch } from "./shared";

const EMPTY_FORM = { name: "", title: "", department: "", email: "", phone: "", mobile: "", office: "" };
const SOURCE_LABEL: Record<string, string> = { manual: "manual", graph: "Microsoft 365", google: "Google Workspace" };

export function DirectoryPeoplePanel({
  initialPeople,
  initialLinks,
  fields,
}: {
  initialPeople: DirectoryPerson[];
  initialLinks: LinkRow[];
  fields: DirectoryField[];
}) {
  const router = useRouter();
  const [people, setPeople] = useState(initialPeople);
  const [links, setLinks] = useState(initialLinks);
  async function onChange() {
    const r = await jsonFetch("/api/admin/directory/people");
    if (r.ok) {
      setPeople(r.data.people);
      setLinks(r.data.links ?? []);
    }
    router.refresh();
  }
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [formCustom, setFormCustom] = useState<Record<string, string>>({});
  const [revert, setRevert] = useState<Set<string>>(new Set());
  const [formLinks, setFormLinks] = useState<Record<string, number[]>>({});
  const [formLinkedBy, setFormLinkedBy] = useState<Record<string, number[]>>({});
  const [editing, setEditing] = useState<DirectoryPerson | null>(null);
  const [busy, setBusy] = useState(false);

  const jsonbFields = useMemo(() => fields.filter((f) => !f.builtin && f.kind !== "people"), [fields]);
  const peopleFields = useMemo(() => fields.filter((f) => f.kind === "people"), [fields]);
  const pinned = useMemo(
    () => people.filter((p) => p.pin_order != null).sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0)),
    [people]
  );
  const pickerOptions = useMemo(
    () => people.map((p) => ({ id: p.id, label: p.name, sublabel: p.title || p.department || undefined })),
    [people]
  );
  const synced = editing ? editing.source !== "manual" : false;

  function reset() {
    setEditing(null);
    setForm({ ...EMPTY_FORM });
    setFormCustom({});
    setRevert(new Set());
    setFormLinks({});
    setFormLinkedBy({});
  }

  function startEdit(p: DirectoryPerson) {
    setEditing(p);
    setForm({ name: p.name, title: p.title, department: p.department, email: p.email, phone: p.phone, mobile: p.mobile, office: p.office });
    setFormCustom({ ...(p.manual ?? {}) });
    setRevert(new Set());
    const out: Record<string, number[]> = {};
    const inn: Record<string, number[]> = {};
    for (const f of peopleFields) {
      out[f.key] = links.filter((l) => l.source === "manual" && l.field_key === f.key && l.person_id === p.id).map((l) => l.target_id);
      inn[f.key] = links.filter((l) => l.source === "manual" && l.field_key === f.key && l.target_id === p.id).map((l) => l.person_id);
    }
    setFormLinks(out);
    setFormLinkedBy(inn);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    // Send only what changed in the manual layer; a reverted key goes as null.
    const custom: Record<string, string | null> = {};
    const before = editing?.manual ?? {};
    for (const f of jsonbFields) {
      const v = formCustom[f.key] ?? "";
      if (revert.has(f.key)) custom[f.key] = null;
      else if ((before[f.key] ?? "") !== v && (v !== "" || before[f.key] !== undefined)) custom[f.key] = v;
    }
    const body: Record<string, unknown> = { custom, links: formLinks, linked_by: formLinkedBy };
    if (!synced) Object.assign(body, form);
    const r = editing
      ? await jsonFetch(`/api/admin/directory/people/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) })
      : await jsonFetch("/api/admin/directory/people", { method: "POST", body: JSON.stringify(body) });
    setBusy(false);
    if (!r.ok) {
      toast("error", r.data?.error || "Could not save.");
      return;
    }
    toast("ok", editing ? "Saved." : "Added.");
    reset();
    await onChange();
  }

  async function patch(p: DirectoryPerson, body: Record<string, unknown>) {
    const r = await jsonFetch(`/api/admin/directory/people/${p.id}`, { method: "PATCH", body: JSON.stringify(body) });
    if (!r.ok) toast("error", r.data?.error || "Could not save.");
    await onChange();
  }
  async function remove(p: DirectoryPerson) {
    if (!confirm(`Remove ${p.name} from the directory?`)) return;
    await jsonFetch(`/api/admin/directory/people/${p.id}`, { method: "DELETE" });
    await onChange();
  }
  async function movePin(p: DirectoryPerson, dir: -1 | 1) {
    const ids = pinned.map((x) => x.id);
    const i = ids.indexOf(p.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const r = await jsonFetch("/api/admin/directory/pins", { method: "PUT", body: JSON.stringify({ ids }) });
    if (!r.ok) toast("error", r.data?.error || "Could not reorder.");
    await onChange();
  }

  const syncedLinks = (p: DirectoryPerson, f: DirectoryField, direction: "out" | "in") =>
    links
      .filter((l) => l.source !== "manual" && l.field_key === f.key && (direction === "out" ? l.person_id === p.id : l.target_id === p.id))
      .map((l) => people.find((x) => x.id === (direction === "out" ? l.target_id : l.person_id))?.name)
      .filter(Boolean) as string[];

  return (
    <>
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <h3 className="mb-1 font-semibold text-slate-900">{editing ? `Edit ${editing.name}` : "Add a person"}</h3>
        {synced && editing && (
          <p className="mb-3 text-xs text-slate-500">
            Synced from {SOURCE_LABEL[editing.source]}. Name, title, contact details and office come from there; anything you
            enter below is yours and survives every sync. Clear a field to fall back to the synced value.
          </p>
        )}
        <form onSubmit={save} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {(["name", "title", "department", "email", "phone", "mobile", "office"] as const).map((k) => (
              <TextInput
                key={k}
                placeholder={k === "name" ? "Name *" : k === "office" ? "Office / location" : k[0].toUpperCase() + k.slice(1)}
                type={k === "email" ? "email" : "text"}
                value={form[k]}
                onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                required={k === "name"}
                disabled={synced}
                aria-label={k}
              />
            ))}
          </div>

          {jsonbFields.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {jsonbFields.map((f) => {
                const syncedValue = editing?.synced?.[f.key] ?? "";
                const reverted = revert.has(f.key);
                const listId = f.options.length ? `opts-${f.key}` : undefined;
                return (
                  <div key={f.key} className="min-w-0">
                    <TextInput
                      placeholder={f.label}
                      value={reverted ? "" : formCustom[f.key] ?? ""}
                      list={listId}
                      onChange={(e) => {
                        setFormCustom({ ...formCustom, [f.key]: e.target.value });
                        if (reverted) setRevert((s) => { const n = new Set(s); n.delete(f.key); return n; });
                      }}
                      aria-label={f.label}
                    />
                    {listId && (
                      <datalist id={listId}>
                        {f.options.map((o) => (
                          <option key={o.value} value={o.value}>{o.label ?? o.value}</option>
                        ))}
                      </datalist>
                    )}
                    {synced && syncedValue && (
                      <p className="mt-0.5 truncate text-[11px] text-slate-400">
                        synced: {syncedValue}
                        {(formCustom[f.key] ?? "") !== "" && !reverted && (
                          <>
                            {" · "}
                            <button type="button" className="text-compass-600 hover:underline" onClick={() => setRevert((s) => new Set(s).add(f.key))}>
                              use synced value
                            </button>
                          </>
                        )}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {peopleFields.length > 0 && (
            <div className="grid gap-3 lg:grid-cols-2">
              {peopleFields.map((f) => (
                <div key={f.key} className="space-y-2">
                  <Field label={f.label} help={editing ? `${f.label}s of ${editing.name}` : undefined}>
                    {editing && syncedLinks(editing, f, "out").length > 0 && (
                      <p className="mb-1 text-[11px] text-slate-400">synced: {syncedLinks(editing, f, "out").join(", ")}</p>
                    )}
                    <EntityPicker
                      options={pickerOptions.filter((o) => o.id !== editing?.id)}
                      value={formLinks[f.key] ?? []}
                      onChange={(ids) => setFormLinks({ ...formLinks, [f.key]: ids })}
                      placeholder={`Add ${f.label.toLowerCase()}…`}
                      emptyText="No people match."
                    />
                  </Field>
                  <Field label={f.inverse_label || `${f.label} to`} help={editing ? `People ${editing.name} is ${f.label.toLowerCase()} to` : undefined}>
                    {editing && syncedLinks(editing, f, "in").length > 0 && (
                      <p className="mb-1 text-[11px] text-slate-400">synced: {syncedLinks(editing, f, "in").join(", ")}</p>
                    )}
                    <EntityPicker
                      options={pickerOptions.filter((o) => o.id !== editing?.id)}
                      value={formLinkedBy[f.key] ?? []}
                      onChange={(ids) => setFormLinkedBy({ ...formLinkedBy, [f.key]: ids })}
                      placeholder="Add people…"
                      emptyText="No people match."
                    />
                  </Field>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60">
              {editing ? "Save" : "Add"}
            </button>
            {editing && (
              <button type="button" className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50" onClick={reset}>
                Cancel
              </button>
            )}
          </div>
        </form>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-surface shadow-xs">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2.5">Name</th>
              <th className="px-4 py-2.5">Title / department</th>
              <th className="px-4 py-2.5">Contact</th>
              <th className="px-4 py-2.5">Source</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {people.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">No directory entries yet.</td>
              </tr>
            )}
            {people.map((p) => (
              <tr key={p.id} className={`border-b border-slate-50 ${p.hidden ? "opacity-45" : ""}`}>
                <td className="px-4 py-2.5 font-medium text-slate-900">
                  {p.name}
                  {p.hidden ? <span className="ml-2 rounded-sm bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">hidden</span> : null}
                  {p.pin_order != null && (
                    <span className="ml-2 inline-flex items-center gap-1 rounded-sm bg-compass-50 px-1.5 py-0.5 text-xs text-compass-700">
                      <Pin className="h-3 w-3" /> pinned
                      <button type="button" onClick={() => movePin(p, -1)} className="text-compass-400 hover:text-compass-700" data-tt="Move up" aria-label={`Move ${p.name} up among pinned`}><ArrowUp className="h-3 w-3" /></button>
                      <button type="button" onClick={() => movePin(p, 1)} className="text-compass-400 hover:text-compass-700" data-tt="Move down" aria-label={`Move ${p.name} down among pinned`}><ArrowDown className="h-3 w-3" /></button>
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-slate-500">
                  {p.title}
                  {p.title && p.department ? " · " : ""}
                  {p.department}
                </td>
                <td className="px-4 py-2.5 text-slate-500">{[p.email, p.phone || p.mobile].filter(Boolean).join(" · ")}</td>
                <td className="px-4 py-2.5">
                  <span className={`rounded-sm px-1.5 py-0.5 text-xs ${p.source !== "manual" ? "bg-compass-50 text-compass-700" : "bg-slate-100 text-slate-500"}`}>
                    {SOURCE_LABEL[p.source] ?? p.source}
                  </span>
                  {Object.keys(p.manual ?? {}).length > 0 && p.source !== "manual" && (
                    <span className="ml-1 rounded-sm bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700" data-tt="Has manual overrides">+ manual</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex justify-end gap-2 text-xs font-medium">
                    <button className="text-compass-600 hover:underline" onClick={() => startEdit(p)}>Edit</button>
                    <button className="text-slate-500 hover:underline" onClick={() => patch(p, { pinned: p.pin_order == null })}>
                      {p.pin_order == null ? "Pin" : "Unpin"}
                    </button>
                    <button className="text-slate-500 hover:underline" onClick={() => patch(p, { hidden: p.hidden === 0 })}>
                      {p.hidden ? "Show" : "Hide"}
                    </button>
                    {p.source === "manual" && (
                      <button className="text-red-600 hover:underline" onClick={() => remove(p)}>Delete</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
