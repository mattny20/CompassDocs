// OAuth token endpoint: authorization_code (+ mandatory PKCE S256) and
// refresh_token (rotating). Public clients — identity is proven by the code
// binding + PKCE verifier, not a client secret.

import { createHash } from "node:crypto";
import { consumeOAuthCode, createOAuthTokens, rotateOAuthTokens } from "@/lib/db";
import { corsJson, corsPreflight } from "@/lib/oauth";

export const dynamic = "force-dynamic";

function err(code: string, description: string, status = 400): Response {
  return corsJson({ error: code, error_description: description }, status);
}

export async function POST(req: Request) {
  let params: URLSearchParams;
  const ctype = req.headers.get("content-type") || "";
  try {
    if (ctype.includes("application/json")) {
      params = new URLSearchParams(Object.entries(await req.json()));
    } else {
      params = new URLSearchParams(await req.text());
    }
  } catch {
    return err("invalid_request", "Could not parse the request body.");
  }

  const grant = params.get("grant_type");

  if (grant === "authorization_code") {
    const code = params.get("code") || "";
    const verifier = params.get("code_verifier") || "";
    if (!code || !verifier) return err("invalid_request", "code and code_verifier are required.");

    const stored = await consumeOAuthCode(code);
    if (!stored) return err("invalid_grant", "Unknown, used, or expired authorization code.");
    if (params.get("client_id") && params.get("client_id") !== stored.client_id) {
      return err("invalid_grant", "client_id does not match the code.");
    }
    if (params.get("redirect_uri") && params.get("redirect_uri") !== stored.redirect_uri) {
      return err("invalid_grant", "redirect_uri does not match the code.");
    }
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (challenge !== stored.code_challenge) {
      return err("invalid_grant", "PKCE verification failed.");
    }

    const t = await createOAuthTokens(stored.client_id, stored.user_id);
    return corsJson({
      access_token: t.accessToken,
      token_type: "Bearer",
      expires_in: t.expiresIn,
      refresh_token: t.refreshToken,
      scope: "mcp",
    });
  }

  if (grant === "refresh_token") {
    const rotated = await rotateOAuthTokens(params.get("refresh_token") || "");
    if (!rotated) return err("invalid_grant", "Unknown or revoked refresh token.");
    if (params.get("client_id") && params.get("client_id") !== rotated.clientId) {
      return err("invalid_grant", "client_id does not match the token.");
    }
    return corsJson({
      access_token: rotated.accessToken,
      token_type: "Bearer",
      expires_in: rotated.expiresIn,
      refresh_token: rotated.refreshToken,
      scope: "mcp",
    });
  }

  return err("unsupported_grant_type", "Use authorization_code or refresh_token.");
}

export const OPTIONS = async () => corsPreflight();
