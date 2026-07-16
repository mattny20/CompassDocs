"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MsDeviceSetup } from "./MsDeviceSetup";
import type { DirectoryPerson, DirectoryField } from "@/lib/directory";

const field =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

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
  last_sync: { at: string; ok: boolean; count?: number; error?: string } | null;
}

const EMPTY_FORM = { name: "", title: "", department: "", email: "", phone: "", mobile: "", office: "" };

// Common Graph user properties offered as mapping suggestions, plus the 15
// Exchange custom attributes (onPremisesExtensionAttributes).
const GRAPH_PATHS = [
  "employeeId", "companyName", "employeeType", "faxNumber", "preferredLanguage",
  "streetAddress", "city", "state", "postalCode", "country", "usageLocation",
  "ageGroup", "mailNickname", "onPremisesSamAccountName", "onPremisesDistinguishedName",
  ...Array.from({ length: 15 }, (_, i) => `onPremisesExtensionAttributes.extensionAttribute${i + 1}`),
];

export function DirectorySettings({
  initialPeople,
  initialFields,
  graph,
}: {
  initialPeople: DirectoryPerson[];
  initialFields: DirectoryField[];
  graph: GraphState;
}) {
  const router = useRouter();
  const [people, setPeople] = useState(initialPeople);
  const [fields, setFields] = useState(initialFields);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [formAssistant, setFormAssistant] = useState<string>("");
  const [formCustom, setFormCustom] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const res = await fetch("/api/admin/directory/people");
    if (res.ok) setPeople((await res.json()).people);
    router.refresh();
  }

  async function savePerson(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch(
      editingId === null ? "/api/admin/directory/people" : `/api/admin/directory/people/${editingId}`,
      {
        method: editingId === null ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          assistant_id: formAssistant ? Number(formAssistant) : null,
          custom: formCustom,
        }),
      }
    );
    setBusy(false);
    if (!res.ok) {
      setError((await res.json().catch(() => ({})))?.error || "Could not save.");
      return;
    }
    setForm({ ...EMPTY_FORM });
    setFormAssistant("");
    setFormCustom({});
    setEditingId(null);
    await refresh();
  }

  async function toggleHidden(p: DirectoryPerson) {
    await fetch(`/api/admin/directory/people/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hidden: p.hidden === 0 }),
    });
    await refresh();
  }

  async function remove(p: DirectoryPerson) {
    if (!confirm(`Remove ${p.name} from the directory?`)) return;
    await fetch(`/api/admin/directory/people/${p.id}`, { method: "DELETE" });
    await refresh();
  }

  function startEdit(p: DirectoryPerson) {
    setEditingId(p.id);
    setForm({
      name: p.name,
      title: p.title,
      department: p.department,
      email: p.email,
      phone: p.phone,
      mobile: p.mobile,
      office: p.office,
    });
    setFormAssistant(p.assistant_id ? String(p.assistant_id) : "");
    setFormCustom({ ...(p.custom ?? {}) });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Directory</h2>
        <p className="mt-1 text-sm text-slate-500">
          Manage the people directory that every signed-in user sees under{" "}
          <span className="font-medium">Directory</span>. Add entries by hand, or connect
          Microsoft 365 to sync them automatically.
        </p>
      </div>

      <GraphPanel graph={graph} onSynced={refresh} />

      <FieldsPanel fields={fields} onChange={setFields} graphEnabled={graph.bundled} />

      {/* Manual entry form */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <h3 className="mb-3 font-semibold text-slate-900">
          {editingId === null ? "Add a person" : "Edit person"}
        </h3>
        {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
        <form onSubmit={savePerson} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input className={field} placeholder="Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <input className={field} placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <input className={field} placeholder="Department" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} />
          <input className={field} placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input className={field} placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <input className={field} placeholder="Mobile" value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} />
          <input className={field} placeholder="Office / location" value={form.office} onChange={(e) => setForm({ ...form, office: e.target.value })} />
          <select className={field} value={formAssistant} onChange={(e) => setFormAssistant(e.target.value)}>
            <option value="">No assistant</option>
            {people
              .filter((pp) => pp.id !== editingId)
              .map((pp) => (
                <option key={pp.id} value={pp.id}>
                  Assistant: {pp.name}
                </option>
              ))}
          </select>
          {fields.map((f) => (
            <input
              key={f.key}
              className={field}
              placeholder={f.label}
              value={formCustom[f.key] ?? ""}
              onChange={(e) => setFormCustom({ ...formCustom, [f.key]: e.target.value })}
            />
          ))}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60">
              {editingId === null ? "Add" : "Save"}
            </button>
            {editingId !== null && (
              <button type="button" className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50" onClick={() => { setEditingId(null); setForm({ ...EMPTY_FORM }); setFormAssistant(""); setFormCustom({}); }}>
                Cancel
              </button>
            )}
          </div>
        </form>
      </div>

      {/* People table */}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-surface shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="px-4 py-2.5">Name</th>
              <th className="px-4 py-2.5">Title / department</th>
              <th className="px-4 py-2.5">Contact</th>
              <th className="px-4 py-2.5">Source</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {people.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  No directory entries yet.
                </td>
              </tr>
            )}
            {people.map((p) => (
              <tr key={p.id} className={`border-b border-slate-50 ${p.hidden ? "opacity-45" : ""}`}>
                <td className="px-4 py-2.5 font-medium text-slate-900">
                  {p.name}
                  {p.hidden ? <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">hidden</span> : null}
                </td>
                <td className="px-4 py-2.5 text-slate-500">
                  {p.title}
                  {p.title && p.department ? " · " : ""}
                  {p.department}
                </td>
                <td className="px-4 py-2.5 text-slate-500">
                  {[p.email, p.phone || p.mobile].filter(Boolean).join(" · ")}
                </td>
                <td className="px-4 py-2.5">
                  <span className={`rounded px-1.5 py-0.5 text-xs ${p.source === "graph" ? "bg-compass-50 text-compass-700" : "bg-slate-100 text-slate-500"}`}>
                    {p.source === "graph" ? "Microsoft 365" : "manual"}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex justify-end gap-2 text-xs font-medium">
                    {p.source === "manual" && (
                      <button className="text-compass-600 hover:underline" onClick={() => startEdit(p)}>Edit</button>
                    )}
                    <button className="text-slate-500 hover:underline" onClick={() => toggleHidden(p)}>
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
    </div>
  );
}

function GraphPanel({ graph, onSynced }: { graph: GraphState; onSynced: () => void }) {
  const [g, setG] = useState(graph);
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

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
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
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
    setError("");
    setMsg("");
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
      setError(data?.error || "Could not save.");
      return;
    }
    if (data?.state) setG(data.state);
    setSecret("");
    setMsg("Saved.");
  }

  async function syncNow() {
    setSyncing(true);
    setError("");
    setMsg("");
    const res = await fetch("/api/ee/directory/sync", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    setSyncing(false);
    if (!res.ok) {
      setError(data?.error || "Sync failed.");
      return;
    }
    setMsg(`Synced ${data?.count ?? "?"} people from Microsoft 365.`);
    onSynced();
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="font-semibold text-slate-900">Microsoft 365 sync</h3>
        <span className="rounded-full bg-compass-600 px-2 py-0.5 text-xs font-semibold text-white">Enterprise</span>
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
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">Tenant ID</span>
          <input className={field} value={g.tenant} onChange={(e) => setG({ ...g, tenant: e.target.value })} placeholder="00000000-0000-…" spellCheck={false} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">Client ID</span>
          <input className={field} value={g.client_id} onChange={(e) => setG({ ...g, client_id: e.target.value })} placeholder="app registration id" spellCheck={false} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            Client secret {g.has_secret && !secret ? <span className="text-green-600">(stored ✓ — paste to replace)</span> : ""}
          </span>
          <input className={field} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={g.has_secret ? "••••••••" : "secret value"} autoComplete="off" />
          {g.secret_expires && g.has_secret && !secret && (
            <span className="mt-1 block text-xs text-slate-400">
              Expires {g.secret_expires} — set a reminder to rotate it.
            </span>
          )}
        </label>
      </div>

      <label className="mt-3 block max-w-md">
        <span className="mb-1 block text-xs font-medium text-slate-500">
          Limit to an Entra group <span className="text-slate-400">(optional — group object ID)</span>
        </span>
        <input className={field} value={g.group} onChange={(e) => setG({ ...g, group: e.target.value })} placeholder="leave blank to sync the whole tenant" spellCheck={false} />
      </label>

      <div className="mt-3 flex flex-wrap gap-4 text-sm text-slate-600">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!g.include_guests} onChange={(e) => setG({ ...g, include_guests: !e.target.checked })} />
          Exclude guest accounts
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={g.require_title} onChange={(e) => setG({ ...g, require_title: e.target.checked })} />
          Require a job title
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={g.require_phone} onChange={(e) => setG({ ...g, require_phone: e.target.checked })} />
          Require a phone number
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={g.photos} onChange={(e) => setG({ ...g, photos: e.target.checked })} />
          Sync profile photos
        </label>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button onClick={save} disabled={saving} className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60">
          {saving ? "Saving…" : "Save"}
        </button>
        <button onClick={syncNow} disabled={syncing || !g.tenant || !g.client_id || !(g.has_secret || secret)} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50" title={!g.tenant || !g.client_id ? "Save the tenant, client ID, and secret first" : ""}>
          {syncing ? "Syncing…" : "Sync now"}
        </button>
        {msg && <span className="text-sm text-green-600">{msg}</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>

      {g.last_sync && (
        <p className={`mt-3 text-xs ${g.last_sync.ok ? "text-slate-400" : "text-red-500"}`}>
          Last sync {new Date(g.last_sync.at).toLocaleString()} —{" "}
          {g.last_sync.ok ? `${g.last_sync.count} people` : `failed: ${g.last_sync.error}`}
        </p>
      )}
    </div>
  );
}

function FieldsPanel({
  fields,
  onChange,
  graphEnabled,
}: {
  fields: DirectoryField[];
  onChange: (f: DirectoryField[]) => void;
  graphEnabled: boolean;
}) {
  const [label, setLabel] = useState("");
  const [graphPath, setGraphPath] = useState("");
  const [showInCard, setShowInCard] = useState(false);
  const [display, setDisplay] = useState<"field" | "tag">("field");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function reload() {
    const res = await fetch("/api/admin/directory/fields");
    if (res.ok) onChange((await res.json()).fields);
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/admin/directory/fields", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, graph_path: graphPath, show_in_card: showInCard, display }),
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json().catch(() => ({})))?.error || "Could not add the field.");
      return;
    }
    setLabel("");
    setGraphPath("");
    setShowInCard(false);
    setDisplay("field");
    await reload();
  }

  async function patch(f: DirectoryField, body: Record<string, unknown>) {
    await fetch(`/api/admin/directory/fields/${f.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await reload();
  }

  async function removeField(f: DirectoryField) {
    if (!confirm(`Delete the "${f.label}" field? Its values are removed from every person.`)) return;
    await fetch(`/api/admin/directory/fields/${f.id}`, { method: "DELETE" });
    await reload();
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
      <h3 className="mb-1 font-semibold text-slate-900">Custom fields</h3>
      <p className="mb-3 text-sm text-slate-500">
        Extra directory attributes (e.g. cost center, pronouns, extension). Display each as a
        plain <strong>field</strong> or as <strong>tags</strong> — comma-separated values shown
        as badges, ideal for skills, certifications, or technologies. They appear in the list
        view&rsquo;s column picker, optionally on cards, and are editable per person below.
        {graphEnabled && (
          <> Map a field to a Microsoft Graph property — including the Exchange custom attributes
          (<code className="font-mono">extensionAttribute1–15</code>) — and the sync fills it
          automatically.</>
        )}
      </p>

      {fields.length > 0 && (
        <div className="mb-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-3 py-2">Label</th>
                <th className="px-3 py-2">Key</th>
                <th className="px-3 py-2">Microsoft Graph mapping</th>
                <th className="px-3 py-2">Display</th>
                <th className="px-3 py-2">On cards</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => (
                <tr key={f.id} className="border-b border-slate-50">
                  <td className="px-3 py-2 font-medium text-slate-900">{f.label}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{f.key}</td>
                  <td className="px-3 py-2">
                    <input
                      className={`${field} max-w-xs font-mono text-xs`}
                      defaultValue={f.graph_path}
                      list="graph-paths"
                      placeholder="not mapped (manual only)"
                      onBlur={(e) => {
                        if (e.target.value.trim() !== f.graph_path) {
                          patch(f, { graph_path: e.target.value.trim() });
                        }
                      }}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <select
                      className={`${field} w-32 text-xs`}
                      value={f.display}
                      onChange={(e) => patch(f, { display: e.target.value })}
                    >
                      <option value="field">Field</option>
                      <option value="tag">Tags</option>
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={f.show_in_card === 1}
                      onChange={(e) => patch(f, { show_in_card: e.target.checked })}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button className="text-xs font-medium text-red-600 hover:underline" onClick={() => removeField(f)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      <form onSubmit={add} className="flex flex-wrap items-center gap-2">
        <input
          className={`${field} w-44`}
          placeholder="New field label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          required
        />
        <input
          className={`${field} w-72 font-mono text-xs`}
          placeholder="Graph property (optional)"
          value={graphPath}
          onChange={(e) => setGraphPath(e.target.value)}
          list="graph-paths"
          spellCheck={false}
        />
        <datalist id="graph-paths">
          {GRAPH_PATHS.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
        <select
          className={`${field} w-40`}
          value={display}
          onChange={(e) => setDisplay(e.target.value as "field" | "tag")}
          title="Field shows as label + text; Tag splits comma-separated values into badges"
        >
          <option value="field">Field (text value)</option>
          <option value="tag">Tags (badges)</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={showInCard} onChange={(e) => setShowInCard(e.target.checked)} />
          Show on cards
        </label>
        <button type="submit" disabled={busy} className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60">
          Add field
        </button>
      </form>
    </div>
  );
}
