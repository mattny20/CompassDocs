import type { DocType, DocStatus } from "./types";
import type { ChipTone } from "@/components/Chip";

/** Document types map onto the closed chip tone set (components/Chip). */
export const TYPE_TONE: Record<DocType, ChipTone> = {
  sop: "label",
  technical: "info",
  policy: "warn",
  knowledge: "ok",
};

export const TYPE_LABEL: Record<DocType, string> = {
  sop: "SOP",
  technical: "Technical",
  policy: "Policy",
  knowledge: "Knowledge",
};

export const STATUS_TONE: Record<DocStatus, ChipTone> = {
  published: "ok",
  draft: "neutral",
};

export function timeAgo(iso: string): string {
  // Accept both "2026-07-12 20:36:58" (space, no zone) and already-normalized
  // ISO strings like "2026-07-12T20:36:58.033Z" — only append a UTC marker when
  // the value carries no timezone, otherwise we'd produce an invalid date.
  const norm = iso.replace(" ", "T");
  const hasZone = /[zZ]$|[+-]\d\d:?\d\d$/.test(norm);
  const then = new Date(hasZone ? norm : norm + "Z").getTime();
  if (Number.isNaN(then)) return iso;
  const secs = Math.floor((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
