// OAuth consent screen. Claude (or any registered MCP client) sends the user
// here; we make sure they're signed in, show who's asking and what access
// means, and on Approve mint a single-use code back to the client. All
// parameter validation happens again server-side in /api/oauth/approve.

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getOAuthClient } from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { Brand } from "@/components/Brand";
import { ROLE_LABEL } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  if (!user) {
    // Bounce through login and come straight back with the same query.
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]
    );
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${qs}`)}`);
  }

  const settings = await getAppSettings();
  const clientId = params.client_id || "";
  const redirectUri = params.redirect_uri || "";
  const client = clientId ? await getOAuthClient(clientId) : undefined;

  const problem = !client
    ? "Unknown client — the app may need to re-register."
    : !client.redirect_uris.includes(redirectUri)
      ? "The redirect address isn't one this app registered."
      : params.response_type !== "code"
        ? "Unsupported response type."
        : !params.code_challenge || (params.code_challenge_method || "S256") !== "S256"
          ? "This app didn't send a valid PKCE challenge."
          : "";

  let redirectHost = "";
  try {
    redirectHost = new URL(redirectUri).host;
  } catch {}

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 to-compass-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center">
          <Brand name={settings.company_name} logoUrl={settings.logo_url || undefined} size="lg" layout="col" />
        </div>
        <div className="rounded-2xl border border-slate-200 bg-surface p-6 shadow-sm">
          {problem ? (
            <p className="text-sm text-red-600">{problem}</p>
          ) : (
            <>
              <h1 className="text-lg font-bold text-slate-900">
                {client!.name || "An application"} wants to connect
              </h1>
              <p className="mt-2 text-sm text-slate-600">
                It will act in CompassDocs as{" "}
                <span className="font-semibold">{user!.name || user!.username}</span>{" "}
                <span className="text-slate-400">({ROLE_LABEL[user!.role]})</span> — searching and
                reading documents, and creating or editing them within your permissions and the
                approval workflow.
              </p>
              <p className="mt-2 text-xs text-slate-400">
                After approving you&rsquo;ll be sent back to <code>{redirectHost}</code>. Revoke
                access anytime under your name → API tokens.
              </p>
              <form method="POST" action="/api/oauth/approve" className="mt-4 space-y-2">
                {(["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope"] as const).map(
                  (k) =>
                    params[k] !== undefined ? (
                      <input key={k} type="hidden" name={k} value={params[k]} />
                    ) : null
                )}
                <button
                  name="decision"
                  value="approve"
                  className="w-full rounded-lg bg-compass-600 px-4 py-2 font-semibold text-white shadow-sm transition hover:bg-compass-700"
                >
                  Approve
                </button>
                <button
                  name="decision"
                  value="deny"
                  className="w-full rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                >
                  Deny
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
