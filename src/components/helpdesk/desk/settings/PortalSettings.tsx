"use client";

// Desk settings → Customer portal (Helpdesk 1.19.1, agent V6): let people
// outside the organisation raise and follow requests at /support without a
// CompassDocs account. On or off, what customers can ask for (exposed
// request types, each with the team it goes to; types that need the
// directory are shown disabled with the reason), who can use it (anyone
// with an email, or approved domains), the brand (name and logo), and
// protection (per-address limits, blocked words and domains). Saves through
// /api/helpdesk/admin/portal (settings.manage); the logo uploads at once.
//
// 1.19.4 (C3): the page is the Settings tab of three under one header
// (app/(desk)/desk/settings/portal/layout.tsx): Settings, Help centre
// (PortalHelpCentre) and Customers (PortalContacts, below, the customers
// who have used the portal, to block or unblock).

import { useEffect, useRef, useState } from "react";
import { ExternalLink, ImagePlus, Lock, Trash2, UserX, UserCheck } from "lucide-react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { Field, SectionEmpty, Select, TextInput, Textarea, Toggle } from "@/components/form";
import { RelativeTime } from "@/components/RelativeTime";
import { SaveRow } from "@/components/SaveRow";
import { Segmented } from "@/components/Segmented";
import { LoadingRow } from "@/components/Spinner";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import {
  PORTAL_BLOCKER_TEXT,
  PORTAL_LIMIT_BOUNDS,
  brandInitials,
  type PortalAccess,
  type PortalBlocker,
  type PortalSettings as Settings,
} from "@/lib/helpdesk/portal-shared";
import { getJson, sendJson } from "../api";

interface TypeOption {
  id: number;
  title: string;
  team_id: number | null;
  team_name: string | null;
  exposed: boolean;
  portal_team_id: number | null;
  blockers: PortalBlocker[];
}

interface Loaded {
  settings: Settings;
  types: TypeOption[];
  teams: { id: number; name: string }[];
  custom_domain: string;
  path: string;
}

interface ContactRow {
  id: number;
  email: string;
  name: string;
  blocked: number;
  last_seen_at: string | null;
  requests: number;
  sessions: number;
}

const lines = (v: string[]) => v.join("\n");
const parseLines = (v: string) =>
  v
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

