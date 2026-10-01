import type { DocType, DocStatus } from "@/lib/types";
import { TYPE_TONE, TYPE_LABEL, STATUS_TONE } from "@/lib/ui";
import { Chip, labelCase } from "./Chip";

export function TypeBadge({ type }: { type: DocType }) {
  return <Chip tone={TYPE_TONE[type]}>{TYPE_LABEL[type]}</Chip>;
}

export function StatusBadge({ status }: { status: DocStatus }) {
  return <Chip tone={STATUS_TONE[status]}>{labelCase(status)}</Chip>;
}

export function Tag({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-sm bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
      #{label}
    </span>
  );
}
