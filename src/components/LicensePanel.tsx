"use client";

import { useEffect, useState } from "react";

interface FeatureRow {
  key: string;
  label: string;
  bundled: boolean;
  licensed: boolean;
  active: boolean;
}
interface LicenseView {
  edition: "enterprise" | "community";
  source: "settings" | "env" | "none";
  status: "none" | "invalid" | "active" | "grace" | "expired";
  reason?: string;
  daysLeft?: number;
  license: { customer: string; plan: string; seats: number; issued: string; expires: string } | null;
  seatsUsed: number;
  features: FeatureRow[];
}

const field =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

const STATUS_TONE: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  grace: "bg-amber-100 text-amber-800",
  expired: "bg-red-100 text-red-700",
  invalid: "bg-red-100 text-red-700",
  none: "bg-slate-100 text-slate-600",
};
const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  grace: "In grace period",
  expired: "Expired",
  invalid: "Invalid",
  none: "No license",
};

export function LicensePanel() {
  const [v, setV] = useState<LicenseView | null>(null);
  const [key, setKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    const res = await fetch("/api/admin/license");
    if (res.ok) setV(await res.json());
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  async function send(payload: Record<string, unknown>) {
    setSaving(true);
    setError("");
    setSaved(false);
    const res = await fetch("/api/admin/license", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setSaving(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data?.error || "Could not save.");
      return;
    }
    if (data?.state) setV(data.state);
    setSaved(true);
  }

  async function save() {
    if (!key.trim()) return;
    await send({ license_key: key.trim() });
    setKey("");
  }
  async function remove() {
    if (!confirm("Remove the license? Enterprise features will turn off.")) return;
    await send({ clear: true });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">License</h2>
        <p className="mt-1 text-sm text-slate-500">
          Activate CompassDocs Enterprise features with your license key. The core app is free and
          open-source and never requires one.
        </p>
      </div>

      {loading && <p className="text-sm text-slate-400">Loading…</p>}

      {v && (
        <>
          {/* Edition + status banner */}
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                v.edition === "enterprise"
                  ? "bg-compass-100 text-compass-700"
                  : "bg-slate-100 text-slate-600"
              }`}
            >
              {v.edition === "enterprise" ? "Enterprise build" : "Community build"}
            </span>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_TONE[v.status]}`}>
              {STATUS_LABEL[v.status]}
              {(v.status === "active" || v.status === "grace") && v.daysLeft != null
                ? ` · ${v.daysLeft}d left`
                : ""}
            </span>
            {v.source === "env" && (
              <span className="text-xs text-slate-400">from COMPASSDOCS_LICENSE_KEY</span>
            )}
          </div>

          {v.edition === "community" && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
              This is the community build — it doesn&rsquo;t contain enterprise code, so a license
              won&rsquo;t unlock features here. Run the enterprise image to use them.
            </div>
          )}
          {v.status === "invalid" && v.reason && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {v.reason}
            </div>
          )}
          {v.status === "grace" && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Your license has expired but is in a grace period. Renew to avoid losing enterprise
              features.
            </div>
          )}

          {/* License details */}
          {v.license && (
            <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
              <h3 className="mb-3 font-semibold text-slate-900">Details</h3>
              <dl className="grid gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
                <Row label="Customer" value={v.license.customer} />
                <Row label="Plan" value={v.license.plan} />
                <Row
                  label="Seats"
                  value={
                    v.license.seats === 0
                      ? `${v.seatsUsed} used · unlimited`
                      : `${v.seatsUsed} / ${v.license.seats}`
                  }
                />
                <Row label="Issued" value={v.license.issued} />
                <Row label="Expires" value={v.license.expires} />
              </dl>
            </div>
          )}

          {/* Entitlements */}
          <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
            <h3 className="mb-3 font-semibold text-slate-900">Enterprise features</h3>
            <ul className="space-y-2">
              {v.features.map((f) => (
                <li key={f.key} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-slate-700">{f.label}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      f.active
                        ? "bg-green-100 text-green-700"
                        : "bg-slate-100 text-slate-500"
                    }`}
                    title={
                      f.active
                        ? "Enabled"
                        : !f.bundled
                          ? "Not in this build"
                          : !f.licensed
                            ? "Not in your license"
                            : "Off"
                    }
                  >
                    {f.active ? "Enabled" : !f.licensed ? "Not licensed" : "Not in build"}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Key entry */}
          <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold text-slate-900">
                {v.status === "none" ? "Add a license" : "Replace license"}
              </h3>
              {v.source === "settings" && (
                <button
                  onClick={remove}
                  disabled={saving}
                  className="text-xs font-medium text-red-600 hover:underline disabled:opacity-60"
                >
                  Remove
                </button>
              )}
            </div>
            <textarea
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setSaved(false);
              }}
              className={`${field} h-24 font-mono text-xs`}
              placeholder="Paste your license key…"
              spellCheck={false}
            />
            <div className="mt-3 flex items-center gap-3">
              <button
                onClick={save}
                disabled={saving || !key.trim()}
                className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-compass-700 disabled:opacity-60"
              >
                {saving ? "Saving…" : "Activate"}
              </button>
              {saved && <span className="text-sm text-green-600">✓ Saved</span>}
              {error && <span className="text-sm text-red-600">{error}</span>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-100 py-1 last:border-0 sm:border-0">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-800">{value}</dd>
    </div>
  );
}
