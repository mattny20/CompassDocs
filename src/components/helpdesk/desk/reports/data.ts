"use client";

// Desk reports (1.19.0): the client half of the reports API. One query per
// widget (POST /api/helpdesk/analytics/query), memoised for 30 seconds in
// the tab so switching dashboards or opening the gallery does not run a
// report twice; live widgets refresh every minute while the tab is
// visible. Every failure carries the server's own sentence.

import { useCallback, useEffect, useRef, useState } from "react";
import type { HdAnalyticsQuery, HdDashboard, HdQueryResult } from "@/lib/helpdesk/analytics/shared";
import { getJson, sendJson } from "../api";

export interface ReportOptions {
  teams: { id: number; name: string }[];
  agents: { id: number; name: string }[];
  request_types: { id: number; name: string }[];
  workflows: { id: number; name: string }[];
  tags: string[];
  categories: string[];
  can: { export: boolean; share_everyone: boolean; set_default: boolean; manage_shared: boolean };
  scope: "all" | "teams" | "own";
  timezone: string;
  me: number;
  has_automated?: boolean;
}

const memo = new Map<string, { at: number; value: HdQueryResult }>();
const inflight = new Map<string, Promise<HdQueryResult>>();
const TTL = 30_000;

export function queryKey(q: HdAnalyticsQuery): string {
  return JSON.stringify([q.measure, q.groupBy ?? [], q.filters ?? {}, q.range, q.compare ?? null, q.limit ?? 50, q.automated === true]);
}

export async function fetchQuery(q: HdAnalyticsQuery, fresh = false): Promise<HdQueryResult> {
  const key = queryKey(q);
  const hit = memo.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.value;
  const running = inflight.get(key);
  if (running && !fresh) return running;
  const p = sendJson<{ result: HdQueryResult }>("/api/helpdesk/analytics/query", "POST", q, "Couldn't run that report.")
    .then((d) => {
      memo.set(key, { at: Date.now(), value: d.result });
      return d.result;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** One report query; `refreshMs` re-runs it while the tab is visible (live tiles). */
export function useReportQuery(q: HdAnalyticsQuery | null, opts: { refreshMs?: number } = {}) {
  const [result, setResult] = useState<HdQueryResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(Boolean(q));
  const key = q ? queryKey(q) : "";
  const qRef = useRef(q);
  qRef.current = q;

  const run = useCallback(
    (fresh = false) => {
      const cur = qRef.current;
      if (!cur) return;
      setLoading(true);
      fetchQuery(cur, fresh)
        .then((r) => {
          if (qRef.current && queryKey(qRef.current) === queryKey(cur)) {
            setResult(r);
            setError("");
          }
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setLoading(false));
    },
    []
  );

  useEffect(() => {
    if (!key) return;
    const hit = memo.get(key);
    setResult(hit && Date.now() - hit.at < TTL ? hit.value : null);
    run();
    if (!opts.refreshMs) return;
    const t = setInterval(() => document.visibilityState === "visible" && run(true), opts.refreshMs);
    return () => clearInterval(t);
  }, [key, run, opts.refreshMs]);

  return { result, error, loading, reload: () => run(true) };
}

export function useReportOptions() {
  const [options, setOptions] = useState<ReportOptions | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    getJson<ReportOptions>("/api/helpdesk/analytics/options", "Couldn't load the report filters.")
      .then(setOptions)
      .catch((e: Error) => setError(e.message));
  }, []);
  return { options, error };
}

export async function listDashboards(): Promise<HdDashboard[]> {
  const d = await getJson<{ dashboards: HdDashboard[] }>("/api/helpdesk/analytics/dashboards", "Couldn't load the dashboards.");
  return d.dashboards;
}

export async function saveDashboard(id: number, patch: Partial<Pick<HdDashboard, "name" | "description" | "visibility" | "team_id" | "layout">> & { is_default?: boolean }): Promise<HdDashboard> {
  const d = await sendJson<{ dashboard: HdDashboard }>(`/api/helpdesk/analytics/dashboards/${id}`, "PATCH", patch, "Couldn't save the dashboard.");
  return d.dashboard;
}

export async function createDashboard(body: Partial<HdDashboard>): Promise<HdDashboard> {
  const d = await sendJson<{ dashboard: HdDashboard }>("/api/helpdesk/analytics/dashboards", "POST", body, "Couldn't create the dashboard.");
  return d.dashboard;
}

export async function duplicateDashboard(id: number): Promise<HdDashboard> {
  const d = await sendJson<{ dashboard: HdDashboard }>(`/api/helpdesk/analytics/dashboards/${id}/duplicate`, "POST", {}, "Couldn't duplicate the dashboard.");
  return d.dashboard;
}

export async function deleteDashboard(id: number): Promise<void> {
  await sendJson(`/api/helpdesk/analytics/dashboards/${id}`, "DELETE", undefined, "Couldn't delete the dashboard.");
}

/** Download a POSTed CSV (a widget's rows) as a file. */
export async function downloadQueryCsv(q: HdAnalyticsQuery, title: string): Promise<void> {
  const res = await fetch("/api/helpdesk/analytics/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...q, format: "csv", title }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error((d as { error?: string }).error || "Couldn't export that.");
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "report.csv";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
