// GET  /api/helpdesk/recycle-bin?q=&team=&limit=&offset=
//        → { rows: HdBinRow[], total, can_purge }: binned tickets of the teams the
//        caller may delete in (tickets.delete), newest first. ?count=1 → { count }
//        (the Views nav), { count: null } without tickets.delete.
// POST /api/helpdesk/recycle-bin
//        { action: "preview" | "bin" | "restore" | "purge", numbers: [1051, 1049] }
//        → { results: [{ number, subject?, ok, error?, chip? }], ok, skipped }.
//        Up to 200 tickets; each is checked on its own (lib/helpdesk/recycle-bin):
//        preview changes nothing (the delete dialog's list, v1); bin and restore
//        need tickets.delete in the ticket's team, purge tickets.purge. Audited per
//        ticket and once per bulk request (helpdesk.ticket.bulk_binned /
//        bulk_restored / bulk_purged). 20 requests a minute per agent. Webhooks
//        get ticket.deleted / ticket.restored per ticket (lib/helpdesk/webhooks).
// Helpdesk 1.19.4 (area C7).

import { NextResponse } from "next/server";
import { ipFrom } from "@/lib/audit";
import { helpdeskGate, hdRateLimited, readJson, tooMany } from "@/lib/helpdesk/access";
import { badRequest, originOf } from "@/lib/helpdesk/routes";
import { hdCan, HD_FORBIDDEN } from "@/lib/helpdesk/roles";
import { binTickets, countBin, HdBinError, listBin, parseBinNumbers, previewBin, purgeTickets, restoreTickets } from "@/lib/helpdesk/recycle-bin";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const sp = new URL(req.url).searchParams;
  if (sp.get("count") === "1") return NextResponse.json({ count: await countBin(gate) });
  if (!(await hdCan(gate, "tickets.delete"))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  const team = Number(sp.get("team"));
  const int = (k: string) => {
    const raw = sp.get(k);
    if (raw === null || raw === "") return undefined;
    const v = Number(raw);
    return Number.isInteger(v) && v >= 0 ? v : undefined;
  };
  const r = await listBin(gate, {
    q: sp.get("q") ?? "",
    team_id: Number.isInteger(team) && team > 0 ? team : null,
    limit: int("limit"),
    offset: int("offset"),
  });
  return NextResponse.json({ ...r, can_purge: await hdCan(gate, "tickets.purge") });
}

export async function POST(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 64 * 1024);
  if (!b) return badRequest("Send the action and the ticket numbers as JSON.");
  const action = b.action;
  if (action !== "preview" && action !== "bin" && action !== "restore" && action !== "purge") {
    return badRequest('action must be "preview", "bin", "restore" or "purge".');
  }
  // Held in some team here; each ticket's own team is checked per ticket.
  if (!(await hdCan(gate, action === "purge" ? "tickets.purge" : "tickets.delete"))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  if (action !== "preview" && hdRateLimited(`hd-bin:${gate.id}`, 20, 60_000)) return tooMany();
  let numbers: number[];
  try {
    numbers = parseBinNumbers(b.numbers);
  } catch (e) {
    if (e instanceof HdBinError) return badRequest(e.message);
    throw e;
  }
  const ctx = { ip: ipFrom(req), bulk: numbers.length > 1, origin: originOf(req) };
  const results =
    action === "preview"
      ? await previewBin(gate, numbers)
      : action === "bin"
        ? await binTickets(gate, numbers, ctx)
        : action === "restore"
          ? await restoreTickets(gate, numbers, ctx)
          : await purgeTickets(gate, numbers, ctx);
  const ok = results.filter((r) => r.ok).length;
  return NextResponse.json({ results, ok, skipped: results.length - ok });
}
