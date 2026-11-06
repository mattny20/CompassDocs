// POST /api/helpdesk/admin/holiday-sets/[id]/import   multipart "file" (.ics) or JSON { ics: "BEGIN:VCALENDAR…" }
//        → { added, duplicates, skipped, retimed }
//      Reads the uploaded iCalendar text only: VEVENT DTSTART/DTEND/SUMMARY,
//      RRULE FREQ=YEARLY. Never fetches a URL.
// Helpdesk 1.19.0, agent L (sla.manage). Audited (helpdesk.holiday_set.updated, details.imported).

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { addHolidays, getHolidaySet } from "@/lib/helpdesk/calendars";
import { CALENDAR_LIMITS, parseIcs } from "@/lib/helpdesk/calendars-shared";
import { badRequest, notFound } from "@/lib/helpdesk/routes";
import { auditCalendar, calendarErrorResponse, calendarGate, idOf } from "../../../calendars/helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const gate = await calendarGate();
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).id);
  const set = id ? await getHolidaySet(id) : undefined;
  if (!id || !set) return notFound();
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > CALENDAR_LIMITS.icsBytes + 16 * 1024) return NextResponse.json({ error: "That file is too large (512 KB at most)." }, { status: 413 });
  let text = "";
  let fileName = "";
  if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return badRequest("Upload the .ics file as form data.");
    }
    const file = form.get("file");
    if (!file || typeof file === "string") return badRequest("Choose an .ics file.");
    if (file.size > CALENDAR_LIMITS.icsBytes) return NextResponse.json({ error: "That file is too large (512 KB at most)." }, { status: 413 });
    fileName = file.name.slice(0, 120);
    text = await file.text();
  } else {
    const b = await readJson(req, CALENDAR_LIMITS.icsBytes + 1024);
    if (!b || typeof b.ics !== "string") return badRequest("Upload an .ics file.");
    text = b.ics;
  }
  if (!/BEGIN:VCALENDAR/i.test(text)) return badRequest("That doesn't look like an iCalendar (.ics) file.");
  const parsed = parseIcs(text);
  if (!parsed.holidays.length) return badRequest(parsed.skipped[0] ? `Nothing to import: ${parsed.skipped[0]}.` : "The file has no events to import.");
  if (parsed.holidays.length > CALENDAR_LIMITS.holidaysPerSet) return badRequest(`Up to ${CALENDAR_LIMITS.holidaysPerSet} holidays in a set.`);
  try {
    const r = await addHolidays(id, parsed.holidays);
    if (!r) return notFound();
    await auditCalendar(req, gate, "helpdesk.holiday_set.updated", { type: "helpdesk_holiday_set", id, label: set.name }, {
      imported: { file: fileName || null, added: r.added.length, duplicates: r.duplicates, skipped: parsed.skipped.length },
      retimed: r.retimed,
    });
    return NextResponse.json({ added: r.added, duplicates: r.duplicates, skipped: parsed.skipped, retimed: r.retimed });
  } catch (e) {
    return calendarErrorResponse(e);
  }
}
