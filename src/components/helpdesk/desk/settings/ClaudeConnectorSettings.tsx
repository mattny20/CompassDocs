"use client";

// Desk settings → Claude connector (1.19.1, agent V1): what Claude may do in
// the helpdesk for people who connect it. Claude always acts as that person,
// with their desk role and teams; the level here only narrows it (read /
// notes and drafts / also update tickets). The never-list is fixed: no
// setting lets Claude send a reply, decide an approval or publish. Below,
// the latest helpdesk writes made through the connector (audit rows with
// via "mcp"). GET/PUT /api/helpdesk/admin/claude (settings.manage).

import { useEffect, useState } from "react";
import { Ban, Bot } from "lucide-react";
import { Card } from "@/components/Card";
import { SectionEmpty } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { RadioCards } from "@/components/PolicyFields";
import { RelativeTime } from "@/components/RelativeTime";
import { SaveRow } from "@/components/SaveRow";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { initialsOf } from "@/components/UserAvatar";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import {
  HD_CLAUDE_LEVELS,
  HD_CLAUDE_LEVEL_HINT,
  HD_CLAUDE_LEVEL_LABEL,
  HD_CLAUDE_NEVER,
  type HdClaudeActivity,
  type HdClaudeLevel,
} from "@/lib/helpdesk/claude-connector-shared";
import { getJson, sendJson } from "../api";

export function ClaudeConnectorSettings() {
  const [level, setLevel] = useState<HdClaudeLevel | null>(null);
  const [activity, setActivity] = useState<HdClaudeActivity[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(level ?? "");
  useLeaveGuard(dirty, hasUnsavedChanges);

  useEffect(() => {
    getJson<{ level: HdClaudeLevel; activity: HdClaudeActivity[] }>("/api/helpdesk/admin/claude", "Couldn't load the Claude connector settings.")
      .then((d) => {
        setLevel(d.level);
        setActivity(d.activity ?? []);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error && !level) return <PageContainer><p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p></PageContainer>;
  if (!level) return <PageContainer><LoadingRow className="py-10" /></PageContainer>;

  async function save() {
    if (!level) return;
    setBusy(true);
    try {
      await sendJson("/api/helpdesk/admin/claude", "PUT", { level }, "Couldn't save the Claude connector settings.");
      markClean(level);
      toast("ok", `Claude can now: ${HD_CLAUDE_LEVEL_LABEL[level].toLowerCase()}.`);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        back={{ href: "/desk/settings/integrations", label: "Integrations" }}
        icon={<Bot />}
        title="Claude connector"
        subtitle="What Claude can do in the helpdesk for people who connect it. It always acts as that person, with their role and teams."
      />
      <div className="flex flex-col gap-4">
        <Card title="Claude can">
          <RadioCards
            label="Claude can"
            name="hd-claude-level"
            value={level}
            onChange={(v) => {
              markDirty();
              setLevel(v);
            }}
            options={HD_CLAUDE_LEVELS.map((l) => ({ value: l, label: HD_CLAUDE_LEVEL_LABEL[l], description: HD_CLAUDE_LEVEL_HINT[l] }))}
          />
        </Card>

        <Card title="Never, whatever the setting">
          <ul className="flex flex-col gap-2 text-sm text-slate-700">
            {HD_CLAUDE_NEVER.map((line) => (
              <li key={line} className="flex items-start gap-2">
                <Ban className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Recent activity via Claude" padding="none">
          {activity.length === 0 ? (
            <SectionEmpty className="px-4 py-4">Nothing yet. Notes, drafts and requests Claude saves for people show here.</SectionEmpty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {activity.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
                  <span className="flex min-w-0 items-center gap-2 font-medium text-slate-800 sm:w-56 sm:shrink-0">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-compass-100 text-2xs font-bold text-compass-700" aria-hidden>
                      {initialsOf(a.actor_name || "?")}
                    </span>
                    <span className="truncate">{a.actor_name}</span>
                  </span>
                  <span className="order-last w-full min-w-0 pl-9 text-slate-700 sm:order-none sm:w-auto sm:flex-1 sm:pl-0">{a.summary}</span>
                  <span className="ml-auto whitespace-nowrap text-xs text-slate-500">
                    <RelativeTime value={a.at} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <SaveRow dirty={dirty} busy={busy} onSave={save} label="Save Claude settings" />
    </PageContainer>
  );
}
