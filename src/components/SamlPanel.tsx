"use client";

// SAML 2.0 IdP settings — sibling of the Entra/OIDC panel on Settings → SSO.
// The IdP certificate is public-key material (not write-only like the OIDC
// client secret). Shares the "sso" license entitlement with OIDC.

import { useState } from "react";
import type { Role } from "@/lib/types";
import { toast } from "@/components/Toasts";

export interface SamlState {
  enabled: boolean; // bundled AND licensed
  bundled: boolean;
  saml_enabled: boolean;
  idp_sso_url: string;
  idp_issuer: string;
  idp_cert: string;
  auto_provision: boolean;
  default_role: Role;
  allowed_domains: string;
  button_label: string;
  configured: boolean;
  sp_entity_id: string;
  sp_acs_url: string;
  sp_metadata_url: string;
}

const field =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-hidden focus:border-compass-400 focus:ring-2 focus:ring-compass-100";
const urlCls = "block select-all rounded-md bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700";

export function SamlPanel({ initial }: { initial: SamlState }) {
  const [s, setS] = useState<SamlState>(initial);
  const [metaXml, setMetaXml] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);

  const configured = Boolean(s.idp_sso_url && s.idp_issuer && s.idp_cert);

  async function save(patch: Record<string, unknown>) {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/saml", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) toast("error", data?.error || "Could not save.");
      else {
        setS(data.state as SamlState);
        setMetaXml("");
        toast("ok", "SAML settings saved.");
      }
    } catch {
      toast("error", "Could not save.");
    }
    setSaving(false);
  }

  function saveAll() {
    void save({
      idp_sso_url: s.idp_sso_url.trim(),
      idp_issuer: s.idp_issuer.trim(),
      idp_cert: s.idp_cert.trim(),
      auto_provision: s.auto_provision,
      default_role: s.default_role,
      allowed_domains: s.allowed_domains,
      button_label: s.button_label,
    });
  }

  if (!s.bundled || !s.enabled) return null; // the Entra panel already shows the upsell/license notice

  return (
    <div className="mt-6 rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="font-semibold text-slate-900">SAML 2.0</h3>
        <span className="rounded-full bg-compass-600 px-2 py-0.5 text-xs font-semibold text-white">
          Enterprise
        </span>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        Connect any SAML identity provider — Okta, OneLogin, Google Workspace, ADFS, and friends.
        Works alongside (or instead of) Microsoft sign-in above; both share the{" "}
        <code className="font-mono text-xs">sso</code> entitlement.
      </p>

      {/* SP values the IdP admin needs */}
      <div className="mb-4 grid gap-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-600 sm:grid-cols-2">
        <div>
          <span className="mb-1 block font-medium text-slate-500">Entity ID / metadata URL</span>
          <span className={urlCls}>{s.sp_metadata_url}</span>
        </div>
        <div>
          <span className="mb-1 block font-medium text-slate-500">ACS URL (POST)</span>
          <span className={urlCls}>{s.sp_acs_url}</span>
        </div>
      </div>

      {/* Quick fill from IdP metadata */}
      <label className="mb-4 block">
        <span className="mb-1 block text-xs font-medium text-slate-500">
          Paste your IdP&rsquo;s metadata XML to fill the fields below
        </span>
        <div className="flex gap-2">
          <textarea
            value={metaXml}
            onChange={(e) => setMetaXml(e.target.value)}
            rows={2}
            placeholder="<EntityDescriptor …>"
            className={`${field} font-mono text-xs`}
            spellCheck={false}
          />
          <button
            onClick={() => save({ idp_metadata_xml: metaXml })}
            disabled={saving || !metaXml.trim()}
            className="shrink-0 self-start rounded-lg bg-slate-700 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
          >
            Import
          </button>
        </div>
      </label>

      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">IdP sign-on URL</span>
            <input
              type="url"
              value={s.idp_sso_url}
              onChange={(e) => setS({ ...s, idp_sso_url: e.target.value })}
              placeholder="https://idp.example.com/app/…/sso/saml"
              className={`${field} font-mono`}
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">IdP issuer (entity ID)</span>
            <input
              type="text"
              value={s.idp_issuer}
              onChange={(e) => setS({ ...s, idp_issuer: e.target.value })}
              placeholder="http://www.okta.com/exk…"
              className={`${field} font-mono`}
              spellCheck={false}
            />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            IdP signing certificate (PEM or base64)
          </span>
          <textarea
            value={s.idp_cert}
            onChange={(e) => setS({ ...s, idp_cert: e.target.value })}
            rows={3}
            placeholder="-----BEGIN CERTIFICATE-----"
            className={`${field} font-mono text-xs`}
            spellCheck={false}
          />
        </label>

        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-xs font-medium text-slate-500 hover:text-slate-700"
        >
          {showAdvanced ? "▾" : "▸"} Provisioning &amp; appearance
        </button>
        {showAdvanced && (
          <div className="space-y-3 rounded-lg border border-slate-200 p-3">
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={s.auto_provision}
                onChange={(e) => setS({ ...s, auto_provision: e.target.checked })}
              />
              Create an account on first sign-in (JIT provisioning)
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Default role</span>
                <select
                  value={s.default_role}
                  onChange={(e) => setS({ ...s, default_role: e.target.value as Role })}
                  className={field}
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="approver">Approver</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-xs font-medium text-slate-500">
                  Allowed email domains (comma-separated, empty = any)
                </span>
                <input
                  type="text"
                  value={s.allowed_domains}
                  onChange={(e) => setS({ ...s, allowed_domains: e.target.value })}
                  placeholder="example.com, example.org"
                  className={field}
                />
              </label>
            </div>
            <label className="block sm:max-w-xs">
              <span className="mb-1 block text-xs font-medium text-slate-500">Login button label</span>
              <input
                type="text"
                value={s.button_label}
                onChange={(e) => setS({ ...s, button_label: e.target.value })}
                maxLength={40}
                className={field}
              />
            </label>
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center gap-3 border-t border-slate-200 pt-3">
        <button
          onClick={saveAll}
          disabled={saving}
          className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-xs hover:bg-compass-700 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={s.saml_enabled}
            disabled={saving || (!configured && !s.saml_enabled)}
            onChange={(e) => save({ saml_enabled: e.target.checked })}
          />
          Enabled on the login page
        </label>
        {s.saml_enabled && configured && (
          <a
            href="/api/ee/saml/login"
            className="text-sm font-medium text-compass-600 underline underline-offset-2 hover:text-compass-700"
          >
            Test sign-in
          </a>
        )}
      </div>
    </div>
  );
}
