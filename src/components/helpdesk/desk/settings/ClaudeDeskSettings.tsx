"use client";

// Desk settings → Claude in the desk (1.20.0, mock c3): the switch and the
// teams it is on for, what Claude can do (five switches, as drawn), web
// search limited to listed sites, and spending (monthly limits for the
// workspace and per agent, this month's estimated use from hd_claude_usage).
// The key and the model are Settings → AI's: this page only says which model
// and whether the key is there. GET/PUT /api/helpdesk/admin/claude-desk
// (settings.manage). STYLEGUIDE §Helpdesk: Claude in the desk.

import { useEffect, useRef, useState } from "react";
import { Check, Sparkle, Users } from "lucide-react";
import { buttonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { Field, SectionEmpty, TextInput, Textarea, Toggle } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { Popover } from "@/components/Popover";
import { SaveRow } from "@/components/SaveRow";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import {
  CLAUDE_DATA_NOTICE,
  CLAUDE_DESK_CAP_HINT,
  CLAUDE_DESK_CAP_LABEL,
  CLAUDE_DESK_CAPS,
  CLAUDE_DESK_LIMITS,
  CLAUDE_ESTIMATE_NOTE,
  cleanDomain,
  dollars,
  webHint,
  type ClaudeDeskAdminView,
  type ClaudeDeskCap,
  type ClaudeDeskConfig,
} from "@/lib/helpdesk/claude/shared";
import { getJson, sendJson } from "../api";
import { DeskNewStrip } from "./DeskNew";

interface Form {
  cfg: ClaudeDeskConfig;
  domains: string;
  limitWorkspace: string;
  limitAgent: string;
}

const toForm = (cfg: ClaudeDeskConfig): Form => ({
  cfg,
  domains: cfg.web_domains.join(", "),
  limitWorkspace: cfg.limit_workspace_usd === null ? "" : String(cfg.limit_workspace_usd),
  limitAgent: cfg.limit_agent_usd === null ? "" : String(cfg.limit_agent_usd),
});

function parseDomains(text: string): { list: string[]; bad: string | null } {
  const list: string[] = [];
  for (const raw of text.split(/[\s,]+/).filter(Boolean)) {
    const d = cleanDomain(raw);
    if (!d) return { list, bad: raw };
    if (!list.includes(d)) list.push(d);
  }
  return { list, bad: null };
}

function limitError(v: string): string | null {
  if (!v.trim()) return null;
  const n = Number(v.replace(/^\$/, ""));
  return Number.isFinite(n) && n >= 0 && n <= CLAUDE_DESK_LIMITS.limit ? null : "A dollar amount, or empty for no limit.";
}

export function ClaudeDeskSettings() {
  const [data, setData] = useState<ClaudeDeskAdminView | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [teamsOpen, setTeamsOpen] = useState(false);
  const teamsBtn = useRef<HTMLButtonElement>(null);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(form ? JSON.stringify(form) : "");
  useLeaveGuard(dirty, hasUnsavedChanges);

  useEffect(() => {
    getJson<ClaudeDeskAdminView>("/api/helpdesk/admin/claude-desk", "Couldn't load the Claude in the desk settings.")
      .then((d) => {
        setData(d);
        setForm(toForm(d.config));
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error && !data) return <PageContainer><p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p></PageContainer>;
  if (!data || !form) return <PageContainer><LoadingRow className="py-10" /></PageContainer>;

  const set = (patch: Partial<Form>) => {
    markDirty();
    setForm((f) => (f ? { ...f, ...patch } : f));
  };
  const setCfg = (patch: Partial<ClaudeDeskConfig>) => set({ cfg: { ...form.cfg, ...patch } });
  const setCap = (k: ClaudeDeskCap, v: boolean) => setCfg({ caps: { ...form.cfg.caps, [k]: v } });

  const domains = parseDomains(form.domains);
  const domainError = domains.bad ? `"${domains.bad}" isn't a site name. Use names like support.microsoft.com.` : null;
  const wsError = limitError(form.limitWorkspace);
  const agentError = limitError(form.limitAgent);
  const on = data.teams.filter((t) => !form.cfg.teams_off.includes(t.id));
  const off = data.teams.filter((t) => form.cfg.teams_off.includes(t.id));

  async function save() {
    if (!form || domainError || wsError || agentError) return;
    setBusy(true);
    try {
      const body = {
        enabled: form.cfg.enabled,
        teams_off: form.cfg.teams_off,
        caps: form.cfg.caps,
        web_domains: domains.list,
        web_max_uses: form.cfg.web_max_uses,
        limit_workspace_usd: form.limitWorkspace.trim() ? Number(form.limitWorkspace.replace(/^\$/, "")) : null,
        limit_agent_usd: form.limitAgent.trim() ? Number(form.limitAgent.replace(/^\$/, "")) : null,
      };
      const d = await sendJson<ClaudeDeskAdminView>("/api/helpdesk/admin/claude-desk", "PUT", body, "Couldn't save the Claude in the desk settings.");
      setData(d);
      const next = toForm(d.config);
      setForm(next);
      markClean(JSON.stringify(next));
      toast("ok", "Claude in the desk settings saved.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const u = data.usage;
  const stats: [string, string][] = [
    ["This month", dollars(u.month_usd)],
    ["Chats", u.turns.toLocaleString("en-US")],
    ["Drafts used", u.drafts_used_percent === null ? "None yet" : `${u.drafts_used_percent}%`],
    ["Top user", u.top_user ? `${u.top_user.name} · ${dollars(u.top_user.usd)}` : "Nobody yet"],
  ];

  return (
    <PageContainer>
      <DeskNewStrip />
      <PageHeader
        icon={<Sparkle />}
        title="Claude in the desk"
        subtitle="A Claude chat inside the desk that works on tickets with each agent, using your workspace's Anthropic API key."
      />
      <div className="flex flex-col gap-4">
        <Card>
          <Toggle
            size="full"
            label="Claude in the desk"
            help={`Uses the key and model set in Settings → AI · ${data.model_label}`}
            checked={form.cfg.enabled}
            onChange={(v) => setCfg({ enabled: v })}
          />
          {!data.key_ready && (
            <p className="notice-warn mt-3 rounded-lg border px-3 py-2 text-sm">
              {data.provider !== "anthropic"
                ? "Settings → AI uses another provider. Claude in the desk needs the Anthropic provider and its API key."
                : "There's no Anthropic API key in Settings → AI yet. Agents see Claude once a key is saved."}
            </p>
          )}
          <p className="mt-4 mb-1.5 text-sm font-medium text-slate-800">Teams</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {on.map((t) => (
              <span key={t.id} className={chipClass("neutral")}>
                {t.name}
              </span>
            ))}
            {off.map((t) => (
              <span key={t.id} className="px-1 text-xs text-slate-500">
                {t.name}: off
              </span>
            ))}
            {data.teams.length === 0 && <SectionEmpty action={{ href: "/desk/settings/teams", label: "Add a team" }}>No teams yet. Claude works on every ticket until you add teams.</SectionEmpty>}
            {data.teams.length > 0 && (
              <span className="relative">
                <button
                  ref={teamsBtn}
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={teamsOpen}
                  onClick={() => setTeamsOpen((o) => !o)}
                  className={buttonClass("ghost", "sm")}
                >
                  <Users className="h-3.5 w-3.5" aria-hidden />
                  Choose teams…
                </button>
                <Popover open={teamsOpen} onClose={() => setTeamsOpen(false)} triggerRef={teamsBtn} role="menu" label="Teams Claude is on for" width="w-64" className="mt-1">
                  {data.teams.map((t) => {
                    const checked = !form.cfg.teams_off.includes(t.id);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={checked}
                        onClick={() => setCfg({ teams_off: checked ? [...form.cfg.teams_off, t.id].sort((x, y) => x - y) : form.cfg.teams_off.filter((x) => x !== t.id) })}
                        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-slate-800 hover:bg-slate-100"
                      >
                        <span className="grid h-4 w-4 place-items-center" aria-hidden>
                          {checked && <Check className="h-4 w-4 text-compass-600" />}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{t.name}</span>
                      </button>
                    );
                  })}
                </Popover>
              </span>
            )}
          </div>
        </Card>

        <Card title="What Claude can do">
          <div className="divide-y divide-slate-100">
            {CLAUDE_DESK_CAPS.filter((k) => k !== "web" || data.web_available).map((k) => (
              <div key={k} className="py-3 first:pt-0 last:pb-0">
                <Toggle
                  size="full"
                  label={CLAUDE_DESK_CAP_LABEL[k]}
                  help={k === "web" ? webHint(domains.list) : CLAUDE_DESK_CAP_HINT[k]}
                  checked={form.cfg.caps[k]}
                  onChange={(v) => setCap(k, v)}
                />
                {k === "web" && form.cfg.caps.web && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
                    <Field label="Sites Claude may search" help="Site names, separated by commas. Pages under each site are included." error={domainError}>
                      <Textarea rows={2} value={form.domains} onChange={(e) => set({ domains: e.target.value })} placeholder="support.microsoft.com, support.apple.com" />
                    </Field>
                    <Field label="Searches per answer" help={`1 to ${CLAUDE_DESK_LIMITS.maxUses}.`}>
                      <TextInput
                        type="number"
                        min={1}
                        max={CLAUDE_DESK_LIMITS.maxUses}
                        value={String(form.cfg.web_max_uses)}
                        onChange={(e) => setCfg({ web_max_uses: Math.min(CLAUDE_DESK_LIMITS.maxUses, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
                      />
                    </Field>
                  </div>
                )}
              </div>
            ))}
          </div>
          {!data.web_available && (
            <p className="mt-3 text-xs text-slate-500">Web search isn&apos;t offered for {data.model_label} on this provider.</p>
          )}
        </Card>

        <Card title="Spending">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Monthly limit for the workspace" help="Empty for no limit." error={wsError}>
              <TextInput inputMode="decimal" value={form.limitWorkspace} placeholder="No limit" onChange={(e) => set({ limitWorkspace: e.target.value })} />
            </Field>
            <Field label="Monthly limit per agent" help="Empty for no limit." error={agentError}>
              <TextInput inputMode="decimal" value={form.limitAgent} placeholder="No limit" onChange={(e) => set({ limitAgent: e.target.value })} />
            </Field>
          </div>
          <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-3">
            {stats.map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-slate-500">{k}</dt>
                <dd className="text-lg font-bold text-slate-900">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-slate-500">
            {CLAUDE_DATA_NOTICE} {CLAUDE_ESTIMATE_NOTE}
          </p>
        </Card>
      </div>
      <SaveRow dirty={dirty} busy={busy} onSave={save} disabled={!!(domainError || wsError || agentError)} label="Save Claude settings" />
    </PageContainer>
  );
}
