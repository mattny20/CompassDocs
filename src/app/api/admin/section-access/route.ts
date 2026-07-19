import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { listUsers, listGroups } from "@/lib/db";
import { SECTIONS, getSectionGrants, setSectionGrants } from "@/lib/section-access";
import type { Section } from "@/lib/section-access";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Configuration of delegated section access (admin only): who besides admins
// can run Announcements and Compliance from the main navigation.

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const [users, groups] = await Promise.all([listUsers(), listGroups()]);
  const sections = await Promise.all(
    SECTIONS.map(async (s) => ({ ...s, ...(await getSectionGrants(s.key)) }))
  );
  return NextResponse.json({
    sections,
    all_users: users
      .filter((u) => u.status === "active")
      .map((u) => ({ id: u.id, name: u.name || u.username, username: u.username, role: u.role })),
    all_groups: groups.map((g) => ({ id: g.id, name: g.name, member_count: g.member_count })),
  });
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const def = SECTIONS.find((s) => s.key === body?.section);
  if (!def) return NextResponse.json({ error: "Unknown section." }, { status: 404 });

  await setSectionGrants(def.key as Section, {
    users: Array.isArray(body?.users) ? body.users : [],
    groups: Array.isArray(body?.groups) ? body.groups : [],
  });
  const grants = await getSectionGrants(def.key as Section);
  await audit({
    actor: actorFrom(user),
    action: "settings.section_access",
    targetType: "section",
    targetId: def.key,
    targetLabel: def.label,
    details: { users: grants.users.length, groups: grants.groups.length },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, section: { ...def, ...grants } });
}
