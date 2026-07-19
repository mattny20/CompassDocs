import { scimGuard, scimJson, SCIM_LIST_SCHEMA, SCIM_USER_SCHEMA } from "@/lib/scim";
import { requestOrigin } from "@/lib/oauth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await scimGuard(req);
  if (denied) return denied;
  const origin = requestOrigin(req);
  return scimJson({
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: 1,
    startIndex: 1,
    itemsPerPage: 1,
    Resources: [
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        id: "User",
        name: "User",
        endpoint: "/Users",
        schema: SCIM_USER_SCHEMA,
        meta: { resourceType: "ResourceType", location: `${origin}/api/scim/v2/ResourceTypes/User` },
      },
    ],
  });
}
