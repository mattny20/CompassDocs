"use client";

// Settings → Single sign-on → Duo sign-in check (1.20.5). Same three states
// as the SSO form beside it: community build → upsell; Enterprise build
// without the `sso` entitlement → licence nudge; licensed → the form.
//
// The form mirrors the server's lockout guards (api/admin/duo), it does not
// replace them: a rule's switch is offered only after "Test with my account"
// has passed in this session against the saved details, and editing the
// details says that saving them turns the rules off until the test is run
// again. The client secret is write-only.

import { useEffect, useState } from "react";
import { Check, ShieldAlert, ShieldCheck } from "lucide-react";
import { buttonClass } from "@/components/Button";
import { Chip, EnterpriseBadge } from "@/components/Chip";
import { EntityPicker, type PickerOption } from "@/components/EntityPicker";
import { Field, Select, TextInput, Toggle, rangeError } from "@/components/form";
import { LicenseGate } from "@/components/LicenseGate";
import { SaveRow } from "@/components/SaveRow";
import { toast } from "@/components/Toasts";
import { DUO_DESK_HOURS_MAX, DUO_DESK_HOURS_MIN } from "@/lib/duo-policy";
import type { DuoView } from "@/lib/duo-view";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";

const TEST_RESULT: Record<string, string> = {
  denied: "Duo didn't approve the test. Nothing was changed.",
  expired: "The test took too long or was started in another window. Run it again.",
  unreachable: "Duo couldn't be reached during the test. Nothing was changed.",
};

