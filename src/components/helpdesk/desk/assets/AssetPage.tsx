"use client";

// One asset's page in the desk (1.19.3; mock-up i2), /desk/assets/[id]: the
// trail "Assets › TAG", the asset's picture, name and "TAG · serial … · from
// Snipe-IT" with "Open in Snipe-IT"; then "Tickets on this asset" (ticket,
// requester, status, opened, time logged; only the tickets the viewer may
// open, the rest counted in one line) beside the Details card and
// "Maintenance in Snipe-IT" (the source's records, newest first; a record
// naming a ticket the viewer can't open is only counted). The
// details are refreshed from the source when it answers; when it doesn't,
// a notice says the page shows what was synced last.
// GET /api/helpdesk/assets/[id] (agents; 404 for an asset they may not see).

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, ExternalLink, Package, Wrench } from "lucide-react";
import { Button } from "@/components/Button";
import { Card, CARD_CLASS } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { EYEBROW_TEXT } from "@/components/Heading";
import { EmptyState, SectionEmpty } from "@/components/form";
import { PageContainer } from "@/components/PageWidth";
import { LoadingRow } from "@/components/Spinner";
import { Table, TABLE_HEAD_ROW, Td, Th, TR } from "@/components/Table";
import { formatMinutes } from "@/lib/helpdesk/time-shared";
import { dayMonth, maintenanceTypeLabel, monthYear, statusText, warrantyLabel, type HdAssetPage } from "@/lib/helpdesk/assets-shared";
import type { HdStatus } from "@/lib/helpdesk/types";
import { ApiError, getJson } from "../api";
import { statusChip, ticketHref } from "../ui";
import { AssetGlyph } from "./TicketAssets";

function opened(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Today";
  return dayMonth(iso.slice(0, 10), today);
}

