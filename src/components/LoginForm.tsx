"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LoginForm({ next = "/" }: { next?: string }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
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
        body: JSON.stringify({
          username,
          password,
          ...(needsTotp && totpCode ? { totp_code: totpCode } : {}),
        }),
      });
      const data = await res.json();
      if (data?.totp_required) {
        // Correct password, 2FA account: reveal the code field.
        setNeedsTotp(true);
        setTotpCode("");
        setError(data?.error || "");
        setLoading(false);
        return;
      }
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
      {!needsTotp ? (
        <>
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
        </>
      ) : (
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-600">
            Two-factor code
          </span>
          <input
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value)}
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6-digit code or recovery code"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-center font-mono tracking-widest outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100"
          />
          <span className="mt-1 block text-xs text-slate-400">
            From your authenticator app — or one of your recovery codes.
          </span>
        </label>
      )}
      <button
        type="submit"
        disabled={loading || (needsTotp && !totpCode)}
        className="w-full rounded-lg bg-compass-600 px-4 py-2 font-semibold text-white shadow-sm transition hover:bg-compass-700 disabled:opacity-60"
      >
        {loading ? "Signing in…" : needsTotp ? "Verify" : "Sign in"}
      </button>
      {needsTotp && (
        <button
          type="button"
          onClick={() => {
            setNeedsTotp(false);
            setTotpCode("");
            setError("");
          }}
          className="w-full text-center text-xs font-medium text-slate-400 hover:text-slate-600"
        >
          ← Back
        </button>
      )}
    </form>
  );
}
