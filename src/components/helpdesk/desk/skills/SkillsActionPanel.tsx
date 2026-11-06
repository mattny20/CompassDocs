"use client";

// The assignment rule editor's "An agent with the right skills or language"
// choice (1.19.2, agent W2, mock-up b2): Speaks [language] and knows
// [skill] [skill] [+ Skill]; what happens when nobody matching is
// available (the team's turn, or wait in the queue for a match); and the
// "N agents match today" preview, which asks the server who in the team the
// rule reaches could take a ticket right now (the same checks as the team's
// turn: role, pause, availability, shift and cap).

import { useEffect, useState } from "react";
import { Plus, UsersRound, X } from "lucide-react";
import { chipClass } from "@/components/Chip";
import { SectionEmpty, Select } from "@/components/form";
import { HD_SKILL_FALLBACK_LABEL, TICKET_LANGUAGE, type HdSkillCriteria } from "@/lib/helpdesk/skills/shared";
import { PickMenu } from "../PickMenu";
import { sendJson } from "../api";

export const EMPTY_SKILL_CRITERIA: HdSkillCriteria = { language: null, skill_ids: [], fallback: "team" };

interface Preview {
  agents: { user_id: number; name: string }[];
  text: string;
  unavailable: string[];
}

const BOX = "inline-flex min-h-9 items-center gap-2 rounded-lg border border-slate-200 bg-surface px-2.5 py-1 text-sm text-slate-500";

export function SkillsActionPanel({
  value,
  onChange,
  skills,
  languages,
  teamId,
  minRole,
}: {
  value: HdSkillCriteria;
  onChange: (next: HdSkillCriteria) => void;
  skills: { id: number; name: string }[];
  languages: { code: string; name: string }[];
  /** The team the rule reaches (moves to, or is limited to); null = every team. */
  teamId: number | null;
  minRole: string | null;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const remaining = skills.filter((s) => !value.skill_ids.includes(s.id));
  const empty = !value.language && value.skill_ids.length === 0;
  const key = JSON.stringify([value.language, value.skill_ids, teamId, minRole]);

  useEffect(() => {
    if (empty) {
      setPreview(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      sendJson<Preview>("/api/helpdesk/admin/assignment/skills-preview", "POST", { skills: value, team_id: teamId, min_role: minRole }, "Couldn't check who matches.")
        .then((p) => {
          if (!live) return;
          setPreview(p);
          setPreviewError("");
        })
        .catch((e: Error) => live && setPreviewError(e.message));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // `key` covers the criteria, the team and the role.
  }, [key, empty]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className={BOX}>
          Speaks
          <Select
            dense
            aria-label="Speaks"
            className="w-auto font-medium text-compass-700"
            value={value.language ?? ""}
            onChange={(e) => onChange({ ...value, language: e.target.value || null })}
          >
            <option value="">any language</option>
            <option value={TICKET_LANGUAGE}>the ticket&apos;s language</option>
            {languages.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </Select>
        </label>
        {value.skill_ids.map((id, i) => {
          const name = skills.find((s) => s.id === id)?.name ?? "A deleted skill";
          return (
            <span key={id} className={BOX}>
              {i === 0 ? "and knows" : "and"}
              <span className={chipClass("neutral")}>{name}</span>
              <button
                type="button"
                onClick={() => onChange({ ...value, skill_ids: value.skill_ids.filter((x) => x !== id) })}
                aria-label={`Remove ${name}`}
                data-tt="Remove"
                className="grid h-5 w-5 place-items-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </span>
          );
        })}
        {remaining.length > 0 && value.skill_ids.length < 10 && (
          <PickMenu
            label="Add a skill"
            value={null}
            options={remaining.map((s) => ({ value: s.id, label: s.name }))}
            onPick={(id) => onChange({ ...value, skill_ids: [...value.skill_ids, id] })}
            trigger={(p) => (
              <button {...p} type="button" className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-surface px-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Skill
              </button>
            )}
          />
        )}
        {skills.length === 0 && <SectionEmpty className="text-xs">No skills yet: add them under Skills and languages.</SectionEmpty>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-sm text-slate-600">
        <span>Nobody matching available?</span>
        <Select
          dense
          aria-label="Nobody matching available?"
          className="w-auto font-semibold text-slate-800"
          value={value.fallback}
          onChange={(e) => onChange({ ...value, fallback: e.target.value === "queue" ? "queue" : "team" })}
        >
          <option value="team">{HD_SKILL_FALLBACK_LABEL.team}</option>
          <option value="queue">{HD_SKILL_FALLBACK_LABEL.queue}</option>
        </Select>
      </div>
      {!empty && (preview || previewError) && (
        <div className="rounded-lg border border-compass-200 bg-compass-50 px-3 py-2 text-sm text-compass-800" aria-live="polite">
          {previewError ? (
            <p>{previewError}</p>
          ) : (
            preview && (
              <>
                <p className="flex items-start gap-2">
                  <UsersRound className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>{preview.text}</span>
                </p>
                {preview.unavailable.length > 0 && <p className="mt-1 pl-6 text-xs text-slate-600">Not available now: {preview.unavailable.join("; ")}.</p>}
              </>
            )
          )}
        </div>
      )}
    </div>
  );
}
