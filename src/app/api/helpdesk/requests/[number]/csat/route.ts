// POST /api/helpdesk/requests/[number]/csat   { score: 1-5, comment?, token? }
// Helpdesk 1.19.0 (helpdesk.request). The requester rates their own solved
// request, once (lib/helpdesk/csat). `token` is the t= of the solved
// email's rating links; a wrong one is refused, none is fine.

import { NextResponse } from "next/server";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { submitCsat } from "@/lib/helpdesk/csat";

export const dynamic = "force-dynamic";

const recent = new Map<number, number[]>();

/** 10 ratings attempts a minute per person (it is once per request; this stops a loop). */
function limited(userId: number): boolean {
  const now = Date.now();
  const list = (recent.get(userId) ?? []).filter((t) => now - t < 60_000);
  list.push(now);
  recent.set(userId, list);
  if (recent.size > 5000) for (const [k, v] of recent) if (!v.some((t) => now - t < 60_000)) recent.delete(k);
  return list.length > 10;
}

export async function POST(req: Request, ctx: { params: Promise<{ number: string }> }) {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  if (limited(gate.id)) return NextResponse.json({ error: "Too many attempts. Try again in a minute." }, { status: 429 });
  const number = Number(String((await ctx.params).number).replace(/^#/, ""));
  if (!Number.isInteger(number) || number <= 0) return NextResponse.json({ error: "Request not found." }, { status: 404 });
  const body = await readJson(req, 16 * 1024);
  if (!body) return NextResponse.json({ error: "Send the rating as JSON." }, { status: 400 });
  const r = await submitCsat(gate, number, { score: body.score, comment: body.comment, token: body.token });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ csat: { score: r.score, comment: r.comment, at: r.at } });
}
