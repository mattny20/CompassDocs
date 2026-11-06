// Helpdesk 1.19.0, machine intake (agent P): what an alert does to the desk.
// Every integration (webhook, API, automated email) ends here with
// normalised alerts (lib/helpdesk/intake/adapters):
//
//   firing, new key            a ticket: automated = 1, the integration's
//                              service identity as requester ("Monitoring
//                              (Grafana)"), its team, priority from the
//                              severity map, the description sanitised. The
//                              usual after-create hooks run (rules, the
//                              assignment, agents' notices); the requester
//                              notices skip automated tickets.
//   firing, key open           an internal "Fired again (×N)" line, the count
//                              bumped. No new ticket, no hooks (no notices,
//                              no assignment re-run).
//   firing, key solved         within the dedup window and reopen_on_repeat:
//                              reopened with a note. Otherwise (closed, too
//                              old, reopen off) a new ticket, which notes the
//                              earlier one.
//   resolved                   an internal note; solved when auto_resolve is
//                              on, unless a person replied publicly on it
//                              ("Alert resolved; ticket left open because a
//                              person replied"). A resolve for an unknown or
//                              already resolved key is ignored.
//
// One request is one transaction: the retry guard (hd_intake_requests: the
// tool's request id, else a payload hash per minute) is claimed in it, so a
// retried POST has one effect however the two race; each dedup key is held
// under an advisory lock while it is decided. Status changes and the create
// hooks run after commit, through the core (updateTicket, afterTicketCreated).
//
// An API integration (kind api) may name requester_email: when that is an active
// member who may use the helpdesk, the ticket is theirs (automated = 0, so
// they get the usual notices); otherwise the address is ignored. Server-only.

import "server-only";
import { createHash } from "node:crypto";
import { logEvent } from "../../log";
import { audit } from "../../audit";
import { hqOne, withTx } from "../db-core";
import { HD_OPEN_STATUSES } from "../types";
import type { HdPriority, HdStatus, HdTicketRow } from "../types";
import { cleanFields, cleanLinks, markdownLink, plainLine, sanitizeDescription } from "./sanitize";
import { ensureIntakeSchema, recordDelivery, type HdIntegrationRow } from "./integrations";
import {
  HD_ALERT_SEVERITY_LABEL,
  HD_INTAKE_LIMITS,
  HD_INTEGRATION_KIND_SHORT,
  normalizeSeverity,
  serviceIdentityName,
  sourceForKind,
  type HdAlertLink,
  type HdIntakeOutcome,
  type HdNormalizedAlert,
} from "./shared";

// --- Rate limits and audit throttle (in memory, per process) ------------------------

const buckets = new Map<string, { count: number; resetAt: number }>();

export function intakeLimited(key: string, max: number, windowMs = 60_000, now = Date.now()): boolean {
  let w = buckets.get(key);
  if (!w || now >= w.resetAt) {
    w = { count: 0, resetAt: now + windowMs };
    buckets.set(key, w);
  }
  w.count++;
  if (buckets.size > 10_000) for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
  return w.count > max;
}

/** Tests: forget the counters. */
export function resetIntakeLimitsForTests(): void {
  buckets.clear();
}

/** Audit a refused delivery, at most once per integration and reason every ten minutes (a flood must not flood the log). */
export async function auditRejection(
  integration: { id: number; name: string } | null,
  integrationId: number,
  reason: string,
  details: Record<string, unknown> = {},
  ip: string | null = null
): Promise<void> {
  if (intakeLimited(`audit:${integrationId}:${reason}`, 1, 10 * 60_000)) return;
  await audit({
    actor: { name: integration ? `integration: ${integration.name}` : "integration" },
    action: "helpdesk.intake.rejected",
    targetType: "helpdesk_integration",
    targetId: integrationId,
    targetLabel: integration?.name ?? `Integration #${integrationId}`,
    details: { reason, ...details },
    ip,
  });
}

// --- Normalising one alert -----------------------------------------------------------

