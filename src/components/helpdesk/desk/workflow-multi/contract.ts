// Multi-team workflows (1.19.0): the engine's shapes as the desk's UI reads
// them. lib/helpdesk/types (B's contract, merged) is the source of truth
// and is re-exported here.
//
// Pure types and constants: safe in client components.

import type { HdProgressStep } from "@/lib/helpdesk/types";
import type { HdConditionRule, HdWorkflowContext, HdWorkflowRunStateB, HdTaskOutputType } from "@/lib/helpdesk/types";

export type {
  HdConditionOp,
  HdConditionRule,
  HdStepCondition,
  HdTaskRoute,
  HdTaskOutputType,
  HdTaskOutputDef,
  HdTaskStepDefB,
  HdWorkflowStepB,
  HdWorkflowDefinitionB,
  HdRunStepStateB,
  HdTaskTransfer,
  HdTaskOutcomeInput,
  HdProgressStepB,
  HdWorkflowProgressB,
  HdHandoff,
  HdMissingOutput,
  HdWorkflowContext,
  HdWorkflowContextTask,
} from "@/lib/helpdesk/types";

export type HdRunStateB = HdWorkflowRunStateB;
export type HdConditionSource = HdConditionRule["source"];
export type HdCantDo = "stop" | "continue";

export type HdSiblingTask = HdWorkflowContext["siblings"][number];

/** A test-run step with the engine's multi-team answers (UI reads them when present). */
export interface SimulatedStepExtras {
  /** The step would not run: its Only if is not met. */
  skipped?: boolean;
  /** Why it is skipped, or why its team was chosen. */
  reason?: string | null;
  /** The team a routed task would go to. */
  team_name?: string | null;
}

export const REQUESTER_FIELDS: { key: string; label: string }[] = [
  { key: "department", label: "Department" },
  { key: "office", label: "Office" },
  { key: "location", label: "Location" },
  { key: "title", label: "Job title" },
  { key: "manager", label: "Manager" },
];

export const OUTPUT_TYPE_LABEL: Record<HdTaskOutputType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  select: "A choice",
  yes_no: "Yes or no",
};

export const STEP_STATE_LABEL: Record<HdProgressStep["state"] | "failed", string> = {
  pending: "Not started",
  active: "In progress",
  done: "Done",
  declined: "Declined",
  skipped: "Skipped",
  cancelled: "Cancelled",
  failed: "Couldn't be done",
};

export const STEP_STATE_TONE: Record<HdProgressStep["state"] | "failed", "ok" | "accent" | "neutral" | "error" | "warn"> = {
  pending: "neutral",
  active: "accent",
  done: "ok",
  declined: "error",
  skipped: "neutral",
  cancelled: "neutral",
  failed: "error",
};
