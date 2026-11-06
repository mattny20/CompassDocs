"use client";

// The composer (1.19.0, STYLEGUIDE §Email templates in parts): one email
// event's template, built by choosing a header, a body, a signature and a
// footer from their libraries, beside a live preview of the mail it makes.
// A helpdesk event can also be composed per team (scope 'hd_team:<id>');
// a team that has no variant of its own sends the All teams template.
//
// Each picker's first choice inherits: the kind's default part on All
// teams (the event's own built-in body for a body), the All teams choice on
// a team. Edit and New beside a picker open that library with the part in
// its editor (the leave guard asks first while the composer is dirty).
// One SaveRow (Ctrl/⌘+S); Send me a test mails the unsaved combination to
// the admin; Reset to defaults puts every picker back on its inherited
// choice (still to be saved); Remove team version deletes a team's row.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Eye, Mail, Pencil, Plus, RotateCcw, Send, Trash2, Users } from "lucide-react";
import { Card } from "@/components/Card";
import { Button, iconButtonClass } from "@/components/Button";
import { chipClass } from "@/components/Chip";
import { SectionHeading } from "@/components/Heading";
import { Field, Select } from "@/components/form";
import { SaveRow } from "@/components/SaveRow";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges, LEAVE_PROMPT } from "@/lib/use-unsaved";
import { EmailPreview } from "./EmailPreview";
import { compositionsApi, previewApi, type Slots } from "./api";
import { fallbackPart } from "./summary";
import { KINDS, KIND_LABEL, SCOPE_ALL, eventHref, libraryHref, scopeTeamId, teamScope } from "./types";
import type { EmailComposition, EmailPartKind, EventInfo, PartWithUsage, Surface, TeamOption } from "./types";

const SLOT: Record<EmailPartKind, keyof Slots> = {
  header: "header_id",
  body: "body_id",
  signature: "signature_id",
  footer: "footer_id",
};

function slotsOf(c: EmailComposition | undefined): Slots {
  if (!c || !c.stored) return { header_id: null, body_id: null, signature_id: null, footer_id: null };
  return { header_id: c.header.id, body_id: c.body.id, signature_id: c.signature.id, footer_id: c.footer.id };
}

/** A stored 'all' row that names exactly the fallback part is still "the default": show it as inheriting. */
function normalise(slots: Slots, parts: PartWithUsage[], event: string, scope: string): Slots {
  if (scope !== SCOPE_ALL) return slots;
  const out = { ...slots };
  for (const kind of KINDS) {
    const fb = fallbackPart(parts, kind, event);
    if (fb && out[SLOT[kind]] === fb.id) out[SLOT[kind]] = null;
  }
  return out;
}

