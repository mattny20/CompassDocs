import { requireUser } from "@/lib/auth";
import { listApiTokens, listOAuthGrants } from "@/lib/db";
import { ROLE_LABEL } from "@/lib/types";
import { ApiTokens } from "@/components/ApiTokens";

export const dynamic = "force-dynamic";

export default async function ApiTokensPage() {
  const user = await requireUser();
  const [tokens, connections] = await Promise.all([
    listApiTokens(user.id),
    listOAuthGrants(user.id),
  ]);

  return (
    <section>
      <h2 className="mb-1 font-semibold text-slate-900">API tokens</h2>
      <p className="mb-3 text-sm text-slate-500">
        Personal tokens for the Claude connector and other integrations. They act as you,
        with your role ({ROLE_LABEL[user.role]}).
      </p>
      <div className="rounded-xl border border-slate-200 bg-surface p-5 shadow-xs">
        <ApiTokens initial={tokens} initialConnections={connections} />
      </div>
    </section>
  );
}
