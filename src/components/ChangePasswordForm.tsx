"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ChangePasswordForm({ forced }: { forced: boolean }) {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next.length < 6) return setError("New password must be at least 6 characters.");
    if (next !== confirm) return setError("New passwords don't match.");
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not change password.");
      router.push("/");
      router.refresh();
    } catch (e: any) {
      setError(e.message);
      setLoading(false);
    }
  }

  const field =
    "w-full rounded-lg border border-slate-200 px-3 py-2 outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-600">Current password</span>
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" className={field} />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-600">New password</span>
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" className={field} />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-600">Confirm new password</span>
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" className={field} />
      </label>
      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-compass-600 px-4 py-2 font-semibold text-white shadow-sm transition hover:bg-compass-700 disabled:opacity-60"
      >
        {loading ? "Saving…" : forced ? "Set password & continue" : "Update password"}
      </button>
    </form>
  );
}
