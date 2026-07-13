"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SecureCookieMode } from "@/lib/settings";

const field =
  "w-full rounded-lg border border-slate-200 px-3 py-2 outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

export function SetupForm({ enterprise = false }: { enterprise?: boolean }) {
  const router = useRouter();
  const [companyName, setCompanyName] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [secureCookies, setSecureCookies] = useState<SecureCookieMode>("auto");
  const [licenseKey, setLicenseKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          name,
          email,
          password,
          company_name: companyName,
          secure_cookies: secureCookies,
          ...(enterprise && licenseKey.trim() ? { license_key: licenseKey.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Setup failed.");
      router.push("/");
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
        <span className="mb-1 block text-sm font-medium text-slate-600">
          Company / workspace name <span className="font-normal text-slate-400">(optional)</span>
        </span>
        <input
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          placeholder="CompassDocs"
          maxLength={80}
          className={field}
        />
      </label>

      <div className="border-t border-slate-100 pt-4">
        <p className="mb-3 text-sm font-medium text-slate-700">Your admin account</p>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-600">Full name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                placeholder="Jane Doe"
                className={field}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-600">Username</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                autoComplete="username"
                placeholder="jane"
                className={field}
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-600">
              Email <span className="font-normal text-slate-400">(optional)</span>
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="jane@company.com"
              className={field}
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-600">Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                placeholder="At least 8 characters"
                className={field}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-600">Confirm password</span>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                className={field}
              />
            </label>
          </div>
        </div>
      </div>

      {enterprise && (
        <div className="border-t border-slate-100 pt-4">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-600">
              Enterprise license key <span className="font-normal text-slate-400">(optional)</span>
            </span>
            <textarea
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value)}
              placeholder="Paste your license key to activate Enterprise features now — or add it later under Settings → License."
              className={`${field} h-20 font-mono text-xs`}
              spellCheck={false}
            />
          </label>
        </div>
      )}

      <div className="border-t border-slate-100 pt-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-600">
            How will you reach this server?
          </span>
          <select
            value={secureCookies}
            onChange={(e) => setSecureCookies(e.target.value as SecureCookieMode)}
            className={field}
          >
            <option value="auto">Automatic — detect HTTP vs HTTPS (recommended)</option>
            <option value="always">Always over HTTPS (I have a certificate)</option>
            <option value="never">Plain HTTP only (internal / no HTTPS)</option>
          </select>
          <span className="mt-1 block text-xs text-slate-400">
            Controls the login cookie&rsquo;s <code className="font-mono">Secure</code> flag.
            Leave on Automatic unless you&rsquo;re sure — you can change it later under
            Settings → Domain &amp; HTTPS.
          </span>
        </label>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-compass-600 px-4 py-2 font-semibold text-white shadow-sm transition hover:bg-compass-700 disabled:opacity-60"
      >
        {loading ? "Creating…" : "Create account & get started"}
      </button>
    </form>
  );
}
