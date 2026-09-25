"use client";

// The directory registry: every field, its kind, options, display, and the
// per-provider mappings that fill it. The three editors — Mapping (with a live
// preview against stored records), Options (with values harvested from the
// data), and the row itself — are what turn "data mapping to custom fields"
// into something an office manager can drive.

import { useEffect, useMemo, useState } from "react";
import { Plus, Sparkles, Trash2 } from "lucide-react";
import type { DirectoryField } from "@/lib/directory";
import { describeMapping, parseMapping, type Mapping } from "@/lib/directory-mapping";
import { CHIP_COLORS, matchOption, type FieldOption } from "@/lib/directory-display";
import { Field, Select, TextInput, Toggle } from "@/components/form";
import { toast } from "@/components/Toasts";
import type { ProviderKey } from "@/lib/identity-provider";
import { Disclosure, jsonFetch } from "./shared";

// Suggestions, not a whitelist: the mapping input is free text.
const MICROSOFT_PATHS = [
  "jobTitle", "department", "officeLocation", "city", "state", "streetAddress", "postalCode", "country",
  "companyName", "employeeId", "employeeType", "employeeOrgData.division", "employeeOrgData.costCenter",
  "mail", "userPrincipalName", "mailNickname", "givenName", "surname", "displayName",
  "businessPhones", "businessPhones.0", "businessPhones.1", "mobilePhone", "faxNumber",
  "onPremisesSamAccountName", "onPremisesDistinguishedName", "preferredLanguage", "usageLocation",
  "manager.mail", "manager.userPrincipalName", "manager.displayName",
  ...Array.from({ length: 15 }, (_, i) => `onPremisesExtensionAttributes.extensionAttribute${i + 1}`),
];
// Entra ID has no assistant attribute on a user — the AD `assistant` and
// Exchange `msExchAssistantName` fields never reach Microsoft Graph. What a
// tenant can put assistants in: an Exchange custom attribute (1–15), a
// directory extension, or the manager relationship for the other direction.
const MICROSOFT_PEOPLE_PATHS = [
  "manager.mail", "manager.userPrincipalName",
  ...Array.from({ length: 15 }, (_, i) => `onPremisesExtensionAttributes.extensionAttribute${i + 1}`),
];
const GOOGLE_PEOPLE_PATHS = ["relations.value", "relations[assistant].value", "relations[manager].value"];
const GOOGLE_PATHS = [
  "organizations[primary].title", "organizations[primary].department", "organizations[primary].costCenter",
  "organizations[primary].description", "orgUnitPath", "phones.value", "phones[primary].value",
  "locations[primary].buildingId", "locations[primary].area", "locations[primary].deskCode",
  "relations.value", "name.givenName", "name.familyName", "primaryEmail", "customSchemas.HR.employee_id",
];

const KIND_LABEL: Record<string, string> = { text: "Text", choice: "Choice", people: "People" };
const DISPLAY_LABEL: Record<string, string> = { field: "Text", tag: "Chips", phone: "Phone" };

type MappingMode = "none" | "path" | "compose" | "extract" | "first" | "groups" | "derive";

function modeOf(m: Mapping | undefined): MappingMode {
  return m ? m.kind : "none";
}

