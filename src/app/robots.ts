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
  // The customer portal's help centre (1.19.4, C3): its home, categories and
  // articles, only while it is open and its admin ticked "Let search engines
  // index the help centre". Sign-in, requests and search stay closed.
  let helpCentre = false;
  try {
    const { getHelpCentreSettings, helpCentreOpen } = await import("@/lib/helpdesk/help-centre");
    const hc = await getHelpCentreSettings();
    helpCentre = hc.indexing && (await helpCentreOpen({ hc }));
  } catch {
    /* no database (build time) — stay closed */
  }
  const allow = [...(indexing ? ["/public", "/public/"] : []), ...(helpCentre ? ["/support$", "/support/articles/", "/support/categories/"] : [])];
  return {
    rules: allow.length ? [{ userAgent: "*", allow, disallow: ["/"] }] : [{ userAgent: "*", disallow: ["/"] }],
  };
}
