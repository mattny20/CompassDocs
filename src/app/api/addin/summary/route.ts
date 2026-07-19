import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listRecentDocuments } from "@/lib/db";
import { spaceScopeFor } from "@/lib/access";
import { getAppSettings } from "@/lib/settings-store";
import { roleAtLeast } from "@/lib/types";

export const dynamic = "force-dynamic";

// Bootstrap payload for the Outlook task pane: who's signed in, workspace
// branding, and a few recent documents. A 401 here is how the pane knows to
// show its sign-in state (no redirects — the pane lives in a webview).

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const settings = await getAppSettings();
  const recent = await listRecentDocuments(
    6,
    roleAtLeast(user.role, "editor"),
    await spaceScopeFor(user)
  );

  return NextResponse.json({
    user: { name: user.name || user.username },
    org: settings.company_name,
    accent: settings.accent_color,
    recent: recent.map((d) => ({
      id: d.id,
      title: d.title,
      space_name: d.space_name,
      space_icon: d.space_icon,
    })),
  });
}
