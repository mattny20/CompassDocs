"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Globe, Building2, PencilRuler, ChevronUp, ChevronDown, Pencil, Trash2 } from "lucide-react";
import { EntityPicker } from "@/components/EntityPicker";
import { SpaceIconPicker } from "./SpaceIconPicker";
import type { Space } from "@/lib/types";

type SpaceRow = Space & { doc_count: number };
export type GroupOption = { id: number; name: string; source: string; member_count: number };
export type EditorUserOption = { id: number; name: string; role: string };
export type CategoryOption = { id: number; name: string; position: number };
type EditorGrants = { users: Record<number, number[]>; groups: Record<number, number[]> };
export type TemplateOption = { id: number; name: string; hidden: boolean };

const field =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

export function SpacesManager({
  initial,
  groups,
  users,
  templates = [],
  initialSpaceGroups,
  initialSubscriptionGroups,
  initialEditorGrants,
  initialEditorsEditAll,
  initialCategories,
}: {
  initial: SpaceRow[];
  groups: GroupOption[];
  users: EditorUserOption[];
  templates?: TemplateOption[];
  initialSpaceGroups: Record<number, number[]>;
  initialSubscriptionGroups: Record<number, number[]>;
  initialEditorGrants: EditorGrants;
  initialEditorsEditAll: boolean;
  initialCategories: Record<number, CategoryOption[]>;
}) {
  const router = useRouter();
  const [spaces, setSpaces] = useState<SpaceRow[]>(initial);
  const [spaceGroups, setSpaceGroups] = useState<Record<number, number[]>>(initialSpaceGroups);
  const [subGroups, setSubGroups] = useState<Record<number, number[]>>(initialSubscriptionGroups);
  const [editorGrants, setEditorGrants] = useState<EditorGrants>(initialEditorGrants);
  const [editAll, setEditAll] = useState(initialEditorsEditAll);
  const [togglingEditAll, setTogglingEditAll] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    const res = await fetch("/api/admin/spaces");
    if (res.ok) {
      const data = await res.json();
      setSpaces(data.spaces);
      setSpaceGroups(data.spaceGroups ?? {});
      setSubGroups(data.subscriptionGroups ?? {});
      setEditorGrants(data.editorGrants ?? { users: {}, groups: {} });
      setEditAll(Boolean(data.editorsEditAll));
    }
    router.refresh();
  }

  async function toggleEditAll(next: boolean) {
    setTogglingEditAll(true);
    setError("");
    const res = await fetch("/api/admin/spaces", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editorsEditAll: next }),
    });
    setTogglingEditAll(false);
    if (res.ok) setEditAll(next);
    else setError((await res.json().catch(() => ({}))).error || "Could not update the setting.");
  }

  async function remove(space: SpaceRow) {
    setError("");
    if (!confirm(`Delete the space “${space.name}”? This can't be undone.`)) return;
    const res = await fetch(`/api/admin/spaces/${space.id}`, { method: "DELETE" });
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error || "Could not delete the space.");
      return;
    }
    await refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Spaces</h2>
          <p className="mt-1 text-sm text-slate-500">
            Spaces group related documents — one per team, product, or topic. Public spaces are
            visible to everyone who signs in; private spaces only to admins and the groups you
            grant.
          </p>
        </div>
        {!creating && editing === null && (
          <button
            onClick={() => setCreating(true)}
            className="shrink-0 rounded-lg bg-compass-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-compass-700"
          >
            ＋ New space
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Org-level edit-rights switch */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={editAll}
            disabled={togglingEditAll}
            onChange={(e) => toggleEditAll(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-compass-600"
          />
          <span>
            <span className="font-medium text-slate-800">
              All editors can edit all spaces
            </span>
            <span className="mt-0.5 block text-xs text-slate-500">
              On (default): anyone with the editor role can author in every space they can
              see, and per-space editor lists below are ignored. Off: each space&apos;s
              &ldquo;Who can edit&rdquo; list applies — a space with no list stays open to
              all editors. Admins can always edit everything.
            </span>
          </span>
        </label>
      </div>

      {creating && (
        <SpaceForm
          groups={groups}
          users={users}
          templates={templates}
          grantedIds={[]}
          subscribedGroupIds={[]}
          editorUserIds={[]}
          editorGroupIds={[]}
          initialCategories={[]}
          editAllActive={editAll}
          onCancel={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      )}

      <div className="space-y-2">
        {spaces.map((s) =>
          editing === s.id ? (
            <SpaceForm
              key={s.id}
              space={s}
              groups={groups}
              users={users}
              templates={templates}
              grantedIds={spaceGroups[s.id] ?? []}
              subscribedGroupIds={subGroups[s.id] ?? []}
              editorUserIds={editorGrants.users[s.id] ?? []}
              editorGroupIds={editorGrants.groups[s.id] ?? []}
              initialCategories={initialCategories[s.id] ?? []}
              editAllActive={editAll}
              onCancel={() => setEditing(null)}
              onSaved={async () => {
                setEditing(null);
                await refresh();
              }}
            />
          ) : (
            <div
              key={s.id}
              className="flex items-center gap-3 rounded-xl border border-slate-200 bg-surface p-3 shadow-sm"
            >
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-lg"
                style={{ backgroundColor: `${s.color}22` }}
              >
                {s.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-slate-900">{s.name}</span>
                  <span className="rounded-full bg-slate-100 px-1.5 text-xs text-slate-500">
                    {s.doc_count} doc{s.doc_count === 1 ? "" : "s"}
                  </span>
                  {s.visibility === "private" && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700">
                      <Lock className="h-3 w-3" />
                      Private
                      {(spaceGroups[s.id]?.length ?? 0) > 0 && (
                        <span className="text-amber-600/80">
                          · {spaceGroups[s.id].length} group
                          {spaceGroups[s.id].length === 1 ? "" : "s"}
                        </span>
                      )}
                    </span>
                  )}
                  {s.visibility === "public" && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700">
                      <Globe className="h-3 w-3" />
                      Public — no sign-in
                    </span>
                  )}
                  {!editAll &&
                    ((editorGrants.users[s.id]?.length ?? 0) > 0 ||
                      (editorGrants.groups[s.id]?.length ?? 0) > 0) && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-1.5 py-0.5 text-xs font-medium text-violet-700">
                        <PencilRuler className="h-3 w-3" />
                        Restricted editing
                      </span>
                    )}
                </div>
                {s.description && (
                  <p className="truncate text-xs text-slate-500">{s.description}</p>
                )}
              </div>
              <button
                onClick={() => setEditing(s.id)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Edit
              </button>
              <button
                onClick={() => remove(s)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
              >
                Delete
              </button>
            </div>
          )
        )}
        {spaces.length === 0 && !creating && (
          <p className="rounded-lg border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
            No spaces yet. Create your first one to start organizing documents.
          </p>
        )}
      </div>
    </div>
  );
}

function SpaceForm({
  space,
  groups,
  users,
  templates,
  grantedIds,
  subscribedGroupIds,
  editorUserIds,
  editorGroupIds,
  initialCategories,
  editAllActive,
  onCancel,
  onSaved,
}: {
  space?: SpaceRow;
  groups: GroupOption[];
  users: EditorUserOption[];
  templates: TemplateOption[];
  grantedIds: number[];
  subscribedGroupIds: number[];
  editorUserIds: number[];
  editorGroupIds: number[];
  initialCategories: CategoryOption[];
  /** True while the org-wide "all editors edit all spaces" switch is on. */
  editAllActive: boolean;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(space?.name ?? "");
  const [description, setDescription] = useState(space?.description ?? "");
  const [icon, setIcon] = useState(space?.icon ?? "📁");
  const [color, setColor] = useState(space?.color ?? "#2e75bd");
  const [visibility, setVisibility] = useState<"public" | "internal" | "private">(
    space?.visibility ?? "internal"
  );
  const [groupIds, setGroupIds] = useState<number[]>(grantedIds);
  const [subGroupIds, setSubGroupIds] = useState<number[]>(subscribedGroupIds);
  const [edUserIds, setEdUserIds] = useState<number[]>(editorUserIds);
  const [edGroupIds, setEdGroupIds] = useState<number[]>(editorGroupIds);
  const [restrictEditing, setRestrictEditing] = useState(
    editorUserIds.length > 0 || editorGroupIds.length > 0
  );
  const [defaultTemplateId, setDefaultTemplateId] = useState<number | null>(
    space?.default_template_id ?? null
  );
  const [defaultView, setDefaultView] = useState<string>(space?.default_view ?? "cards");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");


  async function save() {
    if (name.trim().length < 2) {
      setError("Give the space a name (at least 2 characters).");
      return;
    }
    if (visibility === "public" && space?.visibility !== "public") {
      const ok = confirm(
        "Make this space PUBLIC? Its published documents will be readable by anyone " +
          "on the internet, without signing in (once the public site is enabled in " +
          "Settings \u2192 Public site)."
      );
      if (!ok) return;
    }
    setSaving(true);
    setError("");
    const res = await fetch(space ? `/api/admin/spaces/${space.id}` : "/api/admin/spaces", {
      method: space ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        description,
        icon,
        color,
        visibility,
        groupIds: visibility === "private" ? groupIds : [],
        subscriptionGroupIds: subGroupIds,
        editorUserIds: restrictEditing ? edUserIds : [],
        editorGroupIds: restrictEditing ? edGroupIds : [],
        default_template_id: defaultTemplateId,
        default_view: defaultView,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error || "Could not save the space.");
      return;
    }
    onSaved();
  }

  return (
    <div className="rounded-xl border border-compass-200 bg-compass-50/40 p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={field}
            placeholder="Engineering"
            maxLength={60}
            autoFocus
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            Description <span className="text-slate-400">(optional)</span>
          </span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={field}
            placeholder="Runbooks, architecture, and on-call docs"
            maxLength={280}
          />
        </label>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto]">
        <div>
          <span className="mb-1 block text-xs font-medium text-slate-500">Icon</span>
          <SpaceIconPicker value={icon} onChange={setIcon} />
        </div>
        <div>
          <span className="mb-1 block text-xs font-medium text-slate-500">Color</span>
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-9 w-16 cursor-pointer rounded-md border border-slate-200"
          />
        </div>
      </div>

      <div className="mt-4">
        <span className="mb-1 block text-xs font-medium text-slate-500">Who can see it</span>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setVisibility("internal")}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium ${
              visibility === "internal"
                ? "border-compass-400 bg-compass-50 text-compass-700"
                : "border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
          >
            <Building2 className="h-3.5 w-3.5" />
            Internal — everyone signed in
          </button>
          <button
            type="button"
            onClick={() => setVisibility("private")}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium ${
              visibility === "private"
                ? "border-amber-400 bg-amber-50 text-amber-700"
                : "border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
          >
            <Lock className="h-3.5 w-3.5" />
            Private — selected groups only
          </button>
          <button
            type="button"
            onClick={() => setVisibility("public")}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium ${
              visibility === "public"
                ? "border-emerald-400 bg-emerald-50 text-emerald-700"
                : "border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
          >
            <Globe className="h-3.5 w-3.5" />
            Public — anyone, no sign-in
          </button>
        </div>

        {visibility === "public" && (
          <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/50 p-3">
            <p className="text-xs text-emerald-800">
              Published documents in this space will be readable by <strong>anyone on the
              internet</strong> — no account needed — at{" "}
              <code className="rounded bg-white/70 px-1">/public</code>. Drafts stay hidden.
              The public site itself is switched on under{" "}
              <a href="/admin/public-site" className="font-medium underline">
                Settings → Public site
              </a>
              .
            </p>
          </div>
        )}

        {visibility === "private" && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/50 p-3">
            <p className="mb-2 text-xs text-amber-800">
              Admins always have access. Grant one or more groups to give their members access:
            </p>
            {groups.length === 0 ? (
              <p className="text-sm text-slate-500">
                No groups yet — create one under{" "}
                <a href="/admin/groups" className="font-medium text-compass-700 underline">
                  Settings → Groups
                </a>
                . Until a group is granted, only admins can see this space.
              </p>
            ) : (
              <EntityPicker
                options={groups.map((g) => ({
                  id: g.id,
                  label: g.name,
                  sublabel: `${g.member_count} member${g.member_count === 1 ? "" : "s"}${g.source === "entra" ? " · synced" : ""}`,
                }))}
                value={groupIds}
                onChange={setGroupIds}
                placeholder="Search groups…"
              />
            )}
          </div>
        )}
      </div>

      <div className="mt-4">
        <span className="mb-1 block text-xs font-medium text-slate-500">Who can edit</span>
        {editAllActive && (
          <p className="mb-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
            The org-wide <strong>&ldquo;All editors can edit all spaces&rdquo;</strong> switch
            (top of this page) is on, so this list is saved but not enforced until you turn
            that switch off.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setRestrictEditing(false)}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
              !restrictEditing
                ? "border-compass-400 bg-compass-50 text-compass-700"
                : "border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
          >
            All editors
          </button>
          <button
            type="button"
            onClick={() => setRestrictEditing(true)}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
              restrictEditing
                ? "border-violet-400 bg-violet-50 text-violet-700"
                : "border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
          >
            Only selected people or groups
          </button>
        </div>
        {restrictEditing && (
          <div className="mt-3 space-y-3 rounded-lg border border-violet-200 bg-violet-50/40 p-3">
            <p className="text-xs text-violet-900/80">
              Only the people and group members below can create, edit, move, or trash
              documents in this space (they also need the editor role). Everyone with view
              access can still read and suggest. Admins always have edit access.
            </p>
            <div>
              <span className="mb-1 block text-xs font-medium text-slate-500">People</span>
              {users.length === 0 ? (
                <p className="text-sm text-slate-400">No editor or approver accounts yet.</p>
              ) : (
                <EntityPicker
                  options={users.map((u) => ({ id: u.id, label: u.name, sublabel: u.role }))}
                  value={edUserIds}
                  onChange={setEdUserIds}
                  placeholder="Search people…"
                  accent="violet"
                />
              )}
            </div>
            <div>
              <span className="mb-1 block text-xs font-medium text-slate-500">Groups</span>
              {groups.length === 0 ? (
                <p className="text-sm text-slate-400">
                  No groups yet — create one under{" "}
                  <a href="/admin/groups" className="font-medium text-compass-700 underline">
                    Settings → Groups
                  </a>
                  .
                </p>
              ) : (
                <EntityPicker
                  options={groups.map((g) => ({
                  id: g.id,
                  label: g.name,
                  sublabel: `${g.member_count} member${g.member_count === 1 ? "" : "s"}${g.source === "entra" ? " · synced" : ""}`,
                }))}
                  value={edGroupIds}
                  onChange={setEdGroupIds}
                  placeholder="Search groups…"
                  accent="violet"
                />
              )}
            </div>
            {edUserIds.length === 0 && edGroupIds.length === 0 && (
              <p className="text-xs text-amber-700">
                Nothing selected yet — saving like this leaves the space open to all editors.
              </p>
            )}
          </div>
        )}
      </div>

      {space && (
        <div className="mt-4">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            Categories <span className="text-slate-400">(optional)</span>
          </span>
          <p className="mb-2 text-xs text-slate-400">
            Group this space&apos;s documents into sections. Writers pick a category in the
            editor; documents without one appear under &ldquo;General&rdquo;.
          </p>
          <CategoryEditor spaceId={space.id} initial={initialCategories} />
        </div>
      )}

      {templates.length > 0 && (
        <div className="mt-4">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            Default template <span className="text-slate-400">(optional)</span>
          </span>
          <p className="mb-2 text-xs text-slate-400">
            Pre-fills new documents created from this space. Writers can still switch to
            another template or a blank page. Manage templates under{" "}
            <a href="/admin/templates" className="font-medium text-compass-700 underline">
              Settings → Templates
            </a>
            .
          </p>
          <select
            value={defaultTemplateId ?? ""}
            onChange={(e) => setDefaultTemplateId(e.target.value ? Number(e.target.value) : null)}
            className="w-64 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400"
          >
            <option value="">None — start blank</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.hidden ? " (hidden)" : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="mt-4">
        <span className="mb-1 block text-sm font-medium text-slate-700">Default view</span>
        <p className="mb-2 text-xs text-slate-400">
          The layout this space opens with. Visitors can switch views any time and their
          choice is remembered on their browser.
        </p>
        <select
          value={defaultView}
          onChange={(e) => setDefaultView(e.target.value)}
          className="w-64 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400"
        >
          <option value="cards">Cards (default)</option>
          <option value="table">Table</option>
          <option value="tree">Tree &mdash; needs nested pages enabled</option>
          <option value="board">Board</option>
          <option value="timeline">Timeline</option>
          <option value="tags">By tag</option>
        </select>
      </div>

      <div className="mt-4">
        <span className="mb-1 block text-xs font-medium text-slate-500">
          Email subscriptions <span className="text-slate-400">(optional)</span>
        </span>
        <p className="mb-2 text-xs text-slate-400">
          Members of these groups are subscribed automatically — they get an email when a
          document here is published or updated (each person can mute it).
        </p>
        {groups.length === 0 ? (
          <p className="text-sm text-slate-400">
            No groups yet — create one under <a href="/admin/groups" className="font-medium text-compass-700 underline">Settings → Groups</a>.
          </p>
        ) : (
          <EntityPicker
            options={groups.map((g) => ({
              id: g.id,
              label: g.name,
              sublabel: `${g.member_count} member${g.member_count === 1 ? "" : "s"}`,
            }))}
            value={subGroupIds}
            onChange={setSubGroupIds}
            placeholder="Search groups…"
          />
        )}
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-compass-700 disabled:opacity-60"
        >
          {saving ? "Saving…" : space ? "Save changes" : "Create space"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}


/** Inline category manager for one space; changes apply immediately. */
function CategoryEditor({ spaceId, initial }: { spaceId: number; initial: CategoryOption[] }) {
  const [cats, setCats] = useState<CategoryOption[]>(initial);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function reload() {
    const res = await fetch(`/api/admin/spaces/${spaceId}/categories`);
    if (res.ok) setCats((await res.json()).categories);
  }

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    await fetch(`/api/admin/spaces/${spaceId}/categories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setName("");
    await reload();
    setBusy(false);
  }

  async function rename(c: CategoryOption) {
    const next = prompt("Rename category", c.name)?.trim();
    if (!next || next === c.name) return;
    await fetch(`/api/admin/spaces/${spaceId}/categories/${c.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: next }),
    });
    await reload();
  }

  async function move(c: CategoryOption, dir: -1 | 1) {
    const idx = cats.findIndex((x) => x.id === c.id);
    const other = cats[idx + dir];
    if (!other) return;
    setBusy(true);
    await Promise.all([
      fetch(`/api/admin/spaces/${spaceId}/categories/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: other.position }),
      }),
      fetch(`/api/admin/spaces/${spaceId}/categories/${other.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: c.position }),
      }),
    ]);
    await reload();
    setBusy(false);
  }

  async function remove(c: CategoryOption) {
    if (!confirm(`Delete the "${c.name}" category? Its documents move to General.`)) return;
    await fetch(`/api/admin/spaces/${spaceId}/categories/${c.id}`, { method: "DELETE" });
    await reload();
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-surface p-3">
      <ul className="mb-2 space-y-1">
        {cats.map((c, i) => (
          <li key={c.id} className="flex items-center gap-1.5 text-sm">
            <span className="flex-1 text-slate-700">{c.name}</span>
            <button type="button" onClick={() => move(c, -1)} disabled={busy || i === 0} title="Move up" className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30">
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => move(c, 1)} disabled={busy || i === cats.length - 1} title="Move down" className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30">
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => rename(c)} disabled={busy} title="Rename" className="rounded p-1 text-slate-400 hover:bg-slate-100">
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => remove(c)} disabled={busy} title="Delete" className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
        {cats.length === 0 && <li className="text-sm text-slate-400">No categories yet.</li>}
      </ul>
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
          placeholder="New category name"
          className="w-56 rounded-lg border border-slate-200 px-3 py-1.5 text-sm outline-none focus:border-compass-400"
        />
        <button
          type="button"
          onClick={add}
          disabled={busy || !name.trim()}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </div>
  );
}
