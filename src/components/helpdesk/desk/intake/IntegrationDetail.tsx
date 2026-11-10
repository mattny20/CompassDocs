"use client";

// Settings → Integrations → one integration (agent P): its endpoint and key
// (make a new key: shown once), "Send a test alert", its settings, the
// recent deliveries log (the newest 50: when, the status code, what came of
// it and why, the ticket), the tool's setup notes, and turn off / delete.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { KeyRound, Power, RefreshCw, Send, Trash2 } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { chipClass, type ChipTone } from "@/components/Chip";
import { CopyButton } from "@/components/CopyButton";
import { confirmDialog } from "@/components/Dialog";
import { DangerAction, DangerZone, SectionEmpty } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { RelativeTime } from "@/components/RelativeTime";
import { SaveRow } from "@/components/SaveRow";
import { LoadingRow } from "@/components/Spinner";
import { TABLE_HEAD_ROW, TD, TH, TR, Table } from "@/components/Table";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import {
  HD_INTAKE_OUTCOME_LABEL,
  HD_INTEGRATION_KIND_LABEL,
  type HdDeliveryView,
  type HdIntakeOutcome,
  type HdIntegrationView,
} from "@/lib/helpdesk/intake/shared";
import { getJson, sendJson } from "../api";
import { ticketHref } from "../ui";
import { IntegrationForm, draftBody, draftFrom, type IntegrationDraft } from "./IntegrationForm";
import { KIND_ICON } from "./kind-icons";
import { KeyOnce, absoluteUrl } from "./KeyOnce";
import { SetupNotes } from "./SetupNotes";

export const OUTCOME_TONE: Record<HdIntakeOutcome, ChipTone> = {
  created: "info",
  updated: "neutral",
  reopened: "warn",
  resolved: "ok",
  ignored: "neutral",
  rejected: "error",
};

