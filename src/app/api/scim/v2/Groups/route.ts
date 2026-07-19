import { scimGuard, scimJson, scimError, SCIM_LIST_SCHEMA } from "@/lib/scim";

export const dynamic = "force-dynamic";

// Group provisioning is intentionally not implemented over SCIM: CompassDocs
// groups sync directly from Microsoft Entra via the enterprise Graph
// connector (Settings → Groups), which carries richer membership data. The
// empty list keeps SCIM clients that probe /Groups happy.

export async function GET(req: Request) {
  const denied = await scimGuard(req);
  if (denied) return denied;
  return scimJson({
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: 0,
    startIndex: 1,
    itemsPerPage: 0,
    Resources: [],
  });
}

export async function POST(req: Request) {
  const denied = await scimGuard(req);
  if (denied) return denied;
  return scimError(
    501,
    "Group provisioning is not supported over SCIM — use Entra group sync (Settings → Groups)."
  );
}
