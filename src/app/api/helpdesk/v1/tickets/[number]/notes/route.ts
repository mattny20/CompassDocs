// POST /api/helpdesk/v1/tickets/{number}/notes  { body }: an internal note (Add internal notes).
// Bearer token only (lib/helpdesk/api-v1 documents every route).

import { addNoteRoute, apiV1 } from "@/lib/helpdesk/api-v1";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  return apiV1(req, "POST /tickets/{number}/notes", (ctx) => addNoteRoute(ctx, number));
}
