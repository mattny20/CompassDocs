"use client";

// Settings → Newsletter: who can use the module. A per-user capability, not a
// new org role — None (no access), Contributor (write + submit drafts), or
// Approver (review, approve, send). Admins always have full access.

import { useState } from "react";
import Link from "next/link";
import { Mail } from "lucide-react";

interface PersonRow {
  id: number;
  username: string;
  name: string;
  email: string;
  role: string;
  status: string;
  newsletter_role: string;
}

export function NewsletterPeople({ initial }: { initial: PersonRow[] }) {
  const [rows, setRows] = useState(initial);
  const [busyId, setBusyId] = useState(0);
  const [error, setError] = useState("");

  async function setRole(userId: number, role: string) {
    setBusyId(userId);
    setError("");
    const res = await fetch("/api/admin/newsletter/people", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, newsletter_role: role }),
    });
    setBusyId(0);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data?.error || "Couldn't update.");
      return;
    }
    setRows((prev) => prev.map((r) => (r.id === userId ? { ...r, newsletter_role: role } : r)));
  }

  const contributors = rows.filter((r) => r.newsletter_role === "contributor").length;
  const approvers = rows.filter((r) => r.newsletter_role === "approver").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Newsletter</h1>
        <p className="mt-1 text-sm text-slate-500">
          Grant people access to the newsletter module without a new org role.
          Contributors write drafts and submit them for review; approvers also review,
          approve, and send. Admins always have full access.
        </p>
      </div>

      <div className="flex items-center justify-between rounded-lg border border-compass-200 bg-compass-50 px-3 py-2 text-sm text-compass-800">
        <span>
          {approvers} approver{approvers === 1 ? "" : "s"} · {contributors} contributor
          {contributors === 1 ? "" : "s"} (plus all admins)
        </span>
        <Link
          href="/newsletter"
          className="inline-flex items-center gap-1.5 font-medium text-compass-700 underline hover:text-compass-900"
        >
          <Mail className="h-4 w-4" /> Open the newsletter workspace
        </Link>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-surface shadow-sm">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-xs uppercase tracking-wider text-slate-400">
              <th className="px-4 py-3 font-medium">Person</th>
              <th className="px-4 py-3 font-medium">Org role</th>
              <th className="px-4 py-3 font-medium">Newsletter access</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.id} className={r.status !== "active" ? "opacity-50" : ""}>
                <td className="px-4 py-2.5">
                  <p className="font-medium text-slate-800">{r.name}</p>
                  <p className="text-xs text-slate-400">
                    {r.username}
                    {r.status !== "active" ? " · disabled" : ""}
                  </p>
                </td>
                <td className="px-4 py-2.5 capitalize text-slate-600">{r.role}</td>
                <td className="px-4 py-2.5">
                  {r.role === "admin" ? (
                    <span className="text-slate-500">Full access (admin)</span>
                  ) : (
                    <select
                      value={r.newsletter_role}
                      disabled={busyId === r.id}
                      onChange={(e) => setRole(r.id, e.target.value)}
                      className="rounded-lg border border-slate-200 bg-surface px-2 py-1.5 text-sm outline-none focus:border-compass-400"
                    >
                      <option value="none">None</option>
                      <option value="contributor">Contributor</option>
                      <option value="approver">Approver</option>
                    </select>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
