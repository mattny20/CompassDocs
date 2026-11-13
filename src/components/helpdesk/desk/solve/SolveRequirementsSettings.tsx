"use client";

// Settings → Before you solve (1.20.5, lib/helpdesk/solve-requirements): the
// requirement sets, as a list (the Teams pattern: a list, then one page per
// item). A row names the set, whether it is on, what it applies to and how
// much it asks for; it is a link to the set's own page
// (SolveRequirementSetDetail). "New requirement set" asks for a name, creates
// the set switched off and opens its page, so nothing changes for agents
// until it is ready.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, ClipboardCheck, Plus } from "lucide-react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { EmptyState } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { LoadingRow } from "@/components/Spinner";
import { formDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { SOLVE_REQ_LIMITS, solveScopeLabel, type HdSolveRequirementSet, type HdSolveTicketField } from "@/lib/helpdesk/solve-requirements-shared";
import { getJson, itemOf, sendJson } from "../api";

export const SOLVE_SETTINGS = "/desk/settings/before-you-solve";
export const solveSetHref = (id: number) => `${SOLVE_SETTINGS}/${id}`;

export interface SolveSettingsData {
  sets: (HdSolveRequirementSet & { answered: number })[];
  teams: { id: number; name: string }[];
  request_types: { id: number; title: string; active: number }[];
  /** The ticket fields this install can require (an asset only while an asset source is connected). */
  ticket_fields: HdSolveTicketField[];
  /** 1.20.6: the custom fields a set may require (lib/helpdesk/custom-fields). */
  custom_fields: { id: number; key: string; label: string; all_teams: boolean; team_ids: number[]; archived: boolean }[];
}

/** The page's data, reloadable. */
export function useSolveSettings() {
  const [data, setData] = useState<SolveSettingsData | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => {
    getJson<SolveSettingsData>("/api/helpdesk/admin/solve-requirements", "Couldn't load the requirement sets.")
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => reload(), [reload]);
  return { data, error, reload };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 ticket fields · 3 closing fields" */
function asksFor(s: HdSolveRequirementSet): string {
  const parts: string[] = [];
  if (s.ticket_fields.length) parts.push(plural(s.ticket_fields.length, "ticket field", "ticket fields"));
  if (s.custom_field_ids?.length) parts.push(plural(s.custom_field_ids.length, "custom field", "custom fields"));
  if (s.fields.length) parts.push(plural(s.fields.length, "closing field", "closing fields"));
  return parts.join(" · ") || "Nothing required yet";
}

export function SolveRequirementsSettings() {
  const router = useRouter();
  const { data, error, reload } = useSolveSettings();

  async function create() {
    const v = await formDialog({
      title: "New requirement set",
      body: "A set says what a ticket needs before it can be solved. It starts switched off. You choose what it asks for on the next page.",
      fields: [
        {
          key: "name",
          label: "Name",
          placeholder: "IT closing details",
          validate: (s) => (s.trim().length > SOLVE_REQ_LIMITS.name ? `Up to ${SOLVE_REQ_LIMITS.name} characters.` : undefined),
        },
      ],
      confirmLabel: "Create set",
    });
    if (!v) return;
    try {
      const r = await sendJson(`/api/helpdesk/admin/solve-requirements`, "POST", { name: v.name.trim(), enabled: false }, "Couldn't create the requirement set.");
      const set = itemOf<{ id: number }>(r, "set");
      toast("ok", `${v.name.trim()} created. Choose what it asks for.`);
      if (set?.id) router.push(solveSetHref(set.id));
      else reload();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  const sets = data?.sets ?? null;
  return (
    <PageContainer>
      <PageHeader
        icon={<ClipboardCheck />}
        title="Before you solve"
        subtitle="What agents fill in before a ticket can be solved."
        actions={
          <Button icon={<Plus />} onClick={create}>
            New requirement set
          </Button>
        }
      />
      {error && <p className="notice-error mb-4 rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {sets === null && !error && <LoadingRow className="py-10" />}
      {sets && sets.length === 0 && (
        <EmptyState
          icon={<ClipboardCheck />}
          title="No requirement sets yet"
          body="Add a set to ask agents for details, such as a resolution code or a linked asset, before they solve a ticket. Until you add one, solving works as it always has."
          action={{ onClick: create, label: "New requirement set", icon: <Plus /> }}
        />
      )}
      {sets && sets.length > 0 && data && (
        <Card padding="none">
          <ul role="list" className="divide-y divide-slate-100" data-testid="hd-solve-sets">
            {sets.map((s) => (
              <li key={s.id} data-testid="hd-solve-set-row">
                <Link href={solveSetHref(s.id)} className="flex items-center gap-3 px-4 py-3 outline-offset-[-2px] transition hover:bg-slate-50">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-compass-50 text-compass-700" aria-hidden>
                    <ClipboardCheck className="h-4.5 w-4.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="min-w-0 truncate text-sm font-semibold text-slate-900">{s.name}</span>
                      <Chip tone={s.enabled ? "ok" : "neutral"} size="sm">
                        {s.enabled ? "On" : "Off"}
                      </Chip>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-slate-500">
                      {solveScopeLabel(s, data.teams, data.request_types)} · {asksFor(s)}
                    </span>
                  </span>
                  <span className="hidden shrink-0 text-right text-xs text-slate-500 sm:block">
                    {s.answered > 0 ? (
                      <>
                        Answered on <span className="font-medium text-slate-700">{s.answered}</span> {s.answered === 1 ? "ticket" : "tickets"}
                      </>
                    ) : (
                      "No answers yet"
                    )}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {sets && sets.length > 0 && (
        <p className="mt-4 text-sm text-slate-500">
          Every set that is on and matches a ticket applies to it. Workflow task tickets are never asked: their hand-off is their closing step.
        </p>
      )}
    </PageContainer>
  );
}
