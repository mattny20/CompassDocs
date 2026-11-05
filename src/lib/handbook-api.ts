// The small pieces every /api/handbooks route shares (1.18.0): the id in
// the path, the JSON body, and turning a HandbookError into its answer.
// Server-only; the decisions themselves are lib/handbooks'.

import "server-only";
import { NextResponse } from "next/server";
import { HandbookError, HANDBOOK_NOT_FOUND } from "./handbooks";

/** A positive integer path segment, or null (the route answers 404). */
export function pathId(raw: string): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function notFound(): NextResponse {
  return NextResponse.json({ error: HANDBOOK_NOT_FOUND }, { status: 404 });
}

/** The request's JSON body, or the 400 to answer. */
export async function jsonBody(req: Request): Promise<{ body: unknown } | { denied: NextResponse }> {
  try {
    return { body: await req.json() };
  } catch {
    return { denied: NextResponse.json({ error: "Invalid JSON." }, { status: 400 }) };
  }
}

/** Run a domain call; a HandbookError becomes `{ error }` with its status, anything else is rethrown. */
export async function answer<T>(fn: () => Promise<T>, status = 200): Promise<NextResponse> {
  try {
    return NextResponse.json(await fn(), { status, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof HandbookError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
