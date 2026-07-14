// OAuth 2.0 Dynamic Client Registration (RFC 7591) — lets Claude (or any MCP
// client) register itself before the authorize step. Public clients only:
// no secret is issued, PKCE is mandatory at the token endpoint.

import { registerOAuthClient } from "@/lib/db";
import { corsJson, corsPreflight, redirectUriAllowed } from "@/lib/oauth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return corsJson({ error: "invalid_client_metadata" }, 400);
  }

  const uris: string[] = Array.isArray(body?.redirect_uris)
    ? body.redirect_uris.map((u: unknown) => String(u)).filter(Boolean)
    : [];
  if (!uris.length || !uris.every(redirectUriAllowed)) {
    return corsJson(
      {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be HTTPS (or localhost) URLs.",
      },
      400
    );
  }

  const client = await registerOAuthClient(String(body?.client_name ?? "MCP client"), uris);
  return corsJson(
    {
      client_id: client.client_id,
      client_name: client.name,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201
  );
}

export const OPTIONS = async () => corsPreflight();
