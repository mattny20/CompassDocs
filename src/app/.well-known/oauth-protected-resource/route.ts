import { corsJson, corsPreflight, protectedResourceMetadata, requestOrigin } from "@/lib/oauth";

export const dynamic = "force-dynamic";
export const GET = async (req: Request) => corsJson(protectedResourceMetadata(requestOrigin(req)));
export const OPTIONS = async () => corsPreflight();