/** One editable mapping (any kind). `first` nests these. */
function MappingRow({
  value,
  onChange,
  suggestions,
  allowNested = true,
}: {
  value: Mapping | undefined;
  onChange: (m: Mapping | undefined) => void;
  suggestions: string[];
  allowNested?: boolean;
}) {
  const mode = modeOf(value);
  const listId = useMemo(() => `paths-${Math.random().toString(36).slice(2, 8)}`, []);
  const set = (m: Mapping | undefined) => onChange(m);
  return (
    <div className="space-y-2">
      <Select
        value={mode}
        onChange={(e) => {
          const next = e.target.value as MappingMode;
          if (next === "none") set(undefined);
          else if (next === "path") set({ kind: "path", path: "" });
          else if (next === "compose") set({ kind: "compose", template: "" });
          else if (next === "extract") set({ kind: "extract", path: "", pattern: "", group: 1 });
          else if (next === "first") set({ kind: "first", of: [{ kind: "path", path: "" }] });
          else if (next === "groups") set({ kind: "groups", groups: [{ id: "", value: "" }] });
          else if (next === "derive") set({ kind: "derive", rule: "initials" });
        }}
        className="w-full"
        aria-label="Mapping type"
      >
        <option value="none">Not mapped (manual only)</option>
        <option value="path">A property</option>
        <option value="compose">Compose from properties</option>
        <option value="extract">Extract with a pattern</option>
        {allowNested && <option value="first">First of several</option>}
        <option value="groups">Group membership</option>
        <option value="derive">Derived</option>
      </Select>
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>

      {value?.kind === "path" && (
        <TextInput className="w-full font-mono text-xs" list={listId} placeholder="e.g. officeLocation or onPremisesExtensionAttributes.extensionAttribute3" value={value.path} onChange={(e) => set({ kind: "path", path: e.target.value })} spellCheck={false} />
      )}
      {value?.kind === "compose" && (
        <TextInput className="w-full font-mono text-xs" placeholder="e.g. {officeLocation} – {city}" value={value.template} onChange={(e) => set({ kind: "compose", template: e.target.value })} spellCheck={false} />
      )}
      {value?.kind === "extract" && (
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_5rem]">
          <TextInput className="font-mono text-xs" list={listId} placeholder="property, e.g. businessPhones" value={value.path} onChange={(e) => set({ ...value, path: e.target.value })} spellCheck={false} />
          <TextInput className="font-mono text-xs" placeholder="pattern, e.g. x(\d{2,5})$" value={value.pattern} onChange={(e) => set({ ...value, pattern: e.target.value })} spellCheck={false} />
          <TextInput className="font-mono text-xs" type="number" min={0} placeholder="group" value={value.group ?? 1} onChange={(e) => set({ ...value, group: Number(e.target.value) })} aria-label="Capture group" />
        </div>
      )}
      {value?.kind === "first" && (
        <div className="space-y-2 rounded-lg border border-dashed border-slate-200 p-2">
          {value.of.map((inner, i) => (
            <div key={i} className="flex items-start gap-2">
              <div className="flex-1">
                <MappingRow
                  value={inner}
                  onChange={(m) => {
                    const of = [...value.of];
                    if (m) of[i] = m;
                    else of.splice(i, 1);
                    set(of.length ? { kind: "first", of } : undefined);
                  }}
                  suggestions={suggestions}
                  allowNested={false}
                />
              </div>
              <button type="button" onClick={() => { const of = value.of.filter((_, j) => j !== i); set(of.length ? { kind: "first", of } : undefined); }} className="mt-2 text-slate-400 hover:text-red-600" data-tt="Remove" aria-label="Remove fallback">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button type="button" onClick={() => set({ kind: "first", of: [...value.of, { kind: "path", path: "" }] })} className="text-xs font-medium text-compass-600 hover:underline">
            + Add a fallback
          </button>
          <p className="text-xs text-slate-400">The first one that yields a value wins.</p>
        </div>
      )}
      {value?.kind === "groups" && (
        <div className="space-y-2">
          {value.groups.map((g, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <TextInput className="font-mono text-xs" placeholder="group object id" value={g.id} onChange={(e) => { const groups = [...value.groups]; groups[i] = { ...g, id: e.target.value }; set({ kind: "groups", groups }); }} spellCheck={false} aria-label="Group id" />
              <TextInput className="text-xs" placeholder="value when a member, e.g. Litigation" value={g.value} onChange={(e) => { const groups = [...value.groups]; groups[i] = { ...g, value: e.target.value }; set({ kind: "groups", groups }); }} aria-label="Value" />
              <button type="button" onClick={() => { const groups = value.groups.filter((_, j) => j !== i); set(groups.length ? { kind: "groups", groups } : undefined); }} className="text-slate-400 hover:text-red-600" data-tt="Remove" aria-label="Remove group">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button type="button" onClick={() => set({ kind: "groups", groups: [...value.groups, { id: "", value: "" }] })} className="text-xs font-medium text-compass-600 hover:underline">
            + Add a group
          </button>
          <p className="text-xs text-slate-400">
            Each provider group a person belongs to contributes its value. Membership is read by the sync (nested groups included).
          </p>
        </div>
      )}
      {value?.kind === "derive" && (
        <Select value={value.rule} onChange={(e) => set({ kind: "derive", rule: e.target.value as "initials" | "email_localpart" })} className="w-full" aria-label="Derive rule">
          <option value="initials">Initials from the name</option>
          <option value="email_localpart">The part of the email before @</option>
        </Select>
      )}
    </div>
  );
}

interface Preview {
  total: number;
  filled: number;
  samples: { name: string; values: string[] }[];
  values: { value: string; count: number }[];
}

function MappingEditor({
  field,
  provider,
  onSaved,
}: {
  field: DirectoryField;
  provider: ProviderKey;
  onSaved: (f: DirectoryField) => void;
}) {
  const [mapping, setMapping] = useState<Mapping | undefined>(field.mappings[provider]);
  const [direction, setDirection] = useState(field.link_direction);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const suggestions =
    field.kind === "people"
      ? provider === "microsoft" ? MICROSOFT_PEOPLE_PATHS : GOOGLE_PEOPLE_PATHS
      : provider === "microsoft" ? MICROSOFT_PATHS : GOOGLE_PATHS;
  const valid = mapping ? parseMapping(mapping) : null;

  async function runPreview() {
    if (!valid) return;
    setBusy(true);
    const r = await jsonFetch("/api/admin/directory/fields/preview", { method: "POST", body: JSON.stringify({ provider, mapping: valid }) });
    setBusy(false);
    if (!r.ok) {
      toast("error", r.data?.error || "Preview failed.");
      return;
    }
    setPreview(r.data.preview);
  }

  async function save() {
    if (mapping && !valid) {
      toast("error", "That mapping isn't complete.");
      return;
    }
    setBusy(true);
    const mappings = { ...field.mappings };
    if (valid) mappings[provider] = valid;
    else delete mappings[provider];
    const r = await jsonFetch(`/api/admin/directory/fields/${field.id}`, {
      method: "PATCH",
      body: JSON.stringify({ mappings, ...(field.kind === "people" ? { link_direction: direction } : {}) }),
    });
    setBusy(false);
    if (!r.ok) {
      toast("error", r.data?.error || "Could not save the mapping.");
      return;
    }
    const applied = r.data?.applied;
    toast("ok", applied ? `Mapping saved and applied to ${applied.updated} synced ${applied.updated === 1 ? "person" : "people"}.` : "Mapping saved.");
    onSaved(r.data.field);
  }

  return (
    <div className="space-y-3">
      {field.kind === "people" && provider === "microsoft" && (
        <p className="text-xs text-slate-500">
          Entra ID has no assistant attribute, so there is nothing named “assistant” to pick. Map this field to wherever your
          tenant keeps it: an Exchange custom attribute (<code className="font-mono">onPremisesExtensionAttributes.extensionAttribute1</code>…<code className="font-mono">15</code>)
          holding the assistant’s email or sign-in name, or a directory extension (<code className="font-mono">extension_&lt;appId&gt;_assistant</code>).
          <code className="font-mono"> manager.mail</code> maps the manager relationship. Not mapped means links are made by hand in People.
        </p>
      )}
      <MappingRow value={mapping} onChange={(m) => { setMapping(m); setPreview(null); }} suggestions={suggestions} />
      {field.kind === "people" && mapping && (
        <Field label="What the value names" help="A list of emails, sign-in names, or provider ids, separated by commas or semicolons.">
          <Select value={direction} onChange={(e) => setDirection(e.target.value as "out" | "in")} className="w-full">
            <option value="out">This person's {field.label.toLowerCase()}s (the value on an attorney lists their assistants)</option>
            <option value="in">The people this person is {field.label.toLowerCase()} to (the value on an assistant lists their attorneys)</option>
          </Select>
        </Field>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={runPreview} disabled={!valid || busy} className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          <span className="inline-flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" /> Preview</span>
        </button>
        <button type="button" onClick={save} disabled={busy} className="rounded-lg bg-compass-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60">
          Save mapping
        </button>
        {mapping && !valid && <span className="text-xs text-amber-600">Incomplete — fill in every part.</span>}
      </div>
      {preview && (
        <div className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800/50">
          {preview.total === 0 ? (
            <p className="text-slate-500">No stored records for this provider yet — run a sync, then preview.</p>
          ) : (
            <>
              <p className="font-medium text-slate-800">
                Fills {preview.filled} of {preview.total} synced people
                {preview.filled < preview.total ? <span className="font-normal text-slate-500"> — {preview.total - preview.filled} would be empty</span> : null}
              </p>
              {preview.samples.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
                  {preview.samples.map((s) => (
                    <li key={s.name}>
                      <span className="text-slate-400">{s.name}:</span> {s.values.join(", ")}
                    </li>
                  ))}
                </ul>
              )}
              {preview.values.length > 0 && (
                <p className="mt-2 text-xs text-slate-500">
                  {preview.values.length} distinct value{preview.values.length === 1 ? "" : "s"}: {preview.values.slice(0, 12).map((v) => `${v.value} (${v.count})`).join(", ")}
                  {preview.values.length > 12 ? ", …" : ""}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function OptionsEditor({ field, onSaved }: { field: DirectoryField; onSaved: (f: DirectoryField) => void }) {
  const [options, setOptions] = useState<FieldOption[]>(field.options);
  const [format, setFormat] = useState(field.value_format);
  const [seen, setSeen] = useState<{ value: string; count: number }[] | null>(null);
  const [busy, setBusy] = useState(false);

  const unmatched = useMemo(
    () => (seen ?? []).filter((v) => !matchOption({ options }, v.value).option),
    [seen, options]
  );

  async function harvest() {
    const r = await jsonFetch(`/api/admin/directory/fields/values?key=${encodeURIComponent(field.key)}`);
    if (r.ok) setSeen(r.data.values ?? []);
  }
  function update(i: number, patch: Partial<FieldOption>) {
    const next = [...options];
    next[i] = { ...next[i], ...patch };
    setOptions(next);
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= options.length) return;
    const next = [...options];
    [next[i], next[j]] = [next[j], next[i]];
    setOptions(next);
  }
  function addOption(value: string) {
    if (!value.trim() || options.some((o) => o.value.toLowerCase() === value.trim().toLowerCase())) return;
    setOptions([...options, { value: value.trim() }]);
  }
  function addAlias(i: number, alias: string) {
    const cur = options[i].matches ?? [];
    if (cur.some((m) => m.toLowerCase() === alias.toLowerCase())) return;
    update(i, { matches: [...cur, alias] });
  }
  async function save() {
    setBusy(true);
    const r = await jsonFetch(`/api/admin/directory/fields/${field.id}`, { method: "PATCH", body: JSON.stringify({ options, value_format: format }) });
    setBusy(false);
    if (!r.ok) {
      toast("error", r.data?.error || "Could not save the options.");
      return;
    }
    toast("ok", "Options saved.");
    onSaved(r.data.field);
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Options give this field an <strong>order</strong> (sections and sorting follow it), a <strong>label</strong>
        (what the code shows as), and <strong>aliases</strong> (raw values that fold into it — <code className="font-mono">*</code> is a wildcard).
      </p>
      {options.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left uppercase tracking-wide text-slate-400">
                <th className="px-1 py-1">Value</th>
                <th className="px-1 py-1">Label</th>
                <th className="px-1 py-1">Aliases</th>
                <th className="px-1 py-1">Colour</th>
                <th className="px-1 py-1">Hidden</th>
                <th className="px-1 py-1" />
              </tr>
            </thead>
            <tbody>
              {options.map((o, i) => (
                <tr key={i} className="align-top">
                  <td className="px-1 py-1"><TextInput className="w-32 text-xs" value={o.value} onChange={(e) => update(i, { value: e.target.value })} aria-label="Value" /></td>
                  <td className="px-1 py-1"><TextInput className="w-32 text-xs" value={o.label ?? ""} placeholder={o.value} onChange={(e) => update(i, { label: e.target.value })} aria-label="Label" /></td>
                  <td className="px-1 py-1"><TextInput className="w-48 text-xs" value={(o.matches ?? []).join(", ")} placeholder="Partner, *Attorney*" onChange={(e) => update(i, { matches: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} aria-label="Aliases" /></td>
                  <td className="px-1 py-1">
                    <Select className="w-24 text-xs" value={o.color ?? ""} onChange={(e) => update(i, { color: e.target.value || undefined })} aria-label="Colour">
                      <option value="">default</option>
                      {Object.keys(CHIP_COLORS).map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-1 py-1 text-center"><input type="checkbox" checked={Boolean(o.hidden)} onChange={(e) => update(i, { hidden: e.target.checked || undefined })} aria-label="Hidden" /></td>
                  <td className="px-1 py-1 whitespace-nowrap">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="px-1 text-slate-400 hover:text-slate-600 disabled:opacity-30" data-tt="Move up" aria-label="Move up">↑</button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === options.length - 1} className="px-1 text-slate-400 hover:text-slate-600 disabled:opacity-30" data-tt="Move down" aria-label="Move down">↓</button>
                    <button type="button" onClick={() => setOptions(options.filter((_, j) => j !== i))} className="px-1 text-slate-400 hover:text-red-600" data-tt="Remove" aria-label="Remove option">×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const input = (e.currentTarget.elements.namedItem("v") as HTMLInputElement);
            addOption(input.value);
            input.value = "";
          }}
          className="flex items-center gap-2"
        >
          <TextInput name="v" className="w-44 text-xs" placeholder="New option value" aria-label="New option" />
          <button type="submit" className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
            <span className="inline-flex items-center gap-1"><Plus className="h-3.5 w-3.5" /> Add</span>
          </button>
        </form>
        <button type="button" onClick={harvest} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
          Values seen in data
        </button>
        <Select value={format} onChange={(e) => setFormat(e.target.value as typeof format)} className="w-44 text-xs" aria-label="How a matched value shows">
          <option value="raw">Show the raw value</option>
          <option value="label">Show the label</option>
          <option value="code_label">Show "value – label"</option>
        </Select>
        <button type="button" onClick={save} disabled={busy} className="rounded-lg bg-compass-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60">
          Save options
        </button>
      </div>
      {seen && (
        <div className="rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-800/50">
          {seen.length === 0 ? (
            <p className="text-slate-500">Nobody has a value for this field yet.</p>
          ) : (
            <>
              <p className="mb-1 font-medium text-slate-700">
                {seen.length} distinct value{seen.length === 1 ? "" : "s"}{unmatched.length ? ` · ${unmatched.length} not matching any option` : " · all matched"}
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {seen.slice(0, 80).map((v) => {
                  const hit = matchOption({ options }, v.value).option;
                  return (
                    <li key={v.value} className={`flex items-center gap-1 rounded-full border px-2 py-0.5 ${hit ? "border-slate-200 text-slate-400" : "border-amber-300 bg-amber-50 text-amber-800"}`}>
                      <span>{v.value}</span>
                      <span className="text-[10px] opacity-70">×{v.count}</span>
                      {!hit && (
                        <>
                          <button type="button" onClick={() => addOption(v.value)} className="ml-1 font-medium hover:underline" data-tt="Add as its own option" aria-label={`Add ${v.value} as an option`}>+ option</button>
                          {options.length > 0 && (
                            <Select className="h-5 w-24 py-0 text-[10px]" value="" onChange={(e) => { const i = Number(e.target.value); if (Number.isInteger(i)) addAlias(i, v.value); }} aria-label={`Fold ${v.value} into an option`}>
                              <option value="">fold into…</option>
                              {options.map((o, i) => (
                                <option key={i} value={i}>{o.label || o.value}</option>
                              ))}
                            </Select>
                          )}
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function DirectoryFieldsPanel({
  fields,
  onChange,
  providers,
}: {
  fields: DirectoryField[];
  onChange: (f: DirectoryField[]) => void;
  /** Providers whose mapping editor to show (the bundled ones). */
  providers: ProviderKey[];
}) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<DirectoryField["kind"]>("text");
  const [display, setDisplay] = useState<DirectoryField["display"]>("field");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<{ id: number; panel: "mapping" | "options" | "settings"; provider?: ProviderKey } | null>(null);

  async function reload() {
    const r = await jsonFetch("/api/admin/directory/fields");
    if (r.ok) onChange(r.data.fields);
  }
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await jsonFetch("/api/admin/directory/fields", {
      method: "POST",
      body: JSON.stringify({ label, kind, display, multi: kind === "people", group_by: kind === "choice", show_in_card: kind !== "people" }),
    });
    setBusy(false);
    if (!r.ok) {
      toast("error", r.data?.error || "Could not add the field.");
      return;
    }
    setLabel("");
    setKind("text");
    setDisplay("field");
    await reload();
  }
  async function patch(f: DirectoryField, body: Record<string, unknown>) {
    const r = await jsonFetch(`/api/admin/directory/fields/${f.id}`, { method: "PATCH", body: JSON.stringify(body) });
    if (!r.ok) toast("error", r.data?.error || "Could not save.");
    await reload();
  }
  async function removeField(f: DirectoryField) {
    if (!confirm(`Delete the "${f.label}" field? Its values are removed from every person.`)) return;
    const r = await jsonFetch(`/api/admin/directory/fields/${f.id}`, { method: "DELETE" });
    if (!r.ok) toast("error", r.data?.error || "Could not delete.");
    await reload();
  }
  const replace = (f: DirectoryField) => onChange(fields.map((x) => (x.id === f.id ? f : x)));
  const providerLabel: Record<ProviderKey, string> = { microsoft: "Microsoft 365", google: "Google Workspace" };
  const showWithOptions = fields.filter((f) => f.builtin && f.kind !== "people");

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
      <h3 className="mb-1 font-semibold text-slate-900">Directory fields</h3>
      <p className="mb-3 text-sm text-slate-500">
        Every attribute the directory shows, built-in columns included. Give a field <strong>options</strong> to
        order and label its values (Attorneys first, PHX1 shown as Phoenix), and a <strong>mapping</strong> per
        provider to fill it from your identity system — previewed against real records before you save.
        Anything not mapped is entered by hand; anything mapped can still be overridden per person.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2">Field</th>
              <th className="px-3 py-2">Kind</th>
              {providers.map((p) => (
                <th key={p} className="px-3 py-2">{providerLabel[p]}</th>
              ))}
              <th className="px-3 py-2">Options</th>
              <th className="px-3 py-2">Display</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <FieldRow
                key={f.id}
                f={f}
                providers={providers}
                providerLabel={providerLabel}
                open={open?.id === f.id ? open : null}
                setOpen={setOpen}
                patch={patch}
                removeField={removeField}
                replace={replace}
                showWithOptions={showWithOptions}
              />
            ))}
          </tbody>
        </table>
      </div>

      <form onSubmit={add} className="mt-3 flex flex-wrap items-center gap-2">
        <TextInput className="w-44" placeholder="New field label" value={label} onChange={(e) => setLabel(e.target.value)} required />
        <Select className="w-36" value={kind} onChange={(e) => setKind(e.target.value as DirectoryField["kind"])} data-tt="Text holds anything; Choice picks from the options you define; People links to other directory entries">
          <option value="text">Text</option>
          <option value="choice">Choice</option>
          <option value="people">People</option>
        </Select>
        {kind !== "people" && (
          <Select className="w-36" value={display} onChange={(e) => setDisplay(e.target.value as DirectoryField["display"])} data-tt="How the value renders">
            <option value="field">Show as text</option>
            <option value="tag">Show as chips</option>
            <option value="phone">Phone number</option>
          </Select>
        )}
        <button type="submit" disabled={busy} className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60">
          Add field
        </button>
      </form>
    </div>
  );
}

function FieldRow({
  f,
  providers,
  providerLabel,
  open,
  setOpen,
  patch,
  removeField,
  replace,
  showWithOptions,
}: {
  f: DirectoryField;
  providers: ProviderKey[];
  providerLabel: Record<ProviderKey, string>;
  open: { id: number; panel: "mapping" | "options" | "settings"; provider?: ProviderKey } | null;
  setOpen: (o: { id: number; panel: "mapping" | "options" | "settings"; provider?: ProviderKey } | null) => void;
  patch: (f: DirectoryField, body: Record<string, unknown>) => Promise<void>;
  removeField: (f: DirectoryField) => Promise<void>;
  replace: (f: DirectoryField) => void;
  showWithOptions: DirectoryField[];
}) {
  const [labelDraft, setLabelDraft] = useState(f.label);
  useEffect(() => setLabelDraft(f.label), [f.label]);
  const linkBtn = "text-xs font-medium text-compass-600 hover:underline";
  const cols = 4 + providers.length;
  return (
    <>
      <tr className="border-b border-slate-50 align-top">
        <td className="px-3 py-2">
          <TextInput
            className="w-40 text-sm font-medium"
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={() => labelDraft.trim() && labelDraft !== f.label && patch(f, { label: labelDraft.trim() })}
            aria-label={`Label for ${f.key}`}
          />
          <div className="mt-0.5 font-mono text-[11px] text-slate-400">
            {f.key}
            {f.builtin ? <span className="ml-1 rounded-sm bg-slate-100 px-1 text-[10px] uppercase text-slate-500">built-in</span> : null}
          </div>
        </td>
        <td className="px-3 py-2 text-slate-600">
          {KIND_LABEL[f.kind]}
          {f.multi ? <span className="text-slate-400"> · many</span> : null}
        </td>
        {providers.map((p) => {
          const m = f.mappings[p];
          return (
            <td key={p} className="px-3 py-2">
              <button type="button" className={`${linkBtn} text-left`} onClick={() => setOpen(open?.panel === "mapping" && open.provider === p ? null : { id: f.id, panel: "mapping", provider: p })}>
                {m ? <span className="font-mono text-[11px] text-slate-600">{describeMapping(m)}</span> : <span className="text-slate-400">not mapped</span>}
              </button>
            </td>
          );
        })}
        <td className="px-3 py-2">
          {f.kind === "people" ? (
            <span className="text-xs text-slate-400">—</span>
          ) : (
            <button type="button" className={linkBtn} onClick={() => setOpen(open?.panel === "options" ? null : { id: f.id, panel: "options" })}>
              {f.options.length ? `${f.options.length} option${f.options.length === 1 ? "" : "s"}` : "none"}
            </button>
          )}
        </td>
        <td className="px-3 py-2 text-xs text-slate-600">
          {f.kind === "people" ? (f.inverse_label ? `inverse “${f.inverse_label}”` : "links") : DISPLAY_LABEL[f.display]}
          {f.group_by ? <span className="text-slate-400"> · group by</span> : null}
          {f.show_in_card ? <span className="text-slate-400"> · on cards</span> : null}
          {f.show_with ? <span className="text-slate-400"> · with {f.show_with}</span> : null}
        </td>
        <td className="px-3 py-2 text-right whitespace-nowrap">
          <button type="button" className={linkBtn} onClick={() => setOpen(open?.panel === "settings" ? null : { id: f.id, panel: "settings" })}>
            Settings
          </button>
          {!f.builtin && (
            <button type="button" className="ml-3 text-xs font-medium text-red-600 hover:underline" onClick={() => removeField(f)}>
              Delete
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-slate-100 bg-slate-50/60 dark:bg-slate-800/30">
          <td colSpan={cols} className="px-3 py-3">
            {open.panel === "mapping" && open.provider && (
              <div className="max-w-3xl">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {providerLabel[open.provider]} → {f.label}
                </p>
                <MappingEditor key={`${f.id}-${open.provider}`} field={f} provider={open.provider} onSaved={(nf) => { replace(nf); setOpen(null); }} />
              </div>
            )}
            {open.panel === "options" && <OptionsEditor key={f.id} field={f} onSaved={(nf) => { replace(nf); setOpen(null); }} />}
            {open.panel === "settings" && (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
                {!f.builtin && f.kind !== "people" && (
                  <Select className="w-36" value={f.kind} onChange={(e) => patch(f, { kind: e.target.value })} aria-label="Kind">
                    <option value="text">Text</option>
                    <option value="choice">Choice</option>
                  </Select>
                )}
                {f.kind !== "people" && (
                  <Select className="w-36" value={f.display} onChange={(e) => patch(f, { display: e.target.value })} aria-label="Display">
                    <option value="field">Show as text</option>
                    <option value="tag">Show as chips</option>
                    <option value="phone">Phone number</option>
                  </Select>
                )}
                {f.kind !== "people" && (
                  <Toggle label="Several values (comma-separated)" checked={f.multi === 1} onChange={(v) => patch(f, { multi: v })} />
                )}
                {f.kind !== "people" && <Toggle label="Offer in “Group by”" checked={f.group_by === 1} onChange={(v) => patch(f, { group_by: v })} />}
                {!f.builtin && f.kind !== "people" && <Toggle label="Show on cards" checked={f.show_in_card === 1} onChange={(v) => patch(f, { show_in_card: v })} />}
                {f.display === "tag" && <Toggle label="Accent-coloured chips" checked={f.highlight === 1} onChange={(v) => patch(f, { highlight: v })} />}
                {!f.builtin && f.kind !== "people" && (
                  <Field label="Show beneath">
                    <Select className="w-40" value={f.show_with} onChange={(e) => patch(f, { show_with: e.target.value })}>
                      <option value="">— nothing —</option>
                      {showWithOptions.filter((x) => x.key !== f.key).map((x) => (
                        <option key={x.key} value={x.key}>{x.label}</option>
                      ))}
                    </Select>
                  </Field>
                )}
                {f.kind === "people" && (
                  <Field label="Inverse label" help="Shown on the other person, e.g. “Assists”.">
                    <TextInput className="w-40" defaultValue={f.inverse_label} onBlur={(e) => e.target.value.trim() !== f.inverse_label && patch(f, { inverse_label: e.target.value.trim() })} />
                  </Field>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
