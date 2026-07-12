import type { DocType, DocStatus } from "./types";

export const TYPE_STYLES: Record<DocType, string> = {
  sop: "bg-violet-100 text-violet-700 ring-violet-200",
  technical: "bg-sky-100 text-sky-700 ring-sky-200",
  policy: "bg-amber-100 text-amber-700 ring-amber-200",
  knowledge: "bg-emerald-100 text-emerald-700 ring-emerald-200",
};

export const TYPE_LABEL: Record<DocType, string> = {
  sop: "SOP",
  technical: "Technical",
  policy: "Policy",
  knowledge: "Knowledge",
};

export const STATUS_STYLES: Record<DocStatus, string> = {
  published: "bg-green-100 text-green-700 ring-green-200",
  draft: "bg-slate-100 text-slate-600 ring-slate-200",
};

export function timeAgo(iso: string): string {
  const then = new Date(iso.replace(" ", "T") + "Z").getTime();
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
