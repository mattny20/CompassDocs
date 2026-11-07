// GET /api/helpdesk/v1/reports/summary?from=&to=&team=: headline numbers (the Claude
// connector's hd_report). Every team needs All reports; one team needs Team reports there.
// Bearer token only (lib/helpdesk/api-v1 documents every route).

import { apiV1, reportSummaryRoute } from "@/lib/helpdesk/api-v1";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return apiV1(req, "GET /reports/summary", reportSummaryRoute);
}
