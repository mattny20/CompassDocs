"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Space } from "@/lib/types";

type SpaceRow = Space & { doc_count: number };

const field =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

// A small palette of friendly emoji so non-technical users can pick an icon
// without hunting for one; they can still type any emoji.
const ICON_CHOICES = ["📁", "📘", "🧭", "🔧", "🛡️", "🚀", "💡", "📊", "🧩", "🗂️", "⚙️", "📝"];

export function SpacesManager({ initial }: { initial: SpaceRow[] }) {
  const router = useRouter();
  const [spaces, setSpaces] = useState<SpaceRow[]>(initial);
  const [editing, setEditing] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    const res = await fetch("/api/admin/spaces");
    if (res.ok) setSpaces((await res.json()).spaces);
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
            Spaces group related documents — one per team, product, or topic. They appear in the
            sidebar and organize search and browsing.
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
  onCancel,
  onSaved,
}: {
  space?: SpaceRow;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(space?.name ?? "");
  const [description, setDescription] = useState(space?.description ?? "");
  const [icon, setIcon] = useState(space?.icon ?? "📁");
  const [color, setColor] = useState(space?.color ?? "#2e75bd");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    if (name.trim().length < 2) {
      setError("Give the space a name (at least 2 characters).");
      return;
    }
    setSaving(true);
    setError("");
    const res = await fetch(space ? `/api/admin/spaces/${space.id}` : "/api/admin/spaces", {
      method: space ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), description, icon, color }),
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

      <div className="mt-4 flex flex-wrap items-end gap-6">
        <div>
          <span className="mb-1 block text-xs font-medium text-slate-500">Icon</span>
          <div className="flex flex-wrap items-center gap-1">
            {ICON_CHOICES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setIcon(c)}
                className={`flex h-8 w-8 items-center justify-center rounded-md text-lg ${
                  icon === c ? "bg-compass-100 ring-2 ring-compass-400" : "hover:bg-slate-100"
                }`}
              >
                {c}
              </button>
            ))}
            <input
              value={icon}
              onChange={(e) => setIcon(e.target.value.slice(0, 8))}
              className="h-8 w-14 rounded-md border border-slate-200 px-2 text-center text-lg outline-none focus:border-compass-400"
              aria-label="Custom emoji"
            />
          </div>
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
