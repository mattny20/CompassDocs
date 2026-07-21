import { authServerMetadata, corsJson, corsPreflight, publicOrigin } from "@/lib/oauth";

export const dynamic = "force-dynamic";
export const GET = async (req: Request) => corsJson(authServerMetadata(await publicOrigin(req)));
export const OPTIONS = async () => corsPreflight();
