// Helpdesk 1.19.0: agent B's contract additions, merged into
// lib/helpdesk/types.ts at integration. This file only re-exports them for
// the modules that still import it; new code imports from ./types.
//
// Pure types: safe in client components.

export {
  HD_CONDITION_OPS,
  HD_REQUESTER_FIELDS,
} from "./types";
export type {
  HdApprovalCard,
  HdApproverDefB,
  HdApproverKindB,
  HdApprovalDecisionB,
  HdConditionOp,
  HdRequesterField,
  HdConditionRule,
  HdStepCondition,
  HdTaskRoute,
  HdTaskOutputType,
  HdTaskOutputDef,
  HdStepExtrasB,
  HdTaskStepDefB,
  HdParallelStepDefB,
  HdWorkflowStepB,
  HdWorkflowDefinitionB,
  HdWorkflowRunStateB,
  HdRunStepStateB,
  HdTaskTransfer,
  HdOutputValue,
  HdTaskOutcomeInput,
  HdProgressStepB,
  HdWorkflowProgressB,
  HdHandoff,
  HdWorkflowContext,
} from "./types";
