// GET /api/helpdesk/v1/tickets: list and search the token's queues, cursor paging.
// Bearer token only (lib/helpdesk/api-v1 documents every route and its filters).

import { apiV1, listTicketsRoute } from "@/lib/helpdesk/api-v1";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return apiV1(req, "GET /tickets", listTicketsRoute);
}
