"use client";

// Settings → Macros: canned replies agents insert from the composer, with
// placeholders filled in and optional field changes applied on send (set
// the status or priority, move the team, add tags). Everyone's, or one
// team's. A list with New macro; each opens in a dialog.

import { useEffect, useId, useState } from "react";
import { Pencil, Plus, Trash2, X, Zap } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { EmptyState, Field, FormError, Select, TextInput, Textarea } from "@/components/form";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { LoadingRow } from "@/components/Spinner";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import {
  HD_PRIORITIES,
  HD_PRIORITY_LABEL,
  HD_STATUSES,
  HD_STATUS_LABEL,
  type HdMacro,
  type HdMacroActions,
  type HdPriority,
  type HdStatus,
} from "@/lib/helpdesk/types";
import { getJson, listOf, sendJson } from "../api";
import { useTeams } from "../admin-data";
import { MACRO_PLACEHOLDERS } from "../ticket/MacroPicker";

type MacroRow = HdMacro & { team_name?: string | null };

export function MacrosSettings() {
  const [rows, setRows] = useState<MacroRow[] | null>(null);
  const [placeholders, setPlaceholders] = useState<string[]>(MACRO_PLACEHOLDERS);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<MacroRow | "new" | null>(null);
  const { teams } = useTeams();

  const load = () =>
    getJson<{ macros: MacroRow[]; placeholders?: (string | { key: string })[] }>("/api/helpdesk/admin/macros", "Couldn't load the macros.")
      .then((d) => {
        setRows(listOf<MacroRow>(d, "macros"));
        if (Array.isArray(d.placeholders) && d.placeholders.length) {
          setPlaceholders(d.placeholders.map((p) => (typeof p === "string" ? p : `{{${p.key}}}`)));
        }
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  async function remove(m: MacroRow) {
    const ok = await confirmDialog({
      title: `Delete ${m.title}?`,
      body: "Agents can no longer insert it, and a rule that sends it skips that step. This cannot be undone.",
      confirmLabel: "Delete macro",
      danger: true,
    });
    if (ok !== true) return;
    try {
      await sendJson(`/api/helpdesk/admin/macros/${m.id}`, "DELETE", undefined, "Couldn't delete the macro.");
      toast("ok", "Macro deleted.");
      void load();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        icon={<Zap />}
        title="Macros"
        subtitle="Canned replies for the questions you answer every week. Agents type / in a reply to use one."
        actions={
          <Button icon={<Plus />} onClick={() => setEditing("new")}>
            New macro
          </Button>
        }
      />
      {error && <p className="notice-error mb-4 rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {rows === null && !error && <LoadingRow className="py-10" />}
      {rows && rows.length === 0 && (
        <EmptyState icon={<Zap />} title="No macros yet" body="Write the reply once, with placeholders for the person's name and the ticket number, and reuse it." action={{ onClick: () => setEditing("new"), label: "New macro", icon: <Plus /> }} />
      )}
      {rows && rows.length > 0 && (
        <Card padding="none">
          <ul className="divide-y divide-slate-100">
            {rows.map((m) => (
              <li key={m.id} className="flex items-start gap-3 px-4 py-3">
                <Zap className="mt-0.5 h-4 w-4 shrink-0 text-compass-600" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
                    {m.title}
                    <Chip tone="neutral" size="sm">{m.team_id ? m.team_name || teams?.find((t) => t.id === m.team_id)?.name || "One team" : "Everyone"}</Chip>
                    {actionSummary(m.actions) && <Chip tone="info" size="sm">{actionSummary(m.actions)}</Chip>}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{m.body}</p>
                </div>
                <button type="button" onClick={() => setEditing(m)} aria-label={`Edit ${m.title}`} data-tt="Edit" className={iconButtonClass("quiet", "sm")}>
                  <Pencil aria-hidden />
                </button>
                <button type="button" onClick={() => remove(m)} aria-label={`Delete ${m.title}`} data-tt="Delete" className={iconButtonClass("quiet", "sm", "hover-danger")}>
                  <Trash2 aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <MacroDialog
        macro={editing}
        teams={(teams ?? []).map((t) => ({ id: t.id, name: t.name }))}
        placeholders={placeholders}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
    </PageContainer>
  );
}

function actionSummary(a: HdMacroActions | undefined): string {
  if (!a) return "";
  const parts: string[] = [];
  if (a.status) parts.push(`Sets ${HD_STATUS_LABEL[a.status]}`);
  if (a.priority) parts.push(`${HD_PRIORITY_LABEL[a.priority]} priority`);
  if (a.team_id) parts.push("Moves team");
  if (a.tags_add?.length) parts.push(`Tags ${a.tags_add.join(", ")}`);
  return parts.join(" · ");
}

function MacroDialog({
  macro,
  teams,
  placeholders,
  onClose,
  onSaved,
}: {
  macro: MacroRow | "new" | null;
  teams: { id: number; name: string }[];
  placeholders: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const titleId = useId();
  const existing = macro && macro !== "new" ? macro : null;
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [team, setTeam] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [moveTeam, setMoveTeam] = useState("");
  const [tags, setTags] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!macro) return;
    const m = macro === "new" ? null : macro;
    setTitle(m?.title ?? "");
    setBody(m?.body ?? "");
    setTeam(m?.team_id ? String(m.team_id) : "");
    setStatus(m?.actions?.status ?? "");
    setPriority(m?.actions?.priority ?? "");
    setMoveTeam(m?.actions?.team_id ? String(m.actions.team_id) : "");
    setTags((m?.actions?.tags_add ?? []).join(", "));
    setTried(false);
    setError("");
  }, [macro]);

  const errs = { title: !title.trim() ? "Give the macro a name." : undefined, body: !body.trim() ? "Write the reply." : undefined };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (errs.title || errs.body) return;
    const actions: HdMacroActions = {};
    if (status) actions.status = status as HdStatus;
    if (priority) actions.priority = priority as HdPriority;
    if (moveTeam) actions.team_id = Number(moveTeam);
    const t = tags.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (t.length) actions.tags_add = t;
    setBusy(true);
    setError("");
    try {
      const payload = { title: title.trim(), body: body.trim(), team_id: team ? Number(team) : null, actions };
      if (existing) await sendJson(`/api/helpdesk/admin/macros/${existing.id}`, "PATCH", payload, "Couldn't save the macro.");
      else await sendJson("/api/helpdesk/admin/macros", "POST", payload, "Couldn't create the macro.");
      toast("ok", existing ? "Macro saved." : "Macro created.");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={!!macro} onClose={onClose} labelledBy={titleId} className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <form onSubmit={save} noValidate>
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            {existing ? `Edit ${existing.title}` : "New macro"}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm", "-mr-1 -mt-1")}>
            <X aria-hidden />
          </button>
        </div>
        <div className="mt-4 space-y-3">
          <Field label="Name" error={tried ? errs.title : undefined}>
            <TextInput value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Password reset steps" />
          </Field>
          <Field label="Reply" help={`Markdown. Placeholders: ${placeholders.join(", ")}`} error={tried ? errs.body : undefined}>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} className="h-40" maxLength={10000} />
          </Field>
          <Field label="Who can use it">
            <Select value={team} onChange={(e) => setTeam(e.target.value)}>
              <option value="">Every agent</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} only
                </option>
              ))}
            </Select>
          </Field>
          <fieldset className="rounded-lg border border-slate-200 p-3">
            <legend className="px-1 text-xs font-medium text-slate-500">When sent, also (optional)</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Set the status">
                <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="">Leave as it is</option>
                  {HD_STATUSES.filter((s) => s !== "new" && s !== "closed").map((s) => (
                    <option key={s} value={s}>
                      {HD_STATUS_LABEL[s]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Set the priority">
                <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="">Leave as it is</option>
                  {HD_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {HD_PRIORITY_LABEL[p]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Move to team">
                <Select value={moveTeam} onChange={(e) => setMoveTeam(e.target.value)}>
                  <option value="">Leave as it is</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Add tags" help="Comma-separated">
                <TextInput value={tags} onChange={(e) => setTags(e.target.value)} placeholder="password, mfa" />
              </Field>
            </div>
          </fieldset>
          <FormError>{error}</FormError>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {existing ? "Save macro" : "Create macro"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
