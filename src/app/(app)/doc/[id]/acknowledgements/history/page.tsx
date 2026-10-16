import { Chip, labelCase } from "@/components/Chip";
import type { ChipTone } from "@/components/Chip";
import { SectionEmpty } from "@/components/form";
import { Table, Th, Td, TABLE_HEAD_ROW, TR } from "@/components/Table";
import { listAckDecisions } from "@/lib/db";
import type { AckDecision } from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { formatDateTime, settingsForUser } from "@/lib/format";
import { ackPageContext } from "../data";

import type { Metadata } from "next";
import { cachedDocument } from "@/lib/page-data";
export const dynamic = "force-dynamic";

// The History tab (C1, 1.10.0): the decision ledger. Every time the text of
// a confirmed document changed, someone decided whether existing
// confirmations stand, and this is where an auditor reads who decided what,
// why, and how many people it touched. Both outcomes are rows, so "why were
// 42 people NOT asked again?" is answered by a row, not by an absence.

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const doc = await cachedDocument(Number(id)).catch(() => undefined);
  return {
    title: doc?.title ? `Read confirmation history · ${doc.title}` : "Read confirmation history",
  };
}

const OUTCOME: Record<string, { tone: ChipTone; label: string }> = {
  reset: { tone: "warn", label: "Asked again" },
  kept: { tone: "info", label: "Kept" },
  retired: { tone: "neutral", label: "Retired" },
};

/** The C1 source vocabulary in plain words. */
const SOURCE: Record<string, string> = {
  edit: "Edit",
  merge: "Merge",
  restore: "Restore",
  approval: "Approval",
  manual: "Manual",
  api: "API",
  mcp: "MCP",
  import: "Import",
  image: "Image",
  ticket: "Ticket",
  bulk: "Bulk edit",
  schedule: "Schedule",
  recurrence: "Annual re-confirmation",
  default: "Default",
};

export default async function AckHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, doc } = await ackPageContext(Number(id));
  const [decisions, settings] = await Promise.all([listAckDecisions(doc.id), getAppSettings()]);
  const fmt = settingsForUser(settings, user);

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-xs">
      {decisions.length === 0 ? (
        <SectionEmpty className="px-4 py-6">
          No decisions recorded yet. Edits to this document from 1.10.0 on are listed here.
        </SectionEmpty>
      ) : (
        <Table scroll minWidth="48rem">
          <thead className={TABLE_HEAD_ROW}>
            <tr>
              <Th fit>Date</Th>
              <Th fit>Decision</Th>
              <Th fit>Version</Th>
              <Th>By</Th>
              <Th fit>Source</Th>
              <Th>Reason</Th>
              <Th fit align="right">People</Th>
            </tr>
          </thead>
          <tbody>
            {decisions.map((d) => (
              <DecisionRow key={d.id} d={d} when={formatDateTime(d.decided_at, fmt)} />
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

/** The recommendation in the words of the review queue ("recommends: editorial fix"). */
const POLICY_WORDS: Record<"keep" | "reset", string> = { keep: "editorial fix", reset: "material change" };

function DecisionRow({ d, when }: { d: AckDecision; when: string }) {
  const outcome = OUTCOME[d.outcome] ?? { tone: "neutral" as ChipTone, label: labelCase(d.outcome) };
  const chose = d.outcome === "kept" ? "keep" : d.outcome;
  // Approvals carry the submitter next to the approver; the ledger names
  // both, and what the submitter recommended when the approver overrode it
  // ("recommended material change by Alex"), so an overridden recommendation
  // is never read as the submitter's.
  const submitter =
    d.submitted_by_name && d.submitted_by_name !== d.decided_by_name ? d.submitted_by_name : "";
  const overridden =
    (d.submitted_policy === "keep" || d.submitted_policy === "reset") && d.submitted_policy !== chose
      ? d.submitted_policy
      : null;
  const recommended = submitter
    ? overridden
      ? `recommended ${POLICY_WORDS[overridden]} by ${submitter}`
      : `recommended by ${submitter}`
    : "";
  const affected = d.confirmations_affected;
  return (
    <tr className={TR}>
      <Td fit className="align-top text-slate-500">
        {when}
      </Td>
      <Td fit className="align-top">
        <Chip tone={outcome.tone}>{outcome.label}</Chip>
        {d.overrode_suggestion ? (
          <span className="mt-1 block text-xs text-slate-500">
            suggested {d.suggested}, chose {chose}
          </span>
        ) : null}
      </Td>
      <Td fit className="align-top text-slate-500">
        {d.rev ? `v${d.rev}` : ""}
      </Td>
      <Td className="align-top">
        <span className="font-medium text-slate-800">{d.decided_by_name || "Automatic"}</span>
        {recommended && <span className="block text-xs text-slate-500">{recommended}</span>}
      </Td>
      <Td fit className="align-top text-slate-500">
        {SOURCE[d.source] ?? labelCase(d.source)}
      </Td>
      <Td className="align-top text-slate-700">{d.reason}</Td>
      <Td fit align="right" className="align-top text-slate-500">
        {affected === null || affected === undefined ? "" : `${affected} affected`}
      </Td>
    </tr>
  );
}
