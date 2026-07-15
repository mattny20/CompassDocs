"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { LayoutGrid, List as ListIcon, Building2, Phone, Smartphone, MapPin } from "lucide-react";
import type { DirectoryPerson, DirectoryField } from "@/lib/directory";

const field =
  "rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

type View = "cards" | "list" | "departments";
const VIEWS: { id: View; label: string; icon: React.ReactNode }[] = [
  { id: "cards", label: "Cards", icon: <LayoutGrid className="h-4 w-4" /> },
  { id: "list", label: "List", icon: <ListIcon className="h-4 w-4" /> },
  { id: "departments", label: "Departments", icon: <Building2 className="h-4 w-4" /> },
];

// Built-in list columns. Custom fields are appended as `custom:<key>`.
const BASE_COLUMNS: { id: string; label: string; get: (p: DirectoryPerson) => string }[] = [
  { id: "name", label: "Name", get: (p) => p.name },
  { id: "title", label: "Title", get: (p) => p.title },
  { id: "department", label: "Department", get: (p) => p.department },
  { id: "email", label: "Email", get: (p) => p.email },
  { id: "phone", label: "Phone", get: (p) => p.phone },
  { id: "mobile", label: "Mobile", get: (p) => p.mobile },
  { id: "office", label: "Office", get: (p) => p.office },
  { id: "assistant", label: "Assistant", get: (p) => p.assistant_name ?? "" },
];
const DEFAULT_COLS = ["name", "title", "department", "email", "phone"];

const LS_VIEW = "compass_dir_view";
const LS_COLS = "compass_dir_cols";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

function Avatar({ p, size = 12 }: { p: DirectoryPerson; size?: 10 | 12 }) {
  const cls = size === 12 ? "h-12 w-12" : "h-10 w-10";
  return p.photo ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={p.photo} alt="" className={`${cls} flex-none rounded-full object-cover`} />
  ) : (
    <div
      className={`${cls} flex flex-none items-center justify-center rounded-full bg-compass-100 font-semibold text-compass-700`}
    >
      {initials(p.name)}
    </div>
  );
}

