// The org chart, from a people field that means "reports to". Pure: the
// server builds it for profile and team pages, the directory builds it in
// the browser. A chain that loops (A reports to B reports to A) is broken at
// its lowest id and reported, never followed.

import type { FieldLike, PersonLike } from "./directory-display";
import { compareByKeys } from "./directory-display";

export const MANAGER_FIELD_KEY = "manager";

export interface OrgNode<P extends PersonLike = PersonLike> {
  person: P;
  reports: OrgNode<P>[];
  depth: number;
  /** Everyone below this node, at any level. */
  size: number;
}

export interface OrgChart<P extends PersonLike = PersonLike> {
  roots: OrgNode<P>[];
  byId: Map<number, OrgNode<P>>;
  /** The manager each person resolved to, after loops are broken. */
  managerOf: Map<number, number>;
  /** Loops found and broken, each as the ids around the loop, starting at the lowest. */
  cycles: number[][];
  /** People with a manager and no reports — the leaves. */
  leaves: number;
  /** People with no manager, counting only those who have reports of their own. */
  heads: number;
}

/** The people field that means "reports to", if the registry has one. */
export function managerField(fields: FieldLike[]): FieldLike | undefined {
  return fields.find((f) => f.key === MANAGER_FIELD_KEY && f.kind === "people");
}

/**
 * Build the tree. `key` is the people field whose link points at the
 * manager; a person with several links (a multi-valued field, or a synced
 * link beside a manual one) follows the first.
 */
export function buildOrgChart<P extends PersonLike>(people: P[], fields: FieldLike[], key = MANAGER_FIELD_KEY): OrgChart<P> {
  const byPerson = new Map<number, P>(people.map((p) => [p.id, p]));
  const managerOf = new Map<number, number>();
  for (const p of people) {
    const target = (p.links?.[key] ?? []).find((l) => l.id !== p.id && byPerson.has(l.id));
    if (target) managerOf.set(p.id, target.id);
  }

  // Break loops: walk up from everyone; a chain that returns to a node it
  // has visited on this walk is a loop, cut at its lowest id (so the same
  // loop always breaks the same way, whichever person the walk started at).
  const cycles: number[][] = [];
  const cleared = new Set<number>();
  const cut = new Set<number>();
  for (const p of people) {
    if (cleared.has(p.id)) continue;
    const path: number[] = [];
    const onPath = new Set<number>();
    let cur: number | undefined = p.id;
    while (cur !== undefined && !cleared.has(cur)) {
      if (onPath.has(cur)) {
        const loop = path.slice(path.indexOf(cur));
        const lowest = Math.min(...loop);
        const start = loop.indexOf(lowest);
        cycles.push([...loop.slice(start), ...loop.slice(0, start)]);
        cut.add(lowest);
        managerOf.delete(lowest);
        break;
      }
      onPath.add(cur);
      path.push(cur);
      cur = managerOf.get(cur);
    }
    for (const id of path) cleared.add(id);
  }

  const order = compareByKeys(fields, [{ key: "title", dir: 1 }]);
  const nodes = new Map<number, OrgNode<P>>();
  for (const p of people) nodes.set(p.id, { person: p, reports: [], depth: 0, size: 0 });
  const roots: OrgNode<P>[] = [];
  for (const p of people) {
    const node = nodes.get(p.id)!;
    const m = managerOf.get(p.id);
    if (m !== undefined && nodes.has(m)) nodes.get(m)!.reports.push(node);
    else roots.push(node);
  }
  const sortReports = (list: OrgNode<P>[]) => list.sort((a, b) => order(a.person, b.person));
  const measure = (node: OrgNode<P>, depth: number): number => {
    node.depth = depth;
    sortReports(node.reports);
    node.size = node.reports.reduce((n, r) => n + 1 + measure(r, depth + 1), 0);
    return node.size;
  };
  // Heads first — the people with a team — then everyone standing alone.
  sortReports(roots);
  for (const r of roots) measure(r, 0);
  roots.sort((a, b) => (b.reports.length > 0 ? 1 : 0) - (a.reports.length > 0 ? 1 : 0) || order(a.person, b.person));

  let leaves = 0;
  for (const n of nodes.values()) if (managerOf.has(n.person.id) && n.reports.length === 0) leaves++;
  const heads = roots.filter((r) => r.reports.length > 0).length;
  cycles.sort((a, b) => a[0] - b[0]);
  return { roots, byId: nodes, managerOf, cycles, leaves, heads };
}

/** The managers above a person, nearest first, up to the top. */
export function chainAbove<P extends PersonLike>(chart: OrgChart<P>, id: number): P[] {
  const out: P[] = [];
  const seen = new Set<number>([id]);
  let cur = chart.managerOf.get(id);
  while (cur !== undefined && !seen.has(cur)) {
    const node = chart.byId.get(cur);
    if (!node) break;
    out.push(node.person);
    seen.add(cur);
    cur = chart.managerOf.get(cur);
  }
  return out;
}

/** Everyone below a person, grouped by how many levels down they are (1 = direct reports). */
export function teamBelow<P extends PersonLike>(chart: OrgChart<P>, id: number): { level: number; people: P[] }[] {
  const root = chart.byId.get(id);
  if (!root) return [];
  const levels: P[][] = [];
  const walk = (node: OrgNode<P>, level: number) => {
    for (const r of node.reports) {
      (levels[level] ??= []).push(r.person);
      walk(r, level + 1);
    }
  };
  walk(root, 0);
  return levels.map((people, i) => ({ level: i + 1, people }));
}

/** The people who share a person's manager, without the person. */
export function peersOf<P extends PersonLike>(chart: OrgChart<P>, id: number): P[] {
  const m = chart.managerOf.get(id);
  if (m === undefined) return [];
  return (chart.byId.get(m)?.reports ?? []).map((n) => n.person).filter((p) => p.id !== id);
}

/** Ids on the path from a root down to `id`, the person included — what a tree must expand to show them. */
export function pathTo<P extends PersonLike>(chart: OrgChart<P>, id: number): number[] {
  return [...chainAbove(chart, id).map((p) => p.id).reverse(), id];
}
