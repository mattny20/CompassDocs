"use client";

// The small chips under a step card in the workflow builder's canvas: the
// step's Only if (accent), a routed task (info), its hand-off fields and a
// task that carries on when the team can't do it (neutral). Each chip
// carries the full sentence as its tooltip and for screen readers; they
// sit above the card's stretched select button (relative z-10) so the
// tooltip shows on hover and keyboard focus. Renders nothing for a plain
// step. A step that counts business time (1.19.1) adds a neutral chip
// naming whose calendar counts; `rtTeamId` (the request type's team) is
// the default for a wait or a reminder.

import { CalendarDays, CircleSlash, ClipboardList, Filter, Signpost } from "lucide-react";
import { chipClass } from "@/components/Chip";
import type { HdCountDef, HdFormField, HdWorkflowDefinition, HdWorkflowStep } from "@/lib/helpdesk/types";
import type { HdTaskStepDefB, HdWorkflowStepB } from "./contract";
import { conditionFields, findField, routeFields, routeSummary, conditionSummary } from "./conditions";

export function StepBadges({
  step,
  form,
  def,
  teams,
  rtTeamId = null,
  className = "",
}: {
  step: HdWorkflowStep;
  form: HdFormField[];
  def?: HdWorkflowDefinition | null;
  teams: { id: number; name: string }[];
  rtTeamId?: number | null;
  className?: string;
}) {
  const s = step as HdWorkflowStepB;
  const task = s.kind === "task" ? (s as HdTaskStepDefB) : null;
  const when = conditionSummary(s.when, conditionFields(form, def, s.key));
  const rFields = routeFields(form);
  const teamName = (id: number) => teams.find((t) => t.id === id)?.name ?? "no team";
  const route = task?.route ? routeSummary(task.route, rFields, teamName, task.team_id) : "";
  const routeBy = task?.route ? findField(rFields, task.route)?.label ?? task.route.field : "";
  const outputs = task?.outputs ?? [];
  const carriesOn = task?.on_cant_do === "continue";
  const counted = step as HdWorkflowStep & HdCountDef;
  const business =
    counted.count === "business" && (s.kind === "wait" || (s.kind === "approval" && !!s.remind_after_hours) || (task !== null && !!task.due));
  const countTeam = counted.count_team_id ?? (task ? task.team_id : rtTeamId);
  const countWhose = countTeam ? `${teamName(countTeam)}'s` : "the default calendar's";
  const countWhat = s.kind === "approval" ? "The reminder counts" : s.kind === "wait" ? "The wait counts" : "The due date counts";
  if (!when && !route && !outputs.length && !carriesOn && !business) return null;

  const chip = (tone: Parameters<typeof chipClass>[0]) => chipClass(tone, "sm", "relative z-10 cursor-default");
  return (
    <ul className={`flex flex-wrap gap-1 ${className || "mt-1.5"}`} aria-label="Step rules">
      {when && (
        <li>
          <span className={chip("accent")} tabIndex={0} data-tt={`${when}.`} data-tt-wrap>
            <Filter className="h-3 w-3" aria-hidden />
            Only if
            <span className="sr-only">: {when.replace(/^Only if /, "")}</span>
          </span>
        </li>
      )}
      {route && (
        <li>
          <span className={chip("info")} tabIndex={0} data-tt={`${route}.`} data-tt-wrap>
            <Signpost className="h-3 w-3" aria-hidden />
            By {routeBy.toLowerCase()}
            <span className="sr-only">: {route}</span>
          </span>
        </li>
      )}
      {outputs.length > 0 && (
        <li>
          <span className={chip("neutral")} tabIndex={0} data-tt={`Hands on: ${outputs.map((o) => `${o.label || o.key}${o.required ? "" : " (optional)"}`).join(", ")}.`} data-tt-wrap>
            <ClipboardList className="h-3 w-3" aria-hidden />
            {outputs.length} hand-off {outputs.length === 1 ? "field" : "fields"}
          </span>
        </li>
      )}
      {business && (
        <li>
          <span className={chip("neutral")} tabIndex={0} data-tt={`${countWhat} ${countWhose} office hours and holidays.`} data-tt-wrap>
            <CalendarDays className="h-3 w-3" aria-hidden />
            Business {s.kind === "approval" || (s.kind === "wait" && !("field" in s.until)) || (task?.due && "after_hours" in task.due) ? "hours" : "days"}
            <span className="sr-only">: {`${countWhat} ${countWhose} office hours and holidays`}</span>
          </span>
        </li>
      )}
      {carriesOn && (
        <li>
          <span className={chip("neutral")} tabIndex={0} data-tt="If the team can't do it, the workflow carries on." data-tt-wrap>
            <CircleSlash className="h-3 w-3" aria-hidden />
            Carries on
          </span>
        </li>
      )}
    </ul>
  );
}