export function PortalSettings() {
  const [data, setData] = useState<Loaded | null>(null);
  const [s, setS] = useState<Settings | null>(null);
  // The list fields are edited as text and parsed on save.
  const [text, setText] = useState({ domains: "", words: "", blockedDomains: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const snap = JSON.stringify(s && { ...s, brand_logo: "" }) + JSON.stringify(text);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(snap);
  useLeaveGuard(dirty, hasUnsavedChanges);

  function take(d: Loaded) {
    setData(d);
    setS(d.settings);
    setText({ domains: lines(d.settings.domains), words: lines(d.settings.blocked_words), blockedDomains: lines(d.settings.blocked_domains) });
  }

  useEffect(() => {
    getJson<Loaded>("/api/helpdesk/admin/portal", "Couldn't load the portal settings.")
      .then(take)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error && !s) return <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>;
  if (!s || !data) return <LoadingRow className="py-10" />;

  const set = (p: Partial<Settings>) => {
    markDirty();
    setS({ ...s, ...p });
  };
  const setLimits = (p: Partial<Settings["limits"]>) => set({ limits: { ...s.limits, ...p } });
  const host = data.custom_domain || (typeof window === "undefined" ? "" : window.location.host);
  const teamName = (id: number | null) => data.teams.find((t) => t.id === id)?.name ?? null;

  function toggleType(t: TypeOption, on: boolean) {
    if (!s) return;
    set({ types: on ? [...s.types, { id: t.id, team_id: null }] : s.types.filter((x) => x.id !== t.id) });
  }

  async function save() {
    if (!s) return;
    setBusy(true);
    try {
      const d = await sendJson<Loaded>(
        "/api/helpdesk/admin/portal",
        "PUT",
        { ...s, domains: parseLines(text.domains), blocked_words: parseLines(text.words), blocked_domains: parseLines(text.blockedDomains) },
        "Couldn't save the portal settings."
      );
      take(d);
      markClean(JSON.stringify({ ...d.settings, brand_logo: "" }) + JSON.stringify({ domains: lines(d.settings.domains), words: lines(d.settings.blocked_words), blockedDomains: lines(d.settings.blocked_domains) }));
      toast("ok", d.settings.enabled ? "Portal settings saved. The portal is on." : "Portal settings saved. The portal is off.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadLogo(file: File | undefined) {
    if (!file) return;
    setLogoBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/helpdesk/admin/portal/logo", { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as { settings?: Settings; error?: string };
      if (!res.ok || !body.settings) throw new Error(body.error || "Couldn't upload the logo.");
      setS((cur) => (cur ? { ...cur, brand_logo: body.settings!.brand_logo } : cur));
      toast("ok", "Logo updated.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setLogoBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removeLogo() {
    setLogoBusy(true);
    try {
      const d = await sendJson<{ settings: Settings }>("/api/helpdesk/admin/portal/logo", "DELETE", undefined, "Couldn't remove the logo.");
      setS((cur) => (cur ? { ...cur, brand_logo: d.settings.brand_logo } : cur));
      toast("ok", "Logo removed.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setLogoBusy(false);
    }
  }

  const brandName = s.brand_name || "Support";
  const logoSrc = s.brand_logo ? `/support/api/logo?v=${s.brand_logo.slice(0, 12)}` : null;

  return (
    <>
      <div className="flex flex-col gap-4">
        <Card
          actions={
            <Button variant="secondary" size="sm" icon={<ExternalLink />} href={data.path} target="_blank" rel="noopener">
              Open portal
              <span className="sr-only"> (opens in a new tab)</span>
            </Button>
          }
        >
          <Toggle
            label={s.enabled ? "Portal is on" : "Portal is off"}
            help={`${host} → ${data.path} · customers sign in with a one-time link sent to their email`}
            checked={s.enabled}
            onChange={(v) => set({ enabled: v })}
            size="full"
          />
          {s.enabled && !data.custom_domain && (
            <p className="notice-warn mt-3 rounded-lg border px-3 py-2 text-sm">
              Set your workspace&apos;s domain under Settings, Domain, so sign-in links always point to it rather than to the address a visitor used.
            </p>
          )}
        </Card>

        <div className="grid items-start gap-4 lg:grid-cols-2">
          <Card title="What customers can ask for" description="Only these request types appear in the portal, each going to the team you choose.">
            {data.types.length === 0 ? (
              <SectionEmpty action={{ label: "Add request types", href: "/desk/settings/request-types" }}>No request types yet.</SectionEmpty>
            ) : (
              <ul className="space-y-2.5">
                {data.types.map((t) => {
                  const on = s.types.find((x) => x.id === t.id);
                  const blocked = t.blockers.length > 0;
                  const team = on ? (teamName(on.team_id) ?? t.team_name) : t.team_name;
                  const reason = t.blockers.map((b) => PORTAL_BLOCKER_TEXT[b]).join(" ");
                  return (
                    <li key={t.id}>
                      <label className={`flex items-start gap-2 text-sm ${blocked ? "text-slate-500" : "text-slate-800"}`}>
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={!!on}
                          disabled={blocked && !on}
                          onChange={(e) => toggleType(t, e.target.checked)}
                        />
                        <span className="min-w-0">
                          {t.title}
                          {team && <span className="text-slate-500"> · {team}</span>}
                          {blocked && (
                            <span className="text-slate-500" data-tt={reason} data-tt-wrap="" tabIndex={0}>
                              {" "}
                              (internal only)
                            </span>
                          )}
                        </span>
                      </label>
                      {blocked && <span className="sr-only">{reason}</span>}
                      {on && !blocked && (
                        <div className="mt-1.5 pl-6">
                          <Select
                            aria-label={`Team for ${t.title}`}
                            className="max-w-xs py-1 text-sm"
                            value={on.team_id ?? ""}
                            onChange={(e) =>
                              set({ types: s.types.map((x) => (x.id === t.id ? { ...x, team_id: e.target.value ? Number(e.target.value) : null } : x)) })
                            }
                          >
                            <option value="">{t.team_name ? `Its own team (${t.team_name})` : "Its own team"}</option>
                            {data.teams.map((tm) => (
                              <option key={tm.id} value={tm.id}>
                                {tm.name}
                              </option>
                            ))}
                          </Select>
                        </div>
                      )}
                      {on && blocked && <p className="mt-1 pl-6 text-xs text-red-600">{reason} Untick it to save.</p>}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card title="Who can use it">
            <Segmented<PortalAccess>
              label="Who can use the portal"
              value={s.access}
              onChange={(v) => set({ access: v })}
              options={[
                { value: "anyone", label: "Anyone with an email" },
                { value: "domains", label: "Approved domains only" },
              ]}
              className="flex-wrap"
            />
            {s.access === "domains" && (
              <Field label="Approved domains" help="One per line. clientco.com also lets in eu.clientco.com." className="mt-3">
                <Textarea
                  rows={3}
                  value={text.domains}
                  onChange={(e) => {
                    markDirty();
                    setText({ ...text, domains: e.target.value });
                  }}
                  placeholder="clientco.com"
                />
              </Field>
            )}

            <p className="mb-1 mt-5 text-sm font-medium text-slate-800">Brand</p>
            <div className="flex flex-wrap items-center gap-2.5">
              {logoSrc ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logoSrc} alt="" className="h-9 w-9 shrink-0 rounded-lg object-contain" />
              ) : (
                <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-compass-50 text-xs font-semibold text-compass-700">
                  {brandInitials(brandName)}
                </span>
              )}
              <TextInput
                aria-label="Portal name"
                className="min-w-0 flex-1"
                value={s.brand_name}
                maxLength={80}
                placeholder="Acme Support"
                onChange={(e) => set({ brand_name: e.target.value })}
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only" tabIndex={-1} onChange={(e) => uploadLogo(e.target.files?.[0])} aria-hidden />
              <Button variant="secondary" size="sm" icon={<ImagePlus />} busy={logoBusy} onClick={() => fileRef.current?.click()}>
                {s.brand_logo ? "Change logo" : "Upload logo"}
              </Button>
              {s.brand_logo && (
                <Button variant="ghost" size="sm" icon={<Trash2 />} disabled={logoBusy} onClick={removeLogo}>
                  Remove logo
                </Button>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-500">PNG, JPEG, GIF or WebP, up to 1 MB. Without one, the portal shows the name&apos;s initials.</p>

            <p className="mb-1 mt-5 text-sm font-medium text-slate-800">Protection</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Sign-in links per email per hour">
                <TextInput
                  type="number"
                  min={PORTAL_LIMIT_BOUNDS.links_per_email_hour.min}
                  max={PORTAL_LIMIT_BOUNDS.links_per_email_hour.max}
                  value={s.limits.links_per_email_hour}
                  onChange={(e) => setLimits({ links_per_email_hour: Number(e.target.value) })}
                />
              </Field>
              <Field label="New requests per email per hour">
                <TextInput
                  type="number"
                  min={PORTAL_LIMIT_BOUNDS.requests_per_email_hour.min}
                  max={PORTAL_LIMIT_BOUNDS.requests_per_email_hour.max}
                  value={s.limits.requests_per_email_hour}
                  onChange={(e) => setLimits({ requests_per_email_hour: Number(e.target.value) })}
                />
              </Field>
              <Field label="Blocked words" help="A request or reply holding one is refused. One per line.">
                <Textarea
                  rows={3}
                  value={text.words}
                  onChange={(e) => {
                    markDirty();
                    setText({ ...text, words: e.target.value });
                  }}
                />
              </Field>
              <Field label="Blocked domains" help="Addresses here can never sign in. One per line.">
                <Textarea
                  rows={3}
                  value={text.blockedDomains}
                  onChange={(e) => {
                    markDirty();
                    setText({ ...text, blockedDomains: e.target.value });
                  }}
                />
              </Field>
            </div>
          </Card>
        </div>

        <p className="flex items-start gap-2 rounded-lg border border-compass-200 bg-compass-50 px-3 py-2.5 text-sm text-compass-800 dark:border-compass-500/40">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Customers only ever see their own requests and the public conversation. They never see CompassDocs, your directory or internal notes.
        </p>
      </div>
      <SaveRow dirty={dirty} busy={busy} onSave={save} label="Save portal settings" className="mt-4" />
    </>
  );
}

/** The customers who have used the portal: search, block and unblock (the Customers tab). */
export function PortalContacts() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ContactRow[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const ctl = new AbortController();
    const t = setTimeout(() => {
      getJson<{ contacts: ContactRow[] }>(`/api/helpdesk/admin/portal/contacts?q=${encodeURIComponent(q)}`, "Couldn't load the customers.", ctl.signal)
        .then((d) => {
          setRows(d.contacts);
          setError("");
        })
        .catch((e: Error) => {
          if (e.name !== "AbortError") setError(e.message);
        });
    }, 200);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q]);

  async function setBlocked(c: ContactRow, blocked: boolean) {
    if (blocked) {
      const ok = await confirmDialog({
        title: `Block ${c.email}?`,
        body: "They're signed out at once and can't sign in, raise a request, reply, or open tickets by email until you unblock them. Their requests stay in the desk.",
        confirmLabel: "Block",
        danger: true,
      });
      if (ok !== true) return;
    }
    try {
      const d = await sendJson<{ contact: ContactRow }>(`/api/helpdesk/admin/portal/contacts/${c.id}`, "PATCH", { blocked }, "Couldn't change that.");
      setRows((rs) => (rs ? rs.map((r) => (r.id === c.id ? { ...r, blocked: d.contact.blocked, sessions: blocked ? 0 : r.sessions } : r)) : rs));
      toast("ok", blocked ? `${c.email} is blocked.` : `${c.email} can use the portal again.`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  return (
    <Card title="Customers" description="People who have signed in to the portal or raised a request there." padding="none">
      <div className="border-b border-slate-100 px-4 py-3">
        <TextInput type="search" aria-label="Search customers" placeholder="Search by email or name" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
      </div>
      {error ? (
        <p className="notice-error m-4 rounded-lg border px-3 py-2 text-sm">{error}</p>
      ) : !rows ? (
        <LoadingRow className="py-6" />
      ) : rows.length === 0 ? (
        <SectionEmpty className="px-4 py-6">{q ? "No customers match that search." : "Nobody has used the portal yet."}</SectionEmpty>
      ) : (
        <ul>
          {rows.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-100 px-4 py-2.5 last:border-b-0">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900">
                  {c.email}
                  {c.name && <span className="font-normal text-slate-500"> · {c.name}</span>}
                </p>
                <p className="text-xs text-slate-500">
                  {c.requests === 1 ? "1 request" : `${c.requests} requests`}
                  {c.last_seen_at && (
                    <>
                      {" "}· last signed in <RelativeTime value={c.last_seen_at} />
                    </>
                  )}
                </p>
              </div>
              {c.blocked === 1 && <span className={chipClass("error", "sm")}>Blocked</span>}
              {c.blocked === 1 ? (
                <Button variant="secondary" size="sm" icon={<UserCheck />} onClick={() => setBlocked(c, false)}>
                  Unblock
                </Button>
              ) : (
                <Button variant="ghost" size="sm" icon={<UserX />} onClick={() => setBlocked(c, true)}>
                  Block
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
