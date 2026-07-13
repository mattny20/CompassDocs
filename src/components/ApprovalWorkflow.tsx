"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ApprovalMode } from "@/lib/types";

export function ApprovalWorkflow({ initial }: { initial: ApprovalMode }) {
  const router = useRouter();
  const [mode, setMode] = useState<ApprovalMode>(initial);
  const [saving, setSaving] = useState(false);

  async function save(next: ApprovalMode) {
    setMode(next);
    setSaving(true);
    await fetch("/api/admin/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approval_mode: next }),
    });
    setSaving(false);
    router.refresh();
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <ModeCard
        active={mode === "strict"}
        disabled={saving}
        onClick={() => save("strict")}
        title="Strict (review required)"
        desc="Editors' changes to published docs and new publishes go to the review queue. Approvers/Admins publish."
      />
      <ModeCard
        active={mode === "open"}
        disabled={saving}
        onClick={() => save("open")}
        title="Open (edit freely)"
        desc="Editors can publish and update live docs directly, with no review step. Approvers still handle suggestions."
      />
    </div>
  );
}

function ModeCard({
  active,
  disabled,
  onClick,
  title,
  desc,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  title: string;
  desc: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl border p-4 text-left transition ${
        active
          ? "border-compass-400 bg-compass-50 ring-2 ring-compass-100"
          : "border-slate-200 bg-surface hover:border-slate-300"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`grid h-4 w-4 place-items-center rounded-full border ${
            active ? "border-compass-600 bg-compass-600" : "border-slate-300"
          }`}
        >
          {active && <span className="h-1.5 w-1.5 rounded-full bg-surface" />}
        </span>
        <span className="font-semibold text-slate-900">{title}</span>
      </div>
      <p className="mt-1 pl-6 text-sm text-slate-500">{desc}</p>
    </button>
  );
}
