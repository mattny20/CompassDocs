// Where to send someone after they sign in (1.9.4).
//
// A signed-out visitor who opens a link to a document is sent to /login with
// the page they wanted as `?next=`; the sign-in paths (password, OIDC, SAML)
// and the forced password change all carry it through and land there. The
// value is attacker-controllable (it is in the URL), so it is reduced to a
// same-app path here, in one place, before anyone redirects to it. The
// candidate is parsed as a URL against a fixed origin, which is what the
// browser will do with it, and only survives when:
//
//   - it is a path (starts with "/") and still resolves to that origin —
//     "//host", "/\host" and anything else the parser reads as another host
//     do not, nor does a path that only becomes "//host" once dot segments
//     resolve ("/..//host");
//   - after resolving dot segments and percent-decoding it is not the
//     sign-in page, an API route, the setup wizard or the forced password
//     change ("/doc/../api/x" and "/%61pi/x" count as "/api/x"), so a bad
//     value cannot loop or fire a request on the user's behalf;
//   - it is short and free of control characters (a Location header is one
//     line).
//
// What is returned is the parser's spelling — dot segments resolved and any
// non-ASCII percent-encoded — so it is safe in a Location header as well as
// in router.push. /oauth/authorize is deliberately allowed: it is the consent
// page the MCP flow bounces through sign-in to reach.
//
// Isomorphic: no server-only imports, usable from the login page (server),
// the login form (client) and the enterprise overlay, which keeps a copy.

const MAX_LENGTH = 2000;
// /account/password is the forced-change step, a stop on the way and never a
// destination: a session that expires there would otherwise come back to it
// after the change and bounce to Account → Security.
const BLOCKED = ["/login", "/api", "/setup", "/logout", "/account/password"];
const ORIGIN = "http://compass.invalid";

/** The same-app path `raw` names, or `fallback` ("/") when it is not one. */
export function safeReturnPath(raw: string | null | undefined, fallback = "/"): string {
  if (typeof raw !== "string") return fallback;
  const next = raw.trim();
  if (!next || next.length > MAX_LENGTH || !next.startsWith("/")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(next)) return fallback;
  let url: URL;
  try {
    url = new URL(next, ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== ORIGIN || url.username || url.password) return fallback;
  // Dot segments can resolve to a path that starts with "//" ("/..//host"):
  // the origin check passes, but the bare string is protocol-relative when
  // the browser reads it back. The result must mean the same thing on its
  // own as it did here.
  if (url.pathname.startsWith("//")) return fallback;
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname).toLowerCase();
  } catch {
    return fallback;
  }
  // The route itself, or anything under it — not a page whose name merely
  // starts with the same letters ("/loginwall", "/apis").
  for (const p of BLOCKED) {
    if (decoded === p || decoded.startsWith(`${p}/`)) return fallback;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** `/login?next=…` for a page worth coming back to; plain `/login` otherwise. */
export function loginHref(returnTo: string | null | undefined): string {
  const path = safeReturnPath(returnTo);
  return path === "/" ? "/login" : `/login?next=${encodeURIComponent(path)}`;
}

/** Append `next` to another sign-in entry point (the SSO buttons). */
export function withReturnPath(href: string, returnTo: string | null | undefined): string {
  const path = safeReturnPath(returnTo);
  if (path === "/") return href;
  return `${href}${href.includes("?") ? "&" : "?"}next=${encodeURIComponent(path)}`;
}
