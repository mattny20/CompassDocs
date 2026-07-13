"use client";

import { useMemo, useState } from "react";
import type { DirectoryPerson } from "@/lib/directory";

const field =
  "rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export function DirectoryClient({
  initialPeople,
  departments,
}: {
  initialPeople: DirectoryPerson[];
  departments: string[];
}) {
  const [q, setQ] = useState("");
  const [dept, setDept] = useState("");

  const people = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return initialPeople.filter((p) => {
      if (dept && p.department !== dept) return false;
      if (!needle) return true;
      return [p.name, p.title, p.department, p.email, p.phone, p.mobile, p.office]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [initialPeople, q, dept]);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search people…"
          className={`${field} w-72`}
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
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {people.map((p) => (
            <div
              key={p.id}
              className="flex gap-3 rounded-xl border border-slate-200 bg-surface p-4 shadow-sm"
            >
              {p.photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={p.photo}
                  alt=""
                  className="h-12 w-12 flex-none rounded-full object-cover"
                />
              ) : (
                <div className="flex h-12 w-12 flex-none items-center justify-center rounded-full bg-compass-100 font-semibold text-compass-700">
                  {initials(p.name)}
                </div>
              )}
              <div className="min-w-0">
                <p className="truncate font-semibold text-slate-900">{p.name}</p>
                {(p.title || p.department) && (
                  <p className="truncate text-sm text-slate-500">
                    {p.title}
                    {p.title && p.department ? " · " : ""}
                    {p.department}
                  </p>
                )}
                <div className="mt-1 space-y-0.5 text-sm">
                  {p.email && (
                    <a
                      href={`mailto:${p.email}`}
                      className="block truncate text-compass-600 hover:underline"
                    >
                      {p.email}
                    </a>
                  )}
                  {p.phone && (
                    <a href={`tel:${p.phone}`} className="block text-slate-600 hover:underline">
                      ☎ {p.phone}
                    </a>
                  )}
                  {p.mobile && (
                    <a href={`tel:${p.mobile}`} className="block text-slate-600 hover:underline">
                      📱 {p.mobile}
                    </a>
                  )}
                  {p.office && <p className="text-slate-400">📍 {p.office}</p>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
