// GET /api/helpdesk/v1/approvals: pending approvals on requests in the token's queues.
// Bearer token only (lib/helpdesk/api-v1 documents every route).

import { apiV1, listApprovalsRoute } from "@/lib/helpdesk/api-v1";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return apiV1(req, "GET /approvals", listApprovalsRoute);
}
