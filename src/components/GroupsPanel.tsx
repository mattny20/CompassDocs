"use client";

// Admin → Groups. Groups bundle users so private spaces can be shared with a
// team at a time: create them by hand, or (enterprise + Microsoft 365 sync)
// import them from Microsoft Entra and keep membership in sync.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UsersRound, RefreshCw, CloudDownload, Trash2, Pencil, X } from "lucide-react";
import { EntityPicker } from "@/components/EntityPicker";

type GroupRow = {
  id: number;
  name: string;
  source: string;
  external_id: string | null;
  last_synced_at: string | null;
  member_count: number;
  space_count: number;
};
type Member = { id: number; username: string; name: string; email: string; role: string };
type UserOption = Member;
type EntraGroup = { id: string; name: string; imported: boolean };

const field =
  "rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

export function GroupsPanel({
  initial,
  users,
  entra,
}: {
  initial: GroupRow[];
  users: UserOption[];
  entra: { bundled: boolean; licensed: boolean; configured: boolean };
}) {
  const router = useRouter();
  const [groups, setGroups] = useState<GroupRow[]>(initial);
  const [open, setOpen] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    const res = await fetch("/api/admin/groups");
    if (res.ok) setGroups((await res.json()).groups);
    router.refresh();
  }

  async function create() {
    const name = newName.trim();
    if (name.length < 2) {
      setError("Give the group a name (at least 2 characters).");
      return;
    }
    setBusy(true);
    setError("");
    const res = await fetch("/api/admin/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error || "Could not create the group.");
      return;
    }
    setNewName("");
    await refresh();
  }

  async function remove(g: GroupRow) {
    setError("");
    const warn =
      g.space_count > 0
        ? ` It is granted on ${g.space_count} private space${g.space_count === 1 ? "" : "s"} — members will lose access.`
        : "";
    if (!confirm(`Delete the group “${g.name}”?${warn}`)) return;
    const res = await fetch(`/api/admin/groups/${g.id}`, { method: "DELETE" });
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error || "Could not delete the group.");
      return;
    }
    if (open === g.id) setOpen(null);
    await refresh();
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Groups</h2>
        <p className="mt-1 text-sm text-slate-500">
          Groups control who can see private spaces (Settings → Spaces). Add users by hand, or
          import groups from Microsoft Entra to keep membership synced with your directory.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      <div className="flex gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
          className={`${field} flex-1`}
          placeholder="New group name — e.g. Engineering, HR, Leadership"
          maxLength={80}
        />
        <button
          onClick={create}
          disabled={busy}
          className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-compass-700 disabled:opacity-60"
        >
          Create group
        </button>
      </div>

      <div className="space-y-2">
        {groups.map((g) => (
          <GroupCard
            key={g.id}
            group={g}
            users={users}
            expanded={open === g.id}
            onToggle={() => setOpen(open === g.id ? null : g.id)}
            onChanged={refresh}
            onDelete={() => remove(g)}
          />
        ))}
        {groups.length === 0 && (
          <p className="rounded-lg border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
            No groups yet. Create one above, then grant it on a private space.
          </p>
        )}
      </div>

      <EntraSection entra={entra} onImported={async (msg) => {
        setNotice(msg);
        await refresh();
      }} />
    </div>
  );
}

