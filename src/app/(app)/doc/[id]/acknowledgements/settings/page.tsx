import { notFound } from "next/navigation";
import { userHolds, spaceScopeFor, scopeAllows, canSeeDrafts } from "@/lib/access";
import {
  getAckSettings,
  getAckRecert,
  getDocument,
  getUserById,
  ackSummary,
  getPolicyAudience,
  getPolicySettings,
  policyDefaultLayers,
  listGroups,
  listUsers,
} from "@/lib/db";
import { getComplianceSettings } from "@/lib/compliance-settings";
import { resolvePolicyDefaults, workspaceDueDefaults } from "@/lib/compliance";
import { resolveDefaults } from "@/lib/ack-due";
import { PolicySettingsPanel } from "@/components/PolicySettingsPanel";
import { ackPageContext } from "../data";
import { listReplacementCandidates } from "./replacements";

import type { Metadata } from "next";
import { cachedDocument } from "@/lib/page-data";
export const dynamic = "force-dynamic";

// The Settings tab of the Read confirmation pages (C2, 1.12.0): the
// per-policy settings, for those who may change how the policy asks. The
// header, the subtitle sentence and the Record · History · Settings row live
// in layout.tsx; the roster guard (ackPageContext) is the layout's, and this
// page adds the Settings tab's own: document.ack_require on the space, or
// compliance.program_manage, else the page does not exist for the caller
// (the sub-nav hides the tab on the same condition).
//
// Six cards: Confirmation statement (C2), Who must confirm (D1, 1.13.0: the
// audience mode, its groups, people, roles and exclusions, the two
// switches), Deadline (E1: inherit, days after assignment or a fixed date,
// and "Also move existing deadlines"), Reminders (E2: the cadence and the
// policy owner), Re-confirmation (G1: the interval, the next date, the
// effective date) and Lifecycle (G3: the replacement, Retire policy,
// Un-retire). The page reads each card's values from the setter that owns
// them and hands the panel one `initial`; the panel's one Save row PATCHes
// /api/documents/[id]/ack-settings.

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const doc = await cachedDocument(Number(id)).catch(() => undefined);
  return {
    title: doc?.title ? `Read confirmation settings · ${doc.title}` : "Read confirmation settings",
  };
}

/** The directory a group came from, as the picker's sublabel. */
function groupSource(source: string): string {
  if (source === "entra") return "Entra";
  if (source === "google") return "Google";
  return "Manual";
}

export default async function AckSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, doc } = await ackPageContext(Number(id));
  const [mayRequire, mayManage, scope] = await Promise.all([
    userHolds(user, "document.ack_require", { spaceId: doc.space_id, legacyMin: "approver" }),
    userHolds(user, "compliance.program_manage", { legacyMin: "admin" }),
    spaceScopeFor(user),
  ]);
  if (!mayRequire && !mayManage) notFound();

  const [settings, recert, program, summary, replacements, replacement, audience, policy, defaults, layers, workspace, groups, users] =
    await Promise.all([
      getAckSettings(doc.id),
      getAckRecert(doc.id),
      getComplianceSettings(),
      // The standing for the Retire question ("42 of 50 people have confirmed
      // version 12") and the re-ask after an un-retire.
      ackSummary(doc.id),
      listReplacementCandidates(doc.id, scope),
      // The replacement's title for the chip; a document moved to the Trash
      // keeps the id (setSupersededBy's rule) and loses the title.
      doc.ack_superseded_by ? getDocument(doc.ack_superseded_by) : Promise.resolve(undefined),
      // Who must confirm (D1): null until the policy has a settings row (space mode).
      getPolicyAudience(doc.id),
      // The policy's own deadline rule, cadence and owner (E1/E2).
      getPolicySettings(doc.id),
      // The cascade with the policy's layer (the effective numbers) …
      resolvePolicyDefaults(doc.id),
      // … and the two layers below it, for what a blank field inherits.
      policyDefaultLayers(doc.id),
      workspaceDueDefaults(),
      // The pickers' options: every group with its source, every active account.
      listGroups(),
      listUsers(),
    ]);
  if (!settings || !recert) notFound();
  // The title under this viewer's own scope and draft rule, as the route
  // answers it (a title never crosses space scope); the id stays, so the
  // chip falls back to "Document #id".
  const replacementTitle =
    replacement &&
    scopeAllows(scope, replacement.space_id) &&
    !(replacement.status === "draft" && !(await canSeeDrafts(user, replacement.space_id)))
      ? replacement.title
      : null;
  const inherited = resolveDefaults({ space: layers?.space.defaults, workspace });
  const [owner, requester] = await Promise.all([
    policy?.owner_user_id ? getUserById(policy.owner_user_id) : Promise.resolve(undefined),
    policy?.requested_by ? getUserById(policy.requested_by) : Promise.resolve(undefined),
  ]);

  return (
    <PolicySettingsPanel
      doc={{ id: doc.id, title: doc.title }}
      initial={{
        statement: settings.statement,
        statement_default: program.compliance_statement_default,
        signature: settings.signature,
        recert_months: recert.ack_recert_months,
        next_recert_at: recert.ack_next_recert_at,
        effective_at: recert.ack_effective_at,
        marker: recert.ack_revision_at,
        recert_default: program.ack_defaults.recert_months,
        superseded_by: doc.ack_superseded_by,
        superseded_by_title: replacementTitle,
        replacements: replacements.map((r) => ({ id: r.id, label: r.title, sublabel: `${r.space_icon} ${r.space_name}` })),
        required: doc.ack_required === 1,
        retired: doc.ack_retired_at
          ? { at: doc.ack_retired_at, by: doc.ack_retired_by_name, reason: doc.ack_retired_reason }
          : null,
        summary: { current: summary.current, eligible: summary.eligible, rev: summary.rev },
        viewerName: user.name || user.username,
        audience: audience ?? { audience_mode: "space", rules: [], exclude_stewards: false, assign_new_members: true },
        groups: groups.map((g) => ({ id: g.id, label: g.name, sublabel: groupSource(g.source) })),
        people: users
          .filter((u) => u.status === "active")
          .map((u) => ({ id: u.id, label: u.name || u.username, sublabel: u.username })),
        rule: defaults.rule,
        defaults: { values: defaults.values, origin: defaults.origin, space: defaults.space },
        inherited: { values: inherited.values, origin: inherited.origin },
        reminders: {
          remind_before_days: policy?.remind_before_days ?? null,
          remind_every_days: policy?.remind_every_days ?? null,
          escalate_after_days: policy?.escalate_after_days ?? null,
          nudge_every_days: policy?.nudge_every_days ?? null,
        },
        owner_user_id: policy?.owner_user_id ?? null,
        owner_name: owner ? owner.name || owner.username : null,
        requested_by: requester ? { id: requester.id, name: requester.name || requester.username } : null,
      }}
    />
  );
}
