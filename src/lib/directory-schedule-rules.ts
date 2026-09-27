// The pure half of scheduled directory syncs: what a schedule is, when a
// provider is due, and the report each run produces. No database, no
// edition — the server module beside this one owns those.

import type { DirectorySyncProvider, DirectorySyncSummary } from "@/ee-contract";

export const SYNC_FREQUENCIES = ["off", "hourly", "daily"] as const;
export type SyncFrequency = (typeof SYNC_FREQUENCIES)[number];

export interface SyncSchedule {
  microsoft: SyncFrequency;
  google: SyncFrequency;
  /** UTC hour for daily runs, 0–23. */
  hour: number;
  /** Report recipients, comma-separated in storage. */
  report_to: string[];
  /** Also email when a scheduled run changed nothing. Off by default. */
  report_quiet: boolean;
  last: Partial<Record<DirectorySyncProvider, { at: string; ok: boolean; summary?: string }>>;
}

export function parseRecipients(raw: string): string[] {
  return [...new Set(String(raw ?? "").split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)))].slice(0, 20);
}

/** Is a provider due, given its frequency and when it last ran on schedule? */
export function isSyncDue(frequency: SyncFrequency, hour: number, lastAt: string | undefined, now: Date): boolean {
  if (frequency === "off") return false;
  const last = lastAt ? Date.parse(lastAt) : NaN;
  if (frequency === "hourly") return Number.isNaN(last) || now.getTime() - last >= 55 * 60 * 1000;
  // Daily: at or after the configured UTC hour, once per UTC day.
  if (now.getUTCHours() < hour) return false;
  if (Number.isNaN(last)) return true;
  const l = new Date(last);
  return !(l.getUTCFullYear() === now.getUTCFullYear() && l.getUTCMonth() === now.getUTCMonth() && l.getUTCDate() === now.getUTCDate());
}

const PROVIDER_LABEL: Record<DirectorySyncProvider, string> = { microsoft: "Microsoft 365", google: "Google Workspace" };

/** The report body for one scheduled run — text and HTML. */
export function syncReportEmail(input: {
  provider: DirectorySyncProvider;
  ok: boolean;
  error?: string;
  summary?: DirectorySyncSummary;
  unresolved?: { field: string; count: number; samples: string[] }[];
  adopted?: number;
  origin: string;
  at: Date;
}): { subject: string; text: string; html: string } {
  const label = PROVIDER_LABEL[input.provider];
  const when = input.at.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const lines: string[] = [];
  const s = input.summary;
  const p = s?.preview;
  if (!input.ok) {
    lines.push(`The scheduled ${label} directory sync failed at ${when}.`, "", `Error: ${input.error ?? "unknown"}`);
  } else {
    lines.push(`The scheduled ${label} directory sync ran at ${when}.`, "");
    lines.push(`People synced: ${s?.count ?? 0}`);
    if (p) {
      lines.push(`Added: ${p.adds.length}${p.adds.length ? " — " + p.adds.slice(0, 8).map((x) => x.name).join(", ") + (p.adds.length > 8 ? ", …" : "") : ""}`);
      lines.push(`Changed: ${p.changes.length}${p.changes.length ? " — " + p.changes.slice(0, 8).map((x) => `${x.name} (${(x.changed ?? []).join(", ")})`).join("; ") + (p.changes.length > 8 ? "; …" : "") : ""}`);
      lines.push(`Removed: ${s?.deleted ?? 0}${p.removals.length && !(s?.deleted) ? ` (${p.removals.length} no longer returned but kept)` : ""}${p.removals.length ? " — " + p.removals.slice(0, 8).map((x) => x.name).join(", ") + (p.removals.length > 8 ? ", …" : "") : ""}`);
      if (p.adoptions.length) lines.push(`Adopted hand-typed entries: ${p.adoptions.length} — ${p.adoptions.slice(0, 8).map((x) => x.name).join(", ")}`);
      lines.push(`Unchanged: ${p.unchanged}`);
    } else if (input.adopted) {
      lines.push(`Adopted hand-typed entries: ${input.adopted}`);
    }
    if (s?.blocked) lines.push("", `Removal brake: ${s.blocked.doomed} of ${s.blocked.total} synced people are no longer returned and were kept. Review them on the Sync page and allow the removals once if they are right.`);
    if (s?.warning && !s.blocked) lines.push("", `Warning: ${s.warning}`);
    if (input.unresolved?.length) {
      lines.push("", "People references that matched nobody:");
      for (const u of input.unresolved) lines.push(`  - ${u.field}: ${u.count} — e.g. ${u.samples.join(", ")}`);
    }
  }
  if (input.origin) lines.push("", `Sync page: ${input.origin}/admin/directory/sync`);
  const text = lines.join("\n");
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#1e293b;line-height:1.5">${lines
    .map((l) => (l === "" ? "<br>" : `<div>${esc(l).replace(/^(Sync page: )(\S+)$/, (_m, a, b) => `${a}<a href="${b}" style="color:#2e75bd">${b}</a>`)}</div>`))
    .join("")}</div>`;
  const subject = input.ok
    ? `Directory sync (${label}): ${s?.count ?? 0} people${p ? `, +${p.adds.length} / ~${p.changes.length} / −${s?.deleted ?? 0}` : ""}${s?.blocked ? " — removals held" : ""}`
    : `Directory sync (${label}) failed`;
  return { subject, text, html };
}