function GroupCard({
  group,
  users,
  expanded,
  onToggle,
  onChanged,
  onDelete,
}: {
  group: GroupRow;
  users: UserOption[];
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => Promise<void>;
  onDelete: () => void;
}) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(group.name);
  const [error, setError] = useState("");

  async function load() {
    const res = await fetch(`/api/admin/groups/${group.id}`);
    if (res.ok) setMembers((await res.json()).members);
  }

  async function patch(body: Record<string, unknown>) {
    setError("");
    const res = await fetch(`/api/admin/groups/${group.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || "Could not update the group.");
      return false;
    }
    setMembers(data.members);
    await onChanged();
    return true;
  }

  const synced = group.source === "entra";
  const available = users.filter((u) => !(members ?? []).some((m) => m.id === u.id));

  return (
    <div className="rounded-xl border border-slate-200 bg-surface shadow-sm">
      <div className="flex items-center gap-3 p-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-compass-50 text-compass-600">
          <UsersRound className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {renaming ? (
              <span className="flex items-center gap-1">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={`${field} py-1`}
                  maxLength={80}
                  autoFocus
                  onKeyDown={async (e) => {
                    if (e.key === "Enter" && (await patch({ name: name.trim() }))) setRenaming(false);
                    if (e.key === "Escape") setRenaming(false);
                  }}
                />
                <button
                  onClick={async () => {
                    if (await patch({ name: name.trim() })) setRenaming(false);
                  }}
                  className="rounded-md bg-compass-600 px-2 py-1 text-xs font-semibold text-white"
                >
                  Save
                </button>
                <button onClick={() => setRenaming(false)} className="p-1 text-slate-400 hover:text-slate-600">
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            ) : (
              <span className="truncate font-medium text-slate-900">{group.name}</span>
            )}
            <span
              className={`rounded-full px-1.5 py-0.5 text-xs font-medium ${
                synced ? "bg-sky-50 text-sky-700" : "bg-slate-100 text-slate-500"
              }`}
            >
              {synced ? "Entra · synced" : "Manual"}
            </span>
          </div>
          <p className="text-xs text-slate-500">
            {group.member_count} member{group.member_count === 1 ? "" : "s"}
            {group.space_count > 0 &&
              ` · grants access to ${group.space_count} space${group.space_count === 1 ? "" : "s"}`}
            {synced && group.last_synced_at &&
              ` · synced ${new Date(group.last_synced_at).toLocaleString()}`}
          </p>
        </div>
        {!synced && !renaming && (
          <button
            onClick={() => {
              setName(group.name);
              setRenaming(true);
            }}
            className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-50"
            title="Rename"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          onClick={() => {
            onToggle();
            if (!expanded && members === null) void load();
          }}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          {expanded ? "Close" : "Members"}
        </button>
        <button
          onClick={onDelete}
          className="rounded-lg border border-slate-200 p-2 text-red-600 hover:bg-red-50"
          title="Delete group"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {expanded && (
        <div className="border-t border-slate-100 p-3">
          {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
          {synced && (
            <p className="mb-2 rounded-md bg-sky-50 px-2.5 py-1.5 text-xs text-sky-700">
              This group syncs from Microsoft Entra — manual changes here are overwritten on the
              next sync.
            </p>
          )}
          {members === null ? (
            <p className="text-sm text-slate-400">Loading members…</p>
          ) : (
            <>
              <ul className="divide-y divide-slate-100">
                {members.map((m) => (
                  <li key={m.id} className="flex items-center gap-2 py-1.5 text-sm">
                    <span className="font-medium text-slate-800">{m.name || m.username}</span>
                    <span className="text-xs text-slate-400">{m.email || m.username}</span>
                    <span className="ml-auto rounded-full bg-slate-100 px-1.5 text-xs text-slate-500">
                      {m.role}
                    </span>
                    <button
                      onClick={() => patch({ removeUserId: m.id })}
                      className="rounded-md p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                      title="Remove from group"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
                {members.length === 0 && (
                  <li className="py-2 text-sm text-slate-400">No members yet.</li>
                )}
              </ul>
              <div className="mt-2">
                <EntityPicker
                  options={available.map((u) => ({
                    id: u.id,
                    label: u.name || u.username,
                    sublabel: u.email || u.username,
                  }))}
                  onPick={(id) => void patch({ addUserId: id })}
                  placeholder="Add a user — search by name or email…"
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function EntraSection({
  entra,
  onImported,
}: {
  entra: { bundled: boolean; licensed: boolean; configured: boolean };
  onImported: (msg: string) => Promise<void>;
}) {
  const [browsing, setBrowsing] = useState(false);
  const [available, setAvailable] = useState<EntraGroup[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function browse() {
    setBrowsing(true);
    setBusy(true);
    setError("");
    const res = await fetch("/api/ee/directory/groups");
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.error || "Could not load groups from Microsoft Entra.");
      setAvailable([]);
      return;
    }
    setAvailable(data.groups ?? []);
    setPicked([]);
  }

  async function importPicked() {
    setBusy(true);
    setError("");
    const res = await fetch("/api/ee/directory/groups/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: picked }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.error || "Import failed.");
      return;
    }
    setBrowsing(false);
    setAvailable(null);
    await onImported(
      `Imported ${data.imported} group${data.imported === 1 ? "" : "s"} from Microsoft Entra (${data.matched} member${data.matched === 1 ? "" : "s"} matched to CompassDocs users).`
    );
  }

  async function syncAll() {
    setBusy(true);
    setError("");
    const res = await fetch("/api/ee/directory/groups/sync", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.error || "Sync failed.");
      return;
    }
    await onImported(
      `Synced ${data.groups} group${data.groups === 1 ? "" : "s"} (${data.matched} member${data.matched === 1 ? "" : "s"} matched).`
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <CloudDownload className="h-4 w-4 text-compass-600" />
            Microsoft Entra groups
            <span className="rounded-full bg-violet-50 px-1.5 py-0.5 text-xs font-medium text-violet-700">
              Enterprise
            </span>
          </h3>
          <p className="mt-1 text-sm text-slate-500">
            Import security groups from your Microsoft 365 tenant and keep their membership in
            sync. Members are matched to CompassDocs accounts by SSO identity or email.
          </p>
        </div>
        {entra.bundled && entra.licensed && entra.configured && (
          <div className="flex shrink-0 gap-2">
            <button
              onClick={syncAll}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
              Sync now
            </button>
            <button
              onClick={browse}
              disabled={busy}
              className="rounded-lg bg-compass-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-compass-700 disabled:opacity-60"
            >
              Browse groups
            </button>
          </div>
        )}
      </div>

      {!entra.bundled ? (
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500">
          This is the community edition — Entra group sync ships in the enterprise image
          (ghcr.io/mattny20/compassdocs-ee).
        </p>
      ) : !entra.licensed ? (
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500">
          Your license doesn't include Microsoft 365 directory sync — contact support to add it.
        </p>
      ) : !entra.configured ? (
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500">
          Connect Microsoft 365 first under{" "}
          <a href="/admin/directory" className="font-medium text-compass-700 underline">
            Settings → Directory
          </a>{" "}
          — group sync reuses the same app registration (it also needs the GroupMember.Read.All
          application permission, which the one-click setup grants).
        </p>
      ) : null}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {browsing && available !== null && (
        <div className="mt-3 rounded-lg border border-slate-200 p-3">
          {available.length === 0 ? (
            <p className="text-sm text-slate-400">No groups found in the tenant.</p>
          ) : (
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {available.map((g) => (
                <label
                  key={g.id}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
                    g.imported ? "text-slate-400" : "cursor-pointer text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  <input
                    type="checkbox"
                    disabled={g.imported}
                    checked={g.imported || picked.includes(g.id)}
                    onChange={() =>
                      setPicked((prev) =>
                        prev.includes(g.id) ? prev.filter((x) => x !== g.id) : [...prev, g.id]
                      )
                    }
                    className="h-3.5 w-3.5 accent-compass-600"
                  />
                  {g.name}
                  {g.imported && <span className="text-xs">already imported</span>}
                </label>
              ))}
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <button
              onClick={importPicked}
              disabled={busy || picked.length === 0}
              className="rounded-lg bg-compass-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-compass-700 disabled:opacity-60"
            >
              {busy ? "Importing…" : `Import ${picked.length || ""} selected`}
            </button>
            <button
              onClick={() => {
                setBrowsing(false);
                setAvailable(null);
              }}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
