import { ee } from "@/lib/ee";

// Enterprise API surface. Core mounts this catch-all and forwards to the
// enterprise overlay's dispatcher (SSO callbacks, SCIM, …). In the community
// build there is no dispatcher, so every path 404s.
export const dynamic = "force-dynamic";

async function handle(req: Request, ctx: { params: Promise<{ slug: string[] }> }) {
  const dispatch = ee().dispatch;
  if (!dispatch) return new Response("Not found", { status: 404 });
  const { slug } = await ctx.params;
  return dispatch(req.method, slug ?? [], req);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
