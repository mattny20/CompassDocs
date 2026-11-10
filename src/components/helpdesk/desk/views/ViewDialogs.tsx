"use client";

// The saved views' dialogs (1.19.1, agent V4; mock-up 1), one host the
// queue layout renders:
//   Save this view   the name, who sees it (Only me, or a team you lead:
//                    stacked radio cards) and the filters in words.
//   Rename view      the name.
//   Filter / Edit    the queue's filters as a form (start from a list,
//                    contains, status, priority, team, owner, tag, created);
//                    Apply shows the filtered list; on a view you may change
//                    "Save to view" stores them.

import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Bookmark, Filter, X } from "lucide-react";
import { Modal } from "@/components/Modal";
import { Button, iconButtonClass } from "@/components/Button";
import { Field, FormError, Select, TextInput } from "@/components/form";
import { useDeskMailboxes } from "../mailboxes";
import { RadioCards } from "@/components/PolicyFields";
import { toast } from "@/components/Toasts";
import { HD_PRIORITIES, HD_PRIORITY_LABEL, HD_STATUSES, HD_STATUS_LABEL } from "@/lib/helpdesk/types";
import { filterSummary, SAVED_VIEW_NAME_MAX, type HdSavedView, type HdViewFilters } from "@/lib/helpdesk/saved-views-shared";
import { itemOf, sendJson } from "../api";
import { VIEWS, selQs, type QueueSel } from "../queue/views";
import { filterSel, type SavedViews } from "./saved";

type Team = { team_id: number; name: string };

export function ViewDialogs({
  sv,
  sel,
  teams,
  title,
  basePath,
}: {
  sv: SavedViews;
  sel: QueueSel;
  /** The desk counts' teams (names for the summary and the Team filter). */
  teams: Team[];
  /** The current list's title (the suggested name). */
  title: string;
  /** "/desk" or "/desk/tickets/1047": where the list opens, keeping the open ticket. */
  basePath: string;
}) {
  const d = sv.dialog;
  const close = () => sv.setDialog(null);
  if (!d) return null;
  if (d.kind === "save") return <SaveViewDialog sv={sv} filters={d.filters} teams={teams} title={title} basePath={basePath} sort={sel.sort} onClose={close} />;
  if (d.kind === "rename") return <RenameViewDialog sv={sv} view={d.view} onClose={close} />;
  return <FilterDialog sv={sv} initial={d.filters} view={d.view} teams={teams} basePath={basePath} sort={sel.sort} onClose={close} />;
}

function DialogFrame({ titleId, icon, title, onClose, children }: { titleId: string; icon: ReactNode; title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Modal open onClose={onClose} labelledBy={titleId} className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <div className="flex items-start justify-between gap-3">
        <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold text-slate-900">
          <span className="shrink-0 text-slate-500 [&>svg]:h-5 [&>svg]:w-5" aria-hidden>
            {icon}
          </span>
          {title}
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm", "-mr-1 -mt-1")}>
          <X aria-hidden />
        </button>
      </div>
      {children}
    </Modal>
  );
}

const TEAM_SCOPE_HELP = "Everyone in the team sees it under the team's views. Team leads can change or remove it.";
const GENERIC_TITLES = new Set(["Report drill-down", "Filtered tickets", "Saved view"]);

