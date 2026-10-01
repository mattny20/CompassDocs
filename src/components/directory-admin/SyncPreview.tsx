"use client";

// What a sync would do (dry run) or did: adds, changes, removals, adoptions,
// with names — the same shape from either provider.

import { useState } from "react";
import { UserPlus, UserMinus, UserPen, UserCheck } from "lucide-react";

export interface SyncPreviewData {
  adds: { name: string; email: string }[];
  changes: { name: string; email: string; changed?: string[] }[];
  removals: { name: string; email: string }[];
  adoptions: { name: string; email: string }[];
  unchanged: number;
}

function Group({ icon, title, items, tone, detail }: { icon: React.ReactNode; title: string; items: { name: string; email: string; changed?: string[] }[]; tone: string; detail?: (i: { changed?: string[] }) => string }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 6);
  return (
    <div className="min-w-0">
      <p className={`mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider ${tone}`}>
        {icon} {title} <span className="font-normal opacity-70">({items.length})</span>
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-slate-500">None.</p>
      ) : (
        <ul className="space-y-0.5 text-sm text-slate-700">
          {shown.map((i, k) => (
            <li key={`${i.email}-${k}`} className="break-words">
              {i.name}
              {i.email ? <span className="text-slate-500"> · {i.email}</span> : null}
              {detail && i.changed?.length ? <span className="block text-xs text-slate-500">{detail(i)}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {items.length > 6 && (
        <button type="button" onClick={() => setAll((a) => !a)} className="mt-1 text-xs font-medium text-compass-600 hover:underline">
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}

export function SyncPreview({ preview, blocked, dryRun }: { preview: SyncPreviewData; blocked?: { doomed: number; total: number; message?: string } | null; dryRun: boolean }) {
  const nothing = preview.adds.length + preview.changes.length + preview.removals.length + preview.adoptions.length === 0;
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="mb-2 text-sm text-slate-700">
        {dryRun ? "Nothing was written. A real run would: " : "This run: "}
        {nothing ? (
          <span className="text-slate-500">change nothing — {preview.unchanged} {preview.unchanged === 1 ? "person is" : "people are"} already up to date.</span>
        ) : (
          <span>
            add <strong>{preview.adds.length}</strong>, change <strong>{preview.changes.length}</strong>, remove <strong>{preview.removals.length}</strong>
            {preview.adoptions.length ? <>, adopt <strong>{preview.adoptions.length}</strong> hand-typed</> : null}; {preview.unchanged} unchanged.
          </span>
        )}
      </p>
      {blocked && (
        <p className="notice-warn mb-2 rounded-md border px-2.5 py-1.5 text-xs">
          {blocked.message ?? `${blocked.doomed} of ${blocked.total} synced people are no longer returned — more than half, so ${dryRun ? "a real run would keep" : "they were kept"} them unless removals are allowed.`}
        </p>
      )}
      {!nothing && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Group icon={<UserPlus className="h-3.5 w-3.5" />} title="Added" items={preview.adds} tone="text-emerald-700" />
          <Group icon={<UserPen className="h-3.5 w-3.5" />} title="Changed" items={preview.changes} tone="text-compass-700" detail={(i) => (i.changed ?? []).join(", ")} />
          <Group icon={<UserMinus className="h-3.5 w-3.5" />} title={dryRun ? "Would be removed" : "No longer returned"} items={preview.removals} tone="text-red-700" />
          <Group icon={<UserCheck className="h-3.5 w-3.5" />} title="Adopted" items={preview.adoptions} tone="text-amber-700" />
        </div>
      )}
    </div>
  );
}