export function DirectoryClient({
  initialPeople,
  departments,
  fields,
}: {
  initialPeople: DirectoryPerson[];
  departments: string[];
  fields: DirectoryField[];
}) {
  const [q, setQ] = useState("");
  const [dept, setDept] = useState("");
  const [view, setView] = useState<View>("cards");
  const [cols, setCols] = useState<string[]>(DEFAULT_COLS);
  const [colsOpen, setColsOpen] = useState(false);
  const [sortBy, setSortBy] = useState("name");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  // Restore per-user view + column preferences.
  useEffect(() => {
    try {
      const v = localStorage.getItem(LS_VIEW) as View | null;
      if (v && VIEWS.some((x) => x.id === v)) setView(v);
      const c = JSON.parse(localStorage.getItem(LS_COLS) || "null");
      if (Array.isArray(c) && c.length) setCols(c);
    } catch {
      /* first visit */
    }
  }, []);
  function saveView(v: View) {
    setView(v);
    try {
      localStorage.setItem(LS_VIEW, v);
    } catch {}
  }
  function saveCols(next: string[]) {
    setCols(next);
    try {
      localStorage.setItem(LS_COLS, JSON.stringify(next));
    } catch {}
  }

  const allColumns = useMemo(
    () => [
      ...BASE_COLUMNS,
      ...fields.map((f) => ({
        id: `custom:${f.key}`,
        label: f.label,
        get: (p: DirectoryPerson) => p.custom?.[f.key] ?? "",
      })),
    ],
    [fields]
  );
  const activeColumns = useMemo(
    () => allColumns.filter((c) => cols.includes(c.id)),
    [allColumns, cols]
  );
  const cardFields = useMemo(() => fields.filter((f) => f.show_in_card), [fields]);

  const people = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = initialPeople.filter((p) => {
      if (dept && p.department !== dept) return false;
      if (!needle) return true;
      return [
        p.name, p.title, p.department, p.email, p.phone, p.mobile, p.office,
        p.assistant_name ?? "",
        ...Object.values(p.custom ?? {}),
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
    const col = allColumns.find((c) => c.id === sortBy) ?? allColumns[0];
    return [...filtered].sort(
      (a, b) => col.get(a).localeCompare(col.get(b), undefined, { sensitivity: "base" }) * sortDir
    );
  }, [initialPeople, q, dept, sortBy, sortDir, allColumns]);

  function clickSort(id: string) {
    if (sortBy === id) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortBy(id);
      setSortDir(1);
    }
  }

  const byDepartment = useMemo(() => {
    const groups = new Map<string, DirectoryPerson[]>();
    for (const p of people) {
      const key = p.department || "No department";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(p);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [people]);

  return (
    <div>
      {/* Toolbar */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search people…"
          className={`${field} w-64`}
          autoFocus
        />
        {departments.length > 0 && (
          <select value={dept} onChange={(e) => setDept(e.target.value)} className={field}>
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        )}

        <div className="flex overflow-hidden rounded-lg border border-slate-200">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              onClick={() => saveView(v.id)}
              className={`px-3 py-2 text-sm font-medium ${
                view === v.id ? "bg-compass-600 text-white" : "bg-surface text-slate-600 hover:bg-slate-50"
              }`}
              title={v.label}
            >
              <span className="inline-flex items-center gap-1.5">
                {v.icon}
                <span className="hidden sm:inline">{v.label}</span>
              </span>
            </button>
          ))}
        </div>

        {view === "list" && (
          <div className="relative">
            <button
              onClick={() => setColsOpen((o) => !o)}
              className="rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Columns ▾
            </button>
            {colsOpen && (
              <div className="absolute z-20 mt-1 w-56 rounded-lg border border-slate-200 bg-surface p-2 shadow-lg">
                {allColumns.map((c) => (
                  <label
                    key={c.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                  >
                    <input
                      type="checkbox"
                      checked={cols.includes(c.id)}
                      onChange={(e) =>
                        saveCols(
                          e.target.checked
                            ? [...cols, c.id]
                            : cols.length > 1
                              ? cols.filter((x) => x !== c.id)
                              : cols
                        )
                      }
                    />
                    {c.label}
                  </label>
                ))}
                <button
                  className="mt-1 w-full rounded px-2 py-1.5 text-left text-xs font-medium text-compass-600 hover:bg-slate-50"
                  onClick={() => saveCols(DEFAULT_COLS)}
                >
                  Reset to defaults
                </button>
              </div>
            )}
          </div>
        )}

        <span className="ml-auto text-sm text-slate-400">
          {people.length} {people.length === 1 ? "person" : "people"}
        </span>
      </div>

      {people.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 p-10 text-center text-slate-400">
          {initialPeople.length === 0
            ? "The directory is empty. Admins can add people (or connect Microsoft 365) under Settings → Directory."
            : "No one matches your search."}
        </div>
      ) : view === "list" ? (
        /* ------------------------------ LIST ------------------------------ */
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-surface shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                {activeColumns.map((c) => (
                  <th
                    key={c.id}
                    className="cursor-pointer select-none px-4 py-2.5 hover:text-slate-600"
                    onClick={() => clickSort(c.id)}
                  >
                    {c.label}
                    {sortBy === c.id ? (sortDir === 1 ? " ↑" : " ↓") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id} className="border-b border-slate-50 hover:bg-slate-50/60">
                  {activeColumns.map((c) => (
                    <td key={c.id} className="px-4 py-2.5">
                      {c.id === "name" ? (
                        <Link
                          href={`/directory/${p.id}`}
                          className="flex items-center gap-2 font-medium text-slate-900 hover:text-compass-700"
                        >
                          <Avatar p={p} size={10} />
                          {p.name}
                        </Link>
                      ) : c.id === "email" && p.email ? (
                        <a href={`mailto:${p.email}`} className="text-compass-600 hover:underline">
                          {p.email}
                        </a>
                      ) : (c.id === "phone" || c.id === "mobile") && c.get(p) ? (
                        <a href={`tel:${c.get(p)}`} className="text-slate-600 hover:underline">
                          {c.get(p)}
                        </a>
                      ) : (
                        <span className="text-slate-600">{c.get(p)}</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : view === "departments" ? (
        /* --------------------------- DEPARTMENTS -------------------------- */
        <div className="space-y-6">
          {byDepartment.map(([deptName, members]) => (
            <div key={deptName}>
              <h2 className="mb-2 flex items-baseline gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
                {deptName}
                <span className="text-xs font-normal text-slate-400">({members.length})</span>
              </h2>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {members.map((p) => (
                  <Link
                    key={p.id}
                    href={`/directory/${p.id}`}
                    className="flex items-center gap-3 rounded-lg border border-slate-200 bg-surface px-3 py-2 hover:border-compass-300"
                  >
                    <Avatar p={p} size={10} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-900">{p.name}</p>
                      <p className="truncate text-xs text-slate-500">
                        {p.title}
                        {p.title && (p.phone || p.mobile) ? " · " : ""}
                        {p.phone || p.mobile}
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* ------------------------------ CARDS ------------------------------ */
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {people.map((p) => (
            <div key={p.id} className="flex gap-3 rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
              <Avatar p={p} />
              <div className="min-w-0">
                <Link
                  href={`/directory/${p.id}`}
                  className="block truncate font-semibold text-slate-900 hover:text-compass-700"
                >
                  {p.name}
                </Link>
                {(p.title || p.department) && (
                  <p className="truncate text-sm text-slate-500">
                    {p.title}
                    {p.title && p.department ? " · " : ""}
                    {p.department}
                  </p>
                )}
                <div className="mt-1 space-y-0.5 text-sm">
                  {p.email && (
                    <a href={`mailto:${p.email}`} className="block truncate text-compass-600 hover:underline">
                      {p.email}
                    </a>
                  )}
                  {p.phone && (
                    <a href={`tel:${p.phone}`} className="flex items-center gap-1.5 text-slate-600 hover:underline">
                      <Phone className="h-3.5 w-3.5 text-slate-400" /> {p.phone}
                    </a>
                  )}
                  {p.mobile && (
                    <a href={`tel:${p.mobile}`} className="flex items-center gap-1.5 text-slate-600 hover:underline">
                      <Smartphone className="h-3.5 w-3.5 text-slate-400" /> {p.mobile}
                    </a>
                  )}
                  {p.office && (
                    <p className="flex items-center gap-1.5 text-slate-400">
                      <MapPin className="h-3.5 w-3.5" /> {p.office}
                    </p>
                  )}
                  {p.assistant_name && (
                    <p className="text-slate-500">
                      <span className="text-slate-400">Assistant:</span> {p.assistant_name}
                    </p>
                  )}
                  {cardFields.map((f) =>
                    p.custom?.[f.key] ? (
                      <p key={f.key} className="text-slate-500">
                        <span className="text-slate-400">{f.label}:</span> {p.custom[f.key]}
                      </p>
                    ) : null
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
