import "server-only";

// Which request type a CompassDocs trigger starts (1.19.0), resolved on the
// server for the person who sees the trigger, so its dialog can ask that
// type's own questions (the API refuses a request whose required answers
// are missing):
//
//   doc           "Report a problem with this page"  Report a problem
//   link          "This link is broken"              Report a problem
//   handbook      "Ask about this policy"            Ask HR
//   space_access  "Request access"                   the type whose workflow a space's owner approves, else Access to a space or app
//
// Each falls back to the type's category from the starter set, then to no
// type at all: a general request, routed by the desk's automations. Only a
// type the person may use is ever picked.

import { hq } from "@/lib/helpdesk/db-core";
import { listRequestTypesForUser } from "@/lib/helpdesk/request-types";
import type { HdRequestType, HdSource } from "@/lib/helpdesk/types";

export type TriggerSource = Extract<HdSource, "doc" | "link" | "handbook" | "space_access">;

const PREFERRED: Record<TriggerSource, { slugs: string[]; categories: string[] }> = {
  doc: { slugs: ["report-a-problem"], categories: ["problem"] },
  link: { slugs: ["report-a-problem"], categories: ["problem"] },
  handbook: { slugs: ["ask-hr"], categories: ["question"] },
  space_access: { slugs: ["access-to-a-space"], categories: ["access"] },
};

/** The request type a trigger starts for this person, or null for a general request. */
export async function triggerRequestType(user: { id: number }, source: TriggerSource): Promise<HdRequestType | null> {
  const types = await listRequestTypesForUser(user);
  if (types.length === 0) return null;
  const pref = PREFERRED[source];
  if (source === "space_access") {
    // The workflow that grants the space: its approval waits for the space's owner.
    const rows = await hq<{ id: number }>(
      `SELECT rt.id FROM hd_request_types rt JOIN hd_workflows w ON w.id = rt.workflow_id AND w.published = 1
        WHERE rt.active = 1 AND w.definition::text LIKE '%"space_owner"%'
        ORDER BY rt.position, rt.id`
    );
    const ids = new Set(rows.map((r) => r.id));
    const granted = types.find((t) => ids.has(t.id));
    if (granted) return granted;
  }
  return (
    pref.slugs.map((s) => types.find((t) => t.slug === s)).find(Boolean) ??
    types.find((t) => pref.categories.includes(t.category.toLowerCase())) ??
    null
  );
}
