"use client";

// The org chart as a tree you can fold: heads of the company at the top,
// each person's reports beneath them, everyone standing alone at the end.
// A search keeps only the matches and the line above each; a focus (from a
// profile's "Open in org chart") opens the path to one person and lands
// on them.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Users, Network, Settings } from "lucide-react";
import type { DirectoryPerson, DirectoryField } from "@/lib/directory";
import { initialsOf } from "@/lib/directory-display";
import { buildOrgChart, pathTo, type OrgNode } from "@/lib/directory-org";
import { EmptyState } from "@/components/form";

function Avatar({ p }: { p: DirectoryPerson }) {
  return p.photo ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={p.photo} alt="" className="h-9 w-9 flex-none rounded-full object-cover" />
  ) : (
    <span className="grid h-9 w-9 flex-none place-items-center rounded-full bg-compass-100 text-xs font-semibold text-compass-700">{initialsOf(p.name)}</span>
  );
}

export function OrgChart({
  people,
  fields,
  matches,
  focusId,
  isAdmin = false,
}: {
  /** Everyone visible — the chart is built from all of them. */
  people: DirectoryPerson[];
  fields: DirectoryField[];
  /** Ids that match the current search or filter; null when there is none. */
  matches: Set<number> | null;
  /** A person to open the tree to and land on. */
  focusId?: number;
  isAdmin?: boolean;
}) {
  const chart = useMemo(() => buildOrgChart(people, fields), [people, fields]);
  const placed = chart.roots.filter((r) => r.reports.length > 0);
  const alone = chart.roots.filter((r) => r.reports.length === 0);
  const linked = people.length - alone.length;

  // Which nodes are open. Default: heads and their direct reports, so three
  // levels show; the rest a click away.
  const defaultOpen = useMemo(() => {
    const s = new Set<number>();
    for (const n of chart.byId.values()) if (n.reports.length && n.depth < 2) s.add(n.person.id);
    return s;
  }, [chart]);
  const [open, setOpen] = useState<Set<number>>(defaultOpen);
  const [aloneOpen, setAloneOpen] = useState(false);
  const [landed, setLanded] = useState<number | undefined>(undefined);
  const focusRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  useEffect(() => {
    if (!focusId || !chart.byId.has(focusId)) return;
    setOpen((cur) => {
      const next = new Set(cur);
      for (const id of pathTo(chart, focusId)) next.add(id);
      return next;
    });
    setLanded(focusId);
    const t = setTimeout(() => focusRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }), 50);
    return () => clearTimeout(t);
  }, [focusId, chart]);

  // With a search, keep each match and the line above it, all open.
  const keep = useMemo(() => {
    if (!matches) return null;
    const s = new Set<number>();
    for (const id of matches) for (const a of pathTo(chart, id)) s.add(a);
    return s;
  }, [matches, chart]);

  const toggle = (id: number) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const expandAll = () => setOpen(new Set([...chart.byId.values()].filter((n) => n.reports.length).map((n) => n.person.id)));
  const collapseAll = () => setOpen(new Set(chart.roots.filter((r) => r.reports.length).map((r) => r.person.id)));

  if (linked === 0) {
    return (
      <EmptyState
        icon={<Network />}
        title="No reporting lines yet"
        body={
          isAdmin
            ? "Set who each person reports to on the People page, import a CSV with a Reports to column, or map the field to your identity system under Fields."
            : "Nobody's Reports to is filled in yet. Admins set it under Settings → Directory."
        }
        action={isAdmin ? { href: "/admin/directory", label: "Directory settings", icon: <Settings /> } : undefined}
      />
    );
  }

  const Node = ({ node }: { node: OrgNode<DirectoryPerson> }) => {
    const p = node.person;
    if (keep && !keep.has(p.id)) return null;
    const shownReports = keep ? node.reports.filter((r) => keep.has(r.person.id)) : node.reports;
    const isOpen = keep ? true : open.has(p.id);
    const hit = matches?.has(p.id) ?? false;
    const isLanded = landed === p.id;
    return (
      <li className="relative">
        <div
          ref={isLanded ? focusRef : undefined}
          className={`flex min-w-0 items-center gap-2 rounded-lg border bg-surface px-2.5 py-1.5 ${
            isLanded ? "border-compass-400 ring-2 ring-compass-100" : hit ? "border-compass-300" : "border-slate-200"
          }`}
        >
          {node.reports.length > 0 ? (
            <button
              type="button"
              onClick={() => toggle(p.id)}
              className="rounded-sm p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              aria-expanded={isOpen}
              aria-label={isOpen ? `Collapse ${p.name}'s team` : `Expand ${p.name}'s team`}
              data-tt={isOpen ? "Collapse" : `Show ${node.reports.length} direct ${node.reports.length === 1 ? "report" : "reports"}`}
              disabled={!!keep}
            >
              {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
          ) : (
            <span className="w-5" aria-hidden />
          )}
          <Avatar p={p} />
          <div className="min-w-0 flex-1">
            <Link href={`/directory/${p.id}`} className="block truncate text-sm font-medium text-slate-900 hover:text-compass-700">
              {p.name}
            </Link>
            <p className="truncate text-xs text-slate-500">
              {[p.title, p.department].filter(Boolean).join(" · ")}
            </p>
          </div>
          {node.size > 0 && (
            <Link
              href={`/directory/${p.id}/team`}
              className="inline-flex flex-none items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-compass-50 hover:text-compass-700"
              data-tt={`${node.reports.length} direct · ${node.size} in all — open the team page`}
              aria-label={`${p.name}'s team: ${node.size} people`}
            >
              <Users className="h-3 w-3" aria-hidden /> {node.reports.length}
              {node.size > node.reports.length ? <span className="text-slate-400">/{node.size}</span> : null}
            </Link>
          )}
        </div>
        {isOpen && shownReports.length > 0 && (
          <ul className="ml-4 mt-1.5 space-y-1.5 border-l border-slate-200 pl-4">
            {shownReports.map((r) => (
              <Node key={r.person.id} node={r} />
            ))}
          </ul>
        )}
      </li>
    );
  };

  const shownHeads = keep ? placed.filter((r) => keep.has(r.person.id)) : placed;
  const shownAlone = keep ? alone.filter((r) => keep.has(r.person.id)) : alone;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500">
        <span>
          {chart.heads} {chart.heads === 1 ? "head" : "heads"} · {linked - chart.heads} {linked - chart.heads === 1 ? "person" : "people"} in a reporting line
          {alone.length ? ` · ${alone.length} not placed` : ""}
        </span>
        {chart.cycles.length > 0 && (
          <span className="text-amber-600" data-tt={chart.cycles.map((c) => c.map((id) => chart.byId.get(id)?.person.name ?? id).join(" → ")).join(" · ")}>
            {chart.cycles.length} {chart.cycles.length === 1 ? "loop" : "loops"} broken
          </span>
        )}
        {!keep && (
          <span className="ml-auto flex gap-3">
            <button type="button" onClick={expandAll} className="text-xs font-medium text-compass-600 hover:underline">Expand all</button>
            <button type="button" onClick={collapseAll} className="text-xs font-medium text-compass-600 hover:underline">Collapse all</button>
          </span>
        )}
      </div>
      {shownHeads.length === 0 && shownAlone.length === 0 ? (
        <p className="text-sm text-slate-500">No one in a reporting line matches.</p>
      ) : (
        <ul className="space-y-2">
          {shownHeads.map((r) => (
            <Node key={r.person.id} node={r} />
          ))}
        </ul>
      )}
      {shownAlone.length > 0 && (
        <div className="mt-5">
          <button
            type="button"
            onClick={() => setAloneOpen((o) => !o)}
            className="mb-2 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-slate-500"
            aria-expanded={aloneOpen || !!keep}
          >
            {aloneOpen || keep ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Not in a reporting line <span className="text-xs font-normal text-slate-400">({shownAlone.length})</span>
          </button>
          {(aloneOpen || keep) && (
            <ul className="card-grid gap-1.5 [--card-min:14rem]">
              {shownAlone.map((r) => (
                <li key={r.person.id}>
                  <Link href={`/directory/${r.person.id}`} className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-surface px-2.5 py-1.5 hover:border-compass-300">
                    <Avatar p={r.person} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-slate-900">{r.person.name}</span>
                      <span className="block truncate text-xs text-slate-500">{r.person.title}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
