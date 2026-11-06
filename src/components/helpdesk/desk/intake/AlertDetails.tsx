"use client";

// The alert behind an automated (or integration-opened) ticket, for the
// desk's side panel (agent P; D mounts <AlertDetails ticket={t} /> in the
// ticket's SidePanel). Firing or resolved, how often it fired, when, the
// tool's severity and source, its links (http(s) only, opened in a new tab)
// and fields. Renders nothing for a ticket no integration opened.

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, Settings2 } from "lucide-react";
import { chipClass } from "@/components/Chip";
import { CARD_CLASS } from "@/components/Card";
import { EYEBROW_TEXT } from "@/components/Heading";
import { RelativeTime } from "@/components/RelativeTime";
import { LoadingRow } from "@/components/Spinner";
import { SectionEmpty } from "@/components/form";
import { HD_INTEGRATION_KIND_LABEL, type HdAlertDetailsView } from "@/lib/helpdesk/intake/shared";
import { getJson } from "../api";

export interface AlertTicketLike {
  number: number;
  automated?: number | boolean | null;
  integration_id?: number | null;
  source_ref?: Record<string, unknown> | null;
}

function integrationOf(t: AlertTicketLike): number | null {
  if (typeof t.integration_id === "number") return t.integration_id;
  const ref = t.source_ref?.integration_id;
  return typeof ref === "number" ? ref : null;
}

export function AlertDetails({ ticket, canManage = false }: { ticket: AlertTicketLike; canManage?: boolean }) {
  const linked = integrationOf(ticket) !== null;
  const [d, setD] = useState<HdAlertDetailsView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!linked) return;
    let live = true;
    setD(null);
    getJson<HdAlertDetailsView>(`/api/helpdesk/intake/tickets/${ticket.number}`, "Couldn't load the alert.")
      .then((r) => live && setD(r))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [ticket.number, linked]);

  if (!linked) return null;
  const a = d?.alert;
  const fields = a ? Object.entries(a.fields) : [];

  return (
    <section aria-labelledby="alert-h" className={`${CARD_CLASS} p-4`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 id="alert-h" className={EYEBROW_TEXT}>
          Alert
        </h3>
        {a && <span className={chipClass(a.state === "firing" ? "error" : "ok", "sm")}>{a.state === "firing" ? "Firing" : "Resolved"}</span>}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!d && !error && <LoadingRow className="py-3" />}
      {d && (
        <div className="space-y-3 text-sm">
          {d.integration && (
            <p className="text-slate-600">
              From <span className="font-medium text-slate-800">{d.integration.name}</span>
              <span className="text-slate-500"> · {HD_INTEGRATION_KIND_LABEL[d.integration.kind]}</span>
              {canManage && (
                <Link
                  href={`/desk/settings/integrations/${d.integration.id}`}
                  className="ml-1 inline-flex align-middle text-slate-500 hover:text-slate-700"
                  aria-label="Integration settings"
                  data-tt="Integration settings"
                >
                  <Settings2 className="h-3.5 w-3.5" aria-hidden />
                </Link>
              )}
            </p>
          )}
          {a ? (
            <>
              <dl className="space-y-1.5">
                <Row label="Fired">{a.count === 1 ? "Once" : `${a.count} times`}</Row>
                <Row label="First seen"><RelativeTime value={a.first_seen} /></Row>
                <Row label="Last seen"><RelativeTime value={a.last_seen} /></Row>
                {a.resolved_at && a.state === "resolved" && <Row label="Resolved"><RelativeTime value={a.resolved_at} /></Row>}
                {a.severity && <Row label="Severity">{a.severity}</Row>}
                {a.source && <Row label="Source">{a.source}</Row>}
              </dl>
              {a.links.length > 0 && (
                <ul className="space-y-1">
                  {a.links.map((l) => (
                    <li key={l.url}>
                      <a href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 font-medium text-compass-700 hover:underline">
                        {l.label}
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                        <span className="sr-only">(opens in a new tab)</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              {fields.length > 0 && (
                <details className="group">
                  <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-700">
                    {fields.length === 1 ? "1 field" : `${fields.length} fields`}
                  </summary>
                  <dl className="mt-2 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                    {fields.map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="truncate font-mono text-slate-500">{k}</dt>
                        <dd className="break-words font-mono text-slate-700">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              )}
              <p className="text-xs text-slate-500">
                Key <code className="font-mono">{a.dedup_key}</code>
              </p>
            </>
          ) : (
            <SectionEmpty>No alert details are stored for this ticket.</SectionEmpty>
          )}
        </div>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-slate-700">{label}</dt>
      <dd className="min-w-0 truncate text-right text-slate-800">{children}</dd>
    </div>
  );
}
