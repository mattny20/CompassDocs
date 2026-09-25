"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Pin, ArrowUp, ArrowDown } from "lucide-react";
import { MsDeviceSetup } from "./MsDeviceSetup";
import { EntityPicker } from "./EntityPicker";
import { Field, Select, TextInput, Toggle } from "@/components/form";
import { toast } from "@/components/Toasts";
import type { DirectoryPerson, DirectoryField, LinkRow, SyncReport } from "@/lib/directory";
import type { ExportPreset } from "@/lib/directory-export-config";
import { useFormatDate } from "./SettingsProvider";
import { DirectoryFieldsPanel } from "./directory-admin/DirectoryFieldsPanel";
import { DirectoryExportPanel } from "./directory-admin/DirectoryExportPanel";
import { jsonFetch } from "./directory-admin/shared";
import type { ProviderKey } from "@/lib/identity-provider";

interface GraphState {
  enabled: boolean; // bundled AND licensed
  bundled: boolean;
  tenant: string;
  client_id: string;
  has_secret: boolean;
  secret_expires?: string;
  group: string;
  include_guests: boolean;
  require_title: boolean;
  require_phone: boolean;
  photos: boolean;
  last_sync: {
    at: string;
    ok: boolean;
    count?: number;
    error?: string;
    blocked?: { doomed: number; total: number };
  } | null;
}

const EMPTY_FORM = { name: "", title: "", department: "", email: "", phone: "", mobile: "", office: "" };
const SOURCE_LABEL: Record<string, string> = { manual: "manual", graph: "Microsoft 365", google: "Google Workspace" };

export function DirectorySettings({
  initialPeople,
  initialFields,
  initialLinks,
  initialListColumns,
  initialGroupBy,
  initialPresets,
  graph,
  reports,
}: {
  initialPeople: DirectoryPerson[];
  initialFields: DirectoryField[];
  initialLinks: LinkRow[];
  initialListColumns: string[];
  initialGroupBy: string;
  initialPresets: ExportPreset[];
  graph: GraphState;
  reports: { graph: SyncReport | null; google: SyncReport | null };
}) {
  const router = useRouter();
  const [people, setPeople] = useState(initialPeople);
  const [links, setLinks] = useState(initialLinks);
  const [fields, setFields] = useState(initialFields);

  async function refresh() {
    const r = await jsonFetch("/api/admin/directory/people");
    if (r.ok) {
      setPeople(r.data.people);
      setLinks(r.data.links ?? []);
    }
    router.refresh();
  }

  // Mapping editors are offered for the bundled providers; the community
  // build shows none, and keeps every other control — options, group-by,
  // pins, presets — because none of them need a sync.
  const providers: ProviderKey[] = graph.bundled ? ["microsoft", "google"] : [];

  return (
    <div className="space-y-6">
      <div>
        <p className="mt-1 text-sm text-slate-500">
          Manage the people directory that every signed-in user sees under{" "}
          <span className="font-medium">Directory</span>. Add entries by hand, or connect
          Microsoft 365 or Google Workspace to sync them — and map anything either one knows
          into the fields below.
        </p>
      </div>

      <GraphPanel graph={graph} onSynced={refresh} report={reports.graph} />

      <DirectoryFieldsPanel fields={fields} onChange={(f) => { setFields(f); void refresh(); }} providers={providers} />

      <DirectoryExportPanel
        fields={fields}
        initialListColumns={initialListColumns}
        initialGroupBy={initialGroupBy}
        initialPresets={initialPresets}
      />

      <PeoplePanel people={people} links={links} fields={fields} onChange={refresh} />
    </div>
  );
}

// --- People -------------------------------------------------------------------------

