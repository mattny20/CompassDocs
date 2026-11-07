// GET   /api/helpdesk/v1/tickets/{number}: the ticket and its conversation (internal notes only
//       when the token's role can add them).
// PATCH /api/helpdesk/v1/tickets/{number}  { status?, priority?, team_id?, assignee_id?, tags? }
// Bearer token only (lib/helpdesk/api-v1 documents every route).

import { apiV1, getTicketRoute, patchTicketRoute } from "@/lib/helpdesk/api-v1";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { number } = await params;
  return apiV1(req, "GET /tickets/{number}", (ctx) => getTicketRoute(ctx, number));
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { number } = await params;
  return apiV1(req, "PATCH /tickets/{number}", (ctx) => patchTicketRoute(ctx, number));
}
