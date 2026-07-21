// Shared bits for the MCP connector's OAuth 2.1 authorization server.
// CompassDocs is both the resource server (/api/mcp) and the authorization
// server; Claude registers itself dynamically, the user approves once in the
// browser, and tokens flow from there. Server-only.

import "server-only";

/** Request origin honoring reverse-proxy headers — used for in-app links. */
export function requestOrigin(req: Request): string {
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const host = req.headers.get("x-forwarded-host")?.split(",")[0].trim() || req.headers.get("host");
  if (host) return `${proto || "http"}://${host}`;
  return new URL(req.url).origin;
}

/**
 * The canonical public origin for OAuth/MCP discovery documents.
 *
 * When an admin has configured a custom domain (Settings → Domain & HTTPS) we
 * trust it over the request's forwarded headers. A reverse proxy that forgets
 * to forward `X-Forwarded-Proto: https` — a common nginx misconfiguration —
 * would otherwise make us advertise `http://` issuer and endpoint URLs, which
 * every OAuth client rejects, breaking the connector for no visible reason.
 * The configured domain is always served over HTTPS, so it's the safe source
 * of truth. Falls back to the header-derived origin when no domain is set
 * (development, or an install reached only by IP).
 */
export async function publicOrigin(req: Request): Promise<string> {
  const { getAppSettings } = await import("./settings-store");
  const domain = (await getAppSettings()).custom_domain;
  if (domain) return `https://${domain}`;
  return requestOrigin(req);
}

/**
 * Redirect URIs we accept at registration: HTTPS anywhere, or loopback HTTP
 * (local MCP clients). Anything else is refused.
 */
export function redirectUriAllowed(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

/** CORS headers for the OAuth endpoints (browser-based MCP clients). */
export const OAUTH_CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version",
  "access-control-max-age": "86400",
};

export function corsJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...OAUTH_CORS },
  });
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: OAUTH_CORS });
}

export function authServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  };
}

export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
  };
}
