import { scimGuard, scimJson } from "@/lib/scim";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await scimGuard(req);
  if (denied) return denied;
  return scimJson({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    documentationUri: "https://docs.compassdocs.io/admin/scim/",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "Bearer token",
        description: "Long-lived bearer token generated in Settings → Single sign-on.",
      },
    ],
    meta: { resourceType: "ServiceProviderConfig" },
  });
}
