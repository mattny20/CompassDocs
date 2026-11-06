// POST /api/helpdesk/admin/assignment/rules/test   { ticket_number } or { sample: { subject, body, source,
//      automated, integration_id, team_id, priority, category, request_type_id, tags, department, office,
//      vip, hours: 'open'|'closed', severity } } → { matched, trace: [{rule_id, name, matched, reason}], outcome }
// Which rule would match, why each one did or didn't, and what would happen next. Writes nothing.
// Helpdesk 1.19.0 (agent N). automations.manage; a ticket number must be one the caller can work.

import { NextResponse } from "next/server";
import { canWorkTicket, readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { badRequest, notFound } from "@/lib/helpdesk/assignment/routes";
import { testRules, ticketForTest, type RuleTestSample } from "@/lib/helpdesk/assignment/engine";

export const dynamic = "force-dynamic";

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
const id = (v: unknown) => {
  const n = Number(v);
  return v === null || v === "" || v === undefined ? null : Number.isInteger(n) && n > 0 ? n : null;
};

export async function POST(req: Request) {
  const gate = await hdCapGate("automations.manage");
  if (gate instanceof NextResponse) return gate;
  const body = await readJson(req, 64 * 1024);
  if (!body) return badRequest("Send a ticket number or a sample as JSON.");
  if (body.ticket_number !== undefined) {
    const n = Number(body.ticket_number);
    if (!Number.isInteger(n) || n <= 0) return badRequest("That isn't a ticket number.");
    const t = await ticketForTest(n);
    if (!t || !(await canWorkTicket(gate, t))) return notFound();
    return NextResponse.json(await testRules({}, t));
  }
  const s = (body.sample ?? {}) as Record<string, unknown>;
  if (typeof s !== "object" || Array.isArray(s)) return badRequest("The sample is an object.");
  const sample: RuleTestSample = {
    subject: str(s.subject, 200) ?? "",
    body: str(s.body, 5000) ?? "",
    source: str(s.source, 40) ?? "portal",
    automated: s.automated === true,
    integration_id: s.integration_id === undefined || s.integration_id === null || s.integration_id === "" ? null : String(s.integration_id).slice(0, 40),
    team_id: id(s.team_id),
    priority: str(s.priority, 20) ?? "normal",
    category: str(s.category, 80) ?? "",
    request_type_id: id(s.request_type_id),
    tags: Array.isArray(s.tags) ? s.tags.filter((t): t is string => typeof t === "string").slice(0, 20).map((t) => t.slice(0, 40)) : [],
    department: str(s.department, 120) ?? "",
    office: str(s.office, 120) ?? "",
    vip: s.vip === true,
    hours: s.hours === "closed" ? "closed" : s.hours === "open" ? "open" : undefined,
    severity: str(s.severity, 40),
  };
  return NextResponse.json(await testRules(sample, null));
}
