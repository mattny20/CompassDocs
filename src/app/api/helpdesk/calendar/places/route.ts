// GET /api/helpdesk/calendar/places?q= → { places: string[] }
//       Places used before on events of tickets the caller may see, most recent first (the Event block's
//       suggestions; 1.20.6, lib/helpdesk/desk-calendar). Agents (helpdesk.agent).

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { placeSuggestions } from "@/lib/helpdesk/desk-calendar";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, 200);
  return NextResponse.json({ places: await placeSuggestions(gate, q) });
}
