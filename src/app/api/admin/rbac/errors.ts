import { NextResponse } from "next/server";
import type { RoleMutationError } from "@/lib/db";

// One place to turn a role mutation's failure into an HTTP answer, so the
// wording an admin sees for "this would strand the workspace" is identical
// whether they got there by editing a role, deleting one, or revoking an
// assignment.
const MESSAGES: Record<RoleMutationError, { status: number; error: string }> = {
  not_found: { status: 404, error: "That role no longer exists." },
  builtin: {
    status: 400,
    error:
      "Built-in roles can't be edited — their permissions are reset from the catalog on every upgrade. Duplicate it and edit the copy.",
  },
  duplicate: { status: 409, error: "A role with that name already exists." },
  invalid_permission: { status: 400, error: "That permission isn't in this version's catalog." },
  would_orphan: {
    status: 409,
    error:
      "That change would leave nobody able to manage users — the workspace would have no way back in. Grant someone else user administration first.",
  },
  in_use: {
    status: 400,
    error:
      "This assignment mirrors the person's role. Change it in Settings → Users & roles so both move together.",
  },
};

export function roleMutationError(kind: RoleMutationError): NextResponse {
  const m = MESSAGES[kind];
  return NextResponse.json({ error: m.error }, { status: m.status });
}