export function AssetPageView({ id }: { id: number }) {
  const [page, setPage] = useState<HdAssetPage | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);

  useEffect(() => {
    getJson<HdAssetPage>(`/api/helpdesk/assets/${id}`, "Couldn't load that asset.")
      .then(setPage)
      .catch((e: unknown) => setError({ status: e instanceof ApiError ? e.status : 0, message: (e as Error).message }));
  }, [id]);

  if (error) {
    return (
      <PageContainer>
        <EmptyState
          icon={<Package />}
          title={error.status === 404 ? "Asset not found" : "Couldn't load that asset"}
          body={error.status === 404 ? "It may have been removed from the source, or it isn't one you can see." : error.message}
          action={{ href: "/desk/assets", label: "Search assets" }}
        />
      </PageContainer>
    );
  }
  if (!page) return <PageContainer><LoadingRow className="py-10" /></PageContainer>;
  const a = page.asset;
  const sub = [a.tag, a.serial ? `serial ${a.serial}` : "", `from ${a.provider_label}`].filter(Boolean).join(" · ");
  const details: [string, string][] = (
    [
      ["Status", statusText(a)],
      ["Assigned to", a.assigned_name || (a.assigned_email ? a.assigned_email : "Nobody")],
      ["Model", a.model && a.model !== a.name ? a.model : ""],
      ["Category", a.category],
      ["Location", a.location],
      ["Purchased", monthYear(a.purchase_date)],
      ["Warranty", warrantyLabel(a.warranty_end)],
    ] as [string, string][]
  ).filter(([, v]) => v);

  return (
    <PageContainer>
      <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-1.5 text-sm text-slate-500 print:hidden">
        <Link href="/desk/assets" className="inline-flex items-center gap-1.5 hover:text-slate-700">
          <Package className="h-3.5 w-3.5" aria-hidden />
          Assets
        </Link>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        <span aria-current="page" className="truncate text-slate-700">
          {a.tag || a.name}
        </span>
      </nav>

      <div className="mb-6 flex flex-wrap items-center gap-4">
        <AssetGlyph a={a} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold text-slate-900">{a.name}</h1>
          <p className="text-sm text-slate-600">{sub}</p>
        </div>
        {a.url && (
          <Button variant="secondary" icon={<ExternalLink />} href={a.url} target="_blank" rel="noopener noreferrer" className="print:hidden">
            Open in {a.provider_label}
            <span className="sr-only"> (opens in a new tab)</span>
          </Button>
        )}
      </div>

      {(page.notice || a.gone) && (
        <p className="notice-warn mb-4 rounded-lg border px-3 py-2 text-sm" role="status">
          {a.gone ? `This asset is no longer in ${a.provider_label}. Its tickets are kept here.` : page.notice}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card title="Tickets on this asset" padding="none">
          {page.tickets.length === 0 ? (
            <SectionEmpty className="px-4 py-4">
              {page.hidden_tickets ? "None that you can open." : "No tickets yet. Link this asset from a ticket's side panel."}
            </SectionEmpty>
          ) : (
            <Table scroll minWidth="40rem">
              <thead className={TABLE_HEAD_ROW}>
                <tr>
                  <Th>Ticket</Th>
                  <Th>Requester</Th>
                  <Th fit>Status</Th>
                  <Th fit>Opened</Th>
                  <Th fit align="right">
                    Time
                  </Th>
                </tr>
              </thead>
              <tbody>
                {page.tickets.map((t) => {
                  const chip = statusChip({ status: t.status as HdStatus });
                  return (
                    <tr key={t.number} className={TR}>
                      <Td>
                        <Link href={ticketHref(t.number)} className="font-semibold text-slate-900 hover:underline">
                          #{t.number} {t.subject}
                        </Link>
                      </Td>
                      <Td>{t.requester_name}</Td>
                      <Td fit>
                        <span className={chipClass(chip.tone, "sm")}>{chip.label}</span>
                      </Td>
                      <Td fit>
                        <span className="text-slate-600">{opened(t.created_at)}</span>
                      </Td>
                      <Td fit align="right">
                        <span className="text-slate-600">{t.minutes ? formatMinutes(t.minutes) : "None"}</span>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
          {page.hidden_tickets > 0 && page.tickets.length > 0 && (
            <p className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">
              {page.hidden_tickets === 1 ? "1 more ticket" : `${page.hidden_tickets} more tickets`} on this asset {page.hidden_tickets === 1 ? "is" : "are"} in queues you don&apos;t work.
            </p>
          )}
        </Card>

        <div className="flex flex-col gap-3">
          <section aria-labelledby="asset-details" className={`${CARD_CLASS} px-4 py-3.5`}>
            <h2 id="asset-details" className={EYEBROW_TEXT}>
              Details
            </h2>
            <dl className="mt-2.5 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
              {details.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-slate-500">{k}</dt>
                  <dd className="min-w-0 break-words text-slate-800">{v}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section aria-labelledby="asset-maintenance" className={`${CARD_CLASS} px-4 py-3.5`} data-testid="asset-maintenance">
            <h2 id="asset-maintenance" className={`${EYEBROW_TEXT} flex items-center gap-1.5`}>
              <Wrench className="h-3.5 w-3.5" aria-hidden /> Maintenance in {a.provider_label}
            </h2>
            {page.maintenance === null ? (
              <SectionEmpty className="mt-2">Not available right now.</SectionEmpty>
            ) : page.maintenance.length === 0 ? (
              page.hidden_maintenance === 0 && <SectionEmpty className="mt-2">No maintenance recorded yet.</SectionEmpty>
            ) : (
              <ul className="mt-1">
                {page.maintenance.map((m) => (
                  <li key={m.id} className="flex items-baseline justify-between gap-3 border-b border-slate-100 py-2 text-sm last:border-b-0">
                    <span className="min-w-0 text-slate-800">
                      {[maintenanceTypeLabel(m.type), m.title].filter(Boolean).join(" · ")}
                      {m.supplier && <span className="block text-xs text-slate-500">{m.supplier}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-slate-500">{dayMonth(m.completion_date ?? m.start_date)}</span>
                  </li>
                ))}
              </ul>
            )}
            {page.hidden_maintenance > 0 && (
              <p className="mt-2 text-xs text-slate-500" data-testid="asset-maintenance-hidden">
                {page.hidden_maintenance === 1 ? "1 record from a ticket you can't open." : `${page.hidden_maintenance} records from tickets you can't open.`}
              </p>
            )}
          </section>
        </div>
      </div>
    </PageContainer>
  );
}
