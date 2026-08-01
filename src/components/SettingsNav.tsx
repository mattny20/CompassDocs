"use client";

// The settings rail: sections grouped by area (Platform / Content / People &
// access / AI / Operations) with a search box that flattens across all of
// them. Section identity (label, icon, description, keywords) lives in
// lib/settings-sections — shared with each page's SettingsPage header.

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Search } from "lucide-react";
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingsSection } from "@/lib/settings-sections";

function NavLink({ s, active }: { s: SettingsSection; active: boolean }) {
  const Icon = s.icon;
  return (
    <Link
      href={s.href}
      className={`flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition ${
        active ? "bg-compass-50 text-compass-700" : "text-slate-600 hover:bg-slate-100"
      }`}
    >
      <Icon className="h-4 w-4" aria-hidden />
      {s.label}
    </Link>
  );
}

export function SettingsNav() {
  const path = usePathname();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? SETTINGS_SECTIONS.filter((s) => `${s.label} ${s.keywords}`.toLowerCase().includes(needle))
    : null;

  return (
    <div className="flex shrink-0 flex-col gap-1 sm:w-52">
      <label className="relative mb-1 hidden sm:block">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search settings…"
          aria-label="Search settings"
          className="w-full rounded-lg border border-slate-200 bg-surface py-1.5 pl-8 pr-2 text-sm outline-hidden placeholder:text-slate-400 focus:border-compass-400"
        />
      </label>

      {matches ? (
        <nav className="flex gap-1 overflow-x-auto sm:flex-col">
          {matches.map((s) => (
            <NavLink key={s.href} s={s} active={path === s.href} />
          ))}
          {matches.length === 0 && (
            <p className="px-3 py-2 text-sm text-slate-400">No settings match.</p>
          )}
        </nav>
      ) : (
        <>
          {/* Mobile: one horizontally scrollable flat row. */}
          <nav className="flex gap-1 overflow-x-auto sm:hidden">
            {SETTINGS_SECTIONS.map((s) => (
              <NavLink key={s.href} s={s} active={path === s.href} />
            ))}
          </nav>
          {/* Desktop: grouped rail. */}
          <nav className="hidden sm:flex sm:flex-col sm:gap-1">
            {SETTINGS_GROUPS.map((g) => (
              <div key={g.label} className="flex flex-col gap-1">
                <p className="mb-0.5 mt-3 px-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400 first:mt-1">
                  {g.label}
                </p>
                {g.sections.map((s) => (
                  <NavLink key={s.href} s={s} active={path === s.href} />
                ))}
              </div>
            ))}
          </nav>
        </>
      )}
    </div>
  );
}
