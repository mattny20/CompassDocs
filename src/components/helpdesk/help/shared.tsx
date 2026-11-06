"use client";

// Small pieces every Get help screen shares (1.19.0): the request-type icon
// map (lucide only: a request type stores an icon *name*), the requester's
// status chip, how an answer prints, and one JSON fetch helper that hands
// back the server's own `error` sentence.

import type { LucideIcon } from "lucide-react";
import {
  Briefcase,
  Bug,
  Building2,
  Car,
  CircleHelp,
  Coffee,
  Flag,
  GraduationCap,
  Heart,
  KeyRound,
  Laptop,
  LifeBuoy,
  Lock,
  Mail,
  Monitor,
  Package,
  Phone,
  Printer,
  Smartphone,
  UserPlus,
  Users,
  Wallet,
  Wrench,
} from "lucide-react";
import { chipClass, type ChipTone } from "@/components/Chip";
import { HD_STATUS_LABEL_REQUESTER, type HdFormAnswers, type HdFormField, type HdStatus } from "@/lib/helpdesk/types";

const ICONS: Record<string, LucideIcon> = {
  briefcase: Briefcase,
  bug: Bug,
  building: Building2,
  building2: Building2,
  car: Car,
  coffee: Coffee,
  flag: Flag,
  graduation: GraduationCap,
  heart: Heart,
  help: CircleHelp,
  key: KeyRound,
  keyround: KeyRound,
  laptop: Laptop,
  lifebuoy: LifeBuoy,
  lock: Lock,
  mail: Mail,
  monitor: Monitor,
  package: Package,
  phone: Phone,
  printer: Printer,
  smartphone: Smartphone,
  userplus: UserPlus,
  users: Users,
  wallet: Wallet,
  wrench: Wrench,
};

/** "user-plus", "userPlus" and "UserPlus" all name the same lucide icon. */
export function requestTypeIcon(name: string | null | undefined): LucideIcon {
  const key = (name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return ICONS[key] ?? LifeBuoy;
}

/** What the requester reads: a running workflow is "In progress" (the approved preview), else the requester labels. */
export function requesterStatus(status: HdStatus, inWorkflow: boolean): { label: string; tone: ChipTone } {
  if (inWorkflow && status !== "solved" && status !== "closed") return { label: "In progress", tone: "accent" };
  const label = HD_STATUS_LABEL_REQUESTER[status] ?? status;
  const tone: ChipTone =
    status === "pending" ? "warn" : status === "solved" || status === "closed" ? "ok" : status === "on_hold" ? "neutral" : "accent";
  return { label, tone };
}

export function RequestStatusChip({
  status,
  inWorkflow,
  className = "",
}: {
  status: HdStatus;
  inWorkflow: boolean;
  className?: string;
}) {
  const s = requesterStatus(status, inWorkflow);
  return <span className={chipClass(s.tone, "md", className)}>{s.label}</span>;
}

/**
 * One answer as text: a choice or select prints its option's label, a
 * checkbox Yes / No, a date through the caller's day formatter (a calendar
 * day, never an instant), a user field the name the server resolved.
 */
export function formatAnswer(
  field: HdFormField,
  answers: HdFormAnswers,
  day: (ymd: string) => string
): string {
  const raw = answers[field.key];
  if (raw === null || raw === undefined || raw === "") return "";
  if (field.type === "checkbox") return raw === true || raw === "true" ? "Yes" : "No";
  if ((field.type === "choice" || field.type === "select") && field.options) {
    const opt = field.options.find((o) => o.value === String(raw));
    return opt ? opt.label : String(raw);
  }
  if (field.type === "date" && typeof raw === "string") return day(raw);
  if (field.type === "user") {
    const name = answers[`${field.key}__name`];
    return typeof name === "string" && name ? name : String(raw);
  }
  return String(raw);
}

export type JsonResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

/** fetch + JSON, never throwing: the server's own `error`, else the caller's sentence. */
export async function fetchJson<T>(url: string, init: RequestInit | undefined, fallback: string): Promise<JsonResult<T>> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: init?.body && !(init.body instanceof FormData) ? { "content-type": "application/json", ...init?.headers } : init?.headers,
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, status: res.status, error: data?.error || fallback };
    return { ok: true, data };
  } catch {
    return { ok: false, status: 0, error: fallback };
  }
}

/** First name for "Matthew replied 2m ago". */
export function firstName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}
