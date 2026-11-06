// Client-side shapes for the composable email templates UI (1.19.0). The
// rows themselves are lib/email-parts' (imported as types only, so nothing
// server-side reaches the bundle); this file adds what the screens need on
// top: labels, route segments, and the page's initial data.

import type { EmailComposition, EmailPart, EmailPartKind, PartUsage } from "@/lib/email-parts";

export type { EmailComposition, EmailPart, EmailPartKind, PartUsage };

export const KINDS: EmailPartKind[] = ["header", "body", "signature", "footer"];

export const KIND_LABEL: Record<EmailPartKind, string> = {
  header: "Header",
  body: "Body",
  signature: "Signature",
  footer: "Footer",
};

export const KIND_PLURAL: Record<EmailPartKind, string> = {
  header: "Headers",
  body: "Bodies",
  signature: "Signatures",
  footer: "Footers",
};

/** The library tab's route segment for each kind. */
export const KIND_SEGMENT: Record<EmailPartKind, string> = {
  header: "headers",
  body: "bodies",
  signature: "signatures",
  footer: "footers",
};

export function kindFromSegment(segment: string): EmailPartKind | null {
  const hit = (Object.keys(KIND_SEGMENT) as EmailPartKind[]).find((k) => KIND_SEGMENT[k] === segment);
  return hit ?? null;
}

export interface TagDef {
  tag: string;
  label: string;
}

/** One email event, as the screens list it. */
export interface EventInfo {
  key: string;
  label: string;
  description: string;
  area: string;
  /** The event's own tags (a body may use them). */
  tags: TagDef[];
  /** Helpdesk events: per-team variants are offered. */
  teamScopes: boolean;
}

export interface TeamOption {
  id: number;
  name: string;
}

/** A part with its usage (lib/email-parts PartWithUse); default_for is absent on a part a route just answered with. */
export type PartWithUsage = EmailPart & { used_by: PartUsage[]; default_for?: number };

export const SCOPE_ALL = "all";
export const teamScope = (id: number) => `hd_team:${id}`;
export function scopeTeamId(scope: string): number | null {
  const m = /^hd_team:(\d+)$/.exec(scope);
  return m ? Number(m[1]) : null;
}

/**
 * Where the screens live: Settings → Notifications → Email templates, or
 * the desk's Settings → Email templates (helpdesk events only).
 */
export interface Surface {
  /** The Templates tab's address; the library tabs and the composer hang off it. */
  base: string;
  /** "admin" lists every event; "desk" only the helpdesk ones. */
  mode: "admin" | "desk";
}

export const eventHref = (s: Surface, key: string, scope?: string) =>
  `${s.base}/event/${encodeURIComponent(key)}${scope && scope !== SCOPE_ALL ? `?scope=${encodeURIComponent(scope)}` : ""}`;

export const libraryHref = (s: Surface, kind: EmailPartKind, q: { part?: number; new?: boolean; event?: string; from?: string } = {}) => {
  const p = new URLSearchParams();
  if (q.part) p.set("part", String(q.part));
  if (q.new) p.set("new", "1");
  if (q.event) p.set("event", q.event);
  if (q.from) p.set("from", q.from);
  const qs = p.toString();
  return `${s.base}/${KIND_SEGMENT[kind]}${qs ? `?${qs}` : ""}`;
};
