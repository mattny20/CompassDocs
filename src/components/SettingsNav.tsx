"use client";

// The settings rail: sections grouped by area (Platform / Content / People &
// access / AI / Operations) with a search box that flattens across all of
// them. Section identity (label, icon, description, keywords) lives in
// lib/settings-sections — shared with each page's SettingsPage header. Rows
// and group labels are the shared rail recipe (components/RailLink).

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Search } from "lucide-react";
import { SETTINGS_GROUPS, SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { RailGroupLabel, RailLink } from "./RailLink";
import { controlClass, SectionEmpty } from "@/components/form";

export function SettingsNav({ reachable }: { reachable: string[] }) {
  const pathname = usePathname();
  // A section may have pages of its own (/admin/directory/fields); the rail
  // entry stays lit for all of them. Longest match wins, or /admin (System)
  // would claim every page.
  const path =
    SETTINGS_SECTIONS.filter((s) => pathname === s.href || pathname.startsWith(`${s.href}/`))
      .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? pathname;
  const [query, setQuery] = useState("");
  // The rail lists only what this user may open — the layout resolves that from
  // each section's permission, so a delegated role sees its one section rather
  // than twenty links that redirect home.
  const allowed = new Set(reachable);
  const sections = SETTINGS_SECTIONS.filter((s) => allowed.has(s.href));
  const groups = SETTINGS_GROUPS.map((g) => ({
    ...g,
    sections: g.sections.filter((s) => allowed.has(s.href)),
  })).filter((g) => g.sections.length > 0);
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? sections.filter((s) => `${s.label} ${s.keywords}`.toLowerCase().includes(needle))
    : null;

  return (
    <div className="flex shrink-0 flex-col gap-1 sm:w-rail">
      <label className="relative mb-1 hidden sm:block">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search settings…"
          aria-label="Search settings"
          className={controlClass(false, "py-1.5 pl-8 pr-2")}
        />
      </label>

      {matches ? (
        <nav aria-label="Settings sections" className="flex gap-1 overflow-x-auto sm:flex-col">
          {matches.map((s) => (
            <RailLink key={s.href} href={s.href} icon={s.icon} label={s.label} active={path === s.href} />
          ))}
          {matches.length === 0 && (
            <SectionEmpty className="px-3 py-2">No settings match.</SectionEmpty>
          )}
        </nav>
      ) : (
        <>
          {/* Mobile: one horizontally scrollable flat row. */}
          <nav aria-label="Settings sections" className="flex gap-1 overflow-x-auto sm:hidden">
            {sections.map((s) => (
              <span key={s.href} className="shrink-0 whitespace-nowrap">
                <RailLink href={s.href} icon={s.icon} label={s.label} active={path === s.href} />
              </span>
            ))}
          </nav>
          {/* Desktop: grouped rail. */}
          <nav aria-label="Settings sections" className="hidden sm:flex sm:flex-col sm:gap-1">
            {groups.map((g) => (
              <div key={g.label} className="flex flex-col gap-0.5">
                <RailGroupLabel>{g.label}</RailGroupLabel>
                {g.sections.map((s) => (
                  <RailLink key={s.href} href={s.href} icon={s.icon} label={s.label} active={path === s.href} />
                ))}
              </div>
            ))}
          </nav>
        </>
      )}
    </div>
  );
}
