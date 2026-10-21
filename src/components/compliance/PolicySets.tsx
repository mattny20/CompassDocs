"use client";

// Compliance › Sets (D3, 1.14.0): named, ordered bundles of policies
// assigned to people, groups or everyone as one unit, and to every new
// joiner on day one when a set auto-assigns. Modelled on the training
// Programs block (TrainingPanel) in the portal's own skeleton: the intro
// sentence with one primary "New set" (STYLEGUIDE §Vocabulary: one create
// action per list page, the form opening above the list), one Card per set
// with its chips, its progress, its ordered members and its actions, and
// the two questions the spec names: the Assign modal (people, groups, or
// everyone behind a confirmDialog) and the danger Delete with the set's
// name typed when it auto-assigns. Deactivate tells with Undo (reversible);
// Delete asks (it is not).
//
// The data is GET /api/admin/compliance/sets (the rows and the picker's
// candidates); every write goes through useAction with the route's own
// sentence as the toast on refusal. The viewer's right to act comes from
// the server page (compliance.program_manage); a program_read holder sees
// the sets and no control that would answer 403. The copy is
// lib/policy-sets', so the page and the routes never drift.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Layers, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { Button, buttonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { confirmDialog } from "@/components/Dialog";
import { EntityPicker, type PickerOption } from "@/components/EntityPicker";
import { EmptyState, Field, TextInput, Textarea, Toggle } from "@/components/form";
import { CardTitle } from "@/components/Heading";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/Toasts";
import { OrderedKeyList } from "@/components/directory-admin/shared";
import { people } from "@/components/compliance/copy";
import { policyNoun } from "@/lib/audience";
import {
  SET_ASSIGN_EVERYONE,
  SET_ASSIGN_GROUPS_PLACEHOLDER,
  SET_ASSIGN_PEOPLE_PLACEHOLDER,
  SET_ASSIGN_PRIMARY,
  SET_AUTO_ASSIGN_LABEL,
  SET_DEACTIVATED_TOAST,
  SET_DELETE_BODY,
  SET_DOCS_MAX,
  SET_NAME_MAX,
  SET_NAME_PLACEHOLDER,
  SET_NAME_REQUIRED,
  SET_PAGE_INTRO,
  SET_PICKER_PLACEHOLDER,
  assignEveryoneConfirm,
  normaliseSetName,
  notNarrowedLine,
  progressText,
  switchedOnLine,
} from "@/lib/policy-sets";
import type { PolicySetAssignResult, PolicySetInput, PolicySetPatch, PolicySetRow, PolicySetTarget } from "@/lib/types";
import { useAction } from "@/lib/use-action";
import type { PortalPageProps } from "./use-portal";
import { PortalFallback } from "./PortalFallback";

/** One document the picker offers (GET's `candidates`): published, not a branch, not retired, required or not. */
interface Candidate {
  id: number;
  title: string;
  space_name: string;
  space_icon: string;
  ack_required: number;
}

interface SetsPayload {
  rows: PolicySetRow[];
  candidates: Candidate[];
}

export interface PolicySetsProps extends PortalPageProps {
  /** compliance.program_manage: the create form, the row actions and the Assign modal. */
  canManage: boolean;
  /** The Assign modal's pickers: every active account and every group (empty for a viewer who cannot act). */
  people: PickerOption[];
  groups: PickerOption[];
}

const SETS_URL = "/api/admin/compliance/sets";

// "Set deactivated · Undo": the sentence is the toast's text and the word
// after the dot its action (STYLEGUIDE §Feedback: reversible actions tell).
const [DEACTIVATED_TEXT, UNDO_LABEL] = SET_DEACTIVATED_TOAST.split(" · ");

/** The page's inline sentence when a form is submitted with no policy (the route's own is for API callers). */
const DOCS_REQUIRED = "Add at least one policy.";
const DOCS_TOO_MANY = `A set holds up to ${SET_DOCS_MAX} policies.`;

