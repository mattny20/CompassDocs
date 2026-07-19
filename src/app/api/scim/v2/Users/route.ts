import {
  scimGuard,
  scimJson,
  scimError,
  toScimUser,
  parseScimUser,
  parseScimFilter,
  SCIM_LIST_SCHEMA,
} from "@/lib/scim";
import {
  listUsers,
  getUserById,
  getUserByUsername,
  getUserByAnyExternalId,
  scimCreateUser,
} from "@/lib/db";
import { audit } from "@/lib/audit";
import { requestOrigin } from "@/lib/oauth";
import type { User } from "@/lib/types";

export const dynamic = "force-dynamic";

const SCIM_ACTOR = { name: "SCIM provisioning" };

export async function GET(req: Request) {
  const denied = await scimGuard(req);
  if (denied) return denied;
  const origin = requestOrigin(req);
  const url = new URL(req.url);

  const filter = parseScimFilter(url.searchParams.get("filter") ?? "");
  if (filter && "error" in filter) return scimError(400, filter.error, "invalidFilter");

  let matches: User[];
  if (filter) {
    let hit: User | undefined;
    if (filter.attr === "userName") hit = await getUserByUsername(filter.value);
    else if (filter.attr === "externalId") hit = await getUserByAnyExternalId(filter.value);
    else hit = await getUserById(Number(filter.value) || 0);
    matches = hit ? [hit] : [];
  } else {
    matches = await listUsers();
  }

  // SCIM pagination is 1-based.
  const startIndex = Math.max(1, Number(url.searchParams.get("startIndex")) || 1);
  const count = Math.min(200, Math.max(0, Number(url.searchParams.get("count")) || 100));
  const page = matches.slice(startIndex - 1, startIndex - 1 + count);

  return scimJson({
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: matches.length,
    startIndex,
    itemsPerPage: page.length,
    Resources: page.map((u) => toScimUser(u, origin)),
  });
}

export async function POST(req: Request) {
  const denied = await scimGuard(req);
  if (denied) return denied;
  const origin = requestOrigin(req);

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return scimError(400, "Request body must be JSON.", "invalidSyntax");
  }
  const input = parseScimUser(payload);
  if (!input.userName) return scimError(400, "userName is required.", "invalidValue");

  // Uniqueness: the provisioning client resolves 409s by re-querying with a
  // filter and adopting the existing resource.
  if (await getUserByUsername(input.userName)) {
    return scimError(409, `A user with userName "${input.userName}" already exists.`, "uniqueness");
  }
  if (input.externalId && (await getUserByAnyExternalId(input.externalId))) {
    return scimError(409, `A user with externalId "${input.externalId}" already exists.`, "uniqueness");
  }

  const user = await scimCreateUser({
    username: input.userName,
    name: input.name ?? input.userName,
    email: input.email ?? (input.userName.includes("@") ? input.userName : ""),
    externalId: input.externalId ?? null,
    active: input.active ?? true,
  });
  await audit({
    actor: SCIM_ACTOR,
    action: "scim.user_create",
    targetType: "user",
    targetId: user.id,
    targetLabel: user.username,
    details: { externalId: input.externalId ?? null },
  });
  return scimJson(toScimUser(user, origin), 201);
}
