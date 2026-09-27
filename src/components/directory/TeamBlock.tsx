// Where a person sits: the managers above them, the people beside them, the
// team below. Server-rendered on the profile page from the org chart; the
// team page shows the whole tree below.

import Link from "next/link";
import { ChevronRight, Network, Users } from "lucide-react";
import type { DirectoryPerson } from "@/lib/directory";
import { initialsOf } from "@/lib/directory-display";

export function PersonTile({ p }: { p: DirectoryPerson }) {
  return (
    <Link href={`/directory/${p.id}`} className="flex min-w-0 items-center gap-2.5 rounded-lg border border-slate-200 bg-surface px-3 py-2 hover:border-compass-300">
      {p.photo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={p.photo} alt="" className="h-9 w-9 flex-none rounded-full object-cover" />
      ) : (
        <span className="grid h-9 w-9 flex-none place-items-center rounded-full bg-compass-100 text-xs font-semibold text-compass-700">{initialsOf(p.name)}</span>
      )}
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-slate-900">{p.name}</span>
        {p.title ? <span className="block truncate text-xs text-slate-500">{p.title}</span> : null}
      </span>
    </Link>
  );
}

/** "Reports to: Zed Chief › Ann Vice › Cy Lead" — top of the company first. */
export function ChainLine({ chain, label }: { chain: DirectoryPerson[]; label: string }) {
  if (chain.length === 0) return null;
  const top = [...chain].reverse();
  return (
    <p className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-sm text-slate-600">
      <span className="text-slate-400">{label}:</span>
      {top.map((m, i) => (
        <span key={m.id} className="inline-flex items-center gap-1">
          {i > 0 && <ChevronRight className="h-3 w-3 text-slate-300" aria-hidden />}
          <Link href={`/directory/${m.id}`} className="font-medium text-compass-700 hover:underline">{m.name}</Link>
        </span>
      ))}
    </p>
  );
}

export function TeamBlock({
  person,
  chain,
  reports,
  teamSize,
  peers,
  labels,
}: {
  person: DirectoryPerson;
  chain: DirectoryPerson[];
  reports: DirectoryPerson[];
  /** Everyone below, at any level. */
  teamSize: number;
  peers: DirectoryPerson[];
  labels: { manager: string; reports: string };
}) {
  if (chain.length === 0 && reports.length === 0 && peers.length === 0) return null;
  const shown = reports.slice(0, 8);
  return (
    <div className="mt-5 rounded-lg border border-slate-100 bg-slate-50 p-4">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <Network className="h-3.5 w-3.5 text-compass-600" aria-hidden /> Team
        </p>
        <Link href={`/directory?view=org&focus=${person.id}`} className="text-xs font-medium text-compass-600 hover:underline">
          Open in org chart
        </Link>
        {teamSize > 0 && (
          <Link href={`/directory/${person.id}/team`} className="text-xs font-medium text-compass-600 hover:underline">
            Whole team ({teamSize})
          </Link>
        )}
      </div>
      <ChainLine chain={chain} label={labels.manager} />
      {peers.length > 0 && (
        <p className="mt-1 text-sm text-slate-600">
          <span className="text-slate-400">Alongside:</span>{" "}
          {peers.slice(0, 6).map((p, i) => (
            <span key={p.id}>
              <Link href={`/directory/${p.id}`} className="hover:underline">{p.name}</Link>
              {i < Math.min(peers.length, 6) - 1 ? ", " : ""}
            </span>
          ))}
          {peers.length > 6 ? ` and ${peers.length - 6} more` : ""}
        </p>
      )}
      {reports.length > 0 && (
        <>
          <p className="mb-1.5 mt-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <Users className="h-3.5 w-3.5" aria-hidden /> {labels.reports} <span className="font-normal text-slate-400">({reports.length})</span>
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((r) => (
              <PersonTile key={r.id} p={r} />
            ))}
          </div>
          {reports.length > shown.length && (
            <Link href={`/directory/${person.id}/team`} className="mt-2 inline-block text-xs font-medium text-compass-600 hover:underline">
              All {reports.length} {labels.reports.toLowerCase()}
            </Link>
          )}
        </>
      )}
    </div>
  );
}