export function DuoSettings({ initial, users }: { initial: DuoView; users: PickerOption[] }) {
  const [saved, setSaved] = useState(initial);
  const [s, setSRaw] = useState(initial);
  const [secret, setSecretRaw] = useState("");
  const [hours, setHoursRaw] = useState(String(initial.desk_hours));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(JSON.stringify([s, secret, hours]));
  useLeaveGuard(dirty, hasUnsavedChanges);
  const setS = (v: DuoView) => { markDirty(); setSRaw(v); };
  const setSecret = (v: string) => { markDirty(); setSecretRaw(v); };
  const setHours = (v: string) => { markDirty(); setHoursRaw(v); };

  // Back from "Test with my account" (api/auth/duo/callback): say how it went, once, and tidy the address.
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("duo_test");
    if (!result) return;
    url.searchParams.delete("duo_test");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    // A tick later: the layout's ToastHost subscribes in its own effect, which runs after this one.
    window.setTimeout(() => {
      if (result === "ok") toast("ok", "Duo approved the test. You can turn the rules on now.");
      else toast("error", TEST_RESULT[result] || "The Duo test didn't pass. Nothing was changed.");
    }, 0);
  }, []);

  const header = (
    <div className="mt-8">
      <h2 className="text-lg font-semibold text-slate-900">Duo sign-in check</h2>
      <p className="mb-4 text-sm text-slate-500">
        Ask for a Duo approval on top of single sign-on and password sign-in, or only when someone opens the desk.
      </p>
    </div>
  );

  if (!s.bundled) {
    return (
      <div>
        {header}
        <LicenseGate feature="The Duo sign-in check">
          Add a Duo approval after sign-in. See{" "}
          <a href="https://compassdocs.io/pricing" className="link font-medium">
            pricing
          </a>
          .
        </LicenseGate>
      </div>
    );
  }
  if (!s.enabled) {
    return (
      <div>
        {header}
        <LicenseGate feature="The Duo sign-in check" entitlement="sso" canManage>
          This Enterprise build supports it, but your licence doesn&rsquo;t include it yet. While the licence is missing, no Duo rule is
          enforced.
        </LicenseGate>
      </div>
    );
  }

  const detailsChanged = s.client_id !== saved.client_id || s.api_host !== saved.api_host || secret !== "";
  const rulesOnSaved = saved.enforce_signin || saved.enforce_desk;
  // A rule can be switched ON only with saved, tested details. Switching one off is always allowed.
  const canTurnOn = saved.configured && saved.tested && !detailsChanged;
  const hoursError = s.enforce_desk ? rangeError(hours, DUO_DESK_HOURS_MIN, DUO_DESK_HOURS_MAX) : undefined;
  const enforcing = s.enforce_signin || s.enforce_desk;

  async function save() {
    setSaving(true);
    const res = await fetch("/api/admin/duo", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: s.client_id,
        ...(secret ? { client_secret: secret } : {}),
        api_host: s.api_host,
        username_source: s.username_source,
        enforce_signin: s.enforce_signin,
        enforce_desk: s.enforce_desk,
        ...(hoursError ? {} : { desk_hours: Number(hours) }),
        fail_open: s.fail_open,
        bypass_user_ids: s.bypass_user_ids,
      }),
    });
    setSaving(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast("error", data?.error || "Could not save.");
      return;
    }
    markClean();
    if (data?.state) {
      setSaved(data.state);
      setSRaw(data.state);
      setHoursRaw(String(data.state.desk_hours));
    }
    setSecretRaw("");
    if (data?.rules_turned_off) toast("ok", "Saved. Both rules are off until you test the new details.");
    else toast("ok", "Duo settings saved.");
  }

  async function test() {
    setTesting(true);
    try {
      const res = await fetch("/api/admin/duo/test", { method: "POST", headers: { accept: "application/json" } });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data?.redirect === "string") {
        window.location.assign(data.redirect);
        return;
      }
      toast("error", data?.error || "Couldn't start the test.");
    } catch {
      toast("error", "Couldn't start the test.");
    }
    setTesting(false);
  }

  return (
    <div>
      {header}

      {/* With a rule on, the settings layout already says this on every page. */}
      {s.disabled_by_env && !rulesOnSaved && (
        <div className="notice-warn mb-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            Duo is switched off on the server. <code className="font-mono text-xs">COMPASSDOCS_DUO_DISABLED=1</code> is set, so nobody is asked
            for Duo, whatever is saved here. Remove it and restart to enforce the rules again.
          </p>
        </div>
      )}

      <div id="duo" className="scroll-mt-6 rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h3 className="font-semibold text-slate-900">Duo Universal Prompt</h3>
          <EnterpriseBadge />
          {rulesOnSaved && !saved.configured ? (
            <Chip tone="error" size="sm">Needs attention</Chip>
          ) : saved.enforcing ? (
            <Chip tone="ok" size="sm">Enforced</Chip>
          ) : saved.configured ? (
            <Chip tone="neutral" size="sm">Set up, not enforced</Chip>
          ) : (
            <Chip tone="neutral" size="sm">Not set up</Chip>
          )}
        </div>
        <p className="mb-3 text-sm text-slate-500">
          In the Duo Admin Panel, protect a <span className="font-medium text-slate-600">Web SDK</span> application and copy its three
          details here. Which methods people may use (Duo Push only, passcodes, security keys) is Duo policy. Set it on that application in
          the Duo Admin Panel, not here.
        </p>

        {rulesOnSaved && !saved.configured && (
          <div role="alert" className="notice-error mb-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>
              A Duo rule is on, but the Duo details are missing or can&rsquo;t be read. People are stopped at the Duo step. Enter the
              details again and test them, or turn the rules off.
            </p>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Client ID">
            <TextInput
              value={s.client_id}
              onChange={(e) => setS({ ...s, client_id: e.target.value.trim() })}
              placeholder="20 letters and digits"
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
          <Field
            label={
              <>
                Client secret{" "}
                {s.has_secret && !secret ? (
                  <span className="inline-flex items-center gap-1 text-emerald-600">
                    <Check className="h-3.5 w-3.5" aria-hidden /> (stored, paste to replace)
                  </span>
                ) : (
                  ""
                )}
              </>
            }
          >
            <TextInput
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={s.has_secret ? "••••••••" : "40 characters"}
              autoComplete="off"
            />
          </Field>
          <Field label="API hostname">
            <TextInput
              value={s.api_host}
              onChange={(e) => setS({ ...s, api_host: e.target.value.trim() })}
              placeholder="api-xxxxxxxx.duosecurity.com"
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
        </div>

        <div className="mt-3">
          <Field
            size="sm"
            label="Name sent to Duo"
            help="It must match the person's username or a username alias in Duo. An account without an email is sent by its username."
          >
            <Select
              value={s.username_source}
              onChange={(e) => setS({ ...s, username_source: e.target.value === "username" ? "username" : "email" })}
            >
              <option value="email">Email address</option>
              <option value="username">CompassDocs username</option>
            </Select>
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
          <button
            type="button"
            onClick={test}
            disabled={testing || !saved.configured || dirty}
            className={buttonClass("secondary")}
          >
            <ShieldCheck className="h-4 w-4" aria-hidden />
            {testing ? "Opening Duo…" : "Test with my account"}
          </button>
          {saved.tested && !detailsChanged ? (
            <Chip tone="ok" size="sm">Tested in this session</Chip>
          ) : (
            <p className="min-w-0 flex-1 basis-64 text-xs text-slate-500">
              {!saved.configured || dirty
                ? "Save the three details first. Then test: Duo asks you to approve, like it will ask everyone."
                : "Approve one Duo request yourself. The rules below can be turned on only after your own test passes in this session."}
            </p>
          )}
        </div>

        <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
          <h4 className="text-sm font-semibold text-slate-900">Where Duo is asked for</h4>
          <Toggle
            label="At sign-in"
            help="Every session passes Duo once, after single sign-on or a password. API tokens and the Claude connector are not asked."
            checked={s.enforce_signin}
            onChange={(next) => setS({ ...s, enforce_signin: next })}
            disabled={!s.enforce_signin && !canTurnOn}
          />
          <Toggle
            label="When opening the desk"
            help="The desk and its API want a Duo approval no older than the hours below. With only this on, the rest of CompassDocs is not affected."
            checked={s.enforce_desk}
            onChange={(next) => setS({ ...s, enforce_desk: next })}
            disabled={!s.enforce_desk && !canTurnOn}
          />
          {s.enforce_desk && (
            <Field size="sm" label="Hours a desk approval lasts" error={hoursError} help={`From ${DUO_DESK_HOURS_MIN} to ${DUO_DESK_HOURS_MAX}. The default is 12.`}>
              <TextInput type="number" min={DUO_DESK_HOURS_MIN} max={DUO_DESK_HOURS_MAX} step={1} value={hours} onChange={(e) => setHours(e.target.value)} />
            </Field>
          )}
          {detailsChanged && rulesOnSaved && (
            <p className="text-xs ink-warn">Saving new Duo details turns both rules off until you run the test again.</p>
          )}
          <Toggle
            label="Let people in when Duo can't be reached"
            help="Off: they see a message and can retry. On: they are let through, and each time is written to the audit log. Bypass accounts get in either way."
            checked={s.fail_open}
            onChange={(next) => setS({ ...s, fail_open: next })}
          />
        </div>

        <div className="mt-4 border-t border-slate-100 pt-4">
          <h4 className="text-sm font-semibold text-slate-900">Accounts that skip Duo</h4>
          <p className="mb-2 mt-0.5 text-xs text-slate-500">
            Break-glass accounts, picked by name. They sign in without Duo, and each of their sign-ins is written to the audit log. Keep the
            list short and give these accounts strong passwords.
          </p>
          <div className="max-w-xl">
            <EntityPicker
              options={users}
              value={s.bypass_user_ids}
              onChange={(ids) => setS({ ...s, bypass_user_ids: ids })}
              label="Accounts that skip Duo"
              placeholder="Search people…"
              emptyText="No account matches."
            />
          </div>
          {enforcing && s.bypass_user_ids.length === 0 && (
            <div className="notice-warn mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <p>
                No account skips Duo. If Duo stops working for your workspace, nobody can sign in to fix it here. Add at least one
                break-glass account.
              </p>
            </div>
          )}
        </div>

        <SaveRow dirty={dirty} busy={saving} onSave={save} label="Save" disabled={Boolean(hoursError)} />
      </div>
    </div>
  );
}
