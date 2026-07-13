"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { TlsMode } from "@/lib/settings";

interface ProxyStatus {
  managed: boolean;
  reachable: boolean;
}

interface DomainState {
  custom_domain: string;
  tls_mode: TlsMode;
  tls_email: string;
  has_custom_cert: boolean;
  proxy: ProxyStatus;
}

const field =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

const TLS_OPTIONS: { value: TlsMode; label: string; hint: string }[] = [
  {
    value: "auto",
    label: "Automatic HTTPS (Let's Encrypt)",
    hint: "Free certificate, auto-renewed. The domain must be public and resolve to this server, with ports 80 and 443 reachable.",
  },
  {
    value: "internal",
    label: "Self-signed (internal CA)",
    hint: "For LAN or testing. Browsers show a warning unless you trust Caddy's local CA.",
  },
  {
    value: "custom",
    label: "Bring your own certificate",
    hint: "Paste a PEM certificate (with any chain) and private key. You're responsible for renewals.",
  },
  {
    value: "off",
    label: "Plain HTTP (terminate TLS elsewhere)",
    hint: "Serve HTTP only — use when a load balancer or Cloudflare already handles HTTPS in front of this server.",
  },
];

export function DomainSettings({ initial }: { initial: DomainState }) {
  const router = useRouter();
  const [domain, setDomain] = useState(initial.custom_domain);
  const [mode, setMode] = useState<TlsMode>(initial.tls_mode);
  const [email, setEmail] = useState(initial.tls_email);
  const [cert, setCert] = useState("");
  const [key, setKey] = useState("");
  const [hasCert, setHasCert] = useState(initial.has_custom_cert);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");

  const { managed, reachable } = initial.proxy;

  async function save() {
    setSaving(true);
    setError("");
    setWarning("");
    setSaved(false);
    const res = await fetch("/api/admin/domain", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        custom_domain: domain,
        tls_mode: mode,
        tls_email: email,
        ...(cert || key ? { tls_cert: cert, tls_key: key } : {}),
      }),
    });
    setSaving(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data?.error || "Could not save.");
      return;
    }
    // Saved; the certificate is now stored server-side so clear the inputs.
    if (cert || key) {
      setCert("");
      setKey("");
      setHasCert(true);
    }
    if (data?.state) {
      setDomain(data.state.custom_domain);
      setMode(data.state.tls_mode);
      setEmail(data.state.tls_email);
      setHasCert(data.state.has_custom_cert);
    }
    if (!data.applied && data.proxyError) setWarning(data.proxyError);
    setSaved(true);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Domain &amp; HTTPS</h2>
        <p className="mt-1 text-sm text-slate-500">
          Serve CompassDocs on your own domain with HTTPS. Changes are applied to the bundled
          reverse proxy immediately — no restart needed.
        </p>
      </div>

      {/* Proxy status banner */}
      {!managed ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <p className="font-semibold">No reverse proxy is attached to this deployment.</p>
          <p className="mt-1">
            These settings are saved but won&rsquo;t take effect until you run the HTTPS compose
            profile (<code className="font-mono">docker-compose.tls.yml</code>), which adds a Caddy
            proxy that CompassDocs configures for you.
          </p>
        </div>
      ) : reachable ? (
        <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          ✓ Reverse proxy connected — configuration will apply live.
        </div>
      ) : (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          ✕ Reverse proxy is configured but not reachable right now. Saving will still store your
          settings; they&rsquo;ll apply once the proxy is back.
        </div>
      )}

      {/* Domain */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <h3 className="mb-1 font-semibold text-slate-900">Custom domain</h3>
        <p className="mb-3 text-sm text-slate-500">
          Point an A/AAAA DNS record for this hostname at your server, then enter it here. Leave
          blank to serve on any hostname over plain HTTP.
        </p>
        <label className="block max-w-md">
          <span className="mb-1 block text-xs font-medium text-slate-500">Domain</span>
          <input
            value={domain}
            onChange={(e) => {
              setDomain(e.target.value);
              setSaved(false);
            }}
            className={field}
            placeholder="docs.example.com"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
      </div>

      {/* TLS mode */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <h3 className="mb-3 font-semibold text-slate-900">HTTPS / TLS</h3>
        <div className="space-y-2">
          {TLS_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition ${
                mode === opt.value
                  ? "border-compass-400 bg-compass-50"
                  : "border-slate-200 hover:bg-slate-50"
              }`}
            >
              <input
                type="radio"
                name="tls_mode"
                checked={mode === opt.value}
                onChange={() => {
                  setMode(opt.value);
                  setSaved(false);
                }}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium text-slate-900">{opt.label}</span>
                <span className="block text-xs text-slate-500">{opt.hint}</span>
              </span>
            </label>
          ))}
        </div>

        {/* Let's Encrypt email */}
        {mode === "auto" && (
          <label className="mt-4 block max-w-md">
            <span className="mb-1 block text-xs font-medium text-slate-500">
              Contact email <span className="text-slate-400">(optional, for renewal notices)</span>
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setSaved(false);
              }}
              className={field}
              placeholder="admin@example.com"
            />
          </label>
        )}

        {/* Bring-your-own cert */}
        {mode === "custom" && (
          <div className="mt-4 space-y-3">
            {hasCert && !cert && !key && (
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                A certificate is on file. Paste new PEM below to replace it, or leave blank to keep
                it.
              </p>
            )}
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">
                Certificate (PEM, including any chain)
              </span>
              <textarea
                value={cert}
                onChange={(e) => {
                  setCert(e.target.value);
                  setSaved(false);
                }}
                className={`${field} h-28 font-mono text-xs`}
                placeholder="-----BEGIN CERTIFICATE-----&#10;…"
                spellCheck={false}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">
                Private key (PEM)
              </span>
              <textarea
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setSaved(false);
                }}
                className={`${field} h-28 font-mono text-xs`}
                placeholder="-----BEGIN PRIVATE KEY-----&#10;…"
                spellCheck={false}
              />
            </label>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-compass-700 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save & apply"}
        </button>
        {saved && !warning && <span className="text-sm text-green-600">✓ Saved</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
      {warning && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Settings saved, but the proxy didn&rsquo;t apply them: {warning}
        </div>
      )}
    </div>
  );
}