export interface PreparedAlert {
  title: string;
  body: string;
  severity: string;
  severityLabel: string;
  priority: HdPriority;
  dedup_key: string;
  source: string;
  status: "firing" | "resolved";
  links: HdAlertLink[];
  fields: Record<string, string>;
  requester_email: string;
}

/** The priority for a severity: the integration's map (canonical severity), else its default. */
export function priorityFor(integration: Pick<HdIntegrationRow, "severity_map" | "default_priority">, severity: string): HdPriority {
  const canon = normalizeSeverity(severity);
  const map = integration.severity_map ?? {};
  return (canon && map[canon]) || integration.default_priority || "normal";
}

/** Sanitise and cap one alert, and derive what is missing (the dedup key from title and source). Pure. */
export function prepareAlert(integration: Pick<HdIntegrationRow, "severity_map" | "default_priority">, a: HdNormalizedAlert): PreparedAlert {
  const title = plainLine(a.title, HD_INTAKE_LIMITS.title) || "Alert";
  const source = plainLine(a.source, HD_INTAKE_LIMITS.source);
  let dedup = plainLine(a.dedup_key, HD_INTAKE_LIMITS.dedupKey);
  if (!dedup) dedup = `auto:${createHash("sha256").update(`${title.toLowerCase()}\n${source.toLowerCase()}`).digest("hex").slice(0, 32)}`;
  const canon = normalizeSeverity(a.severity);
  const severity = plainLine(a.severity, 40);
  return {
    title,
    body: sanitizeDescription(a.description, a.description_format ?? "markdown"),
    severity,
    severityLabel: canon ? HD_ALERT_SEVERITY_LABEL[canon] : severity,
    priority: priorityFor(integration, a.severity),
    dedup_key: dedup,
    source,
    status: a.status === "resolved" ? "resolved" : "firing",
    links: cleanLinks(a.links),
    fields: cleanFields(a.fields),
    requester_email: plainLine(a.requester_email ?? "", 320).toLowerCase(),
  };
}

