// Helpdesk 1.19.1 import: what the /api/helpdesk/admin/import routes share
// (the gate, loading a job, the error answer). Server-only.

import "server-only";
import { NextResponse } from "next/server";
import { hdCapGate } from "./roles";
import { getImportJob, ImportError } from "./import";
import type { SessionUser } from "../types";

/** Desk capability settings.manage (same-origin, signed in, licensed). */
export async function importGate(): Promise<SessionUser | NextResponse> {
  return hdCapGate("settings.manage");
}

export async function loadJob(rawId: string): Promise<NonNullable<Awaited<ReturnType<typeof getImportJob>>> | NextResponse> {
  const job = await getImportJob(Number(rawId));
  if (!job || job.status === "discarded") return NextResponse.json({ error: "That import was not found." }, { status: 404 });
  return job;
}

/** An ImportError's own sentence and status; anything else is logged and a 500. */
export function importErrorResponse(e: unknown): NextResponse {
  if (e instanceof ImportError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error("[helpdesk import]", e);
  return NextResponse.json({ error: "The import couldn't do that. Try again." }, { status: 500 });
}

/** The uploaded file's name from the x-filename header (URI-encoded by the client). */
export function uploadFilename(req: Request, fallback: string): string {
  const raw = req.headers.get("x-filename") ?? "";
  try {
    return decodeURIComponent(raw).slice(0, 200) || fallback;
  } catch {
    return raw.slice(0, 200) || fallback;
  }
}
