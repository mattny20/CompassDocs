import type { MetadataRoute } from "next";
import { getPublicSiteConfig } from "@/lib/public-site";

export const dynamic = "force-dynamic";

// Nothing behind sign-in is for crawlers. The public site is the one surface
// that may be indexed, and only when the admin has switched indexing on
// (Settings › Public site) — the pages themselves also carry noindex until then.
export default async function robots(): Promise<MetadataRoute.Robots> {
  let indexing = false;
  try {
    const cfg = await getPublicSiteConfig();
    indexing = cfg.enabled && cfg.indexing;
  } catch {
    /* no database (build time) — stay closed */
  }
  return {
    rules: indexing
      ? [{ userAgent: "*", allow: ["/public", "/public/"], disallow: ["/"] }]
      : [{ userAgent: "*", disallow: ["/"] }],
  };
}