export function IntegrationDetail({ id }: { id: number }) {
  const router = useRouter();
  const [v, setV] = useState<HdIntegrationView | null>(null);
  const [teams, setTeams] = useState<{ id: number; name: string }[]>([]);
  const [draft, setDraft] = useState<IntegrationDraft | null>(null);
  const [deliveries, setDeliveries] = useState<HdDeliveryView[] | null>(null);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const snap = JSON.stringify(draft);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(snap);
  useLeaveGuard(dirty, hasUnsavedChanges);

  const loadDeliveries = useCallback(() => {
    getJson<{ deliveries: HdDeliveryView[] }>(`/api/helpdesk/intake/integrations/${id}/deliveries`, "Couldn't load the deliveries.")
      .then((d) => setDeliveries(d.deliveries))
      .catch(() => setDeliveries([]));
  }, [id]);

  useEffect(() => {
    Promise.all([
      getJson<{ integration: HdIntegrationView }>(`/api/helpdesk/intake/integrations/${id}`, "Couldn't load the integration."),
      getJson<{ teams: { id: number; name: string }[] }>("/api/helpdesk/intake/integrations", "Couldn't load the teams."),
    ])
      .then(([one, all]) => {
        setV(one.integration);
        const d = draftFrom(one.integration);
        setDraft(d);
        markClean(JSON.stringify(d));
        setTeams(all.teams);
      })
      .catch((e: Error) => setError(e.message));
    loadDeliveries();
    // markClean is stable for the page's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, loadDeliveries]);

  if (error && !v) return <PageContainer><p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p></PageContainer>;
  if (!v || !draft) return <PageContainer><LoadingRow className="py-10" /></PageContainer>;

  const Icon = KIND_ICON[v.kind];
  const url = absoluteUrl(v.endpoint_path);

  async function patch(body: Record<string, unknown>, ok: string): Promise<boolean> {
    setBusy(true);
    try {
      const r = await sendJson<{ integration: HdIntegrationView }>(`/api/helpdesk/intake/integrations/${id}`, "PATCH", body, "Couldn't save the integration.");
      setV(r.integration);
      toast("ok", ok);
      return true;
    } catch (e) {
      toast("error", (e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!draft || !v) return;
    if (await patch(draftBody(draft, v.kind), "Integration saved.")) markClean(snap);
  }

  async function rotate() {
    const ok = await confirmDialog({
      title: "Make a new key?",
      body: "The current key stops working at once. Put the new one into the tool straight away, or its alerts are refused.",
      confirmLabel: "Make a new key",
      danger: true,
    });
    if (ok !== true) return;
    try {
      const r = await sendJson<{ integration: HdIntegrationView; key: string }>(`/api/helpdesk/intake/integrations/${id}/rotate`, "POST", {}, "Couldn't make a new key.");
      setV(r.integration);
      setFreshKey(r.key);
      toast("ok", "New key made. Copy it now.");
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function sendTest() {
    setBusy(true);
    try {
      const r = await sendJson<{ ticket?: number | null }>(`/api/helpdesk/intake/integrations/${id}/test`, "POST", {}, "Couldn't send the test alert.");
      toast("ok", r.ticket ? `Test alert sent: ticket #${r.ticket}.` : "Test alert sent.");
      loadDeliveries();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled() {
    if (!v) return;
    if (v.enabled) {
      const ok = await confirmDialog({
        title: `Turn off ${v.name}?`,
        body: "Its alerts are refused (403) until you turn it on again. Open tickets stay as they are.",
        confirmLabel: "Turn off",
        danger: true,
      });
      if (ok !== true) return;
    }
    await patch({ enabled: !v.enabled }, v.enabled ? "Integration turned off." : "Integration turned on.");
  }

  async function remove() {
    if (!v) return;
    const ok = await confirmDialog({
      title: `Delete ${v.name}?`,
      body: "Its key stops working and its alert history and deliveries go. The tickets it opened stay, no longer linked to it.",
      confirmLabel: "Delete integration",
      danger: true,
    });
    if (ok !== true) return;
    try {
      await sendJson(`/api/helpdesk/intake/integrations/${id}`, "DELETE", undefined, "Couldn't delete the integration.");
      toast("ok", `${v.name} deleted.`);
      router.push("/desk/settings/integrations/alerts");
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        icon={<Icon />}
        title={v.name}
        subtitle={HD_INTEGRATION_KIND_LABEL[v.kind]}
        back={{ href: "/desk/settings/integrations/alerts", label: "Alert sources" }}
        actions={
          <>
            <span className={chipClass(v.enabled ? "ok" : "neutral")}>{v.enabled ? "On" : "Off"}</span>
            <Button variant="secondary" icon={<Send />} onClick={sendTest} disabled={busy}>
              Send a test alert
            </Button>
          </>
        }
      />
      <div className="flex flex-col gap-4">
        {v.kind !== "email" && (
          <Card title="Endpoint" description="The tool posts its alerts here, with the key as a Bearer token.">
            {freshKey ? (
              <KeyOnce kind={v.kind} endpointPath={v.endpoint_path} apiKey={freshKey} onDone={() => setFreshKey(null)} doneLabel="I've copied the key" />
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="min-w-0 max-w-full truncate rounded-md border border-slate-200 bg-canvas px-2 py-1.5 font-mono text-xs text-slate-700">{url}</code>
                  <CopyButton text={url} label="Copy URL" />
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
                  <span>
                    Key <code className="font-mono text-xs">{v.token_prefix}…</code>
                  </span>
                  <Button variant="secondary" size="sm" icon={<KeyRound />} onClick={rotate}>
                    Make a new key
                  </Button>
                </div>
              </div>
            )}
          </Card>
        )}

        <Card title="Settings">
          <IntegrationForm
            kind={v.kind}
            draft={draft}
            teams={teams}
            onChange={(p) => {
              markDirty();
              setDraft({ ...draft, ...p });
            }}
          />
          <SaveRow dirty={dirty} busy={busy} onSave={() => void save()} label="Save integration" sticky={false} />
        </Card>

        <Card
          title="Recent deliveries"
          description="The newest 50: what each alert became, and why."
          padding="none"
          actions={
            <button type="button" onClick={loadDeliveries} className={iconButtonClass("bordered")} aria-label="Refresh deliveries" data-tt="Refresh">
              <RefreshCw aria-hidden />
            </button>
          }
        >
          {deliveries === null ? (
            <LoadingRow className="py-6" />
          ) : deliveries.length === 0 ? (
            <SectionEmpty className="px-4 py-6">
              Nothing received yet. Send a test alert, or point {v.kind === "email" ? "the tool's mail at your help address" : "the tool at the endpoint above"}.
            </SectionEmpty>
          ) : (
            <Table scroll minWidth="40rem">
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th scope="col" className={`${TH} w-px whitespace-nowrap`}>When</th>
                  <th scope="col" className={`${TH} w-px whitespace-nowrap`}>Code</th>
                  <th scope="col" className={`${TH} w-px whitespace-nowrap`}>Outcome</th>
                  <th scope="col" className={`${TH} w-px whitespace-nowrap`}>Ticket</th>
                  <th scope="col" className={TH}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id} className={TR}>
                    <td className={`${TD} whitespace-nowrap text-slate-700`}><RelativeTime value={d.at} /></td>
                    <td className={`${TD} font-mono text-xs ${d.status_code >= 400 ? "text-red-600" : "text-slate-700"}`}>{d.status_code}</td>
                    <td className={TD}><span className={chipClass(OUTCOME_TONE[d.outcome] ?? "neutral", "sm")}>{HD_INTAKE_OUTCOME_LABEL[d.outcome] ?? d.outcome}</span></td>
                    <td className={`${TD} whitespace-nowrap`}>
                      {d.ticket_number ? (
                        <Link href={ticketHref(d.ticket_number)} className="link">#{d.ticket_number}</Link>
                      ) : (
                        <span className="text-slate-500">None</span>
                      )}
                    </td>
                    <td className={`${TD} text-slate-600`}>
                      <span className="block max-w-md truncate">{d.reason || (d.dedup_key ? `Key ${d.dedup_key}` : "")}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <SetupNotes kind={v.kind} url={url} />
        </Card>

        <DangerZone>
          <DangerAction
            label={v.enabled ? "Turn off" : "Turn on"}
            description={v.enabled ? "Refuse its alerts until you turn it on again." : "Accept its alerts again."}
          >
            <Button variant={v.enabled ? "danger" : "secondary"} icon={<Power />} onClick={toggleEnabled} disabled={busy}>
              {v.enabled ? "Turn off" : "Turn on"}
            </Button>
          </DangerAction>
          <DangerAction label="Delete integration" description="Its key, alert history and deliveries go. Its tickets stay.">
            <Button variant="danger" icon={<Trash2 />} onClick={remove}>
              Delete
            </Button>
          </DangerAction>
        </DangerZone>
      </div>
    </PageContainer>
  );
}
