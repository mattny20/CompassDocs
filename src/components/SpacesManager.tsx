"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Globe, Building2 } from "lucide-react";
import { SpaceIconPicker } from "./SpaceIconPicker";
import type { Space } from "@/lib/types";

type SpaceRow = Space & { doc_count: number };
export type GroupOption = { id: number; name: string; source: string; member_count: number };

const field =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

export function SpacesManager({
  initial,
  groups,
  initialSpaceGroups,
  initialSubscriptionGroups,
}: {
  initial: SpaceRow[];
  groups: GroupOption[];
  initialSpaceGroups: Record<number, number[]>;
  initialSubscriptionGroups: Record<number, number[]>;
}) {
  const router = useRouter();
  const [spaces, setSpaces] = useState<SpaceRow[]>(initial);
  const [spaceGroups, setSpaceGroups] = useState<Record<number, number[]>>(initialSpaceGroups);
  const [subGroups, setSubGroups] = useState<Record<number, number[]>>(initialSubscriptionGroups);
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
    }
    router.refresh();
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

      {creating && (
        <SpaceForm
          groups={groups}
          grantedIds={[]}
          subscribedGroupIds={[]}
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
              grantedIds={spaceGroups[s.id] ?? []}
              subscribedGroupIds={subGroups[s.id] ?? []}
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
  grantedIds,
  subscribedGroupIds,
  onCancel,
  onSaved,
}: {
  space?: SpaceRow;
  groups: GroupOption[];
  grantedIds: number[];
  subscribedGroupIds: number[];
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function toggleGroup(id: number) {
    setGroupIds((prev) => (prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]));
  }

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
              <div className="flex flex-wrap gap-2">
                {groups.map((g) => (
                  <label
                    key={g.id}
                    className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm ${
                      groupIds.includes(g.id)
                        ? "border-compass-400 bg-white text-compass-800 shadow-sm"
                        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={groupIds.includes(g.id)}
                      onChange={() => toggleGroup(g.id)}
                      className="h-3.5 w-3.5 accent-compass-600"
                    />
                    {g.name}
                    <span className="text-xs text-slate-400">
                      {g.member_count} member{g.member_count === 1 ? "" : "s"}
                      {g.source === "entra" ? " · synced" : ""}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
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
          <div className="flex flex-wrap gap-2">
            {groups.map((g) => (
              <label
                key={g.id}
                className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm ${
                  subGroupIds.includes(g.id)
                    ? "border-compass-400 bg-compass-50 text-compass-800"
                    : "border-slate-200 bg-surface text-slate-600 hover:bg-slate-50"
                }`}
              >
                <input
                  type="checkbox"
                  checked={subGroupIds.includes(g.id)}
                  onChange={() =>
                    setSubGroupIds((prev) =>
                      prev.includes(g.id) ? prev.filter((x) => x !== g.id) : [...prev, g.id]
                    )
                  }
                  className="h-3.5 w-3.5 accent-compass-600"
                />
                {g.name}
                <span className="text-xs text-slate-400">
                  {g.member_count} member{g.member_count === 1 ? "" : "s"}
                </span>
              </label>
            ))}
          </div>
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
