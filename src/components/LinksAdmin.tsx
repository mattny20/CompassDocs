"use client";

// Admin manager for the Quick links launchpad: categories (rename/reorder/
// delete) and links (title, URL, description, category, icon source, and
// per-group visibility). Icon sources: auto-fetched site favicon, the
// workspace brand logo, or a custom uploaded image.

import { useRef, useState } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  ChevronUp,
  ChevronDown,
  RefreshCw,
  ExternalLink,
} from "lucide-react";

interface Category {
  id: number;
  name: string;
  position: number;
}

interface AdminLink {
  id: number;
  category_id: number | null;
  title: string;
  url: string;
  description: string;
  icon_type: "favicon" | "brand" | "custom";
  icon_file: string | null;
  icon_mime: string | null;
  position: number;
  group_ids: number[];
}

interface GroupLite {
  id: number;
  name: string;
}

const EMPTY_FORM = {
  title: "",
  url: "",
  description: "",
  category_id: null as number | null,
  icon_type: "favicon" as AdminLink["icon_type"],
  group_ids: [] as number[],
};

export function LinksAdmin({
  initialCategories,
  initialLinks,
  groups,
  brandLogo,
}: {
  initialCategories: Category[];
  initialLinks: AdminLink[];
  groups: GroupLite[];
  brandLogo: string;
}) {
  const [categories, setCategories] = useState(initialCategories);
  const [links, setLinks] = useState(initialLinks);
  const [newCategory, setNewCategory] = useState("");
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [iconBust, setIconBust] = useState(0); // cache-buster after refresh/upload
  const fileInput = useRef<HTMLInputElement>(null);

  async function reload() {
    const res = await fetch("/api/admin/links");
    if (res.ok) {
      const data = await res.json();
      setCategories(data.categories);
      setLinks(data.links);
    }
  }

  // --- categories ---------------------------------------------------------

  async function addCategory() {
    const name = newCategory.trim();
    if (!name) return;
    setBusy(true);
    setError("");
    const res = await fetch("/api/admin/link-categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setBusy(false);
    if (res.ok) {
      setNewCategory("");
      await reload();
    } else {
      setError((await res.json().catch(() => ({}))).error || "Could not add the category.");
    }
  }

  async function renameCategory(c: Category) {
    const name = prompt("Rename category", c.name)?.trim();
    if (!name || name === c.name) return;
    await fetch(`/api/admin/link-categories/${c.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    await reload();
  }

  async function moveCategory(c: Category, dir: -1 | 1) {
    const idx = categories.findIndex((x) => x.id === c.id);
    const other = categories[idx + dir];
    if (!other) return;
    await Promise.all([
      fetch(`/api/admin/link-categories/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: other.position }),
      }),
      fetch(`/api/admin/link-categories/${other.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: c.position }),
      }),
    ]);
    await reload();
  }

  async function deleteCategory(c: Category) {
    if (!confirm(`Delete "${c.name}"? Its links move to General.`)) return;
    await fetch(`/api/admin/link-categories/${c.id}`, { method: "DELETE" });
    await reload();
  }

  // --- links ---------------------------------------------------------------

  function startNew() {
    setForm(EMPTY_FORM);
    setIconFile(null);
    setEditing("new");
    setError("");
  }

  function startEdit(l: AdminLink) {
    setForm({
      title: l.title,
      url: l.url,
      description: l.description,
      category_id: l.category_id,
      icon_type: l.icon_type,
      group_ids: l.group_ids,
    });
    setIconFile(null);
    setEditing(l.id);
    setError("");
  }

  async function saveLink() {
    if (!form.title.trim() || !form.url.trim()) {
      setError("A title and URL are required.");
      return;
    }
    setBusy(true);
    setError("");
    const payload = {
      title: form.title,
      url: form.url,
      description: form.description,
      category_id: form.category_id,
      icon_type: form.icon_type,
      group_ids: form.group_ids,
    };
    const res =
      editing === "new"
        ? await fetch("/api/admin/links", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/admin/links/${editing}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
    if (!res.ok) {
      setBusy(false);
      setError((await res.json().catch(() => ({}))).error || "Could not save the link.");
      return;
    }
    // A custom icon uploads after the row exists (create needs the id first).
    if (form.icon_type === "custom" && iconFile) {
      const { link } = await res.json();
      const fd = new FormData();
      fd.append("file", iconFile);
      const up = await fetch(`/api/admin/links/${link.id}/icon`, { method: "POST", body: fd });
      if (!up.ok) {
        setError((await up.json().catch(() => ({}))).error || "The icon upload failed.");
      }
    }
    setBusy(false);
    setEditing(null);
    setIconBust(Date.now());
    await reload();
  }

  async function refreshIcon(l: AdminLink) {
    setBusy(true);
    await fetch(`/api/admin/links/${l.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_icon: true }),
    });
    setBusy(false);
    setIconBust(Date.now());
    await reload();
  }

  async function deleteLink(l: AdminLink) {
    if (!confirm(`Delete the "${l.title}" link?`)) return;
    await fetch(`/api/admin/links/${l.id}`, { method: "DELETE" });
    await reload();
  }

  const sections: { id: number | null; name: string; links: AdminLink[] }[] = [
    ...categories.map((c) => ({
      id: c.id as number | null,
      name: c.name,
      links: links.filter((l) => l.category_id === c.id),
    })),
    { id: null, name: "General", links: links.filter((l) => l.category_id === null) },
  ].filter((s) => s.links.length > 0 || s.id !== null);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Links</h1>
        <p className="mt-1 text-sm text-slate-500">
          Curate the shortcuts shown on the <a href="/links" className="text-compass-700 hover:underline">Links page</a> —
          your team&apos;s launchpad for external tools. Restrict any link to specific groups,
          organize with categories, and pick each link&apos;s icon.
        </p>
      </div>

      {error && !editing && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Categories */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <h2 className="mb-3 font-semibold text-slate-900">Categories</h2>
        <ul className="mb-3 space-y-1.5">
          {categories.map((c, i) => (
            <li key={c.id} className="flex items-center gap-2 text-sm">
              <span className="flex-1 font-medium text-slate-700">{c.name}</span>
              <span className="text-xs text-slate-400">
                {links.filter((l) => l.category_id === c.id).length} links
              </span>
              <button onClick={() => moveCategory(c, -1)} disabled={i === 0 || busy} title="Move up" className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30">
                <ChevronUp className="h-4 w-4" />
              </button>
              <button onClick={() => moveCategory(c, 1)} disabled={i === categories.length - 1 || busy} title="Move down" className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30">
                <ChevronDown className="h-4 w-4" />
              </button>
              <button onClick={() => renameCategory(c)} disabled={busy} title="Rename" className="rounded p-1 text-slate-400 hover:bg-slate-100">
                <Pencil className="h-4 w-4" />
              </button>
              <button onClick={() => deleteCategory(c)} disabled={busy} title="Delete" className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600">
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
          {categories.length === 0 && (
            <li className="text-sm text-slate-400">No categories yet — links appear under “General”.</li>
          )}
        </ul>
        <div className="flex gap-2">
          <input
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addCategory()}
            placeholder="New category name"
            className="w-64 rounded-lg border border-slate-200 px-3 py-1.5 text-sm focus:border-compass-400 focus:outline-none"
          />
          <button
            onClick={addCategory}
            disabled={busy || !newCategory.trim()}
            className="rounded-lg bg-compass-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>

      {/* Links */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold text-slate-900">Links</h2>
          <button
            onClick={startNew}
            className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-compass-700"
          >
            <Plus className="h-4 w-4" /> Add link
          </button>
        </div>

        {editing !== null && (
          <LinkForm
            form={form}
            setForm={setForm}
            categories={categories}
            groups={groups}
            brandLogo={brandLogo}
            iconFile={iconFile}
            setIconFile={setIconFile}
            fileInput={fileInput}
            editingLink={editing === "new" ? null : links.find((l) => l.id === editing) ?? null}
            iconBust={iconBust}
            busy={busy}
            error={error}
            onSave={saveLink}
            onCancel={() => setEditing(null)}
          />
        )}

        {sections.map((s) => (
          <div key={s.name} className="mb-4">
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
              {s.name}
            </h3>
            <ul className="divide-y divide-slate-100">
              {s.links.map((l) => (
                <li key={l.id} className="flex items-center gap-3 py-2 text-sm">
                  <IconPreview link={l} brandLogo={brandLogo} bust={iconBust} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 font-medium text-slate-800">
                      <span className="truncate">{l.title}</span>
                      <a href={l.url} target="_blank" rel="noopener noreferrer" title={l.url}>
                        <ExternalLink className="h-3.5 w-3.5 text-slate-300 hover:text-compass-500" />
                      </a>
                    </span>
                    <span className="block truncate text-xs text-slate-400">{l.url}</span>
                  </span>
                  <span className="hidden shrink-0 text-xs text-slate-400 sm:block">
                    {l.group_ids.length === 0
                      ? "Everyone"
                      : l.group_ids
                          .map((id) => groups.find((g) => g.id === id)?.name || "?")
                          .join(", ")}
                  </span>
                  {l.icon_type === "favicon" && (
                    <button onClick={() => refreshIcon(l)} disabled={busy} title="Re-fetch site icon" className="rounded p-1 text-slate-400 hover:bg-slate-100">
                      <RefreshCw className="h-4 w-4" />
                    </button>
                  )}
                  <button onClick={() => startEdit(l)} disabled={busy} title="Edit" className="rounded p-1 text-slate-400 hover:bg-slate-100">
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button onClick={() => deleteLink(l)} disabled={busy} title="Delete" className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
              {s.links.length === 0 && (
                <li className="py-2 text-sm text-slate-400">No links in this category.</li>
              )}
            </ul>
          </div>
        ))}
        {links.length === 0 && editing === null && (
          <p className="text-sm text-slate-400">
            No links yet — add your first shortcut (an HR portal, status page, ticketing
            system…).
          </p>
        )}
      </div>
    </div>
  );
}

function IconPreview({
  link,
  brandLogo,
  bust,
  size = "md",
}: {
  link: { id: number; title: string; icon_type: string; icon_file: string | null };
  brandLogo: string;
  bust: number;
  size?: "sm" | "md";
}) {
  const cls =
    (size === "sm" ? "h-8 w-8" : "h-10 w-10") +
    " shrink-0 rounded-lg object-contain bg-white ring-1 ring-slate-100";
  if (link.icon_file) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={`/api/links/icon/${link.id}?v=${bust}`} alt="" className={cls} />;
  }
  if (link.icon_type === "brand" && brandLogo) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={brandLogo} alt="" className={cls} />;
  }
  return (
    <span
      className={`${size === "sm" ? "h-8 w-8 text-sm" : "h-10 w-10 text-lg"} flex shrink-0 items-center justify-center rounded-lg bg-compass-100 font-bold text-compass-700`}
    >
      {(link.title.trim()[0] || "?").toUpperCase()}
    </span>
  );
}

function LinkForm({
  form,
  setForm,
  categories,
  groups,
  brandLogo,
  iconFile,
  setIconFile,
  fileInput,
  editingLink,
  iconBust,
  busy,
  error,
  onSave,
  onCancel,
}: {
  form: typeof EMPTY_FORM;
  setForm: (f: typeof EMPTY_FORM) => void;
  categories: Category[];
  groups: GroupLite[];
  brandLogo: string;
  iconFile: File | null;
  setIconFile: (f: File | null) => void;
  fileInput: React.RefObject<HTMLInputElement | null>;
  editingLink: AdminLink | null;
  iconBust: number;
  busy: boolean;
  error: string;
  onSave: () => void;
  onCancel: () => void;
}) {
  const input =
    "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-compass-400 focus:outline-none";
  return (
    <div className="mb-4 rounded-xl border border-compass-200 bg-compass-50/40 p-4">
      <h3 className="mb-3 font-semibold text-slate-900">
        {editingLink ? `Edit “${editingLink.title}”` : "New link"}
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block font-medium text-slate-600">Title</span>
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Duo Central" className={input} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-slate-600">URL</span>
          <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://…" className={input} />
        </label>
        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block font-medium text-slate-600">Description (optional)</span>
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Shown under the title on the Links page" className={input} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-slate-600">Category</span>
          <select
            value={form.category_id ?? ""}
            onChange={(e) => setForm({ ...form, category_id: e.target.value ? Number(e.target.value) : null })}
            className={input}
          >
            <option value="">General</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
      </div>

      {/* Icon source */}
      <fieldset className="mt-3 text-sm">
        <legend className="mb-1 font-medium text-slate-600">Icon</legend>
        <div className="flex flex-wrap items-center gap-4">
          {(
            [
              ["favicon", "Site icon (fetched automatically)"],
              ["brand", "Workspace logo"],
              ["custom", "Upload an image"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex cursor-pointer items-center gap-1.5">
              <input
                type="radio"
                name="icon_type"
                checked={form.icon_type === value}
                onChange={() => setForm({ ...form, icon_type: value })}
                className="accent-compass-600"
              />
              {label}
            </label>
          ))}
        </div>
        {form.icon_type === "brand" && !brandLogo && (
          <p className="mt-1 text-xs text-amber-600">
            No workspace logo is set (Settings → Workspace) — the link will show a letter tile.
          </p>
        )}
        {form.icon_type === "custom" && (
          <div className="mt-2 flex items-center gap-3">
            {editingLink && (
              <IconPreview link={editingLink} brandLogo={brandLogo} bust={iconBust} size="sm" />
            )}
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/x-icon,image/vnd.microsoft.icon"
              onChange={(e) => setIconFile(e.target.files?.[0] ?? null)}
              className="text-xs"
            />
            {iconFile && <span className="text-xs text-slate-500">{iconFile.name}</span>}
          </div>
        )}
      </fieldset>

      {/* Visibility */}
      <fieldset className="mt-3 text-sm">
        <legend className="mb-1 font-medium text-slate-600">Who can see it</legend>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="radio"
            name="link_vis"
            checked={form.group_ids.length === 0}
            onChange={() => setForm({ ...form, group_ids: [] })}
            className="accent-compass-600"
          />
          Everyone
        </label>
        <label className="mt-1 flex cursor-pointer items-center gap-1.5">
          <input
            type="radio"
            name="link_vis"
            checked={form.group_ids.length > 0}
            onChange={() => groups.length && setForm({ ...form, group_ids: [groups[0].id] })}
            disabled={groups.length === 0}
            className="accent-compass-600"
          />
          Only these groups{groups.length === 0 && " (no groups exist yet)"}
        </label>
        {form.group_ids.length > 0 && (
          <div className="ml-6 mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            {groups.map((g) => (
              <label key={g.id} className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={form.group_ids.includes(g.id)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      group_ids: e.target.checked
                        ? [...form.group_ids, g.id]
                        : form.group_ids.filter((id) => id !== g.id),
                    })
                  }
                  className="accent-compass-600"
                />
                {g.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <div className="mt-4 flex gap-2">
        <button
          onClick={onSave}
          disabled={busy}
          className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60"
        >
          {busy ? "Saving…" : editingLink ? "Save changes" : "Add link"}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
