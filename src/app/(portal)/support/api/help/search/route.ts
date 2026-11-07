// GET  /support/api/help/search?q=…&j=<journey>   → { articles: HelpSuggestion[] }
//      suggestions as you type in the help centre's search box.
// POST /support/api/help/search  { q }             → { articles }
//      the request form's suggestions from its subject: the subject travels
//      in the body (never the address, so no proxy or access log keeps it)
//      and is never counted or stored.
// Customer portal help centre (Helpdesk 1.19.4, C3). Public: no sign-in
// needed. 404 while the help centre or the portal is off (it says nothing
// about the workspace). 40 a minute per network address (an IPv6 /64),
// 429 with its own sentence. Only the help centre's rule
// (lib/helpdesk/help-centre publicArticleScope) picks the articles. A GET
// is counted for the settings page's numbers only when the page itself
// asked (same origin), so a link from elsewhere cannot fill the stats; a
// POST must be same-origin.

import { ipFrom } from "@/lib/audit";
import { getHelpCentreSettings, helpCentreOpen, helpSearchLimited, searchHelpCentre } from "@/lib/helpdesk/help-centre";
import { getPortalSettings, portalNotFound, portalOriginRejection } from "@/lib/helpdesk/portal";
import { portalJson, readSmallJson } from "@/lib/helpdesk/portal-http";

export const dynamic = "force-dynamic";

const LIMITED = "Too many searches right now. Wait a moment and try again.";

async function open() {
  const [hc, portal] = await Promise.all([getHelpCentreSettings(), getPortalSettings()]);
  return (await helpCentreOpen({ hc, portal })) ? { hc, portal } : null;
}

export async function GET(req: Request) {
  const ctx = await open();
  if (!ctx) return portalNotFound();
  if (helpSearchLimited(ipFrom(req) ?? "unknown")) return portalJson({ error: LIMITED, limited: true }, 429);
  const url = new URL(req.url);
  const articles = await searchHelpCentre(
    url.searchParams.get("q") ?? "",
    {
      journey: url.searchParams.get("j") ?? "",
      // A page from before the POST form may still ask by address: never counted.
      source: url.searchParams.get("src") === "form" ? "form" : "home",
      record: portalOriginRejection(req) === null,
    },
    ctx
  );
  return portalJson({ articles });
}

export async function POST(req: Request) {
  const ctx = await open();
  if (!ctx) return portalNotFound();
  const cross = portalOriginRejection(req);
  if (cross) return cross;
  if (helpSearchLimited(ipFrom(req) ?? "unknown")) return portalJson({ error: LIMITED, limited: true }, 429);
  const b = await readSmallJson(req, 2048);
  if (!b) return portalJson({ error: "Send the words to look for." }, 400);
  const articles = await searchHelpCentre(b.q, { source: "form", record: false }, ctx);
  return portalJson({ articles });
}
