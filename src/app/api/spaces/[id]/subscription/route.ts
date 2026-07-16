import { NextResponse } from "next/server";
import { getSpaceById, getSubscriptionState, setSubscriptionState } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor, scopeAllows } from "@/lib/access";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// A user's own subscription to one space. Spaces outside their scope look
// nonexistent, like everywhere else.
async function guard(params: Promise<{ id: string }>) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  const id = Number((await params).id);
  const space = Number.isInteger(id) ? await getSpaceById(id) : undefined;
  if (!space || !scopeAllows(await spaceScopeFor(user), space.id)) {
    return NextResponse.json({ error: "Space not found." }, { status: 404 });
  }
  return { user, space };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard(ctx.params);
  if (g instanceof NextResponse) return g;
  const sub = await getSubscriptionState(g.space.id, g.user.id);
  return NextResponse.json(sub);
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard(ctx.params);
  if (g instanceof NextResponse) return g;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const action = body?.action;
  if (!["subscribe", "mute", "clear"].includes(action)) {
    return NextResponse.json(
      { error: "action must be 'subscribe', 'mute', or 'clear'." },
      { status: 400 }
    );
  }
  await setSubscriptionState(
    g.space.id,
    g.user.id,
    action === "subscribe" ? "subscribed" : action === "mute" ? "muted" : null
  );
  return NextResponse.json(await getSubscriptionState(g.space.id, g.user.id));
}