export function PolicySets({ licensed, canManageLicense = false, canManage, people: peopleOpts, groups: groupOpts }: PolicySetsProps) {
  const { run, busy } = useAction();
  const [data, setData] = useState<SetsPayload | null>(null);
  const [loadError, setLoadError] = useState("");
  const [creating, setCreating] = useState(false);
  // Focus after Delete and after a create (STYLEGUIDE §Settings pages: focus
  // never falls to <body>): the control that opened the question or the
  // form unmounts with the row or the form, so focus moves to New set.
  const newSetRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(SETS_URL);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d?.error || "Couldn't load the policy sets.");
      setData(d as SetsPayload);
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error && e.message ? e.message : "Couldn't load the policy sets.");
    }
  }, []);
  useEffect(() => {
    if (licensed) void load();
  }, [licensed, load]);

  /** One request through useAction: the server's error or the fallback is toasted; the body comes back on success. */
  async function send<T>(key: string, method: string, url: string, body: unknown, fallback: string): Promise<T | null> {
    const box: { result?: T } = {};
    const ok = await run(
      key,
      async () => {
        const res = await fetch(url, {
          method,
          headers: body === undefined ? undefined : { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (res.ok) box.result = (await res.clone().json().catch(() => ({}))) as T;
        return res;
      },
      { fallback, refresh: false }
    );
    return ok ? (box.result ?? ({} as T)) : null;
  }

  const focusNewSet = () => requestAnimationFrame(() => newSetRef.current?.focus());

  async function create(input: PolicySetInput): Promise<boolean> {
    const r = await send<{ set: PolicySetRow }>("create", "POST", SETS_URL, input, "Couldn't create the set.");
    if (!r) return false;
    const n = input.doc_ids.length;
    toast("ok", `Set created: ${n} ${policyNoun(n)}${input.assign_new_members ? " · auto-assigned to new joiners" : ""}`);
    setCreating(false);
    await load();
    focusNewSet();
    return true;
  }

  async function update(set: PolicySetRow, patch: PolicySetPatch): Promise<boolean> {
    if (Object.keys(patch).length === 0) return true;
    const r = await send(`update-${set.id}`, "PATCH", `${SETS_URL}/${set.id}`, patch, "Couldn't save the set.");
    if (!r) return false;
    toast("ok", "Set updated.");
    await load();
    return true;
  }

  async function assign(set: PolicySetRow, target: PolicySetTarget): Promise<boolean> {
    const r = await send<PolicySetAssignResult>(`assign-${set.id}`, "POST", `${SETS_URL}/${set.id}`, target, "Couldn't assign the set.");
    if (!r) return false;
    // The answer's counts are the truth: what the reconciles reached, what
    // was switched on, what stayed in space mode.
    let line = `Set assigned: ${r.policies} ${policyNoun(r.policies)}, ${people(r.people)}`;
    if (r.switched_on.length > 0) line += ` · ${r.switched_on.length} switched on`;
    if (r.not_narrowed.length > 0) line += ` · ${r.not_narrowed.length} left asking everyone`;
    toast("ok", line);
    await load();
    return true;
  }

  // Reversible, so it tells (STYLEGUIDE §Feedback): auto-assign and
  // assignment stop, every rule and row stays, and Undo re-activates. A 409
  // on the undo (the name taken meanwhile) is the route's sentence.
  async function deactivate(set: PolicySetRow) {
    const r = await send(`deactivate-${set.id}`, "PATCH", `${SETS_URL}/${set.id}`, { active: false }, "Couldn't deactivate the set.");
    if (!r) return;
    toast("ok", DEACTIVATED_TEXT, { action: { label: UNDO_LABEL, onClick: () => void activate(set, true) } });
    await load();
  }

  async function activate(set: PolicySetRow, undo = false) {
    const r = await send(`activate-${set.id}`, "PATCH", `${SETS_URL}/${set.id}`, { active: true }, "Couldn't activate the set.");
    if (!r) return;
    toast("ok", undo ? "Set active again." : "Set activated.");
    await load();
  }

  async function remove(set: PolicySetRow) {
    const answer = await confirmDialog({
      title: `Delete "${set.name}"?`,
      body: SET_DELETE_BODY,
      confirmLabel: "Delete set",
      danger: true,
      // An auto-assigning set reaches every new joiner: its name is typed before it goes.
      typeToConfirm: set.assign_new_members === 1 ? set.name : undefined,
    });
    if (answer !== true) return;
    const r = await send(`delete-${set.id}`, "DELETE", `${SETS_URL}/${set.id}`, undefined, "Couldn't delete the set.");
    if (!r) return;
    toast("ok", "Set deleted.");
    await load();
    focusNewSet();
  }

  if (!data) {
    return <PortalFallback licensed={licensed} canManageLicense={canManageLicense} portal={{ data: null, loadError, load }} />;
  }
  const { rows, candidates } = data;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-sm text-slate-500">{SET_PAGE_INTRO}</p>
        {canManage && !creating && (
          <button ref={newSetRef} type="button" onClick={() => setCreating(true)} className={buttonClass("primary")}>
            <Plus className="h-4 w-4" aria-hidden /> New set
          </button>
        )}
      </div>

      {creating && (
        <SetForm
          title="New set"
          submitLabel="Create set"
          initial={{ name: "", description: "", doc_ids: [], assign_new_members: true }}
          candidates={candidates}
          busy={busy}
          onCancel={() => {
            setCreating(false);
            focusNewSet();
          }}
          onSubmit={create}
          className="mb-4"
        />
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={<Layers />}
          title="No sets yet"
          body="Create one for onboarding or the annual cycle."
          action={canManage && !creating ? { onClick: () => setCreating(true), label: "New set", icon: <Plus /> } : undefined}
        />
      ) : (
        <div className="space-y-4">
          {rows.map((set) => (
            <SetCard
              key={set.id}
              set={set}
              candidates={candidates}
              canManage={canManage}
              peopleOpts={peopleOpts}
              groupOpts={groupOpts}
              busy={busy}
              onUpdate={(patch) => update(set, patch)}
              onAssign={(target) => assign(set, target)}
              onToggleActive={() => (set.active === 1 ? deactivate(set) : activate(set))}
              onDelete={() => remove(set)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// --- One set ---------------------------------------------------------------------

function SetCard({
  set,
  candidates,
  canManage,
  peopleOpts,
  groupOpts,
  busy,
  onUpdate,
  onAssign,
  onToggleActive,
  onDelete,
}: {
  set: PolicySetRow;
  candidates: Candidate[];
  canManage: boolean;
  peopleOpts: PickerOption[];
  groupOpts: PickerOption[];
  busy: boolean;
  onUpdate: (patch: PolicySetPatch) => Promise<boolean>;
  onAssign: (target: PolicySetTarget) => Promise<boolean>;
  onToggleActive: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const active = set.active === 1;

  /** Only what changed: an empty patch sends nothing (the route would answer "Nothing to change."). */
  async function save(input: PolicySetInput): Promise<boolean> {
    const patch: PolicySetPatch = {};
    if (input.name !== set.name) patch.name = input.name;
    if (input.description !== set.description) patch.description = input.description;
    const current = set.docs.map((d) => d.id);
    if (input.doc_ids.length !== current.length || input.doc_ids.some((id, i) => id !== current[i])) patch.doc_ids = input.doc_ids;
    if (input.assign_new_members !== (set.assign_new_members === 1)) patch.assign_new_members = input.assign_new_members;
    const ok = await onUpdate(patch);
    if (ok) setEditing(false);
    return ok;
  }

  return (
    <Card padding="p-4" id={`set-${set.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="min-w-0">
              <span className="min-w-0 truncate">{set.name}</span>
            </CardTitle>
            {!active && <span className={chipClass("neutral", "sm")}>Inactive</span>}
            {active && set.assign_new_members === 1 && <span className={chipClass("info", "sm")}>Auto-assign</span>}
          </div>
          {set.description && <p className="mt-0.5 text-xs text-slate-500">{set.description}</p>}
          {/* "87% · 6 overdue", or "Nobody asked yet": the standing over the members' open rows. */}
          <p className="mt-1 text-sm text-slate-700">
            <span className="sr-only">Progress: </span>
            {progressText(set.progress)}
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={`Policies in ${set.name}, in order`}>
            {set.docs.map((d) => (
              <li key={d.id}>
                {d.ack_required === 1 ? (
                  <span className={chipClass("neutral", "sm")}>
                    {d.position + 1}. {d.title}
                  </span>
                ) : (
                  // A member not yet asking anyone: assigning the set switches it on (the modal says so too).
                  <span
                    className={chipClass("neutral", "sm")}
                    data-tt="Not yet requiring confirmation. Assigning the set switches it on."
                    tabIndex={0}
                  >
                    {d.position + 1}. {d.title}
                    <span className="sr-only">, not yet requiring confirmation</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            {active && (
              <Button size="sm" icon={<Send />} disabled={busy} onClick={() => setAssigning(true)}>
                Assign
              </Button>
            )}
            <Button size="sm" variant="secondary" icon={<Pencil />} disabled={busy} onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
              Edit
            </Button>
            {/* One button for both directions, so the control that was pressed survives the reload. */}
            <Button size="sm" variant="secondary" disabled={busy} onClick={onToggleActive}>
              {active ? "Deactivate" : "Activate"}
            </Button>
            <Button size="sm" variant="danger" icon={<Trash2 />} disabled={busy} onClick={onDelete}>
              Delete
            </Button>
          </div>
        )}
      </div>

      {editing && (
        <SetForm
          title={`Edit "${set.name}"`}
          submitLabel="Save changes"
          initial={{
            name: set.name,
            description: set.description,
            doc_ids: set.docs.map((d) => d.id),
            assign_new_members: set.assign_new_members === 1,
          }}
          candidates={candidates}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSubmit={save}
          className="mt-4"
          nested
        />
      )}

      {canManage && (
        <AssignModal
          set={set}
          open={assigning}
          onClose={() => setAssigning(false)}
          peopleOpts={peopleOpts}
          groupOpts={groupOpts}
          busy={busy}
          onAssign={async (target) => {
            const ok = await onAssign(target);
            if (ok) setAssigning(false);
          }}
        />
      )}
    </Card>
  );
}

// --- The create / edit form ---------------------------------------------------------

function SetForm({
  title,
  submitLabel,
  initial,
  candidates,
  busy,
  onCancel,
  onSubmit,
  className = "",
  nested = false,
}: {
  title: string;
  submitLabel: string;
  initial: PolicySetInput;
  candidates: Candidate[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: PolicySetInput) => Promise<boolean>;
  className?: string;
  /** Inside a set's card: a bordered block, not a second card. */
  nested?: boolean;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [docIds, setDocIds] = useState<number[]>(initial.doc_ids);
  const [auto, setAuto] = useState(initial.assign_new_members);
  const [tried, setTried] = useState(false);
  const helpId = useId();
  const byId = new Map(candidates.map((c) => [c.id, c]));

  // The search box offers what is not in the set yet; the list under it is
  // the set in order (the Section order recipe, STYLEGUIDE §Settings pages).
  const options: PickerOption[] = candidates
    .filter((c) => !docIds.includes(c.id))
    .map((c) => ({ id: c.id, label: c.title, sublabel: `${c.space_icon} ${c.space_name}` }));
  const normalised = normaliseSetName(name);
  const nameError = tried && (!normalised || normalised.length > SET_NAME_MAX) ? SET_NAME_REQUIRED : undefined;
  const docsError = tried && docIds.length === 0 ? DOCS_REQUIRED : docIds.length > SET_DOCS_MAX ? DOCS_TOO_MANY : undefined;

  function submit() {
    setTried(true);
    if (!normalised || normalised.length > SET_NAME_MAX || docIds.length === 0 || docIds.length > SET_DOCS_MAX) return;
    void onSubmit({ name: normalised, description: description.trim(), doc_ids: docIds, assign_new_members: auto });
  }

  const body = (
    <>
      <div className="space-y-3">
        <Field label="Set name" error={nameError} size="md">
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={SET_NAME_PLACEHOLDER}
            maxLength={SET_NAME_MAX}
            autoComplete="off"
            data-autofocus=""
          />
        </Field>
        <Field label="Description (optional)" size="lg">
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {/* A fieldset, not a Field: a Field's label would hand a click on any row's text to the first button. */}
        <fieldset aria-describedby={helpId}>
          <legend className="mb-1 block text-xs font-medium text-slate-500">Policies, in order</legend>
          <EntityPicker
            options={options}
            onPick={(id) => setDocIds((ids) => (ids.includes(id) ? ids : [...ids, id]))}
            label="Add policies"
            placeholder={SET_PICKER_PLACEHOLDER}
            emptyText="No published documents match."
            maxVisible={10}
          />
          {docIds.length > 0 && (
            <div className="mt-2">
              <OrderedKeyList
                value={docIds.map(String)}
                onChange={(next) => setDocIds(next.map(Number))}
                available={docIds.map((id, i) => ({ key: String(id), label: `${i + 1}. ${byId.get(id)?.title ?? `Document #${id}`}` }))}
                minimum={0}
                extra={(key) => {
                  const c = byId.get(Number(key));
                  if (!c) return null;
                  return (
                    <span className="text-2xs text-slate-500">
                      {c.space_icon} {c.space_name}
                      {c.ack_required === 0 ? " · not yet required" : ""}
                    </span>
                  );
                }}
              />
            </div>
          )}
          <p id={helpId} role={docsError ? "alert" : undefined} className={docsError ? "mt-1 text-xs text-red-600" : "mt-1 text-xs text-slate-500"}>
            {docsError ?? "Published documents only. A policy not yet requiring confirmation is switched on when the set is assigned."}
          </p>
        </fieldset>
        <Toggle
          label={SET_AUTO_ASSIGN_LABEL}
          help="Every new account is asked to confirm these policies on day one."
          checked={auto}
          onChange={setAuto}
        />
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button busy={busy} onClick={submit}>
          {submitLabel}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </>
  );

  if (nested) {
    return (
      <div className={`rounded-lg border border-slate-200 p-4 ${className}`.trim()}>
        <CardTitle as="h3" className="mb-3">
          {title}
        </CardTitle>
        {body}
      </div>
    );
  }
  return (
    <Card id="new-set" title={title} className={className}>
      {body}
    </Card>
  );
}

// --- The Assign modal ----------------------------------------------------------------

function AssignModal({
  set,
  open,
  onClose,
  peopleOpts,
  groupOpts,
  busy,
  onAssign,
}: {
  set: PolicySetRow;
  open: boolean;
  onClose: () => void;
  peopleOpts: PickerOption[];
  groupOpts: PickerOption[];
  busy: boolean;
  onAssign: (target: PolicySetTarget) => Promise<void>;
}) {
  const titleId = useId();
  const [userIds, setUserIds] = useState<number[]>([]);
  const [groupIds, setGroupIds] = useState<number[]>([]);
  // The members already asking everyone who can see their space: a set never
  // narrows them, and the line says so before anything is sent. Read from
  // each required member's own settings when the modal opens (the portal's
  // rows carry no audience mode); a member that cannot be read is left out,
  // and the answer's not_narrowed is the truth for the toast.
  const [spaceMode, setSpaceMode] = useState<string[]>([]);
  const switchedOn = set.docs.filter((d) => d.ack_required === 0).map((d) => d.title);

  useEffect(() => {
    if (!open) return;
    setUserIds([]);
    setGroupIds([]);
    setSpaceMode([]);
    let cancelled = false;
    const required = set.docs.filter((d) => d.ack_required === 1);
    void Promise.all(
      required.map(async (d) => {
        try {
          const res = await fetch(`/api/documents/${d.id}/ack-settings`);
          if (!res.ok) return null;
          const a = (await res.json().catch(() => ({}))) as { audience_mode?: string };
          return a?.audience_mode === "space" ? d.title : null;
        } catch {
          return null;
        }
      })
    ).then((titles) => {
      if (!cancelled) setSpaceMode(titles.filter((t): t is string => t !== null));
    });
    return () => {
      cancelled = true;
    };
    // The members are re-read when the modal opens for this set; a reload
    // while it is open does not restart the probe.
  }, [open, set.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function everyone() {
    const answer = await confirmDialog({
      title: assignEveryoneConfirm(set.name, set.docs.length),
      body: "Everyone who can see each policy's space is asked to confirm it, and the set's policies stop being targeted at named people and groups.",
      confirmLabel: SET_ASSIGN_EVERYONE,
    });
    if (answer !== true) return;
    await onAssign({ user_ids: [], group_ids: [], everyone: true });
  }

  const n = set.docs.length;
  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      className="w-full max-w-lg rounded-xl border border-slate-200 bg-surface p-5 shadow-modal"
    >
      <h2 id={titleId} className="text-base font-semibold text-slate-900">
        Assign &ldquo;{set.name}&rdquo;
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        {n} {policyNoun(n)}, in order, to the people and groups you name, or to everyone.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <EntityPicker
          options={peopleOpts}
          value={userIds}
          onChange={setUserIds}
          label="Add people"
          placeholder={SET_ASSIGN_PEOPLE_PLACEHOLDER}
          emptyText="No people match."
        />
        <EntityPicker
          options={groupOpts}
          value={groupIds}
          onChange={setGroupIds}
          label="Add groups"
          placeholder={SET_ASSIGN_GROUPS_PLACEHOLDER}
          emptyText="No groups match."
        />
      </div>
      {(switchedOn.length > 0 || spaceMode.length > 0) && (
        <ul className="mt-4 space-y-1 text-sm text-slate-600">
          {switchedOn.length > 0 && (
            <li>
              {switchedOnLine(switchedOn.length)}: {switchedOn.join(", ")}
            </li>
          )}
          {spaceMode.length > 0 && (
            <li>
              {notNarrowedLine(spaceMode.length)}: {spaceMode.join(", ")}
            </li>
          )}
        </ul>
      )}
      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => void everyone()}>
          {SET_ASSIGN_EVERYONE}
        </Button>
        <Button
          icon={<Send />}
          busy={busy}
          disabled={userIds.length === 0 && groupIds.length === 0}
          onClick={() => void onAssign({ user_ids: userIds, group_ids: groupIds, everyone: false })}
        >
          {SET_ASSIGN_PRIMARY}
        </Button>
      </div>
    </Modal>
  );
}