function SaveViewDialog({
  sv,
  filters,
  teams,
  title,
  basePath,
  sort,
  onClose,
}: {
  sv: SavedViews;
  filters: HdViewFilters;
  teams: Team[];
  title: string;
  basePath: string;
  sort: QueueSel["sort"];
  onClose: () => void;
}) {
  const titleId = useId();
  const router = useRouter();
  const [name, setName] = useState(GENERIC_TITLES.has(title) ? "" : title.slice(0, SAVED_VIEW_NAME_MAX));
  const [who, setWho] = useState("me");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const share = sv.list?.share_teams ?? [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Give the view a name.");
    setBusy(true);
    setError("");
    try {
      const teamId = who.startsWith("team:") ? Number(who.slice(5)) : null;
      const r = await sendJson(`/api/helpdesk/views`, "POST", { name: name.trim(), filters, team_id: teamId }, "Couldn't save the view.");
      const view = itemOf<HdSavedView>(r, "view");
      toast("ok", `Saved "${view.name}".`);
      sv.add(view);
      sv.refresh();
      onClose();
      router.push(`${basePath}${selQs({ view: null, team: null, drill: null, saved: view.id, sort })}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogFrame titleId={titleId} icon={<Bookmark />} title="Save this view" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <p className="mt-1 text-sm text-slate-500">
          Saved views sit under Views with their own count. Filters: {filterSummary(filters, teams)}.
        </p>
        <Field label="Name" className="mt-4" error={error && !name.trim() ? error : undefined}>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={SAVED_VIEW_NAME_MAX} required data-autofocus />
        </Field>
        <div className="mt-4">
          <p className="mb-1 text-xs font-medium text-slate-500">Who sees it</p>
          {share.length > 0 && share.length <= 2 ? (
            <RadioCards
              label="Who sees it"
              name="view-scope"
              value={who}
              onChange={setWho}
              options={[
                { value: "me", label: "Only me", description: "Under My views." },
                ...share.map((t) => ({
                  value: `team:${t.id}`,
                  label: t.name,
                  description: TEAM_SCOPE_HELP,
                })),
              ]}
            />
          ) : share.length > 2 ? (
            // Many teams (a manager): one card and a team picker under it.
            <RadioCards
              label="Who sees it"
              name="view-scope"
              value={who === "me" ? "me" : "team"}
              onChange={(v) => setWho(v === "me" ? "me" : `team:${share[0].id}`)}
              options={[
                { value: "me", label: "Only me", description: "Under My views." },
                {
                  value: "team",
                  label: "A team",
                  description: TEAM_SCOPE_HELP,
                  extra: (
                    <Field label="Team" size="md">
                      <Select value={who.startsWith("team:") ? who.slice(5) : ""} onChange={(e) => setWho(`team:${e.target.value}`)}>
                        {share.map((t) => (
                          <option key={t.id} value={String(t.id)}>
                            {t.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ),
                },
              ]}
            />
          ) : (
            <p className="text-sm text-slate-600">Only you, under My views.</p>
          )}
        </div>
        <FormError className="mt-3">{error && name.trim() ? error : ""}</FormError>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Save view
          </Button>
        </div>
      </form>
    </DialogFrame>
  );
}

function RenameViewDialog({ sv, view, onClose }: { sv: SavedViews; view: HdSavedView; onClose: () => void }) {
  const titleId = useId();
  const [name, setName] = useState(view.name);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Give the view a name.");
    setBusy(true);
    try {
      await sendJson(`/api/helpdesk/views/${view.id}`, "PATCH", { name: name.trim() }, "Couldn't rename the view.");
      toast("ok", "View renamed.");
      sv.refresh();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <DialogFrame titleId={titleId} icon={<Bookmark />} title="Rename view" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <Field label="Name" className="mt-4" error={error || undefined}>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={SAVED_VIEW_NAME_MAX} required data-autofocus />
        </Field>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Save
          </Button>
        </div>
      </form>
    </DialogFrame>
  );
}

// --- The filter form --------------------------------------------------------------

const FORM_KEYS = new Set(["view", "q", "status", "status_group", "priority", "team", "assignee", "tag", "created_within", "mailbox"]);
const CREATED = [
  { value: "", label: "Any time" },
  { value: "1", label: "Today" },
  { value: "7", label: "In the last 7 days" },
  { value: "30", label: "In the last 30 days" },
  { value: "90", label: "In the last 90 days" },
];

interface Form {
  start: string;
  q: string;
  status: string;
  priority: string;
  team: string;
  assignee: string;
  tag: string;
  created: string;
  /** 1.20.2: a help address (lib/helpdesk/mailboxes); '' = any. */
  mailbox: string;
}

function formFrom(f: HdViewFilters): Form {
  let start = f.view ?? "open";
  let team = f.team ?? "";
  // A team's queue is All open in that team.
  if (start.startsWith("team:")) {
    team = team || start.slice(5);
    start = "open";
  }
  return {
    start,
    q: f.q ?? "",
    status: f.status_group === "open" ? "group:open" : f.status ?? "",
    priority: f.priority ?? "",
    team,
    assignee: f.assignee ?? "",
    tag: f.tag ?? "",
    created: f.created_within ?? "",
    mailbox: f.mailbox ?? "",
  };
}

function filtersFrom(form: Form, extra: HdViewFilters): HdViewFilters {
  const out: HdViewFilters = { ...extra, view: form.start || "all" };
  if (form.q.trim()) out.q = form.q.trim();
  if (form.status === "group:open") out.status_group = "open";
  else if (form.status) out.status = form.status;
  if (form.priority) out.priority = form.priority;
  if (form.team) out.team = form.team;
  if (form.assignee) out.assignee = form.assignee;
  if (form.tag.trim()) out.tag = form.tag.trim();
  if (form.created) out.created_within = form.created;
  if (form.mailbox) out.mailbox = form.mailbox;
  return out;
}

function FilterDialog({
  sv,
  initial,
  view,
  teams,
  basePath,
  sort,
  onClose,
}: {
  sv: SavedViews;
  initial: HdViewFilters;
  view: HdSavedView | null;
  teams: Team[];
  basePath: string;
  sort: QueueSel["sort"];
  onClose: () => void;
}) {
  const titleId = useId();
  const router = useRouter();
  // 1.20.2: the Address choice, offered while more than one help address is listed (or one is already chosen).
  const mailboxes = useDeskMailboxes();
  const [form, setForm] = useState<Form>(() => formFrom(initial));
  const [extra, setExtra] = useState<HdViewFilters>(() => Object.fromEntries(Object.entries(initial).filter(([k]) => !FORM_KEYS.has(k))));
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const filters = useMemo(() => filtersFrom(form, extra), [form, extra]);
  const extraText = Object.keys(extra).length ? filterSummary(extra, teams) : "";

  function apply(e?: FormEvent) {
    e?.preventDefault();
    onClose();
    router.push(`${basePath}${selQs(filterSel(filters, sort))}`);
  }

  async function saveToView() {
    if (!view) return;
    setBusy(true);
    const ok = await sv.setFilters(view, filters);
    setBusy(false);
    if (!ok) return;
    onClose();
    router.push(`${basePath}${selQs({ view: null, team: null, drill: null, saved: view.id, sort })}`);
  }

  const assigneeOther = form.assignee && form.assignee !== "me" && form.assignee !== "none";
  return (
    <DialogFrame titleId={titleId} icon={<Filter />} title={view ? `Edit "${view.name}"` : "Filter tickets"} onClose={onClose}>
      <form onSubmit={apply} noValidate>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Start from">
            <Select value={form.start} onChange={set("start")}>
              <option value="all">Every ticket</option>
              {VIEWS.map((v) => (
                <option key={v.key} value={v.key}>
                  {v.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Contains">
            <TextInput value={form.q} onChange={set("q")} maxLength={80} placeholder="Words, a name or #1047" data-autofocus />
          </Field>
          <Field label="Status">
            <Select value={form.status} onChange={set("status")}>
              <option value="">Any status</option>
              <option value="group:open">Not solved</option>
              {HD_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {HD_STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={form.priority} onChange={set("priority")}>
              <option value="">Any priority</option>
              {HD_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {HD_PRIORITY_LABEL[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Team">
            <Select value={form.team} onChange={set("team")}>
              <option value="">Any team</option>
              {teams.map((t) => (
                <option key={t.team_id} value={String(t.team_id)}>
                  {t.name}
                </option>
              ))}
              {form.team && !teams.some((t) => String(t.team_id) === form.team) && <option value={form.team}>Team {form.team}</option>}
            </Select>
          </Field>
          <Field label="Owner">
            <Select value={form.assignee} onChange={set("assignee")}>
              <option value="">Anyone</option>
              <option value="me">Me</option>
              <option value="none">Nobody (unassigned)</option>
              {assigneeOther && <option value={form.assignee}>One person (from Reports)</option>}
            </Select>
          </Field>
          <Field label="Tag">
            <TextInput value={form.tag} onChange={set("tag")} maxLength={80} />
          </Field>
          <Field label="Created">
            <Select value={form.created} onChange={set("created")}>
              {CREATED.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
              {form.created && !CREATED.some((c) => c.value === form.created) && <option value={form.created}>In the last {form.created} days</option>}
            </Select>
          </Field>
          {(mailboxes.length > 1 || form.mailbox) && (
            <Field label="Address">
              <Select value={form.mailbox} onChange={set("mailbox")}>
                <option value="">Any address</option>
                {mailboxes.map((m) => (
                  <option key={m.id} value={m.address}>
                    {m.address}
                  </option>
                ))}
                {form.mailbox && !mailboxes.some((m) => m.address === form.mailbox) && <option value={form.mailbox}>{form.mailbox}</option>}
              </Select>
            </Field>
          )}
        </div>
        {extraText && (
          <p className="mt-3 text-xs text-slate-500">
            Also filtered by: {extraText}.{" "}
            <button type="button" className="link" onClick={() => setExtra({})}>
              Remove
            </button>
          </p>
        )}
        <p className="mt-3 text-xs text-slate-500" aria-live="polite">
          {filterSummary(filters, teams)}
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {view?.can_edit ? (
            <>
              <Button type="submit" variant="secondary">
                Show list
              </Button>
              <Button busy={busy} onClick={() => void saveToView()}>
                Save to view
              </Button>
            </>
          ) : (
            <Button type="submit">Show list</Button>
          )}
        </div>
      </form>
    </DialogFrame>
  );
}
