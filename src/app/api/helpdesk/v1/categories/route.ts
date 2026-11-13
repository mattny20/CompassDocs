// GET /api/helpdesk/v1/categories: the categories and sub-categories a ticket can be given (1.20.6).
// Bearer token only (lib/helpdesk/api-v1 documents every route).

import { apiV1, listCategoriesRoute } from "@/lib/helpdesk/api-v1";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return apiV1(req, "GET /categories", listCategoriesRoute);
}
