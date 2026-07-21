import { corsJson, corsPreflight, protectedResourceMetadata, publicOrigin } from "@/lib/oauth";

export const dynamic = "force-dynamic";
export const GET = async (req: Request) => corsJson(protectedResourceMetadata(await publicOrigin(req)));
export const OPTIONS = async () => corsPreflight();
