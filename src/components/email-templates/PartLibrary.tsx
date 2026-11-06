"use client";

// A library tab (1.19.0, STYLEGUIDE §Email templates in parts): the
// headers, bodies, signatures or footers every email is composed from. A
// two-pane layout (the export presets' recipe): the list on the left, the
// selected part's editor on the right with a live preview of the part
// inside the default other parts, and one SaveRow below.
//
// The editor: name, subject (bodies), content as markdown in a textarea
// with an Insert tag menu of the tags this kind may use (a body adds its
// event's; a textarea keeps the stored markdown byte for byte),
// "Used by N templates" (opens the list, each a link to its composer),
// Set as default (headers, signatures, footers), Reset to original
// (built-ins that were edited) and Delete (disabled, with the reason beside
// it, for a built-in, the default or a part a template uses).
//
// The address carries the selection: ?part=<id>, ?new=1 (&event=<key> for
// a body), and ?from=<composer address> when the composer sent the admin
// here, which puts a back link above the panes.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Braces, Mail, RotateCcw, Star, Trash2 } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { chipClass } from "@/components/Chip";
import { BackLink } from "@/components/BackLink";
import { CardTitle } from "@/components/Heading";
import { Field, FormError, Select, TextInput } from "@/components/form";
import { Popover } from "@/components/Popover";
import { SaveRow } from "@/components/SaveRow";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges, LEAVE_PROMPT } from "@/lib/use-unsaved";
import { EmailPreview } from "./EmailPreview";
import { PartList, bodyGroups, defaultLabel, usedLabel } from "./PartList";
import { MarkdownWithTags } from "./MarkdownWithTags";
import { partsApi, previewApi } from "./api";
import { KIND_LABEL, SCOPE_ALL, eventHref, libraryHref, scopeTeamId } from "./types";
import type { EmailPartKind, EventInfo, PartWithUsage, Surface, TagDef, TeamOption } from "./types";

/** Limits the routes enforce (lib/email-parts), checked here first. */
const NAME_MAX = 120;
const SUBJECT_MAX = 300;
const CONTENT_MAX: Record<EmailPartKind, number> = { header: 5000, body: 20000, signature: 5000, footer: 5000 };

interface Draft {
  name: string;
  subject: string;
  content: string;
  event: string;
}

function draftOf(p: PartWithUsage | undefined, kind: EmailPartKind, event: string): Draft {
  if (!p) return { name: "", subject: "", content: "", event };
  return { name: p.name, subject: p.subject, content: p.content, event: p.event_key ?? event };
}

function problems(d: Draft, kind: EmailPartKind): Partial<Record<"name" | "subject" | "content" | "event", string>> {
  const out: Partial<Record<"name" | "subject" | "content" | "event", string>> = {};
  if (!d.name.trim()) out.name = "Give the part a name.";
  else if (d.name.trim().length > NAME_MAX) out.name = `At most ${NAME_MAX} characters.`;
  if (kind === "body") {
    if (!d.event) out.event = "Choose the email this body is for.";
    if (!d.subject.trim()) out.subject = "A body needs a subject.";
    else if (d.subject.length > SUBJECT_MAX) out.subject = `At most ${SUBJECT_MAX} characters.`;
    if (!d.content.trim()) out.content = "A body can't be empty.";
  }
  if (d.content.length > CONTENT_MAX[kind]) out.content = `At most ${CONTENT_MAX[kind].toLocaleString("en-US")} characters.`;
  return out;
}

