import type { DocType, DocStatus } from "@/lib/types";
import { TYPE_STYLES, TYPE_LABEL, STATUS_STYLES } from "@/lib/ui";

export function TypeBadge({ type }: { type: DocType }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TYPE_STYLES[type]}`}
    >
      {TYPE_LABEL[type]}
    </span>
  );
}

export function StatusBadge({ status }: { status: DocStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

export function Tag({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
      #{label}
    </span>
  );
}
