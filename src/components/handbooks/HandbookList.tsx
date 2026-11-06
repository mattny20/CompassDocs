"use client";

// The handbooks list (1.18.0, mock-up 4-list): every handbook this person
// can read, and the drafts they can edit, in one table — the name with its
// count ("8 policies", "3 policies and 2 SOPs"), the owner, the status chip, the whole-handbook confirmation
// progress (with the Read confirmation licence: the share of the audience
// holding a confirmation of the current contents, and how many people that
// audience is) and the row's actions (Edit for an editor, Print). The one
// primary create action, New handbook, sits in the header for whoever may
// create one (STYLEGUIDE §Vocabulary).

import Link from "next/link";
import { BookOpen, Pencil, Plus, Printer } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { EmptyState } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { TABLE_HEAD_ROW, TR, Table, Td, Th } from "@/components/Table";
import type { HandbookSummary } from "@/lib/handbooks";
import { handbookItemsLabel } from "@/lib/handbook-shared";

export const HANDBOOKS_SUBTITLE = "Policies and SOPs brought together for people to read, print and confirm as one.";

function people(n: number): string {
  return `${n.toLocaleString("en")} ${n === 1 ? "person" : "people"}`;
}

/** Where a row's title goes: the reader once published, the editor for a draft its editor opens. */
function rowHref(h: HandbookSummary): string {
  return h.status === "draft" && h.can_edit ? `/handbooks/${h.id}/edit` : `/handbooks/${h.id}`;
}

export function HandbookList({
  rows,
  canCreate,
  showProgress,
}: {
  rows: HandbookSummary[];
  canCreate: boolean;
  /** policy_ack is licensed: the Confirmation column exists. */
  showProgress: boolean;
}) {
  return (
    <>
      <PageHeader
        icon={<BookOpen />}
        title="Handbooks"
        subtitle={HANDBOOKS_SUBTITLE}
        actions={
          canCreate ? (
            <Button href="/handbooks/new" icon={<Plus />}>
              New handbook
            </Button>
          ) : null
        }
      />

      {rows.length === 0 ? (
        // No action of its own: New handbook in the header is the page's one
        // primary, right above this card.
        <EmptyState
          icon={<BookOpen />}
          title="No handbooks yet"
          body={
            canCreate
              ? "Bring published policies and SOPs from any space together, in order, for people to read, print and confirm as one."
              : "When a handbook is shared with you, it appears here."
          }
        />
      ) : (
        <Card padding="none">
          <Table scroll>
            <thead className={TABLE_HEAD_ROW}>
              <tr>
                <Th>Handbook</Th>
                <Th className="hidden sm:table-cell">Owner</Th>
                <Th fit className="hidden sm:table-cell">
                  Status
                </Th>
                {showProgress && <Th className="hidden w-56 md:table-cell">Confirmation</Th>}
                <Th fit align="right">
                  <span className="max-sm:sr-only">{rows.some((r) => r.can_edit) ? "Actions" : "Print"}</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((h) => (
                <tr key={h.id} className={TR}>
                  <Td>
                    <Link href={rowHref(h)} className="block font-semibold [overflow-wrap:anywhere] text-slate-900 hover:text-compass-700">
                      {h.title}
                    </Link>
                    <span className="text-xs text-slate-500">{handbookItemsLabel(h.item_types)}</span>
                    {/* On a phone the other columns fold into this line. */}
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 sm:hidden">
                      <Chip size="sm" tone={h.status === "published" ? "ok" : "neutral"}>
                        {h.status === "published" ? "Published" : "Draft"}
                      </Chip>
                      <OwnerLabel h={h} />
                      {showProgress && h.progress && <span>{Math.round(h.progress.pct)}% confirmed</span>}
                    </span>
                  </Td>
                  <Td className="hidden text-slate-600 sm:table-cell">
                    <OwnerLabel h={h} />
                  </Td>
                  <Td fit className="hidden sm:table-cell">
                    <Chip tone={h.status === "published" ? "ok" : "neutral"}>{h.status === "published" ? "Published" : "Draft"}</Chip>
                  </Td>
                  {showProgress && (
                    <Td className="hidden md:table-cell">
                      <Progress h={h} />
                    </Td>
                  )}
                  <Td fit align="right">
                    <span className="inline-flex items-center gap-1">
                      {h.can_edit && (
                        <Link href={`/handbooks/${h.id}/edit`} data-tt="Edit handbook" aria-label={`Edit ${h.title}`} className={iconButtonClass("quiet", "sm")}>
                          <Pencil aria-hidden />
                        </Link>
                      )}
                      <Link
                        href={`/handbooks/${h.id}/print?print=1`}
                        // Short: the table card clips a long bubble (§Tooltips).
                        data-tt="Print"
                        aria-label={`Print ${h.title}`}
                        className={iconButtonClass("quiet", "sm")}
                      >
                        <Printer aria-hidden />
                      </Link>
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}

function OwnerLabel({ h }: { h: HandbookSummary }) {
  if (h.space_id === null) return <>{h.owner_label}</>;
  return (
    <span>
      {h.space_icon && <span aria-hidden>{h.space_icon} </span>}
      {h.space_name} space
    </span>
  );
}

/** "64% confirmed · 412 people" over a bar, or "Not asked" when the handbook asks nobody to confirm it yet. */
function Progress({ h }: { h: HandbookSummary }) {
  const p = h.progress;
  const pct = p ? Math.max(0, Math.min(100, Math.round(p.pct))) : 0;
  const label = p ? `${pct}% confirmed, ${p.confirmed} of ${people(p.audience)}` : "Not asked";
  return (
    <div>
      <div className="flex justify-between gap-3 text-xs text-slate-600">
        <span>{p ? `${pct}% confirmed` : "0% confirmed"}</span>
        <span>{p ? people(p.audience) : "Not asked"}</span>
      </div>
      <div role="img" aria-label={label} className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-slate-100">
        {pct > 0 && <span className={pct === 100 ? "bg-emerald-500" : "bg-compass-600"} style={{ width: `${pct}%` }} />}
      </div>
    </div>
  );
}
