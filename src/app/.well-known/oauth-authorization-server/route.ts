import { authServerMetadata, corsJson, corsPreflight, requestOrigin } from "@/lib/oauth";

export const dynamic = "force-dynamic";
export const GET = async (req: Request) => corsJson(authServerMetadata(requestOrigin(req)));
export const OPTIONS = async () => corsPreflight();
