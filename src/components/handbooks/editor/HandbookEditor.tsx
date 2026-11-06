"use client";

// The handbook editor (1.18.0, mock-ups 1-editor and 7-where-found):
// /handbooks/new and /handbooks/[id]/edit. The page header carries the
// handbook's title, its status chip and the named status actions (Preview,
// Publish handbook / Unpublish; STYLEGUIDE §Status chips: status is shown,
// changing it is an action); under it the Details and Contents cards beside
// the sticky "Add documents" panel, one SaveRow for the whole page (the
// editor's explicit-save pattern, Ctrl/⌘+S included, with the leave guard)
// and the danger zone's Delete.
//
// A new handbook has no id for the candidate search to scope by, so
// /handbooks/new shows the Details card alone and "Create handbook" takes
// you to the full editor. Save sends what changed, in order: the details
// (PATCH), the contents wholesale (PUT …/contents), then each "Where people
// find it" that changed (stored on the document, so per item). Every write
// is audited by the routes behind it.
//
// The details and the contents are conditional saves: each sends the
// handbook's updated_at as this page last saw it (loaded, or answered by
// the previous write, publishing included), and takes the new one from the
// answer. When someone else saved in between, the route refuses with 409
// and writes nothing: the page keeps every unsaved edit and says so in a
// FormError with a Reload action, inside the Save row (pinned while the
// page is dirty, so it is on screen wherever Save was pressed), and Reload
// asks before it discards them.
//
// A handbook holding documents from spaces this editor can't add from shows
// them as locked placeholders in Contents (HandbookItem.restricted), and the
// routes refuse to publish it, or to change who reads or owns it, with 403
// (HANDBOOK_FOREIGN_CONTENTS). That refusal is about the Details card's
// fields and the Publish action, so it is a FormError at the foot of the
// Details card (scrolled into view), on a Save and on Publish alike, never a
// toast; the page keeps its edits.

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, Eye, RefreshCw, Send, Undo2 } from "lucide-react";
import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { confirmDialog } from "@/components/Dialog";
import { DangerAction, DangerZone, FormError } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { SaveRow } from "@/components/SaveRow";
import { toast } from "@/components/Toasts";
import type { Handbook, HandbookCandidate, HandbookOptions } from "@/lib/handbooks";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import * as api from "./api";
import { AddPoliciesPanel } from "./AddPoliciesPanel";
import { ContentsCard } from "./ContentsCard";
import { DetailsCard } from "./DetailsCard";
import {
  addItem,
  addSection,
  contentsPayload,
  withSectionIds,
  detailsErrors,
  detailsFromHandbook,
  detailsPayload,
  findModeChanges,
  itemCount,
  itemFromCandidate,
  moveItem,
  removeItem,
  removeSection,
  renameSection,
  sectionsFromHandbook,
  setFindMode,
  type DraftDetails,
  type DraftSection,
  draftTypeCounts,
  itemsNoun,
} from "./model";
import { handbookKind, kindNoun } from "@/lib/handbook-shared";

/** What Save compares against: the form's values as they would be sent. */
function snapshotOf(details: DraftDetails, sections: DraftSection[]): string {
  return JSON.stringify([
    detailsPayload(details),
    contentsPayload(sections).sections.map((s) => [s.title, s.doc_ids]),
    sections.flatMap((s) => s.items.map((i) => [i.doc_id, i.find_mode])),
  ]);
}

const SUBTITLE = "Pick the policies and SOPs that make up this handbook, put them in order and group them into sections.";
const NEW_SUBTITLE = "Name the handbook and choose who owns and reads it. You add its policies and SOPs next.";

