"use client";

// The Status page: every tracked SaaS tool with its live state, incident
// timelines, and (for approvers/admins) manual incident comms + service
// management. Data arrives server-rendered; mutations refresh the route.

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Wrench,
  CircleHelp,
  ExternalLink,
  LoaderCircle,
  Megaphone,
  Trash2,
} from "lucide-react";
import type { StatusIncident, StatusService } from "@/lib/db";

const BADGE: Record<string, { label: string; dot: string; chip: string; icon: typeof CheckCircle2 }> = {
  operational: { label: "Operational", dot: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50", icon: CheckCircle2 },
  degraded: { label: "Degraded", dot: "bg-amber-500", chip: "bg-amber-50 text-amber-700 dark:bg-amber-950/50", icon: AlertTriangle },
  outage: { label: "Outage", dot: "bg-red-500", chip: "bg-red-50 text-red-700 dark:bg-red-950/50", icon: XCircle },
  maintenance: { label: "Maintenance", dot: "bg-sky-500", chip: "bg-sky-50 text-sky-700 dark:bg-sky-950/50", icon: Wrench },
  unknown: { label: "Unknown", dot: "bg-slate-300", chip: "bg-slate-100 text-slate-500 dark:bg-slate-800", icon: CircleHelp },
};

type CatalogEntry = { name: string; provider: string; source_url: string };

export function StatusBoard({
  services,
  incidents,
  catalog,
  isAdmin,
  isApprover,
}: {
  services: StatusService[];
  incidents: StatusIncident[];
  catalog: CatalogEntry[];
  isAdmin: boolean;
  isApprover: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState("");
  const [customName, setCustomName] = useState("");
  const [customProvider, setCustomProvider] = useState<"statuspage" | "rss" | "manual">("statuspage");
  const [customUrl, setCustomUrl] = useState("");
  const [declaring, setDeclaring] = useState(false);
  const [incServiceId, setIncServiceId] = useState<number | "">("");
  const [incTitle, setIncTitle] = useState("");
  const [incSeverity, setIncSeverity] = useState("outage");
  const [incBody, setIncBody] = useState("");
  const [updateDrafts, setUpdateDrafts] = useState<Record<number, string>>({});

  const tracked = new Set(services.map((s) => s.name));
  const available = catalog.filter((c) => !tracked.has(c.name));
  const problems = services.filter((s) => ["degraded", "outage", "maintenance"].includes(s.status));
  const open = incidents.filter((i) => i.state === "open");
  const resolved = incidents.filter((i) => i.state === "resolved").slice(0, 10);
  const serviceName = (id: number) => services.find((s) => s.id === id)?.name ?? "Service";

  async function api(url: string, body?: object, method = "POST"): Promise<boolean> {
    setBusy(true);
    setError("");
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    setBusy(false);
    if (res.ok) {
      router.refresh();
      return true;
    }
    setError((await res.json().catch(() => null))?.error || "Something went wrong.");
    return false;
  }

  async function addService() {
    const entry = pick ? catalog.find((c) => c.name === pick) : null;
    const payload = entry ?? { name: customName.trim(), provider: customProvider, source_url: customUrl.trim() };
    if (!payload.name) return setError("Pick a service or give the custom one a name.");
    if (await api("/api/admin/status", payload)) {
      setAdding(false);
      setPick("");
      setCustomName("");
      setCustomUrl("");
    }
  }

  async function declare() {
    if (incServiceId === "" || !incTitle.trim()) return setError("Pick a service and a title.");
    if (
      await api("/api/status/incidents", {
        action: "declare",
        service_id: incServiceId,
        title: incTitle.trim(),
        severity: incSeverity,
        body: incBody.trim(),
      })
    ) {
      setDeclaring(false);
      setIncTitle("");
      setIncBody("");
      setIncServiceId("");
    }
  }

  const input =
    "rounded-lg border border-slate-200 bg-surface px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-compass-400 focus:outline-none";
  const btn =
    "rounded-lg bg-compass-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-compass-700 disabled:opacity-50 print:hidden";
  const chipBtn =
    "shrink-0 whitespace-nowrap rounded-lg border border-slate-200 bg-surface px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 print:hidden";

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div
        className={`flex items-center gap-3 rounded-xl border p-4 ${
          open.length || problems.some((p) => p.status === "outage")
            ? "border-red-200 bg-red-50 dark:border-red-900/60 dark:bg-red-950/30"
            : problems.length
              ? "border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30"
              : "border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/30"
        }`}
      >
        <Activity className="h-5 w-5 shrink-0 text-slate-500" />
        <div className="min-w-0">
          <div className="font-semibold text-slate-900">
            {open.length || problems.length
              ? `${open.length + problems.length} service issue${open.length + problems.length === 1 ? "" : "s"} right now`
              : "All tracked services are operational"}
          </div>
          <div className="text-xs text-slate-500">
            {services.length} service{services.length === 1 ? "" : "s"} tracked · checked about every 5 minutes
          </div>
        </div>
        {isApprover && (
          <button onClick={() => setDeclaring((v) => !v)} className={`${chipBtn} ml-auto`}>
            {"＋ Declare incident"}
          </button>
        )}
      </div>

      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {/* Declare form */}
      {declaring && isApprover && (
        <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-900">
            <Megaphone className="h-4 w-4 text-compass-600" /> Declare an incident
          </h3>
          <p className="mb-3 text-xs text-slate-500">
            For anything without a vendor status page — the phone system, an on-prem server. Everyone
            gets a notification now and again when you resolve it.
          </p>
          <div className="flex flex-wrap gap-2">
            <select
              value={incServiceId}
              onChange={(e) => setIncServiceId(e.target.value === "" ? "" : Number(e.target.value))}
              className={input}
              aria-label="Affected service"
            >
              <option value="">Affected service…</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select value={incSeverity} onChange={(e) => setIncSeverity(e.target.value)} className={input} aria-label="Severity">
              <option value="outage">Outage</option>
              <option value="degraded">Degraded</option>
              <option value="maintenance">Maintenance</option>
            </select>
            <input
              value={incTitle}
              onChange={(e) => setIncTitle(e.target.value)}
              placeholder="What's happening? (e.g. Phones are down)"
              className={`${input} min-w-56 flex-1`}
            />
          </div>
          <textarea
            value={incBody}
            onChange={(e) => setIncBody(e.target.value)}
            placeholder="First update (optional) — what you know, what to do meanwhile…"
            rows={2}
            className={`${input} mt-2 w-full`}
          />
          <div className="mt-2 flex gap-2">
            <button onClick={declare} disabled={busy} className={btn}>
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "Declare"}
            </button>
            <button onClick={() => setDeclaring(false)} className="px-2 text-sm text-slate-500 hover:text-slate-700">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Open incidents */}
      {open.map((inc) => (
        <div key={inc.id} className="rounded-xl border border-red-200 bg-surface p-4 shadow-xs dark:border-red-900/60">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${BADGE[inc.severity]?.chip ?? BADGE.outage.chip}`}>
              {BADGE[inc.severity]?.label ?? inc.severity}
            </span>
            <span className="font-semibold text-slate-900">
              {serviceName(inc.service_id)} — {inc.title}
            </span>
            <span className="text-xs text-slate-400">declared by {inc.created_by}</span>
            {isApprover && (
              <button
                onClick={() => api("/api/status/incidents", { action: "resolve", incident_id: inc.id })}
                disabled={busy}
                className={`${chipBtn} ml-auto`}
              >
                Mark resolved
              </button>
            )}
          </div>
          {inc.updates.length > 0 && (
            <ol className="mt-3 space-y-2 border-l-2 border-slate-100 pl-3">
              {inc.updates.map((u) => (
                <li key={u.id} className="text-sm">
                  <span className="text-slate-700">{u.body}</span>
                  <span className="ml-2 text-xs text-slate-400">
                    {u.author} · {new Date(u.created_at).toLocaleString()}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {isApprover && (
            <div className="mt-3 flex gap-2">
              <input
                value={updateDrafts[inc.id] ?? ""}
                onChange={(e) => setUpdateDrafts((d) => ({ ...d, [inc.id]: e.target.value }))}
                placeholder="Post an update…"
                className={`${input} flex-1`}
              />
              <button
                onClick={async () => {
                  const text = (updateDrafts[inc.id] ?? "").trim();
                  if (!text) return;
                  if (await api("/api/status/incidents", { action: "update", incident_id: inc.id, body: text })) {
                    setUpdateDrafts((d) => ({ ...d, [inc.id]: "" }));
                  }
                }}
                disabled={busy}
                className={btn}
              >
                Post
              </button>
            </div>
          )}
        </div>
      ))}

      {/* Services */}
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-xs">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Tracked services</h2>
          {isAdmin && (
            <button onClick={() => setAdding((v) => !v)} className={chipBtn}>
              {"＋ Track a service"}
            </button>
          )}
        </div>

        {adding && isAdmin && (
          <div className="space-y-2 border-b border-slate-100 bg-slate-50/60 px-4 py-3 dark:bg-slate-900/30">
            <div className="flex flex-wrap items-center gap-2">
              <select value={pick} onChange={(e) => setPick(e.target.value)} className={input} aria-label="Catalog service">
                <option value="">From the catalog…</option>
                {available.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
              <span className="text-xs text-slate-400">or custom:</span>
              <input
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="Name (e.g. Phone system)"
                className={input}
                disabled={!!pick}
              />
              <select
                value={customProvider}
                onChange={(e) => setCustomProvider(e.target.value as any)}
                className={input}
                disabled={!!pick}
                aria-label="Provider"
              >
                <option value="statuspage">Statuspage JSON</option>
                <option value="rss">RSS / Atom feed</option>
                <option value="manual">Manual (internal system)</option>
              </select>
              {customProvider !== "manual" && !pick && (
                <input
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  placeholder="https://status.example.com"
                  className={`${input} min-w-56 flex-1`}
                />
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={addService} disabled={busy} className={btn}>
                Track
              </button>
              <button onClick={() => setAdding(false)} className="px-2 text-sm text-slate-500 hover:text-slate-700">
                Cancel
              </button>
            </div>
          </div>
        )}

        {services.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">
            Nothing tracked yet{isAdmin ? " — add the tools your organization relies on." : "."}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {services.map((s) => {
              const b = BADGE[s.status] ?? BADGE.unknown;
              return (
                <li key={s.id} className="group flex items-center gap-3 px-4 py-3">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${b.dot}`} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-800">{s.name}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${b.chip}`}>{b.label}</span>
                      {s.provider === "manual" && (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500 dark:bg-slate-800">
                          internal
                        </span>
                      )}
                    </div>
                    {s.status_detail && <div className="truncate text-xs text-slate-500">{s.status_detail}</div>}
                  </div>
                  {s.last_checked_at && (
                    <span className="hidden shrink-0 text-xs text-slate-400 sm:block" title={new Date(s.last_checked_at).toLocaleString()}>
                      checked {new Date(s.last_checked_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    </span>
                  )}
                  {s.status_url && (
                    <a
                      href={s.status_url}
                      target="_blank"
                      rel="noreferrer noopener"
                      data-tt="Vendor status page" aria-label="Vendor status page"
                      className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  )}
                  {/* Hidden-until-hover, but only where hovering exists: Tailwind wraps
                      group-hover in `@media (hover:hover)`, so on a coarse pointer it
                      never fires and an ungated `opacity-0` hides this button forever on
                      phones and tablets. Keyboard users get it back via focus-visible —
                      the same shape VideoPlayer already uses. */}
                  {isAdmin && (
                    <button
                      onClick={() => {
                        if (confirm(`Stop tracking ${s.name}?`)) void api(`/api/admin/status?id=${s.id}`, undefined, "DELETE");
                      }}
                      title="Stop tracking"
                      aria-label={`Stop tracking ${s.name}`}
                      className="shrink-0 rounded-md p-1.5 text-slate-300 transition hover:bg-red-50 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:opacity-0"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Recent resolved incidents */}
      {resolved.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Recently resolved</h2>
          <ul className="space-y-1.5">
            {resolved.map((inc) => (
              <li key={inc.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                <span className="font-medium text-slate-700">
                  {serviceName(inc.service_id)} — {inc.title}
                </span>
                <span className="ml-auto text-xs text-slate-400">
                  {inc.resolved_at ? new Date(inc.resolved_at).toLocaleString() : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
