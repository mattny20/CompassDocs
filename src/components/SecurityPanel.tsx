"use client";

// Account → Security: TOTP two-factor enrollment (QR → verify → recovery
// codes) and the active-sessions list with per-device and everywhere-else
// sign-out.

import { useState } from "react";
import type { SessionInfo } from "@/lib/db";

const field =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

interface TotpState {
  enabled: boolean;
  recovery_left: number;
}

export function SecurityPanel({
  initialSessions,
  initialTotp,
}: {
  initialSessions: SessionInfo[];
  initialTotp: TotpState;
}) {
  return (
    <div className="space-y-4">
      <TwoFactor initial={initialTotp} />
      <Sessions initial={initialSessions} />
    </div>
  );
}

// --- Two-factor auth -----------------------------------------------------------

function TwoFactor({ initial }: { initial: TotpState }) {
  const [totp, setTotp] = useState(initial);
  const [phase, setPhase] = useState<"idle" | "enrolling" | "recovery">("idle");
  const [qr, setQr] = useState("");
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[]>([]);
  const [disableCode, setDisableCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function post(body: unknown) {
    setBusy(true);
    setError("");
    const res = await fetch("/api/account/2fa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data?.error || "Something went wrong.");
      return null;
    }
    return data;
  }

  async function startEnroll() {
    const data = await post({ action: "setup" });
    if (!data) return;
    setQr(data.qr);
    setSecret(data.secret);
    setCode("");
    setPhase("enrolling");
  }

  async function confirmEnroll(e: React.FormEvent) {
    e.preventDefault();
    const data = await post({ action: "enable", code });
    if (!data) return;
    setRecovery(data.recovery_codes || []);
    setTotp({ enabled: true, recovery_left: (data.recovery_codes || []).length });
    setPhase("recovery");
  }

  async function disable(e: React.FormEvent) {
    e.preventDefault();
    const data = await post({ action: "disable", code: disableCode });
    if (!data) return;
    setTotp({ enabled: false, recovery_left: 0 });
    setDisableCode("");
    setPhase("idle");
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-surface p-6 shadow-sm">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold text-slate-900">Two-factor authentication</h2>
        {totp.enabled ? (
          <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">
            On
          </span>
        ) : (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
            Off
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Adds an authenticator-app code to password sign-ins. (Single sign-on users get MFA from
        their identity provider.)
      </p>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {!totp.enabled && phase === "idle" && (
        <button
          onClick={startEnroll}
          disabled={busy}
          className="mt-3 rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60"
        >
          {busy ? "Preparing…" : "Set up two-factor auth"}
        </button>
      )}

      {phase === "enrolling" && (
        <form onSubmit={confirmEnroll} className="mt-3">
          <div className="flex flex-wrap items-start gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt="Scan with your authenticator app" className="rounded-lg ring-1 ring-slate-200" />
            <div className="min-w-[240px] flex-1 space-y-2 text-sm text-slate-600">
              <p>
                1. Scan the QR code with your authenticator app (1Password, Google Authenticator,
                Microsoft Authenticator, …).
              </p>
              <p className="text-xs text-slate-400">
                Can&rsquo;t scan? Enter this key manually:{" "}
                <code className="break-all font-mono">{secret}</code>
              </p>
              <p>2. Enter the 6-digit code it shows:</p>
              <div className="flex gap-2">
                <input
                  className={`${field} max-w-[160px] text-center font-mono tracking-widest`}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  placeholder="000000"
                  autoFocus
                />
                <button
                  type="submit"
                  disabled={busy || code.replace(/\D/g, "").length !== 6}
                  className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60"
                >
                  {busy ? "Checking…" : "Turn on"}
                </button>
                <button
                  type="button"
                  onClick={() => setPhase("idle")}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </form>
      )}

      {phase === "recovery" && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="font-semibold text-amber-800">
            Two-factor auth is on. Save these recovery codes now — they&rsquo;re shown once.
          </p>
          <p className="mt-1 text-xs text-amber-700">
            Each works exactly once if you lose your authenticator.
          </p>
          <pre className="mt-2 grid grid-cols-2 gap-x-6 rounded bg-white p-3 font-mono text-[13px] leading-6 ring-1 ring-amber-200 sm:grid-cols-4">
            {recovery.join("\n")}
          </pre>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => navigator.clipboard.writeText(recovery.join("\n")).catch(() => {})}
              className="rounded-lg border border-amber-300 px-3 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
            >
              Copy codes
            </button>
            <button
              onClick={() => setPhase("idle")}
              className="rounded-lg bg-amber-600 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-700"
            >
              I&rsquo;ve saved them
            </button>
          </div>
        </div>
      )}

      {totp.enabled && phase === "idle" && (
        <form onSubmit={disable} className="mt-3">
          <p className="text-xs text-slate-400">
            {totp.recovery_left} recovery code{totp.recovery_left === 1 ? "" : "s"} left.
          </p>
          <div className="mt-2 flex gap-2">
            <input
              className={`${field} max-w-[220px] text-center font-mono`}
              value={disableCode}
              onChange={(e) => setDisableCode(e.target.value)}
              placeholder="code to turn off"
            />
            <button
              type="submit"
              disabled={busy || !disableCode}
              className="rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              Turn off 2FA
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// --- Active sessions -------------------------------------------------------------

function describeAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua) && /Version\//.test(ua)
          ? "Safari"
          : /Firefox\//.test(ua)
            ? "Firefox"
            : /curl|python|node/i.test(ua)
              ? "CLI / script"
              : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS X|Macintosh/.test(ua)
      ? "macOS"
      : /iPhone|iPad/.test(ua)
        ? "iOS"
        : /Android/.test(ua)
          ? "Android"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

function Sessions({ initial }: { initial: SessionInfo[] }) {
  const [sessions, setSessions] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function revoke(sid: string) {
    const res = await fetch(`/api/account/sessions?sid=${encodeURIComponent(sid)}`, {
      method: "DELETE",
    });
    if (res.ok) setSessions(sessions.filter((s) => s.sid !== sid));
  }

  async function revokeOthers() {
    if (!confirm("Sign out everywhere else? All other devices will need to sign in again.")) return;
    setBusy(true);
    const res = await fetch("/api/account/sessions?others=1", { method: "DELETE" });
    setBusy(false);
    if (res.ok) setSessions(sessions.filter((s) => s.current));
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-surface p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-900">Active sessions</h2>
        {sessions.length > 1 && (
          <button
            onClick={revokeOthers}
            disabled={busy}
            className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            {busy ? "Signing out…" : "Sign out everywhere else"}
          </button>
        )}
      </div>
      <ul className="mt-2 divide-y divide-slate-100">
        {sessions.map((s) => (
          <li key={s.sid} className="flex items-center gap-3 py-2.5 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium text-slate-800">
                {describeAgent(s.user_agent)}
                {s.current && (
                  <span className="ml-2 rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">
                    This device
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-400">
                {s.ip ? `${s.ip} · ` : ""}signed in {new Date(s.created_at).toLocaleString()}
              </div>
            </div>
            {!s.current && (
              <button
                onClick={() => revoke(s.sid)}
                className="shrink-0 rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
              >
                Sign out
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
