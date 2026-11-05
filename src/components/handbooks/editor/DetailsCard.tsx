"use client";

// The handbook editor's Details card (1.18.0, mock-up 1-editor): Title and
// Owner side by side, the Introduction printed on the first page, who reads
// it (everyone, or members of the owning space, or chosen groups) and, with
// the Read confirmation licence, the two switches for confirming the whole
// handbook. "Require a typed signature" only means something once the
// first is on, so it is left out until then (STYLEGUIDE §Settings pages).
// A server refusal of these fields (or of Publish) for a handbook holding
// documents its editor can't add from is the card's FormError, at its foot.

import { useEffect, useRef } from "react";
import { Card } from "@/components/Card";
import { EntityPicker } from "@/components/EntityPicker";
import { Field, FormError, Select, TextInput, Textarea, Toggle } from "@/components/form";
import { Segmented } from "@/components/Segmented";
import type { HandbookAudienceMode, HandbookOptions } from "@/lib/handbooks";
import { INTRO_MAX, TITLE_MAX, type DraftDetails } from "./model";

export function DetailsCard({
  details,
  options,
  errors,
  refusal = null,
  disabled,
  onChange,
  titleRef,
  introRef,
  groupsRef,
}: {
  details: DraftDetails;
  options: HandbookOptions;
  /** Shown once a save has been tried. */
  errors: { title?: string; groups?: string; introduction?: string };
  /** The server's refusal of these details or of Publish (HANDBOOK_FOREIGN_CONTENTS): a FormError at the card's foot. */
  refusal?: string | null;
  disabled: boolean;
  onChange: (patch: Partial<DraftDetails>) => void;
  titleRef?: React.Ref<HTMLInputElement>;
  /** The Introduction box: focused when it is the first invalid field. */
  introRef?: React.Ref<HTMLTextAreaElement>;
  /** Wraps the groups picker: its search box is focused when no group is chosen. */
  groupsRef?: React.Ref<HTMLDivElement>;
}) {
  const ownerSpace = details.owner === "" ? null : options.spaces.find((s) => String(s.id) === details.owner);
  // An owner the person can no longer choose (a workspace handbook opened by
  // a space admin cannot exist, but a space they lost can): keep it listed.
  const ownerKnown = details.owner === "" ? options.can_create_workspace : Boolean(ownerSpace);
  // Save is pinned at the page's foot and Publish sits in its header: the
  // refusal is brought on screen from either (it announces itself).
  const refusalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (refusal) refusalRef.current?.scrollIntoView({ block: "nearest" });
  }, [refusal]);

  return (
    <Card title="Details" id="handbook-details" className="scroll-mt-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Title" error={errors.title}>
          <TextInput
            ref={titleRef}
            value={details.title}
            maxLength={TITLE_MAX}
            disabled={disabled}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder="Employee Handbook 2026"
          />
        </Field>
        <Field label="Owner" help={details.owner === "" ? "Workspace admins edit it." : "The space's admins edit it."}>
          <Select value={details.owner} disabled={disabled} onChange={(e) => onChange({ owner: e.target.value })}>
            {(options.can_create_workspace || details.owner === "") && <option value="">Whole workspace (admins)</option>}
            {!ownerKnown && details.owner !== "" && <option value={details.owner}>Current space</option>}
            {options.spaces.map((s) => (
              <option key={s.id} value={String(s.id)}>
                {s.icon ? `${s.icon} ${s.name}` : s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={
            <>
              Introduction <span className="font-normal">(printed on the first page)</span>
            </>
          }
          help="Plain text or Markdown."
          error={errors.introduction}
          className="sm:col-span-2"
        >
          <Textarea
            ref={introRef}
            rows={3}
            value={details.introduction}
            maxLength={INTRO_MAX}
            disabled={disabled}
            onChange={(e) => onChange({ introduction: e.target.value })}
            placeholder="Welcome to Acme. This handbook brings together the policies every member of staff needs to know."
          />
        </Field>
      </div>

      <fieldset className="mt-4">
        <legend className="mb-1 text-xs font-medium text-slate-500">Who reads it</legend>
        <Segmented<HandbookAudienceMode>
          label="Who reads it"
          value={details.audience}
          onChange={(audience) => !disabled && onChange({ audience })}
          className="flex-wrap"
          options={[
            { value: "all", label: ownerSpace ? `Members of ${ownerSpace.name}` : "Everyone" },
            { value: "groups", label: "Chosen groups" },
          ]}
        />
        {details.audience === "groups" && (
          <div ref={groupsRef} className="mt-2 max-w-xl">
            <EntityPicker
              label="Groups"
              placeholder="Search groups…"
              options={options.groups.map((g) => ({ id: g.id, label: g.name }))}
              value={details.group_ids}
              onChange={(group_ids) => onChange({ group_ids })}
              disabled={disabled}
              emptyText="No group matches."
            />
            {errors.groups ? (
              <p role="alert" className="mt-1 text-xs text-red-600">
                {errors.groups}
              </p>
            ) : (
              <p className="mt-1 text-xs text-slate-500">
                {ownerSpace ? `Members of these groups who can read ${ownerSpace.name}.` : "Only members of these groups see the handbook."}
              </p>
            )}
          </div>
        )}
        {details.audience === "all" && (
          <p className="mt-1 text-xs text-slate-500">
            {ownerSpace ? `Everyone who can read ${ownerSpace.name}.` : "Everyone in the workspace."} Readers see the handbook once it is published.
          </p>
        )}
      </fieldset>

      {options.policy_ack && (
        <div className="mt-4 flex flex-col gap-3 border-t border-slate-100 pt-4">
          <Toggle
            label="Ask readers to confirm the whole handbook"
            help="One confirmation covers every policy in it that asks this person to confirm."
            checked={details.confirm_whole}
            disabled={disabled}
            onChange={(confirm_whole) => onChange({ confirm_whole })}
          />
          {details.confirm_whole && (
            <Toggle
              label="Require a typed signature"
              help="Readers type their name (and their password, for a local account) to confirm the handbook, or any policy in it."
              checked={details.require_signature}
              disabled={disabled}
              onChange={(require_signature) => onChange({ require_signature })}
            />
          )}
        </div>
      )}

      <div ref={refusalRef} className="scroll-mb-24">
        <FormError className="mt-4">{refusal}</FormError>
      </div>
    </Card>
  );
}
