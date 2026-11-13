// GET /api/helpdesk/v1/custom-fields: the custom field definitions (1.20.6): each key, label, kind,
// options, who sees it and the teams it is assigned to. Bearer token only (lib/helpdesk/api-v1
// documents every route).

import { apiV1, listCustomFieldsRoute } from "@/lib/helpdesk/api-v1";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return apiV1(req, "GET /custom-fields", listCustomFieldsRoute);
}