function PeoplePanel({
  people,
  links,
  fields,
  onChange,
}: {
  people: DirectoryPerson[];
  links: LinkRow[];
  fields: DirectoryField[];
  onChange: () => Promise<void>;
}) {
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

// --- Microsoft 365 -------------------------------------------------------------------

function GraphPanel({ graph, onSynced, report }: { graph: GraphState; onSynced: () => void; report: SyncReport | null }) {
  const fmt = useFormatDate();
  const [g, setG] = useState(graph);
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  if (!g.bundled) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        <p className="font-semibold text-slate-800">Microsoft 365 directory sync</p>
        <p className="mt-1">
          Automatically fill this directory from your Microsoft Entra tenant — an{" "}
          <span className="font-medium">Enterprise</span> feature. See{" "}
          <a href="https://compassdocs.io/pricing" className="font-medium text-compass-600 hover:underline">
            pricing
          </a>{" "}
          or add people manually below.
        </p>
      </div>
    );
  }

  if (!g.enabled) {
    return (
      <div className="notice-warn rounded-xl border p-4 text-sm">
        <p className="font-semibold">Microsoft 365 directory sync isn&rsquo;t licensed.</p>
        <p className="mt-1">
          This Enterprise build supports it, but your license doesn&rsquo;t include the{" "}
          <code className="font-mono">directory_sync</code> entitlement — check{" "}
          <a href="/admin/license" className="font-medium underline">Settings → License</a>.
        </p>
      </div>
    );
  }

  async function save() {
    setSaving(true);
    const res = await fetch("/api/admin/directory/graph", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenant: g.tenant,
        client_id: g.client_id,
        ...(secret ? { client_secret: secret } : {}),
        group: g.group,
        include_guests: g.include_guests,
        require_title: g.require_title,
        require_phone: g.require_phone,
        photos: g.photos,
      }),
    });
    setSaving(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast("error", data?.error || "Could not save.");
      return;
    }
    if (data?.state) setG(data.state);
    setSecret("");
    toast("ok", "Microsoft 365 sync settings saved.");
  }

  async function syncNow(allowRemovals = false) {
    setSyncing(true);
    const res = await fetch("/api/ee/directory/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allow_removals: allowRemovals }),
    });
    const data = await res.json().catch(() => ({}));
    setSyncing(false);
    if (!res.ok) {
      toast("error", data?.error || "Sync failed.");
      return;
    }
    // The brake tripping is a success with a caveat — the upserts committed.
    if (data?.warning) toast("error", data.warning);
    else toast("ok", `Synced ${data?.count ?? "?"} people from Microsoft 365.`);
    const fresh = await fetch("/api/admin/directory/graph");
    if (fresh.ok) setG(await fresh.json());
    onSynced();
  }

  async function syncAllowingRemovals() {
    const b = g.last_sync?.blocked;
    if (!b) return;
    if (
      !confirm(
        `Remove ${b.doomed} people who are no longer in the tenant? They will be deleted ` +
          `from the directory. Manual entries are not affected.`
      )
    )
      return;
    await syncNow(true);
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="font-semibold text-slate-900">Microsoft 365 sync</h3>
        <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-900/50 dark:text-violet-300">Enterprise</span>
      </div>
      <p className="mb-3 text-sm text-slate-500">
        Register an app in Microsoft Entra with the <code className="font-mono">User.Read.All</code>{" "}
        application permission (admin-consented), then enter its details here.
      </p>

      <MsDeviceSetup
        startUrl="/api/ee/directory/setup/start"
        pollUrl="/api/ee/directory/setup/poll"
        refreshUrl="/api/admin/directory/graph"
        blurb="Signs you in once as a tenant admin, creates the app registration with User.Read.All + GroupMember.Read.All, grants admin consent, and fills in the details below."
        doneMessage="Done — the Entra app was created, consented, and the settings below were filled in. Hit “Sync now” to run the first sync."
        onDone={(state) => {
          setG(state);
          setSecret("");
        }}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Tenant ID">
          <TextInput value={g.tenant} onChange={(e) => setG({ ...g, tenant: e.target.value })} placeholder="00000000-0000-…" spellCheck={false} />
        </Field>
        <Field label="Client ID">
          <TextInput value={g.client_id} onChange={(e) => setG({ ...g, client_id: e.target.value })} placeholder="app registration id" spellCheck={false} />
        </Field>
        <Field
          label={
            <>
              Client secret {g.has_secret && !secret ? <span className="text-green-600">(stored ✓ — paste to replace)</span> : ""}
            </>
          }
          help={
            g.secret_expires && g.has_secret && !secret
              ? `Expires ${g.secret_expires} — set a reminder to rotate it.`
              : undefined
          }
        >
          <TextInput type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={g.has_secret ? "••••••••" : "secret value"} autoComplete="off" />
        </Field>
      </div>

      <div className="mt-3 max-w-md">
        <Field
          label={
            <>
              Limit to an Entra group <span className="text-slate-400">(optional — group object ID)</span>
            </>
          }
        >
          <TextInput value={g.group} onChange={(e) => setG({ ...g, group: e.target.value })} placeholder="leave blank to sync the whole tenant" spellCheck={false} />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap gap-4 text-sm text-slate-600">
        <Toggle label="Exclude guest accounts" checked={!g.include_guests} onChange={(next) => setG({ ...g, include_guests: !next })} />
        <Toggle label="Require a job title" checked={g.require_title} onChange={(next) => setG({ ...g, require_title: next })} />
        <Toggle label="Require a phone number" checked={g.require_phone} onChange={(next) => setG({ ...g, require_phone: next })} />
        <Toggle label="Sync profile photos" checked={g.photos} onChange={(next) => setG({ ...g, photos: next })} />
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button onClick={save} disabled={saving} className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60">
          {saving ? "Saving…" : "Save"}
        </button>
        <button onClick={() => syncNow()} disabled={syncing || !g.tenant || !g.client_id || !(g.has_secret || secret)} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50" data-tt={!g.tenant || !g.client_id ? "Save the tenant, client ID, and secret first" : ""} aria-label={!g.tenant || !g.client_id ? "Save the tenant, client ID, and secret first" : ""}>
          {syncing ? "Syncing…" : "Sync now"}
        </button>
      </div>

      {g.last_sync?.blocked && (
        <div className="notice-warn mt-3 rounded-lg border p-3 text-sm">
          <p className="font-medium">
            {g.last_sync.blocked.doomed} of {g.last_sync.blocked.total} synced people are no
            longer in the tenant — more than half, so they were left in place.
          </p>
          <p className="mt-1.5">
            Usually a group filter pointing somewhere unexpected, or consent that lapsed. If
            the removals are right, allow them once — syncing again on its own will keep
            stopping here.
          </p>
          <button
            type="button"
            onClick={syncAllowingRemovals}
            disabled={syncing}
            className="mt-2 rounded-lg border border-current/40 px-3 py-1.5 font-medium hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/10"
          >
            {syncing ? "Syncing…" : `Sync and remove the ${g.last_sync.blocked.doomed}`}
          </button>
        </div>
      )}

      {g.last_sync && (
        <p className={`mt-3 text-xs ${g.last_sync.ok ? "text-slate-400" : "text-red-500"}`}>
          Last sync {fmt.dateTime(g.last_sync.at)} —{" "}
          {g.last_sync.ok ? `${g.last_sync.count} people` : `failed: ${g.last_sync.error}`}
          {report && g.last_sync.ok ? (
            <>
              {" · "}
              {report.records} with stored records
              {report.adopted ? ` · adopted ${report.adopted} hand-typed ${report.adopted === 1 ? "entry" : "entries"}` : ""}
            </>
          ) : null}
        </p>
      )}
      {report?.unresolved?.length ? (
        <div className="notice-warn mt-2 rounded-lg border p-3 text-xs">
          <p className="font-medium">Some people references didn&rsquo;t match anyone:</p>
          <ul className="mt-1 list-disc pl-4">
            {report.unresolved.map((u) => (
              <li key={u.field}>
                <span className="font-mono">{u.field}</span>: {u.count} unresolved — e.g. {u.samples.join(", ")}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-slate-500">
            Usually someone the sync filters excluded, or an address that isn&rsquo;t the person&rsquo;s primary email. They are retried on every sync.
          </p>
        </div>
      ) : null}
    </div>
  );
}