export function HandbookEditor({
  initial,
  options,
}: {
  /** null on /handbooks/new. */
  initial: Handbook | null;
  options: HandbookOptions;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState<Handbook | null>(initial);
  const defaultOwner = options.can_create_workspace || options.spaces.length === 0 ? "" : String(options.spaces[0].id);
  const [details, setDetails] = useState<DraftDetails>(() => detailsFromHandbook(initial, defaultOwner));
  const [sections, setSections] = useState<DraftSection[]>(() => sectionsFromHandbook(initial));
  const [busy, setBusy] = useState<"" | "save" | "publish" | "unpublish" | "delete">("");
  const [tried, setTried] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const introRef = useRef<HTMLTextAreaElement>(null);
  const groupsRef = useRef<HTMLDivElement>(null);
  /** The handbook's updated_at as last loaded or written: the if_updated_at a save sends. */
  const lastSeen = useRef<string | undefined>(initial?.updated_at);
  /** The 409 sentence once someone else saved in between; the page keeps its edits. */
  const [conflict, setConflict] = useState<string | null>(null);
  /** The 403 for foreign contents (a save of who reads or owns it, or Publish): the Details card's FormError. */
  const [refusal, setRefusal] = useState<string | null>(null);

  const snapshot = useMemo(() => snapshotOf(details, sections), [details, sections]);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(snapshot);
  useLeaveGuard(dirty, hasUnsavedChanges);

  const errors = detailsErrors(details);
  const shownErrors = tried ? errors : {};
  const isNew = saved === null;
  const published = saved?.status === "published";
  const working = busy !== "";
  const spaceHandbook = details.owner !== "";

  function editDetails(patch: Partial<DraftDetails>) {
    markDirty();
    setDetails((d) => ({ ...d, ...patch }));
  }
  function editSections(fn: (s: DraftSection[]) => DraftSection[]) {
    markDirty();
    setSections(fn);
  }

  /** Back to "nothing unsaved", from what the server now holds. */
  function adopt(h: Handbook) {
    lastSeen.current = h.updated_at;
    const nextDetails = detailsFromHandbook(h, defaultOwner);
    const nextSections = sectionsFromHandbook(h);
    markClean(snapshotOf(nextDetails, nextSections));
    setSaved(h);
    setDetails(nextDetails);
    setSections(nextSections);
  }

  function invalid(): boolean {
    setTried(true);
    if (Object.keys(errors).length === 0) return false;
    // The errors are inline and announced (Field's role="alert"); the first
    // one's control, in the card's order, takes focus, which also brings it
    // into view: the title, the introduction, then the groups picker's box.
    if (errors.title) titleRef.current?.focus();
    else if (errors.introduction) introRef.current?.focus();
    else if (errors.groups) groupsRef.current?.querySelector<HTMLInputElement>("input:not([type=hidden])")?.focus();
    else document.getElementById("handbook-details")?.scrollIntoView({ block: "start" });
    return true;
  }

  async function create() {
    if (invalid()) return;
    setBusy("save");
    const res = await api.createHandbook(detailsPayload(details));
    if (!res.ok) {
      setBusy("");
      toast("error", res.error);
      return;
    }
    markClean();
    toast("ok", "Handbook created. Add its policies and SOPs next.");
    router.replace(`/handbooks/${res.value.handbook.id}/edit`);
  }

  /** Every changed part, in order. Resolves to the handbook as saved, or null after a toasted refusal. */
  async function persist(): Promise<Handbook | null> {
    if (!saved) return null;
    setConflict(null);
    setRefusal(null);
    let latest: Handbook = saved;
    const before = detailsPayload(detailsFromHandbook(saved, defaultOwner));
    const now = detailsPayload(details);
    if (JSON.stringify(before) !== JSON.stringify(now)) {
      const r = await api.updateDetails(saved.id, now, lastSeen.current);
      if (!r.ok) return fail(r, latest);
      latest = r.value.handbook;
      lastSeen.current = r.value.updated_at;
    }
    const contentsBefore = JSON.stringify(contentsPayload(sectionsFromHandbook(saved)));
    const contentsNow = contentsPayload(sections);
    if (JSON.stringify(contentsNow) !== contentsBefore) {
      const r = await api.saveContents(saved.id, contentsNow, lastSeen.current);
      if (!r.ok) return fail(r, latest);
      latest = r.value.handbook;
      lastSeen.current = r.value.updated_at;
      // The sections the PUT created now have ids: take them onto the page,
      // so a Save after a later step's refusal compares like with like and
      // does not send the contents again (or make those sections twice).
      setSections((cur) => withSectionIds(cur, latest));
    }
    // Stored on the document, so it leaves the handbook's updated_at (the
    // token) where the last save put it.
    for (const change of findModeChanges(latest, sections)) {
      const r = await api.saveFindMode(saved.id, change.doc_id, change.mode);
      if (!r.ok) return fail(r, latest);
      latest = r.value.handbook;
    }
    return latest;
  }

  /**
   * A refusal part-way through: the parts already accepted become the
   * comparison base for the next Save (so they are not sent twice), and the
   * page stays dirty with everything still on it. A conflict (someone else
   * saved in between) is the FormError in the Save row instead of a toast.
   */
  function fail(r: api.Refusal & { conflict?: true }, latest: Handbook): null {
    // A conflict is the whole form's refusal, and foreign contents the
    // Details card's: each FormError announces itself (an alert), so no
    // toast says it a second time.
    if (r.conflict) setConflict(r.error);
    else if (r.foreign) setRefusal(r.error);
    else toast("error", r.error);
    setSaved(latest);
    return null;
  }

  /** Loads the handbook as it is now; asks first when that would discard edits. */
  async function reload() {
    if (hasUnsavedChanges()) {
      const ok = await confirmDialog({
        title: "Reload and discard your changes?",
        body: "The page loads the handbook as it is now, with the other changes. What you changed here and have not saved is lost, so copy anything you want to keep first.",
        confirmLabel: "Reload and discard",
        danger: true,
      });
      if (ok !== true) return;
      markClean();
    }
    window.location.reload();
  }

  async function save() {
    if (!saved || working) return;
    if (invalid()) return;
    setBusy("save");
    const h = await persist();
    setBusy("");
    if (!h) return;
    adopt(h);
    toast("ok", "Handbook saved.");
    router.refresh();
  }

  async function publish() {
    if (!saved || working) return;
    if (invalid()) return;
    if (itemCount(sections) === 0) {
      toast("error", "Add at least one document before publishing.");
      return;
    }
    setBusy("publish");
    setRefusal(null);
    const h = dirty ? await persist() : saved;
    if (!h) {
      setBusy("");
      return;
    }
    const r = await api.setPublished(h.id, true);
    setBusy("");
    if (!r.ok) {
      adopt(h);
      if (r.foreign) setRefusal(r.error);
      else toast("error", r.error);
      return;
    }
    adopt(r.value.handbook); // publishing moves updated_at: the next save's token
    toast("ok", "Handbook published.");
    router.refresh();
  }

  async function unpublish() {
    if (!saved || working) return;
    const ok = await confirmDialog({
      title: "Unpublish this handbook?",
      body: `Readers lose access to it until it is published again, and its Handbook only ${itemsNoun(sections)} are listed in their spaces meanwhile. Confirmations are kept.`,
      confirmLabel: "Unpublish",
      danger: true,
    });
    if (ok !== true) return;
    setBusy("unpublish");
    const r = await api.setPublished(saved.id, false);
    setBusy("");
    if (!r.ok) {
      toast("error", r.error);
      return;
    }
    // Unpublishing changes the status only; unsaved edits stay on the page.
    // It moves updated_at, though, so the next save sends the new one.
    lastSeen.current = r.value.handbook.updated_at;
    setSaved(r.value.handbook);
    toast("ok", "Handbook unpublished.");
    router.refresh();
  }

  async function remove() {
    if (!saved || working) return;
    const ok = await confirmDialog({
      title: `Delete "${saved.title}"?`,
      body: `The handbook and its sections go. The ${itemsNoun(sections)} in it stay in their spaces, with their own confirmations, and are listed there again. This cannot be undone.`,
      confirmLabel: "Delete handbook",
      danger: true,
      typeToConfirm: published ? saved.title : undefined,
    });
    if (ok !== true) return;
    setBusy("delete");
    const r = await api.deleteHandbook(saved.id);
    if (!r.ok) {
      setBusy("");
      toast("error", r.error);
      return;
    }
    markClean();
    toast("ok", "Handbook deleted.");
    router.push("/handbooks");
  }

  function toggleCandidate(c: HandbookCandidate, on: boolean) {
    editSections((s) => (on ? addItem(s, itemFromCandidate(c)) : removeItem(s, c.id)));
  }

  const title = isNew ? "New handbook" : saved.title || "Untitled handbook";

  return (
    <>
      <PageHeader
        icon={<BookOpen />}
        back={{ href: "/handbooks", label: "Handbooks" }}
        title={<span className="[overflow-wrap:anywhere]">{title}</span>}
        subtitle={isNew ? NEW_SUBTITLE : SUBTITLE}
        actions={
          isNew ? null : (
            <>
              {/* print:hidden on each, as the header slot asks (§Page skeleton). */}
              <Chip tone={published ? "ok" : "neutral"} className="print:hidden">
                {published ? "Published" : "Draft"}
              </Chip>
              <Button
                variant="secondary"
                icon={<Eye />}
                href={`/handbooks/${saved.id}`}
                target="_blank"
                rel="noopener"
                className="print:hidden"
              >
                Preview
              </Button>
              {published ? (
                <Button
                  variant="secondary"
                  icon={<Undo2 />}
                  busy={busy === "unpublish"}
                  disabled={working}
                  onClick={unpublish}
                  className="print:hidden"
                >
                  Unpublish
                </Button>
              ) : (
                <Button icon={<Send />} busy={busy === "publish"} disabled={working} onClick={publish} className="print:hidden">
                  Publish handbook
                </Button>
              )}
            </>
          )
        }
      />

      {isNew ? (
        <div className="space-y-6">
          <DetailsCard details={details} options={options} errors={shownErrors} disabled={working} onChange={editDetails} titleRef={titleRef} introRef={introRef} groupsRef={groupsRef} />
          <div className="flex flex-wrap items-center gap-3">
            <Button busy={busy === "save"} onClick={create}>
              Create handbook
            </Button>
            <Button variant="secondary" href="/handbooks">
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="flex min-w-0 flex-col gap-6">
              <DetailsCard
                details={details}
                options={options}
                errors={shownErrors}
                refusal={refusal}
                disabled={working}
                onChange={editDetails}
                titleRef={titleRef}
                introRef={introRef}
                groupsRef={groupsRef}
                itemNoun={kindNoun(handbookKind(draftTypeCounts(sections)))}
              />
              <ContentsCard
                sections={sections}
                published={published}
                disabled={working}
                emptyHint="No documents yet. Tick them in Add documents to put them here."
                onAddSection={(t) => editSections((s) => addSection(s, t))}
                onRenameSection={(key, t) => editSections((s) => renameSection(s, key, t))}
                onRemoveSection={(key) => editSections((s) => removeSection(s, key))}
                onMove={(doc, dir) => editSections((s) => moveItem(s, doc, dir))}
                onRemove={(doc) => editSections((s) => removeItem(s, doc))}
                onFindMode={(doc, mode) => editSections((s) => setFindMode(s, doc, mode))}
              />
            </div>
            <AddPoliciesPanel
              handbookId={saved.id}
              sections={sections}
              spaces={spaceHandbook ? options.spaces : options.visible_spaces}
              spaceHandbook={spaceHandbook}
              disabled={working}
              onToggle={toggleCandidate}
            />
          </div>

          <SaveRow dirty={dirty} busy={busy === "save"} onSave={save} disabled={working && busy !== "save"} className="mt-6">
            {/* order-first basis-full: its own line, above Save, in the pinned row. */}
            <FormError className="order-first flex basis-full flex-wrap items-center gap-x-4 gap-y-2 print:hidden">
              {conflict && (
                <>
                  <p className="min-w-0 flex-1">{conflict} Your changes stay on this page until you do.</p>
                  <Button variant="secondary" size="sm" icon={<RefreshCw />} onClick={() => void reload()}>
                    Reload
                  </Button>
                </>
              )}
            </FormError>
          </SaveRow>

          <div className="mt-10">
            <DangerZone>
              <DangerAction label="Delete handbook" description={`The ${itemsNoun(sections)} stay in their spaces. This cannot be undone.`}>
                <Button variant="danger" busy={busy === "delete"} disabled={working} onClick={remove}>
                  Delete handbook
                </Button>
              </DangerAction>
            </DangerZone>
          </div>
        </>
      )}
    </>
  );
}
