"use client";

// Admin › Single sign-on. Three states, mirroring the directory Graph panel:
// community build → upsell; enterprise build without the `sso` entitlement →
// license nudge; licensed → the OIDC configuration form.

import { useState } from "react";
import { MsDeviceSetup } from "./MsDeviceSetup";

const field =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

export interface SsoState {
  enabled: boolean; // bundled AND licensed
  bundled: boolean;
  sso_enabled: boolean;
  tenant: string;
  client_id: string;
  has_secret: boolean;
  authority: string;
  effective_authority: string;
  auto_provision: boolean;
  default_role: string;
  allowed_domains: string;
  sso_only: boolean;
  secret_expires: string;
}

export function SsoSettings({ initial }: { initial: SsoState }) {
  const [s, setS] = useState(initial);
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(Boolean(initial.authority));

  const header = (
    <div>
      <h2 className="text-lg font-semibold text-slate-900">Single sign-on</h2>
      <p className="mb-4 text-sm text-slate-500">
        Let your team sign in with Microsoft Entra ID (or any OIDC provider) instead of a
        CompassDocs password.
      </p>
    </div>
  );

  if (!s.bundled) {
    return (
      <div className="max-w-3xl">
        {header}
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          <p className="font-semibold text-slate-800">SSO is an Enterprise feature.</p>
          <p className="mt-1">
            Sign in with Microsoft Entra ID, auto-provision accounts, and enforce SSO-only
            login. See{" "}
            <a
              href="https://compassdocs.io/pricing"
              className="font-medium text-compass-600 hover:underline"
            >
              pricing
            </a>
            .
          </p>
        </div>
      </div>
    );
  }

  if (!s.enabled) {
    return (
      <div className="max-w-3xl">
        {header}
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <p className="font-semibold">SSO isn&rsquo;t licensed.</p>
          <p className="mt-1">
            This Enterprise build supports it, but your license doesn&rsquo;t include the{" "}
            <code className="font-mono">sso</code> entitlement — check{" "}
            <a href="/admin/license" className="font-medium underline">
              Settings → License
            </a>
            .
          </p>
        </div>
      </div>
    );
  }

  async function save() {
    setSaving(true);
    setError("");
    setMsg("");
    const res = await fetch("/api/admin/sso", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sso_enabled: s.sso_enabled,
        tenant: s.tenant,
        client_id: s.client_id,
        ...(secret ? { client_secret: secret } : {}),
        authority: s.authority,
        auto_provision: s.auto_provision,
        default_role: s.default_role,
        allowed_domains: s.allowed_domains,
        sso_only: s.sso_only,
      }),
    });
    setSaving(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data?.error || "Could not save.");
      return;
    }
    if (data?.state) setS(data.state);
    setSecret("");
    setMsg("Saved.");
  }

  const redirectUri =
    typeof window !== "undefined" ? `${window.location.origin}/api/ee/sso/callback` : "…/api/ee/sso/callback";
  const configured = Boolean(s.client_id && (s.has_secret || secret) && (s.tenant || s.authority));

  return (
    <div className="max-w-3xl">
      {header}

      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <div className="mb-1 flex items-center gap-2">
          <h3 className="font-semibold text-slate-900">Microsoft Entra ID (OIDC)</h3>
          <span className="rounded-full bg-compass-600 px-2 py-0.5 text-xs font-semibold text-white">
            Enterprise
          </span>
        </div>
        <p className="mb-3 text-sm text-slate-500">
          Register an app in Microsoft Entra (single-tenant, web platform) with redirect URI{" "}
          <code className="rounded bg-slate-100 px-1 font-mono text-xs">{redirectUri}</code>, create
          a client secret, then enter the details here. No API permissions are needed — sign-in
          uses only OpenID Connect.
        </p>

        <MsDeviceSetup
          startUrl="/api/ee/sso/setup/start"
          pollUrl="/api/ee/sso/setup/poll"
          refreshUrl="/api/admin/sso"
          blurb="Signs you in once as a tenant admin and creates the app registration, secret, and settings below — nothing to copy by hand."
          doneMessage="Done — the Entra app was created and the settings below were filled in and enabled."
          onDone={(state) => {
            setS(state);
            setSecret("");
          }}
        />

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Tenant ID</span>
            <input
              className={field}
              value={s.tenant}
              onChange={(e) => setS({ ...s, tenant: e.target.value })}
              placeholder="00000000-0000-…"
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Client ID</span>
            <input
              className={field}
              value={s.client_id}
              onChange={(e) => setS({ ...s, client_id: e.target.value })}
              placeholder="app registration id"
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">
              Client secret{" "}
              {s.has_secret && !secret ? (
                <span className="text-green-600">(stored ✓ — paste to replace)</span>
              ) : (
                ""
              )}
            </span>
            <input
              className={field}
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={s.has_secret ? "••••••••" : "secret value"}
              autoComplete="off"
            />
            {s.secret_expires && s.has_secret && !secret && (
              <span className="mt-1 block text-xs text-slate-400">
                Expires {s.secret_expires} — set a reminder to rotate it.
              </span>
            )}
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-slate-600">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={s.auto_provision}
              onChange={(e) => setS({ ...s, auto_provision: e.target.checked })}
            />
            Create accounts on first sign-in
          </label>
          <label className="flex items-center gap-2">
            New accounts get role
            <select
              className="rounded-lg border border-slate-200 px-2 py-1 text-sm"
              value={s.default_role}
              onChange={(e) => setS({ ...s, default_role: e.target.value })}
            >
              <option value="viewer">viewer</option>
              <option value="editor">editor</option>
              <option value="approver">approver</option>
              <option value="admin">admin</option>
            </select>
          </label>
        </div>

        <label className="mt-3 block max-w-md">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            Allowed email domains <span className="text-slate-400">(optional, comma-separated)</span>
          </span>
          <input
            className={field}
            value={s.allowed_domains}
            onChange={(e) => setS({ ...s, allowed_domains: e.target.value })}
            placeholder="acme.com, acme.co.uk — blank allows any"
            spellCheck={false}
          />
        </label>

        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="mt-3 text-xs font-medium text-slate-400 hover:text-slate-600"
        >
          {showAdvanced ? "▾" : "▸"} Advanced
        </button>
        {showAdvanced && (
          <label className="mt-2 block max-w-xl">
            <span className="mb-1 block text-xs font-medium text-slate-500">
              Custom OIDC authority{" "}
              <span className="text-slate-400">(overrides the tenant — for Okta, Auth0, …)</span>
            </span>
            <input
              className={field}
              value={s.authority}
              onChange={(e) => setS({ ...s, authority: e.target.value })}
              placeholder="https://your-idp.example.com"
              spellCheck={false}
            />
            {s.effective_authority && (
              <span className="mt-1 block text-xs text-slate-400">
                In effect: <code className="font-mono">{s.effective_authority}</code>
              </span>
            )}
          </label>
        )}

        <div className="mt-4 space-y-2 border-t border-slate-100 pt-4 text-sm text-slate-600">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={s.sso_enabled}
              onChange={(e) => setS({ ...s, sso_enabled: e.target.checked })}
              disabled={!configured && !s.sso_enabled}
            />
            <span className="font-medium">
              Enable &ldquo;Sign in with Microsoft&rdquo; on the login page
            </span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={s.sso_only}
              onChange={(e) => setS({ ...s, sso_only: e.target.checked })}
              disabled={!s.sso_enabled}
            />
            Hide the username/password form (SSO only)
          </label>
          {s.sso_only && (
            <p className="text-xs text-amber-600">
              Break-glass: local sign-in still works by POSTing to /api/auth/login — an admin
              locked out of SSO can use{" "}
              <code className="font-mono">
                curl -X POST /api/auth/login -d {"'{"}&quot;username&quot;:…{"}'"}
              </code>
              .
            </p>
          )}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {s.sso_enabled && configured && (
            <a
              href="/api/ee/sso/login"
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Test sign-in
            </a>
          )}
          {msg && <span className="text-sm text-green-600">{msg}</span>}
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      </div>
    </div>
  );
}