const mdInline = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/([\\`*_[\]{}<>()#!|~&])/g, "\\$1");

/** The opening message: the description, then a line of facts and the links. */
export function openingBody(p: PreparedAlert, earlier: number | null): string {
  const facts: string[] = [];
  if (p.severityLabel) facts.push(`**Severity:** ${mdInline(p.severityLabel)}`);
  if (p.source) facts.push(`**Source:** ${mdInline(p.source)}`);
  const parts = [p.body || "_(The alert had no description.)_"];
  if (facts.length) parts.push(facts.join(" · "));
  // markdownLink: the label escaped, the URL angle-bracketed and encoded, so
  // neither can end the link and start an image.
  if (p.links.length) parts.push(`**Links:** ${p.links.map((l) => markdownLink(l.label, l.url)).join(" · ")}`);
  if (earlier) parts.push(`_This alert fired before as #${earlier}._`);
  return parts.join("\n\n");
}

// --- Processing -------------------------------------------------------------------

export interface AlertResult {
  dedup_key: string;
  outcome: HdIntakeOutcome;
  ticket: number | null;
  reason: string;
}

export interface IntakeResponse {
  status: number;
  body: { ok: boolean; outcome?: HdIntakeOutcome; ticket?: number | null; results?: AlertResult[]; duplicate?: boolean; error?: string };
}

type After =
  | { kind: "created"; row: HdTicketRow }
  | { kind: "status"; ticketId: number; status: HdStatus };

interface KeyRow {
  ticket_id: number;
  count: number;
  state: "firing" | "resolved";
  last_seen: string;
  resolved_at: string | null;
  ticket_status: HdStatus;
  ticket_number: number;
}

export interface ProcessOptions {
  /** The retry guard's keys: the first is claimed; any of them seen means "already done". */
  requestKeys?: string[];
  origin?: string;
  ip?: string | null;
  /** Tags the new tickets carry (the test alert's "test-alert"). */
  tags?: string[];
}

function lockKey(integrationId: number, dedup: string): string {
  return `hd_intake:${integrationId}:${dedup}`;
}

/** Process one request's alerts for an enabled, authenticated integration. */
export async function processAlerts(integration: HdIntegrationRow, alerts: HdNormalizedAlert[], opts: ProcessOptions = {}): Promise<IntakeResponse> {
  await ensureIntakeSchema();
  const prepared = alerts.slice(0, HD_INTAKE_LIMITS.alertsPerRequest).map((a) => prepareAlert(integration, a));
  const service = serviceIdentityName(integration.name, integration.kind);
  const source = sourceForKind(integration.kind);

  // A named requester (API integrations): an active member who may use the helpdesk.
  const requesters = new Map<string, { id: number; name: string; email: string }>();
  // Only the API kind opens tickets for people: a monitoring alert's ticket is always automated.
  for (const p of integration.kind === "api" ? prepared : []) {
    if (!p.requester_email || requesters.has(p.requester_email)) continue;
    const u = await hqOne<{ id: number; name: string; username: string; email: string; role: import("../../types").Role }>(
      "SELECT id, name, username, email, role FROM users WHERE lower(email) = $1 AND status = 'active' ORDER BY id LIMIT 1",
      [p.requester_email]
    );
    if (u) {
      const { canUseHelpdesk } = await import("../access");
      if (await canUseHelpdesk(u)) requesters.set(p.requester_email, { id: u.id, name: u.name || u.username, email: u.email });
    }
  }

  const after: After[] = [];
  const tx = await withTx(async (client) => {
    const keys = opts.requestKeys ?? [];
    if (keys.length) {
      const seen = await client.query<{ response: IntakeResponse["body"] }>(
        `SELECT response FROM hd_intake_requests WHERE integration_id = $1 AND request_key = ANY($2) AND created_at > now() - interval '1 day' LIMIT 1`,
        [integration.id, keys.slice(1)]
      );
      const claim = await client.query(
        `INSERT INTO hd_intake_requests (integration_id, request_key) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1`,
        [integration.id, keys[0]]
      );
      if (!claim.rowCount || seen.rows[0]) {
        const prior = seen.rows[0]?.response
          ?? (await client.query<{ response: IntakeResponse["body"] }>(
            "SELECT response FROM hd_intake_requests WHERE integration_id = $1 AND request_key = $2",
            [integration.id, keys[0]]
          )).rows[0]?.response;
        return { duplicate: true as const, prior: prior ?? { ok: true } };
      }
    }
    // Lock every dedup key of the request, in a stable order (no deadlocks between requests).
    for (const k of Array.from(new Set(prepared.map((p) => p.dedup_key))).sort()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey(integration.id, k)]);
    }
    const { insertTicketTx } = await import("../tickets");
    const { addSystemMessage } = await import("../messages");
    const author = { id: null, name: service, email: "" };
    const results: AlertResult[] = [];

    for (const p of prepared) {
      const key = (
        await client.query<KeyRow>(
          `SELECT k.ticket_id, k.count, k.state, k.last_seen, k.resolved_at, t.status AS ticket_status, t.number AS ticket_number
             FROM hd_alert_keys k JOIN hd_tickets t ON t.id = k.ticket_id
            WHERE k.integration_id = $1 AND k.dedup_key = $2`,
          [integration.id, p.dedup_key]
        )
      ).rows[0];
      const snapshot = [p.severity, p.source, JSON.stringify(p.links), JSON.stringify(p.fields)];

      const createTicket = async (earlier: number | null): Promise<AlertResult> => {
        const person = p.requester_email ? requesters.get(p.requester_email) : undefined;
        const row = await insertTicketTx(client, {
          subject: p.title,
          body: openingBody(p, earlier),
          requester: person ?? { id: null, name: service, email: "" },
          author,
          via: "system",
          first_message_kind: "public",
          source,
          source_ref: {
            integration_id: integration.id,
            integration_kind: integration.kind,
            integration_name: integration.name,
            dedup_key: p.dedup_key,
          },
          team_id: integration.default_team_id,
          priority: p.priority,
          tags: opts.tags,
        });
        const automated = person ? 0 : 1;
        await client.query("UPDATE hd_tickets SET automated = $2, integration_id = $3 WHERE id = $1", [row.id, automated, integration.id]);
        await client.query(
          `INSERT INTO hd_alert_keys (integration_id, dedup_key, ticket_id, first_seen, last_seen, count, state, severity, source, links, fields)
           VALUES ($1, $2, $3, now(), now(), 1, 'firing', $4, $5, $6, $7)
           ON CONFLICT (integration_id, dedup_key) DO UPDATE
             SET ticket_id = EXCLUDED.ticket_id, first_seen = now(), last_seen = now(), count = 1, state = 'firing',
                 severity = EXCLUDED.severity, source = EXCLUDED.source, links = EXCLUDED.links, fields = EXCLUDED.fields, resolved_at = NULL`,
          [integration.id, p.dedup_key, row.id, ...snapshot]
        );
        after.push({ kind: "created", row: { ...row, automated, integration_id: integration.id } as HdTicketRow });
        return { dedup_key: p.dedup_key, outcome: "created", ticket: row.number, reason: earlier ? `New ticket; #${earlier} was closed or too old to reopen.` : "" };
      };

      if (p.status === "firing") {
        if (!key) {
          results.push(await createTicket(null));
          continue;
        }
        const n = key.count + 1;
        const open = HD_OPEN_STATUSES.includes(key.ticket_status);
        const since = Date.parse(key.resolved_at ?? key.last_seen);
        const withinWindow = Date.now() - since <= integration.dedup_window_minutes * 60_000;
        if (open || (key.ticket_status === "solved" && integration.reopen_on_repeat === 1 && withinWindow)) {
          await client.query(
            `UPDATE hd_alert_keys SET count = $3, last_seen = now(), state = 'firing', resolved_at = NULL,
                    severity = $4, source = $5, links = $6, fields = $7
              WHERE integration_id = $1 AND dedup_key = $2`,
            [integration.id, p.dedup_key, n, ...snapshot]
          );
          if (open) {
            const again = key.state === "resolved" ? " after it had resolved" : "";
            await addSystemMessage(key.ticket_id, `Fired again${again} (×${n})${p.severityLabel ? ` · ${mdInline(p.severityLabel)}` : ""}`, { internal: true, author, client });
            await client.query("UPDATE hd_tickets SET updated_at = now() WHERE id = $1", [key.ticket_id]);
            results.push({ dedup_key: p.dedup_key, outcome: "updated", ticket: key.ticket_number, reason: `Fired again (×${n}).` });
          } else {
            await addSystemMessage(key.ticket_id, `Alert fired again (×${n}); reopened.`, { internal: true, author, client });
            after.push({ kind: "status", ticketId: key.ticket_id, status: "open" });
            results.push({ dedup_key: p.dedup_key, outcome: "reopened", ticket: key.ticket_number, reason: `Fired again (×${n}) after the ticket was solved.` });
          }
          continue;
        }
        results.push(await createTicket(key.ticket_number));
        continue;
      }

      // Resolved.
      if (!key) {
        results.push({ dedup_key: p.dedup_key, outcome: "ignored", ticket: null, reason: "No alert with this key has fired." });
        continue;
      }
      const open = HD_OPEN_STATUSES.includes(key.ticket_status);
      if (key.state === "resolved") {
        results.push({ dedup_key: p.dedup_key, outcome: "ignored", ticket: key.ticket_number, reason: "Already resolved." });
        continue;
      }
      await client.query(
        "UPDATE hd_alert_keys SET state = 'resolved', resolved_at = now(), last_seen = now() WHERE integration_id = $1 AND dedup_key = $2",
        [integration.id, p.dedup_key]
      );
      if (!open) {
        results.push({ dedup_key: p.dedup_key, outcome: "resolved", ticket: key.ticket_number, reason: "The ticket was already solved." });
        continue;
      }
      if (integration.auto_resolve !== 1) {
        await addSystemMessage(key.ticket_id, "Alert resolved.", { internal: true, author, client });
        results.push({ dedup_key: p.dedup_key, outcome: "resolved", ticket: key.ticket_number, reason: "Auto-resolve is off; the ticket stays open." });
        continue;
      }
      // A person who answered publicly is owed a human close.
      const human = await client.query(
        "SELECT 1 FROM hd_messages WHERE ticket_id = $1 AND kind = 'public' AND author_id IS NOT NULL LIMIT 1",
        [key.ticket_id]
      );
      if (human.rowCount) {
        await addSystemMessage(key.ticket_id, "Alert resolved; ticket left open because a person replied.", { internal: true, author, client });
        results.push({ dedup_key: p.dedup_key, outcome: "resolved", ticket: key.ticket_number, reason: "Left open: a person replied." });
        continue;
      }
      await addSystemMessage(key.ticket_id, "Alert resolved.", { internal: true, author, client });
      after.push({ kind: "status", ticketId: key.ticket_id, status: "solved" });
      results.push({ dedup_key: p.dedup_key, outcome: "resolved", ticket: key.ticket_number, reason: "" });
    }

    const body: IntakeResponse["body"] = {
      ok: true,
      results,
      ...(results.length === 1 ? { outcome: results[0].outcome, ticket: results[0].ticket } : {}),
    };
    if (keys.length) {
      await client.query("UPDATE hd_intake_requests SET response = $3 WHERE integration_id = $1 AND request_key = $2", [integration.id, keys[0], JSON.stringify(body)]);
    }
    await client.query("UPDATE hd_integrations SET last_used_at = now() WHERE id = $1", [integration.id]);
    for (const r of results) {
      const ticketId = r.ticket ? (await client.query<{ id: number }>("SELECT id FROM hd_tickets WHERE number = $1", [r.ticket])).rows[0]?.id ?? null : null;
      await recordDelivery({ integration_id: integration.id, status_code: 200, outcome: r.outcome, reason: r.reason, ticket_id: ticketId, dedup_key: r.dedup_key }, client);
    }
    return { duplicate: false as const, body };
  });

  if (tx.duplicate) {
    await recordDelivery({ integration_id: integration.id, status_code: 200, outcome: "ignored", reason: "Duplicate delivery (a retry)." });
    return { status: 200, body: { ...tx.prior, duplicate: true } };
  }

  // After commit: the create hooks (rules, workflow, assignment, agents' notices) and status changes through the core.
  const ctx = { actorId: null, actorName: service, origin: opts.origin };
  for (const a of after) {
    try {
      if (a.kind === "created") {
        const { afterTicketCreated } = await import("../events");
        await afterTicketCreated(a.row, ctx);
      } else {
        const { updateTicket } = await import("../tickets");
        await updateTicket(a.ticketId, { status: a.status }, { id: null, name: service }, ctx);
      }
    } catch (e) {
      logEvent("error", "helpdesk.intake_after_failed", { integration: integration.id, step: a.kind, error: e instanceof Error ? e.message : String(e) });
    }
  }
  pruneRequests();
  return { status: 200, body: tx.body };
}

let pruneCounter = 0;
function pruneRequests(): void {
  if (++pruneCounter % 50 !== 0) return;
  void hqOne("DELETE FROM hd_intake_requests WHERE created_at < now() - interval '1 day'").catch(() => {});
}

/** The retry guard's keys for a webhook body: the tool's request id when it sends one, else the payload hash this minute (and last minute's, to catch a retry across the boundary). */
export function requestKeys(raw: string, requestId: string | null, now = Date.now()): string[] {
  const id = (requestId ?? "").trim().slice(0, 200);
  if (id) return [`id:${id}`];
  const h = createHash("sha256").update(raw).digest("hex");
  const minute = Math.floor(now / 60_000);
  return [`h:${h}:${minute}`, `h:${h}:${minute - 1}`];
}

/** The kind's short name, for log lines. */
export const kindShort = (k: HdIntegrationRow["kind"]) => HD_INTEGRATION_KIND_SHORT[k];
