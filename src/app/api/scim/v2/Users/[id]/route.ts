import {
  scimGuard,
  scimJson,
  scimError,
  toScimUser,
  parseScimUser,
  applyScimPatch,
} from "@/lib/scim";
import { getUserById, getUserByUsername, scimUpdateUser, deleteUserSessions } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requestOrigin } from "@/lib/oauth";

export const dynamic = "force-dynamic";

const SCIM_ACTOR = { name: "SCIM provisioning" };

async function findUser(idParam: string) {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) return undefined;
  return getUserById(id);
}

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  const denied = await scimGuard(req);
  if (denied) return denied;
  const user = await findUser((await params).id);
  if (!user) return scimError(404, "User not found.");
  return scimJson(toScimUser(user, requestOrigin(req)));
}

/** Shared update path for PUT (full replace) and PATCH (operations). */
async function applyUpdate(
  req: Request,
  idParam: string,
  fields: {
    userName?: string;
    name?: string;
    email?: string;
    active?: boolean;
    externalId?: string;
  }
) {
  const user = await findUser(idParam);
  if (!user) return scimError(404, "User not found.");

  // A username change must not collide with another account.
  if (fields.userName && fields.userName.toLowerCase() !== user.username.toLowerCase()) {
    const clash = await getUserByUsername(fields.userName);
    if (clash && clash.id !== user.id) {
      return scimError(409, `userName "${fields.userName}" is already in use.`, "uniqueness");
    }
  }

  const nextStatus =
    fields.active === undefined ? undefined : fields.active ? ("active" as const) : ("disabled" as const);
  const updated = await scimUpdateUser(user.id, {
    username: fields.userName,
    name: fields.name,
    email: fields.email,
    status: nextStatus,
    externalId: fields.externalId,
  });
  if (!updated) return scimError(404, "User not found.");

  if (nextStatus === "disabled" && user.status === "active") {
    // Deactivation takes effect immediately — kill any live sessions.
    await deleteUserSessions(user.id);
    await audit({
      actor: SCIM_ACTOR,
      action: "scim.user_disable",
      targetType: "user",
      targetId: user.id,
      targetLabel: updated.username,
    });
  } else if (nextStatus === "active" && user.status === "disabled") {
    await audit({
      actor: SCIM_ACTOR,
      action: "scim.user_enable",
      targetType: "user",
      targetId: user.id,
      targetLabel: updated.username,
    });
  } else {
    await audit({
      actor: SCIM_ACTOR,
      action: "scim.user_update",
      targetType: "user",
      targetId: user.id,
      targetLabel: updated.username,
    });
  }
  return scimJson(toScimUser(updated, requestOrigin(req)));
}

export async function PUT(req: Request, { params }: Params) {
  const denied = await scimGuard(req);
  if (denied) return denied;
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return scimError(400, "Request body must be JSON.", "invalidSyntax");
  }
  return applyUpdate(req, (await params).id, parseScimUser(payload));
}

export async function PATCH(req: Request, { params }: Params) {
  const denied = await scimGuard(req);
  if (denied) return denied;
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return scimError(400, "Request body must be JSON.", "invalidSyntax");
  }
  const patch = applyScimPatch(payload?.Operations ?? []);
  // Given/family-only patches compose a display name.
  if (!patch.name && patch.nameParts) {
    const parts = [patch.nameParts.given, patch.nameParts.family].filter(Boolean);
    if (parts.length) patch.name = parts.join(" ");
  }
  return applyUpdate(req, (await params).id, patch);
}

/**
 * SCIM DELETE deactivates rather than destroys: document authorship, comments,
 * versions, and audit history keep their author. (Admins can hard-delete from
 * Settings → Users if ever truly needed.)
 */
export async function DELETE(req: Request, { params }: Params) {
  const denied = await scimGuard(req);
  if (denied) return denied;
  const user = await findUser((await params).id);
  if (!user) return scimError(404, "User not found.");
  if (user.status === "active") {
    await scimUpdateUser(user.id, { status: "disabled" });
    await deleteUserSessions(user.id);
    await audit({
      actor: SCIM_ACTOR,
      action: "scim.user_disable",
      targetType: "user",
      targetId: user.id,
      targetLabel: user.username,
      details: { via: "delete" },
    });
  }
  return new Response(null, { status: 204 });
}
