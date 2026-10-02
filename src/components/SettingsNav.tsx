"use client";

// The settings rail: sections grouped by area (Platform / Content / People &
// access / AI / Operations) with a search box over everything the console
// contains — sections, their routed pages and the cards inside them
// ("Workspace › Trash retention" links straight to the card). Section
// identity lives in lib/settings-sections, shared with each page's
// SettingsPage header and SubNav. Rows and group labels are the shared rail
// recipe (components/RailLink).
//
// Keyboard: Enter opens the first match, Escape clears, ArrowDown moves
// into the results; a live count tells readers how many matched.

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronRight, Search } from "lucide-react";
import { SETTINGS_GROUPS, SETTINGS_INDEX, SETTINGS_SECTIONS, type SettingsIndexEntry } from "@/lib/settings-sections";
import { RailGroupLabel, RailLink, railRowClass } from "./RailLink";
import { controlClass, SectionEmpty } from "@/components/form";

const MAX_RESULTS = 12;

export function SettingsNav({ reachable }: { reachable: string[] }) {
  const pathname = usePathname();
  const router = useRouter();
  // A section may have pages of its own (/admin/directory/fields); the rail
  // entry stays lit for all of them. Longest match wins, or /admin (System)
  // would claim every page.
  const path =
    SETTINGS_SECTIONS.filter((s) => pathname === s.href || pathname.startsWith(`${s.href}/`))
      .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? pathname;
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLElement>(null);
  const countId = useId();
  // The rail lists only what this user may open — the layout resolves that from
  // each section's permission, so a delegated role sees its one section rather
  // than twenty links that redirect home. Pages and topics inherit their
  // section's reachability.
  const allowed = new Set(reachable);
  const sections = SETTINGS_SECTIONS.filter((s) => allowed.has(s.href));
  const groups = SETTINGS_GROUPS.map((g) => ({
    ...g,
    sections: g.sections.filter((s) => allowed.has(s.href)),
  })).filter((g) => g.sections.length > 0);
  const needle = query.trim().toLowerCase();
  const matches: SettingsIndexEntry[] | null = needle
    ? SETTINGS_INDEX.filter((e) => allowed.has(e.section.href) && e.haystack.includes(needle)).slice(0, MAX_RESULTS)
    : null;

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      if (query) {
        e.preventDefault();
        setQuery("");
      }
      return;
    }
    if (e.key === "Enter" && matches && matches.length > 0) {
      e.preventDefault();
      router.push(matches[0].href);
      setQuery("");
      return;
    }
    if (e.key === "ArrowDown" && matches && matches.length > 0) {
      e.preventDefault();
      listRef.current?.querySelector<HTMLElement>("a")?.focus();
    }
  }

  return (
    <div className="flex shrink-0 flex-col gap-1 sm:w-rail">
      <label className="relative mb-1 hidden sm:block">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search settings…"
          aria-label="Search settings"
          aria-describedby={countId}
          autoComplete="off"
          spellCheck={false}
          className={controlClass(false, "py-1.5 pl-8 pr-2")}
        />
      </label>
      <span id={countId} aria-live="polite" className="sr-only">
        {matches ? `${matches.length} ${matches.length === 1 ? "match" : "matches"}` : ""}
      </span>

      {matches ? (
        <nav ref={listRef} aria-label="Settings sections" className="flex gap-1 overflow-x-auto sm:flex-col">
          {matches.map((m) =>
            m.kind === "section" ? (
              <RailLink key={m.href} href={m.href} icon={m.section.icon} label={m.label} active={path === m.href} />
            ) : (
              <Link
                key={m.href}
                href={m.href}
                onClick={() => setQuery("")}
                className={railRowClass(false, { dense: true })}
              >
                {/* The topic is what was searched for; the section is the breadcrumb. */}
                <span className="flex min-w-0 flex-col py-0.5 leading-tight">
                  <span className="truncate font-medium text-slate-800">{m.label}</span>
                  <span className="flex items-center gap-0.5 text-2xs text-slate-500">
                    {m.section.label}
                    <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
                    {m.kind === "page" ? "page" : "setting"}
                  </span>
                </span>
              </Link>
            )
          )}
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
