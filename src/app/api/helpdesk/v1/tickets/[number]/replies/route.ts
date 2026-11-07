// POST /api/helpdesk/v1/tickets/{number}/replies  { body, status? }: a public reply. A role that
// replies after review has it held for a lead (held: true), exactly as in the desk.
// Bearer token only (lib/helpdesk/api-v1 documents every route).

import { addReplyRoute, apiV1 } from "@/lib/helpdesk/api-v1";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  return apiV1(req, "POST /tickets/{number}/replies", (ctx) => addReplyRoute(ctx, number));
}
