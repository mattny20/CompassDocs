import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ClipboardCheck, Download } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { featureEnabled } from "@/lib/ee";
import { userHolds } from "@/lib/access";
import { getComplianceSettings } from "@/lib/compliance-settings";
import { userLeadGroups, userPolicyTranscript } from "@/lib/db";
import type { PolicyTranscript } from "@/lib/db";
import type { SessionUser } from "@/lib/types";
import { currentVersion } from "@/lib/version";
import { buttonClass } from "@/components/Button";
import { chipClass } from "@/components/Chip";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { PrintButton } from "@/components/PrintButton";
import { PersonRecord, type RecordAbilities } from "@/components/compliance/PersonRecord";

export const dynamic = "force-dynamic";

// The per-person compliance record (F3, 1.14.0): /compliance/person/{id},
// and /compliance/person/me for the viewer's own. One page for the auditor
// ("show me everything Ana Ruiz has confirmed, when, which version, why she
// is exempt from X and whether she was told"), the manager printing a
// leaver's record, the lead checking a member, and the reader looking at
// their own receipt.
//
// It sits in its own route group, (record), so it keeps the app shell but
// not the Compliance section's header and tab row: the record is a sub-page
// with its own title, back link and actions, as /training/person is.
//
// Who may open it is the four-way rule in lib/db userPolicyTranscript (the
// person, the Compliance section, a lead within their readable spaces, a
// space roster reader within theirs), and everyone else, like an unknown
// id, gets the shell's not-found page. The filter runs in SQL, so a lead's
// page never carries a private-space title or IP, only a count.

const loadRecord = cache(async (idParam: string): Promise<{ user: SessionUser; transcript: PolicyTranscript | null }> => {
  const user = await requireUser();
  if (!(await featureEnabled("policy_ack"))) return { user, transcript: null };
  const userId = idParam === "me" ? user.id : Number(idParam);
  if (!Number.isInteger(userId) || userId <= 0) return { user, transcript: null };
  return { user, transcript: await userPolicyTranscript(userId, user) };
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const { transcript } = await loadRecord(id);
  return { title: transcript ? `Compliance record · ${transcript.person.name || transcript.person.username}` : "Compliance record" };
}

/**
 * What the Actions section may do: the programme right for the section
 * itself; the team route's own rule for Remind (compliance.team_read, or a
 * lead with the setting on: the route refuses anyone else); the erasure
 * right (user.delete, with the programme right) on someone else's record,
 * as the Users page gates it.
 */
async function abilities(user: SessionUser, personId: number): Promise<RecordAbilities> {
  const manage = await userHolds(user, "compliance.program_manage", { legacyMin: "admin" });
  if (!manage) return { manage: false, remind: false, anonymise: false };
  const { grantsFor, admits, legacyAuthzEnforcement } = await import("@/lib/authz");
  const [grants, leads, settings] = await Promise.all([grantsFor(user.id), userLeadGroups(user.id), getComplianceSettings()]);
  const remind = admits(grants, "compliance.team_read") || (leads.length > 0 && settings.ack_defaults.leads_see_policies);
  const anonymise = personId !== user.id && (legacyAuthzEnforcement() || admits(grants, "user.delete"));
  return { manage, remind, anonymise };
}

/** The back link: where this viewer came from, by the kind of viewer the rule admitted. */
function backFor(kind: PolicyTranscript["viewer_kind"]): { href: string; label: string } {
  switch (kind) {
    case "self":
      return { href: "/compliance", label: "My policies" };
    case "program":
      return { href: "/compliance/people", label: "People" };
    case "lead":
      return { href: "/compliance/team", label: "Your team's policies" };
    default:
      return { href: "/compliance", label: "Compliance" };
  }
}

export default async function CompliancePersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, transcript } = await loadRecord(id);
  if (!transcript) notFound();
  const { person } = transcript;
  const can = await abilities(user, person.id);
  const name = person.name || person.username;

  return (
    <PageContainer>
      <PageHeader
        icon={<ClipboardCheck />}
        title={
          <>
            Compliance record - {name}
            {person.status === "disabled" && <span className={chipClass("neutral", "sm", "ml-2 align-middle")}>Disabled</span>}
          </>
        }
        subtitle={<>@{person.username} · every policy this person must confirm, with the evidence and prior cycles.</>}
        back={backFor(transcript.viewer_kind)}
        actions={
          <div className="flex items-center gap-2 print:hidden">
            <a href={`/api/admin/compliance/people/${person.id}?format=csv`} className={buttonClass("secondary")}>
              <Download className="h-4 w-4" aria-hidden /> CSV
            </a>
            <PrintButton compact />
          </div>
        }
        className="mb-5"
      />
      <PersonRecord
        transcript={transcript}
        can={can}
        viewerName={user.name || user.username}
        version={currentVersion()}
        generatedAt={new Date().toISOString()}
      />
    </PageContainer>
  );
}
