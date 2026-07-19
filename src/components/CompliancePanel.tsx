"use client";

// Central compliance portal: org-wide acknowledgement progress across every
// policy, per-user standing, request-acknowledgement for any published doc,
// and one-click reminders to stragglers. Enterprise (policy_ack).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ShieldCheck,
  FileCheck,
  Users,
  CircleAlert,
  Percent,
  Download,
  Send,
  BellRing,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  Check,
  CircleDashed,
} from "lucide-react";
import { timeAgo } from "@/lib/ui";

interface DocRow {
  id: number;
  title: string;
  space_name: string;
  space_icon: string;
  updated_at: string;
  ack_last_reminded_at: string | null;
  required: number;
  acked: number;
}

export function CompliancePanel({ licensed }: { licensed: boolean }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [detail, setDetail] = useState<Record<number, any[]>>({});
  const [candidate, setCandidate] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/compliance");
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || "Failed to load.");
      setData(d);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    if (licensed) void load();
  }, [licensed, load]);

  async function act(docId: number, action: "request" | "remind", label: string) {
    setBusy(`${action}-${docId}`);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/admin/compliance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId, action }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || "Request failed.");
      setNotice(
        `${label}: ${d.pending} ${d.pending === 1 ? "person" : "people"} notified` +
          (d.emailed ? ` (${d.emailed} by email)` : "") +
          "."
      );
      setCandidate("");
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function toggleDetail(docId: number) {
    if (open === docId) {
      setOpen(null);
      return;
    }
    setOpen(docId);
    if (!detail[docId]) {
      const res = await fetch(`/api/documents/${docId}/acknowledgements`);
      if (res.ok) {
        const d = await res.json();
        setDetail((prev) => ({ ...prev, [docId]: d.rows ?? d.acks ?? d }));
      }
    }
  }

  if (!licensed) {
    return (
      <div>
        <Header />
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500 dark:bg-slate-800/40">
          The compliance portal requires an enterprise license with the{" "}
          <code className="text-xs">policy_ack</code> entitlement.
        </p>
      </div>
    );
  }

  const k = data?.kpis;
  return (
    <div>
      <Header
        extra={
          <a
            href="/api/admin/compliance?format=csv"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            <Download className="h-4 w-4" /> Export CSV
          </a>
        }
      />

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/40">
          {notice}
        </div>
      )}

      {!data ? (
        <div className="flex items-center gap-2 py-10 text-sm text-slate-400">
          <LoaderCircle className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-5">
          {/* KPIs */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { icon: <FileCheck className="h-4 w-4" />, label: "Policies requiring acknowledgement", value: k.policies },
              { icon: <Percent className="h-4 w-4" />, label: "Overall compliance", value: `${k.pct}%` },
              { icon: <Users className="h-4 w-4" />, label: "Fully compliant people", value: `${k.users_compliant}/${k.users_total}` },
              { icon: <CircleAlert className="h-4 w-4" />, label: "Outstanding acknowledgements", value: k.outstanding },
            ].map((c) => (
              <div key={c.label} className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-compass-50 text-compass-600 dark:bg-compass-950/50">
                  {c.icon}
                </span>
                <div className="mt-2 text-2xl font-bold tracking-tight text-slate-900">{c.value}</div>
                <div className="text-xs text-slate-400">{c.label}</div>
              </div>
            ))}
          </div>

          {/* Request acknowledgement */}
          <section className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
              <Send className="h-4 w-4 text-compass-600" /> Request acknowledgement
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">
              Pick a published document — everyone who can see it gets a dashboard notice and an
              email asking them to read and acknowledge it. Compliance emails are sent regardless
              of personal notification settings.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                value={candidate}
                onChange={(e) => setCandidate(e.target.value)}
                className="min-w-64 rounded-lg border border-slate-200 bg-surface px-2.5 py-1.5 text-sm text-slate-600 outline-none focus:border-compass-400"
              >
                <option value="">Choose a document…</option>
                {data.candidates.map((c: any) => (
                  <option key={c.id} value={c.id}>
                    {c.space_icon} {c.space_name} — {c.title}
                  </option>
                ))}
              </select>
              <button
                onClick={() => candidate && act(Number(candidate), "request", "Acknowledgement requested")}
                disabled={!candidate || busy !== null}
                className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60"
              >
                {busy?.startsWith("request") ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                Request acknowledgement
              </button>
            </div>
          </section>

          {/* Per-policy progress */}
          <section className="overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-sm">
            <div className="border-b border-slate-100 px-4 py-3">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
                <FileCheck className="h-4 w-4 text-compass-600" /> Policy progress
              </h2>
            </div>
            {data.docs.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-slate-400">
                No documents require acknowledgement yet — request one above.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {(data.docs as DocRow[]).map((d) => {
                  const pct = d.required ? Math.round((d.acked / d.required) * 100) : 100;
                  const complete = d.acked >= d.required;
                  return (
                    <li key={d.id}>
                      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                        <button
                          onClick={() => toggleDetail(d.id)}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                          {open === d.id ? (
                            <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
                          ) : (
                            <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
                          )}
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-slate-800">
                              {d.space_icon} {d.title}
                            </span>
                            <span className="block text-xs text-slate-400">
                              Revision of {new Date(d.updated_at).toLocaleDateString()} ·{" "}
                              {d.ack_last_reminded_at
                                ? `last reminded ${timeAgo(d.ack_last_reminded_at)}`
                                : "never reminded"}
                            </span>
                          </span>
                        </button>
                        <div className="w-40">
                          <div className="mb-0.5 flex justify-between text-xs">
                            <span className={complete ? "font-medium text-emerald-600" : "text-slate-500"}>
                              {d.acked}/{d.required}
                            </span>
                            <span className="text-slate-400">{pct}%</span>
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                            <div
                              className={`h-full rounded-full ${complete ? "bg-emerald-500" : "bg-compass-500"}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {!complete && (
                            <button
                              onClick={() => act(d.id, "remind", "Reminder sent")}
                              disabled={busy !== null}
                              title="Notify everyone who hasn't acknowledged yet"
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                            >
                              {busy === `remind-${d.id}` ? (
                                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <BellRing className="h-3.5 w-3.5" />
                              )}
                              Remind
                            </button>
                          )}
                          <a
                            href={`/api/documents/${d.id}/acknowledgements?format=csv`}
                            title="Download this policy's compliance record"
                            className="inline-flex items-center rounded-md border border-slate-200 p-1.5 text-slate-400 hover:text-slate-600"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </a>
                        </div>
                      </div>
                      {open === d.id && (
                        <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-3 dark:bg-slate-800/30">
                          {!detail[d.id] ? (
                            <div className="flex items-center gap-2 text-sm text-slate-400">
                              <LoaderCircle className="h-4 w-4 animate-spin" /> Loading…
                            </div>
                          ) : (
                            <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
                              {(detail[d.id] as any[]).map((r) => (
                                <li key={r.username} className="flex items-center gap-1.5 text-sm">
                                  {r.acknowledged_at ? (
                                    <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                                  ) : (
                                    <CircleDashed className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                                  )}
                                  <span className="truncate text-slate-700">{r.name || r.username}</span>
                                  <span className="ml-auto shrink-0 text-xs text-slate-400">
                                    {r.acknowledged_at ? timeAgo(r.acknowledged_at) : "pending"}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Per-user standing */}
          <section className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-800">
              <Users className="h-4 w-4 text-compass-600" /> People
            </h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="pb-2 font-medium">Person</th>
                  <th className="pb-2 text-right font-medium">Required</th>
                  <th className="pb-2 text-right font-medium">Acknowledged</th>
                  <th className="pb-2 text-right font-medium">Standing</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.users
                  .filter((u: any) => u.required > 0)
                  .map((u: any) => (
                    <tr key={u.id}>
                      <td className="py-2 pr-2 font-medium text-slate-700">
                        {u.name || u.username}
                        <span className="ml-1.5 text-xs font-normal text-slate-400">{u.role}</span>
                      </td>
                      <td className="py-2 text-right text-slate-400">{u.required}</td>
                      <td className="py-2 text-right text-slate-600">{u.acked}</td>
                      <td className="py-2 text-right">
                        {u.acked >= u.required ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/50">
                            <Check className="h-3 w-3" /> Compliant
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/50">
                            <CircleAlert className="h-3 w-3" /> {u.required - u.acked} outstanding
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </div>
  );
}

function Header({ extra }: { extra?: React.ReactNode }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-3">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold text-slate-900">
          <ShieldCheck className="h-5 w-5 text-compass-600" /> Compliance
          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-900/50">
            Enterprise
          </span>
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Acknowledgement progress across every policy — who has read what, and who still owes a
          confirmation.
        </p>
      </div>
      {extra}
    </div>
  );
}
