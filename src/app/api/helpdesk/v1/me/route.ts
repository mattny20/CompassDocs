// GET /api/helpdesk/v1/me: the token, who it acts as and what it can do.
// Bearer token only (lib/helpdesk/api-v1 documents every route).

import { apiV1, getMe } from "@/lib/helpdesk/api-v1";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return apiV1(req, "GET /me", getMe);
}
