// Helpdesk 1.19.0, machine intake (agent P): the desk's view of one
// ticket's alert (the AlertDetails panel) and the admin gate the
// integrations routes share. Server-only.

import "server-only";
import { hqOne } from "../db-core";
import { hdAnyCapGate } from "../roles";
import type { HdCap } from "../roles";
import { ensureIntakeSchema } from "./integrations";
import type { HdAlertDetailsView, HdIntegrationKind } from "./shared";

/** Who may configure integrations: the email channel's capability (settings.manage covers it, as for Email). */
export const INTAKE_ADMIN_CAPS: HdCap[] = ["channels.manage", "settings.manage"];
export const intakeAdminGate = () => hdAnyCapGate(INTAKE_ADMIN_CAPS);

export async function alertDetailsFor(ticketId: number): Promise<HdAlertDetailsView> {
  await ensureIntakeSchema();
  const t = await hqOne<{ automated: number; integration_id: number | null; name: string | null; kind: HdIntegrationKind | null }>(
    `SELECT t.automated, t.integration_id, i.name, i.kind
       FROM hd_tickets t LEFT JOIN hd_integrations i ON i.id = t.integration_id WHERE t.id = $1`,
    [ticketId]
  );
  if (!t) return { integration: null, automated: false, alert: null };
  const k = t.integration_id
    ? await hqOne<NonNullable<HdAlertDetailsView["alert"]>>(
        `SELECT dedup_key, state, count, first_seen, last_seen, resolved_at, severity, source, links, fields
           FROM hd_alert_keys WHERE ticket_id = $1 ORDER BY last_seen DESC LIMIT 1`,
        [ticketId]
      )
    : undefined;
  return {
    integration: t.integration_id && t.kind ? { id: t.integration_id, name: t.name ?? "", kind: t.kind } : null,
    automated: t.automated === 1,
    alert: k ?? null,
  };
}
