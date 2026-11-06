"use client";

// The team switcher at the top of the Teams and On call pages: a labelled
// select, so it reads the same on a phone. The choice lives in ?team=.

import { Select } from "@/components/form";
import { HD_ASSIGN_MODE_LABEL, isAssignMode } from "@/lib/helpdesk/assignment/shared";
import type { AssignmentTeam } from "./data";

export function TeamPicker({ teams, value, onChange, showMode = true }: { teams: AssignmentTeam[]; value: number | null; onChange: (id: number) => void; showMode?: boolean }) {
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-700">
      Team
      <Select dense value={value ?? ""} onChange={(e) => onChange(Number(e.target.value))} className="w-auto min-w-48">
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
            {showMode && isAssignMode(t.mode) ? ` · ${HD_ASSIGN_MODE_LABEL[t.mode]}` : ""}
          </option>
        ))}
      </Select>
    </label>
  );
}
