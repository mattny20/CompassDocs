// GET /api/helpdesk/reviews → { reviews }
//   Newbies' replies held for review that the caller may decide, oldest
//   first. Helpdesk 1.19.0 desk roles (agent J); replies.review.

import { NextResponse } from "next/server";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { pendingReviews } from "@/lib/helpdesk/review";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdCapGate("replies.review");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ reviews: await pendingReviews(gate) });
}
