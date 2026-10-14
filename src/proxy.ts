// Request proxy (Next.js 16's name for middleware). One job: tell server
// components which page is being rendered, so a signed-out visitor can be
// sent to /login with that page as `?next=` and come back to it afterwards
// (lib/auth requireUser, lib/return-to). Server components cannot see the
// request URL on their own, so this forwards it as a request header.
//
// No authentication happens here — the session check stays in requireUser,
// where it can read the database. Static assets and API routes are left
// alone: API callers do not follow redirects, and assets need no page.

import { NextResponse, type NextRequest } from "next/server";

/** The request header that carries the page's path and query. */
export const RETURN_PATH_HEADER = "x-compass-path";

export function proxy(req: NextRequest) {
  // Next hands the proxy a normalised URL: the query is re-serialised
  // (a space becomes "+"), which keeps its meaning — the page reads the
  // same values back — but not its spelling.
  const { pathname, search } = req.nextUrl;
  const headers = new Headers(req.headers);
  headers.set(RETURN_PATH_HEADER, `${pathname}${search}`);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    // Pages only: everything except Next's own assets, static files with an
    // extension (favicon, images, fonts) and the API.
    "/((?!_next/|api/|.*\\.[a-zA-Z0-9]+$).*)",
  ],
};