export function Composer({
  surface,
  event,
  compositions: initialComps,
  parts,
  teams,
  initialScope,
  canCompose,
  canEditParts,
}: {
  surface: Surface;
  event: EventInfo;
  compositions: Record<string, EmailComposition>;
  parts: PartWithUsage[];
  teams: TeamOption[];
  initialScope: string;
  /** May save this event's template (and its team variants). */
  canCompose: boolean;
  /** May edit and create parts (template managers); others can view a part. */
  canEditParts: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [comps, setComps] = useState(initialComps);
  const validScope = initialScope === SCOPE_ALL || (event.teamScopes && teams.some((t) => teamScope(t.id) === initialScope));
  const [scope, setScope] = useState(validScope ? initialScope : SCOPE_ALL);
  const [slots, setSlots] = useState<Slots>(() => normalise(slotsOf(initialComps[scope]), parts, event.key, scope));
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(true);

  const snapshot = JSON.stringify([scope, slots]);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(snapshot);
  useLeaveGuard(dirty, hasUnsavedChanges);

  const teamId = scopeTeamId(scope);
  const team = teamId != null ? teams.find((t) => t.id === teamId) : undefined;
  const current = comps[scope];
  const allComp = comps[SCOPE_ALL];
  const isVariant = scope !== SCOPE_ALL && !!current?.stored;

  const byKind = useMemo(() => {
    const m: Record<EmailPartKind, PartWithUsage[]> = { header: [], body: [], signature: [], footer: [] };
    for (const p of parts) if (p.kind !== "body" || p.event_key === event.key) m[p.kind].push(p);
    return m;
  }, [parts, event.key]);

  /** What the inherit choice resolves to, for its label. */
  function inherited(kind: EmailPartKind): PartWithUsage | undefined {
    if (scope !== SCOPE_ALL && allComp) {
      const id = allComp[kind].effective_id;
      return parts.find((p) => p.id === id);
    }
    return fallbackPart(parts, kind, event.key);
  }

  function effective(kind: EmailPartKind): PartWithUsage | undefined {
    const id = slots[SLOT[kind]];
    return id != null ? parts.find((p) => p.id === id) : inherited(kind);
  }

  // Live preview, 300ms behind the pickers.
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    setRendering(true);
    const t = window.setTimeout(async () => {
      const r = await previewApi.render({ event: event.key, scope, ...slots });
      if (n !== seq.current) return;
      if (r.ok) {
        setPreview({ subject: r.data.subject, html: r.data.html });
        setPreviewError(null);
      } else {
        setPreviewError(r.data.error || "The preview could not be rendered.");
      }
      setRendering(false);
    }, 300);
    return () => window.clearTimeout(t);
  }, [event.key, scope, slots]);

  function choose(kind: EmailPartKind, value: string) {
    markDirty();
    setSlots((s) => ({ ...s, [SLOT[kind]]: value === "" ? null : Number(value) }));
  }

  async function switchScope(next: string) {
    if (next === scope) return;
    if (hasUnsavedChanges() && !window.confirm(LEAVE_PROMPT)) return;
    setScope(next);
    const nextSlots = normalise(slotsOf(comps[next]), parts, event.key, next);
    setSlots(nextSlots);
    markClean(JSON.stringify([next, nextSlots]));
    router.replace(next === SCOPE_ALL ? pathname : `${pathname}?scope=${encodeURIComponent(next)}`, { scroll: false });
  }

  const save = useCallback(async () => {
    setBusy(true);
    const r = await compositionsApi.save(event.key, scope, slots);
    setBusy(false);
    if (!r.ok) {
      toast("error", r.data.error || "The template could not be saved.");
      return;
    }
    markClean();
    if (r.data.composition) setComps((c) => ({ ...c, [scope]: r.data.composition }));
    toast("ok", team ? `Saved the ${team.name} version. Their emails use it from now on.` : "Template saved. Emails use it from now on.");
    router.refresh();
  }, [event.key, scope, slots, team, markClean, router]);

  function resetToDefaults() {
    const cleared: Slots = { header_id: null, body_id: null, signature_id: null, footer_id: null };
    if (JSON.stringify(cleared) === JSON.stringify(slots)) return;
    markDirty();
    setSlots(cleared);
    toast("ok", "Every part is back on its default. Save to keep it.");
  }

  async function removeVariant() {
    if (!team) return;
    const ok = await confirmDialog({
      title: `Remove the ${team.name} version?`,
      body: `${team.name}'s ${event.label.toLowerCase()} emails go back to the All teams template.`,
      confirmLabel: "Remove team version",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    const r = await compositionsApi.removeVariant(event.key, scope);
    setBusy(false);
    if (!r.ok) {
      toast("error", r.data.error || "The team version could not be removed.");
      return;
    }
    const inheritedComp: EmailComposition | undefined = r.data.composition ?? (current ? { ...current, stored: false } : undefined);
    if (inheritedComp) setComps((c) => ({ ...c, [scope]: inheritedComp }));
    const cleared: Slots = { header_id: null, body_id: null, signature_id: null, footer_id: null };
    setSlots(cleared);
    markClean(JSON.stringify([scope, cleared]));
    toast("ok", `${team.name} uses the All teams template again.`);
    router.refresh();
  }

  async function sendTest() {
    setSending(true);
    const r = await previewApi.sendTest({ event: event.key, scope, ...slots });
    setSending(false);
    if (r.ok) toast("ok", r.data.to ? `Test email sent to ${r.data.to}.` : "Test email sent to you.");
    else toast("error", r.data.error || "The test email could not be sent.");
  }

  const from = eventHref(surface, event.key, scope);
  const allDefault = KINDS.every((k) => slots[SLOT[k]] === null);

  return (
    <div className="space-y-4">
      <div>
        <SectionHeading icon={<Mail />} className="mb-1">
          {event.label}
        </SectionHeading>
        <p className="max-w-3xl text-sm text-slate-500">{event.description}</p>
      </div>

      <div className="@container">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 @3xl:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
          <div className="space-y-4">
            {event.teamScopes && (
              <Card
                title="Who it's for"
                icon={<Users />}
                description="Give a helpdesk team its own version, or keep one for all teams."
              >
                {teams.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    This email is the same for every team. Team versions become possible once the helpdesk has teams.
                  </p>
                ) : (
                  <Field
                    label="Template for"
                    help={
                      scope === SCOPE_ALL
                        ? "Teams without a version of their own use this one."
                        : isVariant
                          ? `${team?.name} has its own version.`
                          : `${team?.name} uses the All teams template until you save a version for them.`
                    }
                  >
                    <Select value={scope} onChange={(e) => switchScope(e.target.value)} data-testid="scope-select">
                      <option value={SCOPE_ALL}>All teams</option>
                      {teams.map((t) => (
                        <option key={t.id} value={teamScope(t.id)}>
                          {t.name}
                          {comps[teamScope(t.id)]?.stored ? " (own version)" : ""}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
              </Card>
            )}

            <Card title="Parts" description="Choose one of each. The first choice follows the workspace default.">
              <div className="space-y-4">
                {KINDS.map((kind) => {
                  const list = byKind[kind];
                  const inh = inherited(kind);
                  const eff = effective(kind);
                  const value = slots[SLOT[kind]];
                  const inhName = inh?.name ?? "None";
                  const inheritLabel = scope === SCOPE_ALL ? "Use workspace default" : "Same as All teams";
                  // Where the part the email uses comes from (the slot's `source`, live while unsaved).
                  const allSource = allComp?.[kind].source;
                  const help =
                    value != null
                      ? team
                        ? `Chosen for ${team.name}`
                        : "Chosen for this email"
                      : scope === SCOPE_ALL
                        ? `Workspace default: ${inhName}`
                        : allSource === "chosen"
                          ? `Inherited from All teams: ${inhName}`
                          : `Inherited from All teams: ${inhName} (workspace default)`;
                  return (
                    <div key={kind}>
                      <div className="flex flex-wrap items-start gap-x-1.5">
                        <Field label={KIND_LABEL[kind]} help={help} className="min-w-48 flex-1">
                          <Select value={value == null ? "" : String(value)} onChange={(e) => choose(kind, e.target.value)} disabled={!canCompose}>
                            <option value="">{inheritLabel}</option>
                            {list.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        {eff && (
                          <Link
                            href={libraryHref(surface, kind, { part: eff.id, from })}
                            className={iconButtonClass("bordered", "md", "mt-5.5")}
                            data-tt={`${canEditParts ? "Edit" : "View"} ${eff.name}`}
                            data-tt-wrap
                            aria-label={`${canEditParts ? "Edit" : "View"} ${KIND_LABEL[kind].toLowerCase()} ${eff.name}`}
                          >
                            {canEditParts ? <Pencil className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                          </Link>
                        )}
                        {canEditParts && (
                        <Link
                          href={libraryHref(surface, kind, { new: true, from, event: kind === "body" ? event.key : undefined })}
                          className={iconButtonClass("bordered", "md", "mt-5.5")}
                          data-tt={`New ${KIND_LABEL[kind].toLowerCase()}`}
                          aria-label={`New ${KIND_LABEL[kind].toLowerCase()}`}
                        >
                          <Plus className="h-4 w-4" aria-hidden />
                        </Link>
                        )}
                      </div>
                      {kind === "body" && eff?.builtin && eff.customized && (
                        <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                          <span className={chipClass("warn", "sm")}>Edited</span> The built-in body has been changed from the original.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>

            {canCompose ? (
              <SaveRow dirty={dirty} busy={busy} onSave={save} label={team ? `Save ${team.name} version` : "Save template"}>
                <Button variant="secondary" icon={<Send />} busy={sending} onClick={sendTest}>
                  Send me a test
                </Button>
              </SaveRow>
            ) : (
              <p className="text-sm text-slate-500">You can look at this template. Changing it needs the email template manager permission.</p>
            )}
            {canCompose && (
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" icon={<RotateCcw />} onClick={resetToDefaults} disabled={allDefault}>
                {scope === SCOPE_ALL ? "Reset to defaults" : "Match all teams"}
              </Button>
              {isVariant && (
                <Button variant="danger" size="sm" icon={<Trash2 />} onClick={removeVariant} disabled={busy}>
                  Remove team version
                </Button>
              )}
            </div>
            )}
          </div>

          <div className="@3xl:sticky @3xl:top-6 @3xl:self-start">
            <Card padding="p-4">
              <EmailPreview
                subject={preview?.subject ?? null}
                html={preview?.html ?? null}
                loading={rendering}
                error={previewError}
                label={`Preview of ${event.label}`}
              />
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