export function PartLibrary({
  surface,
  kind,
  parts: initialParts,
  events,
  teams,
  tags,
  tagsByEvent,
  initialPart,
  initialNew,
  initialEvent,
  from,
  canEdit,
}: {
  /** Template managers; everyone else sees the library read-only. */
  canEdit: boolean;
  surface: Surface;
  kind: EmailPartKind;
  parts: PartWithUsage[];
  events: EventInfo[];
  teams: TeamOption[];
  tags: TagDef[];
  tagsByEvent: Record<string, TagDef[]>;
  initialPart: number | null;
  initialNew: boolean;
  initialEvent: string | null;
  /** The composer that sent the admin here (a same-origin path). */
  from: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const label = KIND_LABEL[kind];
  const lower = label.toLowerCase();
  const [parts, setParts] = useState(initialParts);
  const listed = kind === "body" ? bodyGroups(initialParts, events).flatMap((g) => g.parts) : initialParts;
  const firstId =
    initialParts.find((p) => p.id === initialPart)?.id ??
    (kind === "body" && initialEvent ? initialParts.find((p) => p.event_key === initialEvent)?.id : undefined) ??
    listed[0]?.id ??
    null;
  const [creating, setCreating] = useState(canEdit && (initialNew || initialParts.length === 0));
  const [selected, setSelected] = useState<number | null>(firstId);
  const part = creating ? undefined : parts.find((p) => p.id === selected);
  const defaultEvent = initialEvent && events.some((e) => e.key === initialEvent) ? initialEvent : kind === "body" ? "" : events[0]?.key ?? "";
  const [draft, setDraft] = useState<Draft>(() => draftOf(part, kind, defaultEvent));
  const [previewEvent, setPreviewEvent] = useState<string>(() => part?.used_by[0]?.event_key ?? events[0]?.key ?? "");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [usedOpen, setUsedOpen] = useState(false);
  const usedRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const snapshot = JSON.stringify([creating, selected, draft]);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(snapshot);
  useLeaveGuard(dirty, hasUnsavedChanges);
  const errs = problems(draft, kind);
  const shownErrs = tried ? errs : {};

  // The address follows the selection, so a reload or a shared link opens the same part.
  function syncUrl(next: { part?: number | null; creating?: boolean }) {
    const p = new URLSearchParams();
    if (next.creating) p.set("new", "1");
    else if (next.part) p.set("part", String(next.part));
    if (from) p.set("from", from);
    const qs = p.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  }

  function select(id: number) {
    if (id === selected && !creating) return;
    if (hasUnsavedChanges() && !window.confirm(LEAVE_PROMPT)) return;
    const p = parts.find((x) => x.id === id);
    const d = draftOf(p, kind, defaultEvent);
    setCreating(false);
    setSelected(id);
    setDraft(d);
    setTried(false);
    setFormError(null);
    if (p?.used_by[0]) setPreviewEvent(p.used_by[0].event_key);
    markClean(JSON.stringify([false, id, d]));
    syncUrl({ part: id });
  }

  function startNew() {
    if (hasUnsavedChanges() && !window.confirm(LEAVE_PROMPT)) return;
    const d = draftOf(undefined, kind, defaultEvent);
    setCreating(true);
    setDraft(d);
    setTried(false);
    setFormError(null);
    markClean(JSON.stringify([true, selected, d]));
    syncUrl({ creating: true });
    requestAnimationFrame(() => nameRef.current?.focus());
  }

  function edit<K extends keyof Draft>(key: K, value: Draft[K]) {
    markDirty();
    setDraft((d) => ({ ...d, [key]: value }));
  }

  // A body previews in its own event; the others in the event chosen under the preview.
  const evKey = kind === "body" ? draft.event : previewEvent;
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(true);
  const seq = useRef(0);
  useEffect(() => {
    if (!evKey) {
      setPreview(null);
      setPreviewError(kind === "body" ? "Choose the email this body is for to preview it." : null);
      setRendering(false);
      return;
    }
    const n = ++seq.current;
    setRendering(true);
    const t = window.setTimeout(async () => {
      const r = await previewApi.render({
        event: evKey,
        scope: SCOPE_ALL,
        draft: { kind, subject: kind === "body" ? draft.subject : undefined, content: draft.content },
      });
      if (n !== seq.current) return;
      if (r.ok) {
        setPreview({ subject: r.data.subject, html: r.data.html });
        setPreviewError(null);
      } else setPreviewError(r.data.error || "The preview could not be rendered.");
      setRendering(false);
    }, 400);
    return () => window.clearTimeout(t);
  }, [evKey, kind, draft.subject, draft.content]);

  function replacePart(next: PartWithUsage) {
    setParts((all) => {
      const has = all.some((p) => p.id === next.id);
      return has
        ? all.map((p) => (p.id === next.id ? { ...next, used_by: next.used_by ?? p.used_by, default_for: next.default_for ?? p.default_for } : p))
        : [...all, { ...next, used_by: next.used_by ?? [] }];
    });
  }

  const save = useCallback(async () => {
    setTried(true);
    setFormError(null);
    if (Object.keys(problems(draft, kind)).length > 0) {
      requestAnimationFrame(() => (document.querySelector('[aria-invalid="true"]') as HTMLElement | null)?.focus());
      return;
    }
    setBusy(true);
    const body = { name: draft.name.trim(), content: draft.content, ...(kind === "body" ? { subject: draft.subject.trim() } : {}) };
    const r = creating
      ? await partsApi.create(kind, { ...body, event_key: kind === "body" ? draft.event : null })
      : await partsApi.update(selected!, body);
    setBusy(false);
    if (!r.ok || !r.data.part) {
      setFormError(r.data.error || `The ${lower} could not be saved.`);
      return;
    }
    const saved = { ...r.data.part, used_by: r.data.part.used_by ?? part?.used_by ?? [] };
    replacePart(saved);
    const d = draftOf(saved, kind, defaultEvent);
    setDraft(d);
    setCreating(false);
    setSelected(saved.id);
    setTried(false);
    markClean(JSON.stringify([false, saved.id, d]));
    syncUrl({ part: saved.id });
    toast("ok", creating ? `${label} created. Choose it in a template to use it.` : `${label} saved. Every email that uses it changes now.`);
    router.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, kind, creating, selected, part, label, lower, markClean, router]);

  async function makeDefault() {
    if (!part) return;
    setBusy(true);
    const r = await partsApi.makeDefault(part.id);
    setBusy(false);
    if (!r.ok) return toast("error", r.data.error || "Could not change the default.");
    setParts((all) => {
      const followers = all.find((p) => p.is_default)?.default_for ?? 0;
      return all.map((p) => ({ ...p, is_default: p.id === part.id, default_for: p.id === part.id ? followers : 0 }));
    });
    toast("ok", `${part.name} is now the default ${lower}. Templates that follow the default use it.`);
    router.refresh();
  }

  async function resetOriginal() {
    if (!part) return;
    const ok = await confirmDialog({
      title: `Reset ${part.name} to its original?`,
      body: `Your changes to this built-in ${lower} are replaced with what CompassDocs ships. Every email that uses it changes.`,
      confirmLabel: "Reset to original",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    const r = await partsApi.reset(part.id);
    setBusy(false);
    if (!r.ok || !r.data.part) return toast("error", r.data.error || "Could not reset the part.");
    const saved = { ...r.data.part, used_by: r.data.part.used_by ?? part.used_by };
    replacePart(saved);
    const d = draftOf(saved, kind, defaultEvent);
    setDraft(d);
    markClean(JSON.stringify([false, saved.id, d]));
    toast("ok", `${saved.name} is back to its original.`);
    router.refresh();
  }

  async function remove() {
    if (!part) return;
    const ok = await confirmDialog({
      title: `Delete ${part.name}?`,
      body: `The ${lower} is removed from the library. This can't be undone.`,
      confirmLabel: `Delete ${lower}`,
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    const r = await partsApi.remove(part.id);
    setBusy(false);
    if (!r.ok) {
      if (r.data.used_by) replacePart({ ...part, used_by: r.data.used_by });
      return toast("error", r.data.error || `The ${lower} could not be deleted.`);
    }
    const rest = parts.filter((p) => p.id !== part.id);
    setParts(rest);
    const next = rest[0];
    const d = draftOf(next, kind, defaultEvent);
    setSelected(next?.id ?? null);
    setCreating(!next);
    setDraft(d);
    markClean(JSON.stringify([!next, next?.id ?? null, d]));
    syncUrl(next ? { part: next.id } : { creating: true });
    toast("ok", `Deleted ${part.name}.`);
    router.refresh();
  }

  const deleteBlock = !part
    ? null
    : part.builtin
      ? `Built-in ${lower}s can't be deleted.${part.customized ? " Reset it to the original instead." : ""}`
      : part.is_default
        ? `This is the default ${lower}. Make another one the default first.`
        : part.used_by.length > 0
          ? `${usedLabel(part.used_by.length)}. Choose another ${lower} for them first.`
          : null;

  const teamName = (scope: string) => {
    const id = scopeTeamId(scope);
    return id == null ? "All teams" : teams.find((t) => t.id === id)?.name ?? "A team";
  };
  const eventLabel = (key: string) => events.find((e) => e.key === key)?.label ?? key;
  const tagMenu = kind === "body" ? (draft.event ? tagsByEvent[draft.event] ?? tags : tags) : tags;
  const backHref = from && from.startsWith(surface.base) ? from : null;
  const backEvent = backHref ? decodeURIComponent(/\/event\/([^/?]+)/.exec(backHref)?.[1] ?? "") : "";

  return (
    <div className="space-y-4">
      {backHref && <BackLink href={backHref} label={eventLabel(backEvent) || "Template"} className="" />}
      <div className="@container">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 @3xl:grid-cols-[16rem_minmax(0,1fr)] @6xl:grid-cols-[18rem_minmax(0,1fr)]">
          <PartList
            kind={kind}
            parts={parts}
            events={events}
            selected={selected}
            creating={creating}
            onSelect={select}
            onNew={canEdit ? startNew : undefined}
          />

          <div className="min-w-0 space-y-4">
            {/* The actions sit under the name, not flush right: a disabled
                Delete's reason is a sentence, and its tooltip needs room. */}
            <div className="space-y-2">
              <div className="min-w-0">
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 truncate">{creating ? `New ${lower}` : part?.name || label}</span>
                  {!creating && part?.is_default && kind !== "body" && <span className={chipClass("info", "sm")}>Default</span>}
                  {!creating && part?.builtin && <span className={chipClass("neutral", "sm")}>Built-in</span>}
                  {!creating && part?.builtin && part.customized && <span className={chipClass("warn", "sm")}>Edited</span>}
                </CardTitle>
                {!creating && part && defaultLabel(part.default_for) && (
                  <p className="mt-1 text-sm text-slate-500">
                    {defaultLabel(part.default_for)}: every email that doesn&apos;t choose another {lower} uses it.
                  </p>
                )}
                {!creating && part && part.used_by.length === 0 && !part.default_for && (
                  <p className="mt-1 text-sm text-slate-500">Not used by any template</p>
                )}
                {!creating && part && part.used_by.length > 0 && (
                  <div className="relative mt-1">
                    <button
                      ref={usedRef}
                      type="button"
                      className="link text-sm"
                      aria-expanded={usedOpen}
                      aria-haspopup="dialog"
                      onClick={() => setUsedOpen((o) => !o)}
                    >
                      {usedLabel(part.used_by.length)}
                    </button>
                    <Popover open={usedOpen} onClose={() => setUsedOpen(false)} triggerRef={usedRef} label={`Templates that use ${part.name}`} width="w-72" padding="p-2">
                      <ul role="list" className="space-y-0.5">
                        {part.used_by.map((u) => (
                          <li key={`${u.event_key}-${u.scope}-${u.slot}`}>
                            <Link
                              href={eventHref(surface, u.event_key, u.scope)}
                              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                            >
                              <Mail className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                              <span className="min-w-0 flex-1 truncate">{u.event_label || eventLabel(u.event_key)}</span>
                              {u.scope !== SCOPE_ALL && <span className={chipClass("neutral", "sm")}>{teamName(u.scope)}</span>}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </Popover>
                  </div>
                )}
              </div>
              {!creating && part && canEdit && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {kind !== "body" && !part.is_default && (
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<Star />}
                      onClick={makeDefault}
                      disabled={busy || dirty}
                      data-tt={dirty ? "Save your changes first" : `Every email that follows the default ${lower} uses this one`}
                      data-tt-wrap=""
                    >
                      Set as default
                    </Button>
                  )}
                  {part.builtin && part.customized && (
                    <Button variant="secondary" size="sm" icon={<RotateCcw />} onClick={resetOriginal} disabled={busy}>
                      Reset to original
                    </Button>
                  )}
                  {deleteBlock ? (
                    <>
                      <Button variant="danger" size="sm" icon={<Trash2 />} disabled aria-describedby="part-delete-why">
                        Delete
                      </Button>
                      <span id="part-delete-why" className="text-xs text-slate-500" data-testid="delete-reason">
                        {deleteBlock}
                      </span>
                    </>
                  ) : (
                    <Button variant="danger" size="sm" icon={<Trash2 />} onClick={remove} disabled={busy}>
                      Delete
                    </Button>
                  )}
                </div>
              )}
            </div>

            <div className="@container">
              <div className="grid grid-cols-[minmax(0,1fr)] gap-4 @4xl:grid-cols-2">
                <Card title="Content" description={contentHelp(kind)}>
                  <div className="space-y-4">
                    <Field label="Name" error={shownErrs.name} size="md" help="Shown in the pickers. Recipients never see it.">
                      <TextInput ref={nameRef} value={draft.name} maxLength={NAME_MAX + 20} readOnly={!canEdit} onChange={(e) => edit("name", e.target.value)} />
                    </Field>
                    {kind === "body" && creating && (
                      <Field label="Email" error={shownErrs.event} help="A body belongs to one email and can use that email's tags.">
                        <Select value={draft.event} onChange={(e) => edit("event", e.target.value)}>
                          <option value="">Choose an email…</option>
                          {events.map((e) => (
                            <option key={e.key} value={e.key}>
                              {e.area}: {e.label}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    )}
                    {kind === "body" && !creating && part?.event_key && (
                      <p className="text-sm text-slate-500">
                        For <span className="font-medium text-slate-700">{eventLabel(part.event_key)}</span>
                      </p>
                    )}
                    {kind === "body" && (
                      <Field label="Subject" error={shownErrs.subject}>
                        <TextInput value={draft.subject} readOnly={!canEdit} onChange={(e) => edit("subject", e.target.value)} />
                      </Field>
                    )}
                    <div>
                      <span className="mb-1 block text-xs font-medium text-slate-500" id={`content-label-${kind}`}>
                        Content
                      </span>
                      <div
                        className={canEdit ? "" : "rounded-xl border border-slate-200"}
                        role="group"
                        aria-labelledby={`content-label-${kind}`}
                        data-testid="part-content"
                      >
                        {canEdit ? (
                          <MarkdownWithTags
                            id={`content-${kind}`}
                            value={draft.content}
                            onChange={(v) => edit("content", v)}
                            tags={tagMenu}
                            rows={kind === "body" ? 12 : 4}
                            invalid={!!shownErrs.content}
                            describedBy={`content-help-${kind}`}
                            labelledBy={`content-label-${kind}`}
                          />
                        ) : (
                          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs text-slate-700">
                            {draft.content || "(empty)"}
                          </pre>
                        )}
                      </div>
                      {shownErrs.content ? (
                        <span role="alert" id={`content-help-${kind}`} className="mt-1 block text-xs text-red-600">
                          {shownErrs.content}
                        </span>
                      ) : (
                        <span id={`content-help-${kind}`} className="mt-1 block text-xs text-slate-500">
                          {kind === "body"
                            ? "Markdown: **bold**, [a link](https://…), > a quote. Tags are filled in when each email is sent."
                            : `Markdown. Leave it empty for a ${lower} that adds nothing.`}
                        </span>
                      )}
                    </div>
                    <div>
                      <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-500">
                        <Braces className="h-3.5 w-3.5" aria-hidden /> Tags you can use
                      </p>
                      <ul role="list" className="flex flex-wrap gap-1.5">
                        {tagMenu.map((t) => (
                          <li key={t.tag}>
                            <code
                              tabIndex={0}
                              data-tt={t.label}
                              data-tt-wrap
                              className="rounded-sm bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700"
                            >
                              {`{{${t.tag}}}`}
                            </code>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <FormError>{formError}</FormError>
                  </div>
                </Card>

                <Card padding="p-4" className="@4xl:sticky @4xl:top-6 @4xl:self-start">
                  {kind !== "body" && events.length > 0 && (
                    <Field label="Preview in" size="md" className="mb-3" help={`Shown inside that email's other parts.`}>
                      <Select value={previewEvent} onChange={(e) => setPreviewEvent(e.target.value)} dense>
                        {events.map((e) => (
                          <option key={e.key} value={e.key}>
                            {e.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  <EmailPreview
                    subject={preview?.subject ?? null}
                    html={preview?.html ?? null}
                    loading={rendering}
                    error={previewError}
                    label={`Preview of ${draft.name || `the new ${lower}`}`}
                  />
                </Card>
              </div>
            </div>

            {!canEdit ? (
              <p className="text-sm text-slate-500">
                Parts are shared by every email, so changing them needs the email template manager permission.
              </p>
            ) : (
            <SaveRow
              dirty={dirty || (creating && tried)}
              busy={busy}
              onSave={save}
              allowPristine={creating}
              label={creating ? `Create ${lower}` : `Save ${lower}`}
            >
              {creating && parts.length > 0 && (
                <Button variant="ghost" onClick={() => select(selected ?? parts[0].id)} disabled={busy}>
                  Cancel
                </Button>
              )}
              {!creating && part && backHref && (
                <Link href={backHref} className="link text-sm">
                  Back to the template
                </Link>
              )}
            </SaveRow>
            )}
          </div>
        </div>
      </div>
      {surface.mode === "admin" && kind !== "body" && (
        <p className="text-xs text-slate-500">
          Templates that follow the default {lower} change when you set another one as the default. Open{" "}
          <Link className="link" href={libraryHref(surface, "body")}>
            Bodies
          </Link>{" "}
          to edit what each email says.
        </p>
      )}
    </div>
  );
}

function contentHelp(kind: EmailPartKind): string {
  switch (kind) {
    case "header":
      return "Sits above the body of every email that uses it: a logo, the workspace name.";
    case "body":
      return "What the email says, and its subject line.";
    case "signature":
      return "Follows the body: who the email is from.";
    case "footer":
      return "The last lines of the email: who sent it and how to change notifications.";
  }
}
