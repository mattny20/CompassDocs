"use client";

// Admin › Single sign-on. Three states, mirroring the directory Graph panel:
// community build → upsell; enterprise build without the `sso` entitlement →
// license nudge; licensed → the OIDC configuration form.

import { useState } from "react";
import { SaveRow } from "@/components/SaveRow";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import { Check } from "lucide-react";
import { EnterpriseBadge } from "@/components/Chip";
import { buttonClass } from "@/components/Button";
import { MsDeviceSetup } from "./MsDeviceSetup";
import { Field, TextInput, Toggle } from "@/components/form";
import { toast } from "@/components/Toasts";

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
  const [s, setSRaw] = useState(initial);
  const [secret, setSecretRaw] = useState("");
  const [saving, setSaving] = useState(false);

  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(JSON.stringify([s, secret]));
  useLeaveGuard(dirty, hasUnsavedChanges);
  // User edits dirty the form; what the server hands back does not.
  const setS = (v: typeof s) => { markDirty(); setSRaw(v); };
  const setSecret = (v: string) => { markDirty(); setSecretRaw(v); };
  const [showAdvanced, setShowAdvanced] = useState(Boolean(initial.authority));

  const header = (
    <div>
      <h2 className="text-lg font-semibold text-slate-900">OpenID Connect (OIDC)</h2>
      <p className="mb-4 text-sm text-slate-500">
        Let your team sign in with Microsoft Entra ID (or any OIDC provider) instead of a
        CompassDocs password.
      </p>
    </div>
  );

  if (!s.bundled) {
    return (
      <div>
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
      <div>
        {header}
        <div className="notice-warn rounded-xl border p-4 text-sm">
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
      toast("error", data?.error || "Could not save.");
      return;
    }
    markClean();
    if (data?.state) setSRaw(data.state);
    setSecretRaw("");
    toast("ok", "Single sign-on settings saved.");
  }

  const redirectUri =
    typeof window !== "undefined" ? `${window.location.origin}/api/ee/sso/callback` : "…/api/ee/sso/callback";
  const configured = Boolean(s.client_id && (s.has_secret || secret) && (s.tenant || s.authority));

  return (
    <div>
      {header}

      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <div className="mb-1 flex items-center gap-2">
          <h3 className="font-semibold text-slate-900">Microsoft Entra ID (OIDC)</h3>
          <EnterpriseBadge />
        </div>
        <p className="mb-3 text-sm text-slate-500">
          Register an app in Microsoft Entra (single-tenant, web platform) with redirect URI{" "}
          <code className="rounded-sm bg-slate-100 px-1 font-mono text-xs">{redirectUri}</code>, create
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
            markClean();
            setSRaw(state);
            setSecretRaw("");
          }}
        />

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Tenant ID">
            <TextInput
              value={s.tenant}
              onChange={(e) => setS({ ...s, tenant: e.target.value })}
              placeholder="00000000-0000-…"
              spellCheck={false}
            />
          </Field>
          <Field label="Client ID">
            <TextInput
              value={s.client_id}
              onChange={(e) => setS({ ...s, client_id: e.target.value })}
              placeholder="app registration id"
              spellCheck={false}
            />
          </Field>
          <Field
            label={
              <>
                Client secret{" "}
                {s.has_secret && !secret ? (
                  <span className="inline-flex items-center gap-1 text-emerald-600"><Check className="h-3.5 w-3.5" aria-hidden /> (stored — paste to replace)</span>
                ) : (
                  ""
                )}
              </>
            }
            help={
              s.secret_expires && s.has_secret && !secret
                ? `Expires ${s.secret_expires} — set a reminder to rotate it.`
                : undefined
            }
          >
            <TextInput
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={s.has_secret ? "••••••••" : "secret value"}
              autoComplete="off"
            />
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-slate-600">
          <Toggle
            label="Create accounts on first sign-in"
            checked={s.auto_provision}
            onChange={(next) => setS({ ...s, auto_provision: next })}
          />
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

        <div className="mt-3">
          <Field
            size="lg"
            label={
              <>
                Allowed email domains{" "}
                <span className="text-slate-500">(optional, comma-separated)</span>
              </>
            }
          >
            <TextInput
              value={s.allowed_domains}
              onChange={(e) => setS({ ...s, allowed_domains: e.target.value })}
              placeholder="acme.com, acme.co.uk — blank allows any"
              spellCheck={false}
            />
          </Field>
        </div>

        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="mt-3 text-xs font-medium text-slate-500 hover:text-slate-600"
        >
          {showAdvanced ? "▾" : "▸"} Advanced
        </button>
        {showAdvanced && (
          <div className="mt-2">
            <Field
              size="lg"
              label={
                <>
                  Custom OIDC authority{" "}
                  <span className="text-slate-500">(overrides the tenant — for Okta, Auth0, …)</span>
                </>
              }
              help={
                s.effective_authority ? (
                  <>
                    In effect: <code className="font-mono">{s.effective_authority}</code>
                  </>
                ) : undefined
              }
            >
              <TextInput
                value={s.authority}
                onChange={(e) => setS({ ...s, authority: e.target.value })}
                placeholder="https://your-idp.example.com"
                spellCheck={false}
              />
            </Field>
          </div>
        )}

        <div className="mt-4 space-y-2 border-t border-slate-100 pt-4 text-sm text-slate-600">
          <Toggle
            label="Enable “Sign in with Microsoft” on the login page"
            checked={s.sso_enabled}
            onChange={(next) => setS({ ...s, sso_enabled: next })}
            disabled={!configured && !s.sso_enabled}
          />
          <Toggle
            label="Hide the username/password form (SSO only)"
            checked={s.sso_only}
            onChange={(next) => setS({ ...s, sso_only: next })}
            disabled={!s.sso_enabled}
          />
          {s.sso_only && (
            <p className="text-xs ink-warn">
              Break-glass: local sign-in still works by POSTing to /api/auth/login — an admin
              locked out of SSO can use{" "}
              <code className="font-mono">
                curl -X POST /api/auth/login -d {"'{"}&quot;username&quot;:…{"}'"}
              </code>
              .
            </p>
          )}
        </div>

        <SaveRow dirty={dirty} busy={saving} onSave={save} label="Save" className="mt-4">
          {s.sso_enabled && configured && (
            <a href="/api/ee/sso/login" className={buttonClass("secondary")}>
              Test sign-in
            </a>
          )}
        </SaveRow>
      </div>
    </div>
  );
}
