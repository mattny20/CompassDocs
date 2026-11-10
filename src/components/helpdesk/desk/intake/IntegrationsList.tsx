"use client";

// Settings → Integrations (agent P): the monitoring tools, bots and
// automated mail senders that open tickets on their own. One row each:
// kind, team, when it last sent something and how many distinct alerts in
// the last day; a row opens the integration's page.

import Link from "next/link";
import { useEffect, useState } from "react";
import { Plug, Plus } from "lucide-react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { EmptyState } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { RelativeTime } from "@/components/RelativeTime";
import { LoadingRow } from "@/components/Spinner";
import { TABLE_HEAD_ROW, TD, TH, TR, Table } from "@/components/Table";
import { HD_INTEGRATION_KIND_LABEL, type HdIntegrationView } from "@/lib/helpdesk/intake/shared";
import { getJson } from "../api";
import { KIND_ICON } from "./kind-icons";

export const INTEGRATIONS_SUBTITLE = "Monitoring tools, bots and automated mail that open tickets on their own.";

export function IntegrationsList() {
  const [rows, setRows] = useState<HdIntegrationView[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getJson<{ integrations: HdIntegrationView[] }>("/api/helpdesk/intake/integrations", "Couldn't load the integrations.")
      .then((d) => setRows(d.integrations))
      .catch((e: Error) => {
        setError(e.message);
        setRows([]);
      });
  }, []);

  return (
    <PageContainer>
      <PageHeader
        back={{ href: "/desk/settings/integrations", label: "Integrations" }}
        icon={<Plug />}
        title="Alert sources"
        subtitle={INTEGRATIONS_SUBTITLE}
        actions={
          rows && rows.length > 0 ? (
            <Button href="/desk/settings/integrations/new" icon={<Plus />}>
              New integration
            </Button>
          ) : undefined
        }
      />
      {error && <p className="notice-error mb-4 rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {rows === null && <LoadingRow className="py-10" />}
      {rows && rows.length === 0 && !error && (
        <EmptyState
          icon={<Plug />}
          title="No integrations yet"
          body="Connect Prometheus, Grafana, Datadog, Azure Monitor or a script, and their alerts open tickets here. Repeats update the same ticket, and a resolved alert solves it."
          action={{ href: "/desk/settings/integrations/new", label: "New integration", icon: <Plus /> }}
        />
      )}
      {rows && rows.length > 0 && (
        <Card padding="none">
          <Table scroll minWidth="44rem">
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th scope="col" className={TH}>Integration</th>
                <th scope="col" className={TH}>Team</th>
                <th scope="col" className={`${TH} w-px whitespace-nowrap`}>Last used</th>
                <th scope="col" className={`${TH} w-px whitespace-nowrap text-right`}>Alerts, 24h</th>
                <th scope="col" className={`${TH} w-px whitespace-nowrap`}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const Icon = KIND_ICON[r.kind];
                return (
                  <tr key={r.id} className={TR}>
                    <td className={TD}>
                      <Link href={`/desk/settings/integrations/${r.id}`} className="group flex min-w-0 items-center gap-3">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                          <Icon className="h-4 w-4" aria-hidden />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-slate-900 group-hover:underline">{r.name}</span>
                          <span className="block truncate text-xs text-slate-500">{HD_INTEGRATION_KIND_LABEL[r.kind]}</span>
                        </span>
                      </Link>
                    </td>
                    <td className={`${TD} text-slate-700`}>{r.team_name ?? <span className="text-slate-500">Unrouted</span>}</td>
                    <td className={`${TD} whitespace-nowrap text-slate-700`}>
                      {r.last_used_at ? <RelativeTime value={r.last_used_at} /> : <span className="text-slate-500">Never</span>}
                    </td>
                    <td className={`${TD} text-right text-slate-700`}>{r.alerts_24h}</td>
                    <td className={TD}>
                      <span className={chipClass(r.enabled ? "ok" : "neutral", "sm")}>{r.enabled ? "On" : "Off"}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
    </PageContainer>
  );
}
