// What is wrong with the directory, as a list an admin can work through.
//
// Every sync leaves a report and every option list has strays, but nobody
// reads a report on a Tuesday. This turns the data itself into findings —
// people with no office, values no option matches, two people with one
// name, assistants nobody could resolve, rows a sync stopped returning —
// each with a count and, where one exists, a link to the place to fix it.
//
// Pure module: the People page computes it from what it already loads.

import { matchOption, rawValue, type FieldLike, type PersonLike } from "./directory-display";
import type { SyncReport } from "./directory";

export interface HealthFinding {
  id: string;
  /** "warn" needs a hand; "info" is worth knowing. */
  severity: "warn" | "info";
  count: number;
  title: string;
  detail: string;
  /** Where to fix it, when there is a page for that. */
  href?: string;
  /** A few names or values, for the tooltip. */
  samples?: string[];
}

export interface HealthInput<P extends PersonLike> {
  people: (P & { source: string; hidden: number; updated_at: string; photo: string })[];
  fields: FieldLike[];
  reports: { graph: SyncReport | null; google: SyncReport | null };
  /** When each provider last synced successfully, ISO; absent when never. */
  lastSync: { graph?: string; google?: string };
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function directoryHealth<P extends PersonLike>(input: HealthInput<P>): HealthFinding[] {
  const out: HealthFinding[] = [];
  const visible = input.people.filter((p) => !p.hidden);
  const sample = (names: string[]) => names.slice(0, 5);

  // Blanks in the fields a directory sheet cannot do without.
  for (const key of ["office", "title", "phone", "email"] as const) {
    const label = input.fields.find((f) => f.key === key)?.label ?? key[0].toUpperCase() + key.slice(1);
    const missing = visible.filter((p) => !rawValue(p, key).trim() && !(key === "phone" && p.mobile.trim()));
    if (missing.length) {
      out.push({
        id: `missing-${key}`,
        severity: key === "office" || key === "phone" ? "warn" : "info",
        count: missing.length,
        title: `No ${label.toLowerCase()}`,
        detail: key === "phone" ? "No work phone or mobile." : `The ${label.toLowerCase()} is blank.`,
        href: `/admin/directory?missing=${key}`,
        samples: sample(missing.map((p) => p.name)),
      });
    }
  }

  // Values an option list does not know. Sections and sorting treat them as
  // strays, alphabetised after the real options.
  for (const f of input.fields) {
    if (!f.options.length || f.kind === "people") continue;
    const strays = new Map<string, number>();
    for (const p of visible) {
      const raw = rawValue(p, f.key);
      const tokens = f.multi ? raw.split(/[,;]/) : [raw];
      for (const t of tokens.map((s) => s.trim()).filter(Boolean)) {
        if (!matchOption(f, t).option) strays.set(t, (strays.get(t) ?? 0) + 1);
      }
    }
    if (strays.size) {
      const people = [...strays.values()].reduce((a, b) => a + b, 0);
      out.push({
        id: `strays-${f.key}`,
        severity: "warn",
        count: strays.size,
        title: `${f.label}: ${strays.size} ${strays.size === 1 ? "value matches" : "values match"} no option`,
        detail: `${people} ${people === 1 ? "person carries" : "people carry"} a value the option list does not know — add it, or fold it into an option as an alias.`,
        href: "/admin/directory/fields",
        samples: sample([...strays.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} (${n})`)),
      });
    }
  }

  // Two people, one name: links by name become ambiguous and readers guess.
  const byName = new Map<string, string[]>();
  for (const p of visible) {
    const k = norm(p.name);
    if (!k) continue;
    byName.set(k, [...(byName.get(k) ?? []), p.name]);
  }
  const dupes = [...byName.values()].filter((v) => v.length > 1);
  if (dupes.length) {
    out.push({
      id: "duplicate-names",
      severity: "warn",
      count: dupes.length,
      title: `${dupes.length} ${dupes.length === 1 ? "name is" : "names are"} shared by more than one person`,
      detail: "An assistant value naming them cannot be resolved; a reader cannot tell them apart. Hide the duplicate, or give one a distinguishing title.",
      href: "/admin/directory",
      samples: sample(dupes.map((v) => `${v[0]} ×${v.length}`)),
    });
  }

  // What the last sync could not resolve.
  for (const [source, report] of Object.entries(input.reports) as ["graph" | "google", SyncReport | null][]) {
    if (!report?.unresolved?.length) continue;
    const total = report.unresolved.reduce((a, u) => a + u.count, 0);
    out.push({
      id: `unresolved-${source}`,
      severity: "warn",
      count: total,
      title: `${total} people ${total === 1 ? "reference" : "references"} the ${source === "graph" ? "Microsoft 365" : "Google Workspace"} sync could not match`,
      detail: `In ${report.unresolved.map((u) => u.field).join(", ")}: a name nobody has, or someone the sync's filters left out. Retried every run.`,
      href: "/admin/directory/sync",
      samples: sample(report.unresolved.flatMap((u) => u.samples)),
    });
  }

  // Rows a provider owns but stopped returning: the removal brake kept them.
  for (const [source, at] of Object.entries(input.lastSync) as ["graph" | "google", string | undefined][]) {
    if (!at) continue;
    const t = Date.parse(at);
    if (Number.isNaN(t)) continue;
    const stale = input.people.filter((p) => p.source === source && Date.parse(p.updated_at) < t - 60_000);
    if (stale.length) {
      out.push({
        id: `stale-${source}`,
        severity: "warn",
        count: stale.length,
        title: `${stale.length} synced ${stale.length === 1 ? "person was" : "people were"} not in the last ${source === "graph" ? "Microsoft 365" : "Google Workspace"} sync`,
        detail: "They are no longer returned by the provider but were kept — usually the removal brake, or a group filter that changed. Review them on the Sync page.",
        href: "/admin/directory/sync",
        samples: sample(stale.map((p) => p.name)),
      });
    }
  }

  // Worth knowing, not wrong.
  const noPhoto = visible.filter((p) => !p.photo);
  if (noPhoto.length && noPhoto.length < visible.length) {
    out.push({
      id: "no-photo",
      severity: "info",
      count: noPhoto.length,
      title: `${noPhoto.length} ${noPhoto.length === 1 ? "person has" : "people have"} no photo`,
      detail: "Cards and the contact card show initials instead. Upload one on the People page, or turn on photos in the sync.",
      href: "/admin/directory",
      samples: sample(noPhoto.map((p) => p.name)),
    });
  }
  const hidden = input.people.filter((p) => p.hidden).length;
  if (hidden) {
    out.push({ id: "hidden", severity: "info", count: hidden, title: `${hidden} hidden ${hidden === 1 ? "entry" : "entries"}`, detail: "Kept but not shown anywhere; they survive syncs.", href: "/admin/directory" });
  }

  return out.sort((a, b) => (a.severity === b.severity ? b.count - a.count : a.severity === "warn" ? -1 : 1));
}
