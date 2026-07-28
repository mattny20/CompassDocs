import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { setPageWidth, setUserPrefs } from "@/lib/db";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

const WIDTHS = ["normal", "wide", "full"] as const;
const THEMES = ["light", "dark", "system"] as const;
const DATE_FORMATS = ["auto", "medium", "long", "iso", "us", "eu"] as const;

function validTimezone(tz: string): boolean {
  if (tz === "") return true; // auto — follow the browser
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Personal UI preferences: page width, theme, time zone, date format.
export async function PATCH(req: Request) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (body?.page_width !== undefined) {
    if (!WIDTHS.includes(body.page_width)) {
      return NextResponse.json({ error: "page_width must be normal, wide, or full." }, { status: 400 });
    }
    await setPageWidth(user.id, body.page_width);
  }
  if (body?.theme !== undefined) {
    if (!THEMES.includes(body.theme)) {
      return NextResponse.json({ error: "theme must be light, dark, or system." }, { status: 400 });
    }
    await setUserPrefs(user.id, { theme: body.theme });
  }
  if (body?.timezone !== undefined) {
    const tz = typeof body.timezone === "string" ? body.timezone.trim().slice(0, 100) : null;
    if (tz === null || !validTimezone(tz)) {
      return NextResponse.json({ error: "Unknown time zone." }, { status: 400 });
    }
    await setUserPrefs(user.id, { timezone: tz });
  }
  if (body?.date_format !== undefined) {
    if (!DATE_FORMATS.includes(body.date_format)) {
      return NextResponse.json({ error: "date_format must be auto, us, iso, or eu." }, { status: 400 });
    }
    await setUserPrefs(user.id, { date_format: body.date_format });
  }
  return NextResponse.json({ ok: true });
}
