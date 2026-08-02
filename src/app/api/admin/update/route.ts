import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// One-click update: tells the companion updater container (Watchtower with
// its HTTP API, per the docs' compose block) to pull the newer image and
// recreate this container. The web app itself never touches Docker — the
// socket lives only in the updater, which has no published ports; this is
// an authenticated poke over the compose network.
//
// The trigger is fire-and-forget on purpose: the updater STOPS this process
// mid-update, so a response would never arrive. The admin UI polls the
// version endpoint until the app comes back newer.
export async function POST(req: Request) {
  const gate = await apiGuard("admin", "system.update_apply");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const url = (process.env.COMPASSDOCS_UPDATER_URL || "").trim().replace(/\/+$/, "");
  const token = (process.env.COMPASSDOCS_UPDATER_TOKEN || "").trim();
  if (!url || !token) {
    return NextResponse.json(
      { error: "No updater is configured (COMPASSDOCS_UPDATER_URL / COMPASSDOCS_UPDATER_TOKEN)." },
      { status: 400 }
    );
  }
  if (!/^https?:\/\//.test(url)) {
    return NextResponse.json({ error: "COMPASSDOCS_UPDATER_URL must be http(s)." }, { status: 400 });
  }

  await audit({
    actor: actorFrom(user),
    action: "system.update_triggered",
    ip: ipFrom(req),
  });

  // Deliberately plain fetch: the updater is an operator-configured endpoint
  // on the private compose network, which the SSRF guard would (correctly,
  // for user-supplied URLs) refuse.
  void fetch(`${url}/v1/update`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10 * 60_000),
  }).catch(() => {
    // Expected: the updater kills this process before responding.
  });

  return NextResponse.json({ started: true }, { status: 202 });
}
