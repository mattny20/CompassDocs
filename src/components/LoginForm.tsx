"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LoginForm({ next = "/" }: { next?: string }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Sign in failed.");
      router.push(data.must_change_password ? "/account/password" : next);
      router.refresh();
    } catch (e: any) {
      setError(e.message);
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-600">Username</span>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          autoComplete="username"
          className="w-full rounded-lg border border-slate-200 px-3 py-2 outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-600">Password</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="w-full rounded-lg border border-slate-200 px-3 py-2 outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100"
        />
      </label>
      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-compass-600 px-4 py-2 font-semibold text-white shadow-sm transition hover:bg-compass-700 disabled:opacity-60"
      >
        {loading ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
