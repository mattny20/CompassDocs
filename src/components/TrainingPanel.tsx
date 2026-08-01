"use client";

// Training home. "My training" for everyone; Overview (org rollup + triage
// queue) and Manage decks (dense table + expandable deck cards) for admins
// and Training-section grantees. Mirrors the CompliancePanel look so the two
// programs feel like siblings.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Archive,
  Award,
  BarChart3,
  BellRing,
  Camera,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Download,
  Eye,
  GraduationCap,
  Layers,
  LoaderCircle,
  Mail,
  Package,
  Pencil,
  PenLine,
  Play,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings2,
  Timer,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { EntityPicker, type PickerOption } from "@/components/EntityPicker";

interface MyItem {
  assignment_id: number;
  title: string;
  space_name: string;
  space_icon: string;
  assigned_at: string;
  due_at: string | null;
  completed_at: string | null;
  last_slide: number;
  slide_count: number;
  waived: boolean;
}

interface Deck {
  id: number;
  document_id: number;
  title: string;
  space_name: string;
  space_icon: string;
  active: number;
  due_days: number | null;
  assign_new_members: number;
  archived_at: string | null;
  pass_pct: number;
  recert_months: number | null;
  tag: string;
  require_signature: number;
  assigned: number;
  completed: number;
  waived: number;
  overdue: number;
  stall_slide: number | null;
}

interface Program {
  id: number;
  name: string;
  active: number;
  assign_new_members: number;
  decks: { id: number; title: string }[];
}

interface PersonRow {
  assignment_id: number;
  user_id: number;
  name: string;
  username: string;
  due_at: string | null;
  completed_at: string | null;
  source: string;
  quiz_score: number | null;
  quiz_total: number | null;
  prior_completions: number;
}

const fmtDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : null);
const overdue = (it: MyItem) =>
  !it.completed_at && it.due_at !== null && new Date(it.due_at).getTime() < Date.now();

// --- Toasts: action feedback that's visible wherever you are on the page ----

interface Toast {
  id: number;
  kind: "ok" | "error";
  text: string;
}
let toastSeq = 1;

function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`flex items-start justify-between gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg ${
            t.kind === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-950/70"
              : "border-red-200 bg-red-50 text-red-700 dark:border-red-800/60 dark:bg-red-950/70"
          }`}
        >
          <span>{t.text}</span>
          <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="opacity-60 hover:opacity-100">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function TrainingPanel({
  licensed,
  manager,
  teamLead = false,
}: {
  licensed: boolean;
  manager: boolean;
  teamLead?: boolean;
}) {
  const [tab, setTab] = useState<"mine" | "overview" | "matrix" | "decks">("mine");
  const [mine, setMine] = useState<MyItem[] | null>(null);
  const [decks, setDecks] = useState<Deck[] | null>(null);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [archivedCount, setArchivedCount] = useState(0);
  const [candidates, setCandidates] = useState<{ id: number; title: string; space_name: string }[]>([]);
  const [userOpts, setUserOpts] = useState<PickerOption[]>([]);
  const [groupOpts, setGroupOpts] = useState<PickerOption[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((kind: "ok" | "error", text: string) => {
    const id = toastSeq++;
    setToasts((ts) => [...ts.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 6000);
  }, []);
  const dismissToast = (id: number) => setToasts((ts) => ts.filter((t) => t.id !== id));
  const onError = useCallback((s: string) => s && toast("error", s), [toast]);
  const onNotice = useCallback((s: string) => s && toast("ok", s), [toast]);

  // Decks refresh cheaply; the pickers' option lists load once.
  const loadDecks = useCallback(async () => {
    const d = await fetch("/api/training/decks").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (d) {
      setDecks(d.decks);
      setPrograms(d.programs ?? []);
      setArchivedCount(d.archived_count ?? 0);
      setCandidates(d.candidates);
      setUserOpts(d.users);
      setGroupOpts(d.groups);
    }
  }, []);
  const load = useCallback(async () => {
    const my = await fetch("/api/training/my").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (my) setMine(my.items);
    if (manager) await loadDecks();
  }, [manager, loadDecks]);
  useEffect(() => {
    if (licensed) void load();
  }, [licensed, load]);

  const Header = ({ extra }: { extra?: React.ReactNode }) => (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
          <GraduationCap className="h-6 w-6 text-compass-600" /> Training
        </h1>
        <p className="mt-0.5 text-sm text-slate-400">
          Assigned decks to work through, with a confirmation recorded at the end.
        </p>
      </div>
      {extra}
    </div>
  );

  if (!licensed) {
    return (
      <div>
        <Header />
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500 dark:bg-slate-800/40">
          Training requires a license with the <code className="text-xs">training</code> entitlement.
        </p>
      </div>
    );
  }

  return (
    <div>
      <Header
        extra={
          manager ? (
            <div className="flex rounded-lg border border-slate-200 p-0.5 text-sm font-medium">
              {(
                [
                  ["mine", "My training"],
                  ["overview", "Overview"],
                  ["matrix", "Matrix"],
                  ["decks", "Manage decks"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`rounded-md px-3 py-1 ${
                    tab === key ? "bg-compass-600 text-white" : "text-slate-500 hover:bg-slate-50"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : undefined
        }
      />

      <Toasts toasts={toasts} dismiss={dismissToast} />

      {tab === "mine" || !manager ? (
        <MyTraining mine={mine} teamLead={teamLead} />
      ) : tab === "overview" ? (
        <Overview onError={onError} onNotice={onNotice} userOpts={userOpts} />
      ) : tab === "matrix" ? (
        <MatrixView />
      ) : (
        <ManageDecks
          decks={decks}
          programs={programs}
          archivedCount={archivedCount}
          candidates={candidates}
          userOpts={userOpts}
          groupOpts={groupOpts}
          onError={onError}
          onNotice={onNotice}
          reload={loadDecks}
        />
      )}
    </div>
  );
}

// --- My training ------------------------------------------------------------

function MyTraining({ mine, teamLead = false }: { mine: MyItem[] | null; teamLead?: boolean }) {
  const teamLink = teamLead ? (
    <p className="mb-4 flex items-center gap-2 rounded-xl border border-compass-200 bg-compass-50/60 px-4 py-2.5 text-sm text-compass-800 dark:bg-compass-100/20">
      <Users className="h-4 w-4 shrink-0" />
      You lead a team —{" "}
      <Link href="/training/team" className="font-semibold underline underline-offset-2">
        see your team&apos;s training
      </Link>
    </p>
  ) : null;
  if (!mine) {
    return (
      <div>
        {teamLink}
        <div className="flex items-center gap-2 py-10 text-sm text-slate-400">
          <LoaderCircle className="h-4 w-4 animate-spin" /> Loading…
        </div>
      </div>
    );
  }
  if (!mine.length) {
    return (
      <div>
        {teamLink}
        <p className="rounded-xl border border-slate-200 bg-surface px-4 py-10 text-center text-sm text-slate-400 shadow-xs">
          Nothing assigned — when training lands here, you&apos;ll also get a notification.
        </p>
      </div>
    );
  }
  return (
    <div>
      {teamLink}
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {mine.map((it) => {
        const pct = it.completed_at
          ? 100
          : Math.round((Math.min(it.last_slide, it.slide_count) / Math.max(it.slide_count, 1)) * 100);
        return (
          <div key={it.assignment_id} className="flex flex-col rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
            <div className="text-xs text-slate-400">
              {it.space_icon} {it.space_name}
            </div>
            <div className="mt-1 font-semibold text-slate-900">{it.title}</div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div
                className={`h-full rounded-full ${it.completed_at ? "bg-emerald-500" : "bg-compass-500"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="mt-1.5 flex items-center justify-between text-xs">
              <span className="text-slate-400">
                {it.completed_at ? (it.waived ? "Waived" : "Completed") : `${pct}% · ${it.slide_count} slides`}
              </span>
              {it.completed_at ? (
                <span className="inline-flex items-center gap-1 font-medium text-emerald-600">
                  <CircleCheck className="h-3.5 w-3.5" /> {fmtDay(it.completed_at)}
                </span>
              ) : it.due_at ? (
                <span className={`inline-flex items-center gap-1 font-medium ${overdue(it) ? "text-red-600" : "text-slate-500"}`}>
                  {overdue(it) && <CircleAlert className="h-3.5 w-3.5" />} Due {fmtDay(it.due_at)}
                </span>
              ) : null}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Link
                href={`/training/take/${it.assignment_id}`}
                className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold ${
                  it.completed_at
                    ? "border border-slate-200 text-slate-600 hover:bg-slate-50"
                    : "bg-compass-600 text-white hover:bg-compass-700"
                }`}
              >
                <Play className="h-4 w-4" />
                {it.completed_at ? "Review" : it.last_slide > 0 ? "Continue" : "Start"}
              </Link>
              {it.completed_at && !it.waived && (
                <a
                  href={`/training/certificate/${it.assignment_id}`}
                  title="View certificate"
                  aria-label={`Certificate for ${it.title}`}
                  className="inline-flex items-center rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-50"
                >
                  <Award className="h-4 w-4" />
                </a>
              )}
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}

// --- Overview: KPIs, per-deck bars, needs-attention triage queue ------------

interface AttentionRow {
  assignment_id: number;
  deck_id: number;
  deck: string;
  user_id: number;
  name: string;
  username: string;
  due_at: string | null;
  quiz_score: number | null;
  quiz_total: number | null;
  pass_pct: number;
  reason: "overdue" | "failed_quiz" | "stalled";
}

interface OverviewData {
  overview: {
    decks: number;
    people_assigned: number;
    open: number;
    overdue: number;
    completed: number;
    waived: number;
  };
  decks: Deck[];
  attention: { rows: AttentionRow[]; total: number };
}

const REASON_LABEL: Record<AttentionRow["reason"], { text: string; cls: string }> = {
  overdue: { text: "Overdue", cls: "bg-red-100 text-red-700" },
  failed_quiz: { text: "Quiz below pass", cls: "bg-amber-100 text-amber-700" },
  stalled: { text: "Stalled 14d+", cls: "bg-slate-100 text-slate-500" },
};

function Overview({
  onError,
  onNotice,
  userOpts,
}: {
  onError: (s: string) => void;
  onNotice: (s: string) => void;
  userOpts: PickerOption[];
}) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const refresh = useCallback(async () => {
    const d = await fetch("/api/training/overview").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (d) setData(d);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(row: AttentionRow, body: Record<string, unknown>, path?: string, done?: string) {
    setBusyId(row.assignment_id);
    const res = await fetch(path ?? `/api/training/decks/${row.deck_id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) onError(d.error || "Something went wrong.");
    else onNotice(done ?? "Done.");
    setBusyId(null);
    await refresh();
  }

  if (!data) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-slate-400">
        <LoaderCircle className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  const o = data.overview;
  const doneAll = o.completed + o.waived;
  const totalAll = doneAll + o.open;
  const pct = totalAll ? Math.round((doneAll / totalAll) * 100) : 0;
  // Worst-completion first, so the deck needing attention tops the list.
  const decksSorted = [...data.decks].sort((a, b) => {
    const pa = a.assigned ? (a.completed + a.waived) / a.assigned : 1;
    const pb = b.assigned ? (b.completed + b.waived) / b.assigned : 1;
    return pa - pb;
  });

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Active decks", value: o.decks },
          { label: "People with assignments", value: o.people_assigned },
          { label: "Overall completion", value: `${pct}%` },
          { label: "Overdue", value: o.overdue },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
            <div className="text-2xl font-bold tracking-tight text-slate-900">{c.value}</div>
            <div className="text-xs text-slate-400">{c.label}</div>
          </div>
        ))}
      </div>

      {/* Needs attention: work this list to zero. */}
      <section className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <CircleAlert className="h-4 w-4 text-red-500" /> Needs attention
            <span className="text-xs font-normal text-slate-400">
              {data.attention.total > data.attention.rows.length
                ? `showing ${data.attention.rows.length} of ${data.attention.total}`
                : `${data.attention.total}`}
            </span>
          </h2>
          <a
            href="/api/training/overview?format=csv"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            <Download className="h-4 w-4" /> All records (CSV)
          </a>
        </div>
        {data.attention.rows.length === 0 ? (
          <p className="mt-2 text-sm text-slate-400">Nothing needs attention.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100">
            {data.attention.rows.map((r) => (
              <li key={r.assignment_id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <Link
                  href={`/training/person/${r.user_id}`}
                  className="font-medium text-slate-700 hover:text-compass-600 hover:underline"
                >
                  {r.name}
                </Link>
                <span className="min-w-0 flex-1 truncate text-slate-500">{r.deck}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${REASON_LABEL[r.reason].cls}`}>
                  {REASON_LABEL[r.reason].text}
                  {r.reason === "overdue" && r.due_at ? ` · ${fmtDay(r.due_at)}` : ""}
                  {r.reason === "failed_quiz" && r.quiz_total ? ` · ${r.quiz_score}/${r.quiz_total}` : ""}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => void act(r, { remind_assignment_ids: [r.assignment_id] }, undefined, "Reminder sent.")}
                    disabled={busyId === r.assignment_id}
                    title="Remind now"
                    className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  >
                    <BellRing className="h-3 w-3" /> Remind
                  </button>
                  <button
                    onClick={() =>
                      void act(r, { extend_assignment_ids: [r.assignment_id], extend_days: 7 }, undefined, "Due date pushed out 7 days.")
                    }
                    disabled={busyId === r.assignment_id}
                    title="Extend due date by 7 days"
                    className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  >
                    <Timer className="h-3 w-3" /> +7d
                  </button>
                  <button
                    onClick={() =>
                      void act(
                        r,
                        { snooze_assignment_ids: [r.assignment_id], days: 7 },
                        "/api/training/overview",
                        "Snoozed for 7 days."
                      )
                    }
                    disabled={busyId === r.assignment_id}
                    title="Hide from this queue for 7 days"
                    className="rounded-md border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  >
                    Snooze
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <h2 className="text-sm font-semibold text-slate-800">Decks — lowest completion first</h2>
        <ul className="mt-3 space-y-2">
          {decksSorted.map((d) => {
            const done = d.completed + d.waived;
            const p = d.assigned ? Math.round((done / d.assigned) * 100) : 0;
            return (
              <li key={d.id} className="flex items-center gap-3 text-sm">
                <span className="w-56 truncate font-medium text-slate-700" title={d.title}>
                  {d.title}
                </span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-compass-500" style={{ width: `${p}%` }} />
                </div>
                <span className="w-40 shrink-0 text-right text-xs text-slate-400">
                  {d.completed} done{d.waived ? ` · ${d.waived} waived` : ""}
                  {d.overdue ? ` · ${d.overdue} overdue` : ""} / {d.assigned}
                </span>
              </li>
            );
          })}
          {decksSorted.length === 0 && (
            <li className="text-sm text-slate-400">No decks yet — create one under Manage decks.</li>
          )}
        </ul>
      </section>

      <Evidence onError={onError} onNotice={onNotice} />
      <ReportSettings onError={onError} onNotice={onNotice} userOpts={userOpts} />
      <TeamLeads onError={onError} onNotice={onNotice} userOpts={userOpts} />
    </div>
  );
}

// --- Evidence: point-in-time snapshots + the one-click audit package --------

interface SnapshotMeta {
  id: number;
  taken_at: string;
  kind: string;
  period: string;
  taken_by: string;
  sha256: string;
}

function Evidence({ onError, onNotice }: { onError: (s: string) => void; onNotice: (s: string) => void }) {
  const [snapshots, setSnapshots] = useState<SnapshotMeta[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const d = await fetch("/api/training/snapshots").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (d) setSnapshots(d.snapshots);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function take() {
    setBusy(true);
    const res = await fetch("/api/training/snapshots", { method: "POST" });
    const d = (await res.json().catch(() => ({}))) as { error?: string; sha256?: string };
    if (!res.ok) onError(d.error || "Could not take the snapshot.");
    else onNotice(`Snapshot stored — SHA-256 ${String(d.sha256 ?? "").slice(0, 12)}…`);
    setBusy(false);
    await load();
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <Camera className="h-4 w-4 text-compass-600" /> Evidence
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            A snapshot is taken automatically every month; each stores the exact records with a
            SHA-256 an auditor can verify. The audit package bundles everything as one ZIP.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <button
            onClick={() => void take()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
          >
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
            Take snapshot now
          </button>
          <a
            href="/api/training/audit-package"
            className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-3 py-1.5 font-semibold text-white hover:bg-compass-700"
          >
            <Package className="h-4 w-4" /> Audit package (ZIP)
          </a>
        </div>
      </div>
      {snapshots && snapshots.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-100">
          {snapshots.slice(0, 8).map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm">
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  s.kind === "monthly" ? "bg-compass-50 text-compass-700" : "bg-slate-100 text-slate-500"
                }`}
              >
                {s.kind === "monthly" ? s.period : "manual"}
              </span>
              <span className="text-xs text-slate-500">{fmtDay(s.taken_at)}</span>
              {s.taken_by && s.taken_by !== "scheduled" && (
                <span className="text-xs text-slate-400">by {s.taken_by}</span>
              )}
              <code className="min-w-0 flex-1 truncate text-right text-[11px] text-slate-400" title={s.sha256}>
                {s.sha256.slice(0, 16)}…
              </code>
              <a
                href={`/api/training/snapshots/${s.id}`}
                title="Download snapshot JSON"
                aria-label={`Download snapshot ${s.id}`}
                className="inline-flex items-center rounded-md border border-slate-200 p-1 text-slate-500 hover:bg-slate-50"
              >
                <Download className="h-3.5 w-3.5" />
              </a>
            </li>
          ))}
          {snapshots.length > 8 && (
            <li className="px-3 py-1.5 text-xs text-slate-400">
              {snapshots.length - 8} older snapshots are included in the audit package.
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

// --- Monthly report email settings ------------------------------------------

function ReportSettings({
  onError,
  onNotice,
  userOpts,
}: {
  onError: (s: string) => void;
  onNotice: (s: string) => void;
  userOpts: PickerOption[];
}) {
  const [enabled, setEnabled] = useState(false);
  const [userIds, setUserIds] = useState<number[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void fetch("/api/training/report")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setEnabled(d.enabled === true);
          setUserIds(Array.isArray(d.user_ids) ? d.user_ids : []);
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  async function save(next: { enabled: boolean; user_ids: number[] }) {
    const res = await fetch("/api/training/report", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      onError(d.error || "Could not save the report settings.");
    } else onNotice("Report settings saved.");
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
        <Mail className="h-4 w-4 text-compass-600" /> Monthly report email
      </h2>
      <p className="mt-0.5 text-xs text-slate-400">
        Sent with each monthly snapshot: completion, overdue counts, and the decks that need
        attention.
      </p>
      {loaded && (
        <div className="mt-3 space-y-2">
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
                void save({ enabled: e.target.checked, user_ids: userIds });
              }}
            />
            Send the monthly training report
          </label>
          {enabled && (
            <div className="max-w-lg">
              <EntityPicker
                options={userOpts}
                value={userIds}
                onChange={(ids) => {
                  setUserIds(ids);
                  void save({ enabled, user_ids: ids });
                }}
                placeholder="Add recipients…"
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// --- Team leads: who gets the scoped team view + weekly digest --------------

interface LeadRow {
  group_id: number;
  group_name: string;
  user_id: number;
}

function TeamLeads({
  onError,
  onNotice,
  userOpts,
}: {
  onError: (s: string) => void;
  onNotice: (s: string) => void;
  userOpts: PickerOption[];
}) {
  const [groups, setGroups] = useState<{ id: number; name: string }[]>([]);
  const [leads, setLeads] = useState<Map<number, number[]>>(new Map());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void fetch("/api/training/leads")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { groups?: { id: number; name: string }[]; leads?: LeadRow[] } | null) => {
        if (d) {
          setGroups(d.groups ?? []);
          const m = new Map<number, number[]>();
          for (const l of d.leads ?? []) m.set(l.group_id, [...(m.get(l.group_id) ?? []), l.user_id]);
          setLeads(m);
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  async function save(groupId: number, userIds: number[]) {
    setLeads((m) => new Map(m).set(groupId, userIds));
    const res = await fetch("/api/training/leads", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group_id: groupId, user_ids: userIds }),
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      onError(d.error || "Could not save the team leads.");
    } else onNotice("Team leads saved.");
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
        <Users className="h-4 w-4 text-compass-600" /> Team leads
      </h2>
      <p className="mt-0.5 text-xs text-slate-400">
        Leads see a scoped view of their own group&apos;s training (no manager access needed) and
        get a weekly email summary.
      </p>
      {loaded &&
        (groups.length === 0 ? (
          <p className="mt-2 text-sm text-slate-400">
            No groups yet — create them under Settings → Groups.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {groups.map((g) => (
              <div key={g.id} className="flex flex-wrap items-center gap-2">
                <span className="w-44 truncate text-sm font-medium text-slate-700" title={g.name}>
                  {g.name}
                </span>
                <div className="min-w-64 flex-1 sm:max-w-lg">
                  <EntityPicker
                    options={userOpts}
                    value={leads.get(g.id) ?? []}
                    onChange={(ids) => void save(g.id, ids)}
                    placeholder="Add leads…"
                  />
                </div>
              </div>
            ))}
          </div>
        ))}
    </section>
  );
}

// --- Compliance matrix: people × decks --------------------------------------

type MatrixCell = "completed" | "waived" | "overdue" | "open" | null;

interface MatrixData {
  decks: { id: number; title: string; tag: string }[];
  people: { user_id: number; name: string; username: string; cells: MatrixCell[] }[];
}

const CELL_STYLE: Record<Exclude<MatrixCell, null>, string> = {
  completed: "bg-emerald-100 text-emerald-700",
  waived: "bg-slate-100 text-slate-500",
  overdue: "bg-red-100 text-red-700",
  open: "bg-compass-50 text-compass-700",
};
const CELL_SHORT: Record<Exclude<MatrixCell, null>, string> = {
  completed: "Done",
  waived: "Waived",
  overdue: "Overdue",
  open: "Open",
};

function MatrixView() {
  const [data, setData] = useState<MatrixData | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    void fetch("/api/training/matrix")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setData(d))
      .catch(() => {});
  }, []);

  if (!data) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-slate-400">
        <LoaderCircle className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  const needle = query.trim().toLowerCase();
  const people = needle
    ? data.people.filter((p) => `${p.name} ${p.username}`.toLowerCase().includes(needle))
    : data.people;

  return (
    <section className="rounded-xl border border-slate-200 bg-surface shadow-xs">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Compliance matrix</h2>
          <p className="text-xs text-slate-400">
            Everyone with at least one assignment, across every deck.
          </p>
        </div>
        <div className="relative ml-auto min-w-44">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a person…"
            className="w-full rounded-lg border border-slate-200 bg-surface py-1.5 pl-8 pr-3 text-sm outline-hidden placeholder:text-slate-400 focus:border-compass-400"
          />
        </div>
        <a
          href="/api/training/matrix?format=csv"
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          <Download className="h-4 w-4" /> CSV
        </a>
      </div>
      {data.decks.length === 0 || data.people.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-slate-400">
          Nothing to show yet — assign a deck first.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-[11px] uppercase tracking-wide text-slate-400">
                <th className="sticky left-0 bg-surface px-4 py-2">Person</th>
                {data.decks.map((d) => (
                  <th key={d.id} className="max-w-40 truncate px-2 py-2" title={d.title}>
                    {d.title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {people.map((p) => (
                <tr key={p.user_id}>
                  <td className="sticky left-0 bg-surface px-4 py-1.5">
                    <Link
                      href={`/training/person/${p.user_id}`}
                      className="font-medium text-slate-700 hover:text-compass-600 hover:underline"
                    >
                      {p.name}
                    </Link>
                  </td>
                  {p.cells.map((c, i) => (
                    <td key={i} className="px-2 py-1.5">
                      {c ? (
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${CELL_STYLE[c]}`}>
                          {CELL_SHORT[c]}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-300">—</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
              {people.length === 0 && (
                <tr>
                  <td colSpan={1 + data.decks.length} className="px-4 py-6 text-center text-sm text-slate-400">
                    Nobody matches.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// --- Manage decks: dense table + expandable cards ---------------------------

type DeckSort = "title" | "progress" | "overdue" | "created";

function ManageDecks({
  decks,
  programs,
  archivedCount,
  candidates,
  userOpts,
  groupOpts,
  onError,
  onNotice,
  reload,
}: {
  decks: Deck[] | null;
  programs: Program[];
  archivedCount: number;
  candidates: { id: number; title: string; space_name: string }[];
  userOpts: PickerOption[];
  groupOpts: PickerOption[];
  onError: (s: string) => void;
  onNotice: (s: string) => void;
  reload: () => Promise<void>;
}) {
  const [candidate, setCandidate] = useState<number | null>(null);
  const [dueDays, setDueDays] = useState("14");
  const [autoNew, setAutoNew] = useState(true);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [sort, setSort] = useState<DeckSort>("created");
  const [openDeck, setOpenDeck] = useState<number | null>(null);

  const candidateOpts: PickerOption[] = candidates.map((c) => ({
    id: c.id,
    label: c.title,
    sublabel: c.space_name,
  }));
  const chosen = candidates.find((c) => c.id === candidate);

  const tags = useMemo(
    () => [...new Set((decks ?? []).map((d) => d.tag).filter(Boolean))].sort(),
    [decks]
  );
  const visible = useMemo(() => {
    let list = decks ?? [];
    const needle = query.trim().toLowerCase();
    if (needle) list = list.filter((d) => `${d.title} ${d.space_name} ${d.tag}`.toLowerCase().includes(needle));
    if (tagFilter) list = list.filter((d) => d.tag === tagFilter);
    const prog = (d: Deck) => (d.assigned ? (d.completed + d.waived) / d.assigned : 1);
    if (sort === "title") list = [...list].sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === "progress") list = [...list].sort((a, b) => prog(a) - prog(b));
    else if (sort === "overdue") list = [...list].sort((a, b) => b.overdue - a.overdue);
    return list;
  }, [decks, query, tagFilter, sort]);

  async function createDeck() {
    if (!candidate) return;
    setBusy(true);
    const res = await fetch("/api/training/decks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document_id: candidate,
        due_days: dueDays ? Number(dueDays) : null,
        assign_new_members: autoNew,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) onError(data.error || "Could not create the deck.");
    else {
      onNotice("Deck created — assign it below.");
      setCandidate(null);
    }
    setBusy(false);
    await reload();
  }

  return (
    <div className="space-y-5">
      {/* Create */}
      <section className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
          <Plus className="h-4 w-4 text-compass-600" /> New training deck
        </h2>
        <p className="mt-0.5 text-xs text-slate-400">
          Pick a published document — slides split on <code>---</code> lines, an optional{" "}
          <code>:::quiz</code> adds graded questions, and a trailing <code>:::compliance</code>{" "}
          block sets the confirmation wording.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="min-w-72 flex-1 sm:max-w-md">
            {chosen ? (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-compass-200 bg-compass-50 px-3 py-1.5 text-sm font-medium text-compass-800">
                {chosen.title}
                <span className="text-xs font-normal text-compass-600">{chosen.space_name}</span>
                <button onClick={() => setCandidate(null)} aria-label="Clear document choice" className="opacity-60 hover:opacity-100">
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            ) : (
              <EntityPicker
                options={candidateOpts}
                onPick={(id) => setCandidate(id)}
                placeholder="Find a published document…"
                emptyText="No published documents match."
                maxVisible={10}
              />
            )}
          </div>
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            Due within
            <input
              type="number"
              min={1}
              max={365}
              value={dueDays}
              onChange={(e) => setDueDays(e.target.value)}
              className="w-16 rounded-lg border border-slate-200 bg-surface px-2 py-1.5 text-sm outline-hidden focus:border-compass-400"
            />
            days
          </label>
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            <input type="checkbox" checked={autoNew} onChange={(e) => setAutoNew(e.target.checked)} />
            Auto-assign to new members
          </label>
          <button
            onClick={() => void createDeck()}
            disabled={!candidate || busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60"
          >
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create deck
          </button>
        </div>
      </section>

      {/* Onboarding programs */}
      <Programs
        programs={programs}
        decks={decks ?? []}
        userOpts={userOpts}
        groupOpts={groupOpts}
        onError={onError}
        onNotice={onNotice}
        reload={reload}
      />

      {/* Deck table */}
      {!decks ? (
        <div className="flex items-center gap-2 py-10 text-sm text-slate-400">
          <LoaderCircle className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : decks.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-surface px-4 py-8 text-center text-sm text-slate-400 shadow-xs">
          No training decks yet — create one above.
        </p>
      ) : (
        <section className="rounded-xl border border-slate-200 bg-surface shadow-xs">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
            <div className="relative min-w-56 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-slate-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search decks…"
                className="w-full rounded-lg border border-slate-200 bg-surface py-1.5 pl-8 pr-3 text-sm outline-hidden placeholder:text-slate-400 focus:border-compass-400"
              />
            </div>
            {tags.map((t) => (
              <button
                key={t}
                onClick={() => setTagFilter(tagFilter === t ? "" : t)}
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                  tagFilter === t ? "bg-compass-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {t}
              </button>
            ))}
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as DeckSort)}
              aria-label="Sort decks"
              className="ml-auto rounded-lg border border-slate-200 bg-surface px-2 py-1.5 text-sm text-slate-600 outline-hidden focus:border-compass-400"
            >
              <option value="created">Newest first</option>
              <option value="title">Title A–Z</option>
              <option value="progress">Lowest completion</option>
              <option value="overdue">Most overdue</option>
            </select>
          </div>
          <ul className="divide-y divide-slate-100">
            {visible.map((d) => {
              const done = d.completed + d.waived;
              const p = d.assigned ? Math.round((done / d.assigned) * 100) : 0;
              const open = openDeck === d.id;
              return (
                <li key={d.id}>
                  <button
                    onClick={() => setOpenDeck(open ? null : d.id)}
                    className="flex w-full flex-wrap items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-slate-50/60"
                  >
                    {open ? (
                      <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium text-slate-800">
                      {d.title}
                      {d.active === 0 && (
                        <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium uppercase text-slate-500">
                          inactive
                        </span>
                      )}
                    </span>
                    {d.tag && (
                      <span className="rounded-full bg-compass-50 px-2 py-0.5 text-[11px] font-medium text-compass-700">
                        {d.tag}
                      </span>
                    )}
                    <span className="hidden w-28 sm:block">
                      <span className="block h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <span className="block h-full rounded-full bg-compass-500" style={{ width: `${p}%` }} />
                      </span>
                    </span>
                    <span className="w-28 shrink-0 text-right text-xs text-slate-400">
                      {done}/{d.assigned} done
                    </span>
                    <span className={`w-20 shrink-0 text-right text-xs font-medium ${d.overdue ? "text-red-600" : "text-slate-300"}`}>
                      {d.overdue ? `${d.overdue} overdue` : "—"}
                    </span>
                  </button>
                  {open && (
                    <div className="border-t border-slate-100 bg-slate-50/40 px-4 py-4 dark:bg-slate-800/20">
                      <DeckCard
                        deck={d}
                        userOpts={userOpts}
                        groupOpts={groupOpts}
                        onError={onError}
                        onNotice={onNotice}
                        reload={reload}
                      />
                    </div>
                  )}
                </li>
              );
            })}
            {visible.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-slate-400">No decks match.</li>
            )}
          </ul>
        </section>
      )}

      {archivedCount > 0 && (
        <p className="text-right text-sm">
          <Link href="/training/archived" className="font-medium text-compass-600 hover:underline">
            Archived decks ({archivedCount}) →
          </Link>
        </p>
      )}
    </div>
  );
}

// --- Onboarding programs ----------------------------------------------------

function Programs({
  programs,
  decks,
  userOpts,
  groupOpts,
  onError,
  onNotice,
  reload,
}: {
  programs: Program[];
  decks: Deck[];
  userOpts: PickerOption[];
  groupOpts: PickerOption[];
  onError: (s: string) => void;
  onNotice: (s: string) => void;
  reload: () => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [deckIds, setDeckIds] = useState<number[]>([]);
  const [autoNew, setAutoNew] = useState(true);
  const [busy, setBusy] = useState(false);
  const deckOpts: PickerOption[] = decks.map((d) => ({ id: d.id, label: d.title, sublabel: d.space_name }));

  async function create() {
    setBusy(true);
    const res = await fetch("/api/training/programs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, deck_ids: deckIds }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; id?: number };
    if (!res.ok) onError(data.error || "Could not create the program.");
    else {
      if (!autoNew && data.id) {
        await fetch(`/api/training/programs/${data.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ assign_new_members: false }),
        }).catch(() => {});
      }
      onNotice(autoNew ? "Program created — new members will get every deck in it." : "Program created.");
      setName("");
      setDeckIds([]);
      setCreating(false);
    }
    setBusy(false);
    await reload();
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <Layers className="h-4 w-4 text-compass-600" /> Onboarding programs
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Bundle decks into a package — auto-assigned to every new member, or assigned to
            people and groups as one unit.
          </p>
        </div>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            <Plus className="h-4 w-4" /> New program
          </button>
        )}
      </div>

      {creating && (
        <div className="mt-3 space-y-2 rounded-lg border border-slate-200 p-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Program name (e.g. New starter onboarding)"
            className="w-full rounded-lg border border-slate-200 bg-surface px-3 py-1.5 text-sm outline-hidden focus:border-compass-400"
          />
          <EntityPicker
            options={deckOpts}
            value={deckIds}
            onChange={setDeckIds}
            placeholder="Add decks in order…"
            emptyText="No decks — create one first."
            maxVisible={10}
          />
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            <input type="checkbox" checked={autoNew} onChange={(e) => setAutoNew(e.target.checked)} />
            Auto-assign to new members
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void create()}
              disabled={busy || !name.trim() || !deckIds.length}
              className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60"
            >
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Create program
            </button>
            <button onClick={() => setCreating(false)} className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-50">
              Cancel
            </button>
          </div>
        </div>
      )}

      {programs.length > 0 && (
        <div className="mt-3 space-y-3">
          {programs.map((p) => (
            <ProgramRow
              key={p.id}
              program={p}
              deckOpts={deckOpts}
              userOpts={userOpts}
              groupOpts={groupOpts}
              onError={onError}
              onNotice={onNotice}
              reload={reload}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ProgramRow({
  program,
  deckOpts,
  userOpts,
  groupOpts,
  onError,
  onNotice,
  reload,
}: {
  program: Program;
  deckOpts: PickerOption[];
  userOpts: PickerOption[];
  groupOpts: PickerOption[];
  onError: (s: string) => void;
  onNotice: (s: string) => void;
  reload: () => Promise<void>;
}) {
  const [assigning, setAssigning] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(program.name);
  const [editDeckIds, setEditDeckIds] = useState<number[]>(program.decks.map((d) => d.id));
  const [userIds, setUserIds] = useState<number[]>([]);
  const [groupIds, setGroupIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  async function call(method: string, body?: unknown, done?: string) {
    setBusy(true);
    const res = await fetch(`/api/training/programs/${program.id}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      assigned?: number;
      people?: number;
    };
    if (!res.ok) onError(data.error || "Something went wrong.");
    else if (done) onNotice(done);
    else if (data.people !== undefined)
      onNotice(
        `Program assigned — ${data.assigned} new assignment${data.assigned === 1 ? "" : "s"} across ${data.people} ${
          data.people === 1 ? "person" : "people"
        }.`
      );
    setBusy(false);
    setUserIds([]);
    setGroupIds([]);
    setAssigning(false);
    setEditing(false);
    await reload();
  }

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-medium text-slate-800">
            {program.name}
            {program.active === 0 && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium uppercase text-slate-500">
                inactive
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
            {program.decks.map((d, i) => (
              <span key={d.id} className="rounded-full bg-slate-100 px-2 py-0.5 dark:bg-slate-800/60">
                {i + 1}. {d.title}
              </span>
            ))}
            {program.assign_new_members === 1 && program.active === 1 && (
              <span className="text-slate-400">· auto-assigns to new members</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-sm">
          <button
            onClick={() => setAssigning((a) => !a)}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-3 py-1.5 font-semibold text-white hover:bg-compass-700"
          >
            <Send className="h-3.5 w-3.5" /> Assign
          </button>
          <button
            onClick={() => {
              setEditing((e) => !e);
              setEditName(program.name);
              setEditDeckIds(program.decks.map((d) => d.id));
            }}
            disabled={busy}
            title="Edit program"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50"
          >
            <Pencil className="h-3.5 w-3.5" /> Edit
          </button>
          <button
            onClick={() =>
              void call(
                "PATCH",
                { assign_new_members: program.assign_new_members === 0 },
                program.assign_new_members === 0
                  ? "New members will now get this program."
                  : "New members will no longer get this program automatically."
              )
            }
            disabled={busy}
            className="rounded-lg border border-slate-200 px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50"
          >
            {program.assign_new_members === 0 ? "Auto-assign on" : "Auto-assign off"}
          </button>
          <button
            onClick={() =>
              void call("PATCH", { active: program.active === 0 }, program.active === 0 ? "Program activated." : "Program deactivated.")
            }
            disabled={busy}
            className="rounded-lg border border-slate-200 px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50"
          >
            {program.active === 0 ? "Activate" : "Deactivate"}
          </button>
          <button
            onClick={() => {
              if (confirm(`Delete the "${program.name}" program? Decks and completions stay; only the bundle goes.`))
                void call("DELETE", undefined, "Program deleted.");
            }}
            disabled={busy}
            aria-label={`Delete ${program.name}`}
            className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-600"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {editing && (
        <div className="mt-3 space-y-2 rounded-lg border border-slate-100 p-3">
          <input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-surface px-3 py-1.5 text-sm outline-hidden focus:border-compass-400"
          />
          <EntityPicker
            options={deckOpts}
            value={editDeckIds}
            onChange={setEditDeckIds}
            placeholder="Decks in order…"
            maxVisible={10}
          />
          <button
            onClick={() => void call("PATCH", { name: editName, deck_ids: editDeckIds }, "Program updated.")}
            disabled={busy || !editName.trim() || !editDeckIds.length}
            className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60"
          >
            Save changes
          </button>
        </div>
      )}

      {assigning && (
        <div className="mt-3 space-y-2">
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            <EntityPicker options={userOpts} value={userIds} onChange={setUserIds} placeholder="Add people…" />
            <EntityPicker options={groupOpts} value={groupIds} onChange={setGroupIds} placeholder="Add groups…" />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void call("POST", { user_ids: userIds, group_ids: groupIds })}
              disabled={busy || (!userIds.length && !groupIds.length)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60"
            >
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Assign program
            </button>
            <button
              onClick={() => {
                if (confirm(`Assign "${program.name}" (${program.decks.length} decks) to every active member?`))
                  void call("POST", { everyone: true });
              }}
              disabled={busy}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Assign to everyone
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Deck card (expanded row) ----------------------------------------------

function DeckCard({
  deck,
  userOpts,
  groupOpts,
  onError,
  onNotice,
  reload,
}: {
  deck: Deck;
  userOpts: PickerOption[];
  groupOpts: PickerOption[];
  onError: (s: string) => void;
  onNotice: (s: string) => void;
  reload: () => Promise<void>;
}) {
  const [userIds, setUserIds] = useState<number[]>([]);
  const [groupIds, setGroupIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [people, setPeople] = useState<PersonRow[] | null>(null);
  const [passPct, setPassPct] = useState(String(deck.pass_pct));
  const [recert, setRecert] = useState(deck.recert_months ? String(deck.recert_months) : "");
  const [due, setDue] = useState(deck.due_days ? String(deck.due_days) : "");
  const [tag, setTag] = useState(deck.tag);
  const [stats, setStats] = useState<{ question: string; attempts: number; correct: number; pct: number }[]>([]);

  async function loadPeople() {
    const res = await fetch(`/api/training/decks/${deck.id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (res) {
      setPeople(res.rows);
      setStats(res.question_stats ?? []);
    }
  }
  useEffect(() => {
    void loadPeople();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck.id]);

  async function post(body: Record<string, unknown>, done: string) {
    setBusy(true);
    const res = await fetch(`/api/training/decks/${deck.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, number | string | boolean>;
    if (!res.ok) onError(String(data.error || "Something went wrong."));
    else onNotice(done.replace("{n}", String(data.assigned ?? data.waived ?? data.removed ?? data.extended ?? data.reminded ?? data.reopened ?? "")));
    setUserIds([]);
    setGroupIds([]);
    setBusy(false);
    await reload();
    await loadPeople();
  }

  async function patch(body: unknown, done = "Saved.") {
    setBusy(true);
    const res = await fetch(`/api/training/decks/${deck.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      onError(data.error || "Could not save the deck settings.");
    } else onNotice(done);
    setBusy(false);
    await reload();
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-slate-400">
          {deck.space_icon} {deck.space_name} ·{" "}
          <a href={`/doc/${deck.document_id}`} className="text-compass-600 hover:underline">
            open document
          </a>
          {deck.stall_slide !== null && ` · most in-progress stop at slide ${deck.stall_slide}`}
        </div>
        <div className="flex items-center gap-2 text-sm">
          <a
            href={`/training/preview/${deck.id}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50"
          >
            <Eye className="h-4 w-4" /> Preview
          </a>
          <a
            href={`/api/training/decks/${deck.id}?format=csv`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50"
          >
            <Download className="h-4 w-4" /> CSV
          </a>
          <button
            onClick={() => void patch({ active: deck.active === 0 }, deck.active === 0 ? "Deck activated." : "Deck deactivated.")}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50"
          >
            <Settings2 className="h-4 w-4" /> {deck.active === 0 ? "Activate" : "Deactivate"}
          </button>
          <button
            onClick={() => {
              if (
                confirm(
                  `Archive "${deck.title}"? It disappears from everyone's Training tab (history kept) — restore it any time from Archived decks.`
                )
              )
                void patch({ archived: true }, "Deck archived.");
            }}
            disabled={busy}
            title="Archive deck"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50"
          >
            <Archive className="h-4 w-4" /> Archive
          </button>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-compass-500"
            style={{ width: `${deck.assigned ? Math.round(((deck.completed + deck.waived) / deck.assigned) * 100) : 0}%` }}
          />
        </div>
        <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-500">
          <Users className="h-3.5 w-3.5" /> {deck.completed} done
          {deck.waived ? ` · ${deck.waived} waived` : ""} / {deck.assigned}
        </span>
      </div>

      {/* Settings: everything editable after creation. */}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-slate-600">
        <label className="flex items-center gap-1.5">
          Due within
          <input
            type="number"
            min={1}
            max={365}
            value={due}
            placeholder="—"
            onChange={(e) => setDue(e.target.value)}
            onBlur={() => {
              const v = due.trim() === "" ? null : Math.min(365, Math.max(1, Number(due) || 0)) || null;
              if (v !== deck.due_days) void patch({ due_days: v });
            }}
            className="w-16 rounded-lg border border-slate-200 bg-surface px-2 py-1 text-sm outline-hidden focus:border-compass-400"
          />
          days
        </label>
        <label className="flex items-center gap-1.5">
          Quiz pass
          <input
            type="number"
            min={1}
            max={100}
            value={passPct}
            onChange={(e) => setPassPct(e.target.value)}
            onBlur={() => {
              const v = Math.min(100, Math.max(1, Number(passPct) || deck.pass_pct));
              if (v !== deck.pass_pct) void patch({ pass_pct: v });
            }}
            className="w-16 rounded-lg border border-slate-200 bg-surface px-2 py-1 text-sm outline-hidden focus:border-compass-400"
          />
          %
        </label>
        <label className="flex items-center gap-1.5">
          Recertify every
          <input
            type="number"
            min={1}
            max={60}
            value={recert}
            placeholder="—"
            onChange={(e) => setRecert(e.target.value)}
            onBlur={() => {
              const v = recert.trim() === "" ? null : Math.min(60, Math.max(1, Number(recert) || 0)) || null;
              if (v !== deck.recert_months) void patch({ recert_months: v });
            }}
            className="w-16 rounded-lg border border-slate-200 bg-surface px-2 py-1 text-sm outline-hidden focus:border-compass-400"
          />
          months
        </label>
        <label className="flex items-center gap-1.5">
          Tag
          <input
            value={tag}
            placeholder="e.g. Safety"
            onChange={(e) => setTag(e.target.value)}
            onBlur={() => {
              if (tag.trim() !== deck.tag) void patch({ tag: tag.trim() });
            }}
            className="w-28 rounded-lg border border-slate-200 bg-surface px-2 py-1 text-sm outline-hidden focus:border-compass-400"
          />
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={deck.assign_new_members === 1}
            onChange={(e) => void patch({ assign_new_members: e.target.checked })}
          />
          Auto-assign to new members
        </label>
        <label className="flex items-center gap-1.5" title="Trainees type their full name (and local accounts re-enter their password) to confirm — recorded on the completion.">
          <input
            type="checkbox"
            checked={deck.require_signature === 1}
            onChange={(e) =>
              void patch(
                { require_signature: e.target.checked },
                e.target.checked
                  ? "E-signature required — trainees sign by typed name to confirm."
                  : "E-signature no longer required."
              )
            }
          />
          <PenLine className="h-3.5 w-3.5 text-slate-400" /> Require e-signature
        </label>
        <button
          onClick={() => {
            if (
              confirm(
                `Reopen "${deck.title}" for everyone who completed it? Use this after a material update — prior completions stay in the history, and everyone is asked to retake it.`
              )
            )
              void post({ reopen_completed: true }, "Reopened for {n} people — prior completions kept in history.");
          }}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Reopen completed
        </button>
      </div>

      {stats.length > 0 && (
        <div className="mt-3 rounded-lg border border-slate-100 p-3">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <BarChart3 className="h-3.5 w-3.5 text-compass-600" /> Quiz insights
            <span className="font-normal normal-case text-slate-400">
              — % answered correctly ({stats[0].attempts} {stats[0].attempts === 1 ? "attempt" : "attempts"})
            </span>
          </h3>
          <ul className="mt-2 space-y-1.5">
            {stats.map((s, i) => (
              <li key={i} className="flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate text-slate-600" title={s.question}>
                  {i + 1}. {s.question}
                </span>
                <div className="h-1.5 w-32 shrink-0 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className={`h-full rounded-full ${s.pct < 60 ? "bg-red-400" : s.pct < 85 ? "bg-amber-400" : "bg-emerald-500"}`}
                    style={{ width: `${s.pct}%` }}
                  />
                </div>
                <span
                  className={`w-12 shrink-0 text-right text-xs font-medium ${
                    s.pct < 60 ? "text-red-600" : s.pct < 85 ? "text-amber-600" : "text-emerald-600"
                  }`}
                >
                  {s.attempts ? `${s.pct}%` : "—"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <PeopleTable deck={deck} people={people} busy={busy} post={post} />

      <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2">
        <EntityPicker options={userOpts} value={userIds} onChange={setUserIds} placeholder="Add people…" />
        <EntityPicker options={groupOpts} value={groupIds} onChange={setGroupIds} placeholder="Add groups…" />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          onClick={() => void post({ user_ids: userIds, group_ids: groupIds }, "Assigned to {n} people.")}
          disabled={busy || (!userIds.length && !groupIds.length)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60"
        >
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Assign
        </button>
        <button
          onClick={() => {
            if (confirm(`Assign "${deck.title}" to every active member?`)) void post({ everyone: true }, "Assigned to {n} people.");
          }}
          disabled={busy}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          Assign to everyone
        </button>
        <button
          onClick={() => {
            if (
              confirm(
                `Waive "${deck.title}" for every current member? Use this when staff already did this training before CompassDocs — recorded as waived, not completed, and nobody is notified.`
              )
            )
              void post({ everyone: true, waive: true }, "Waived for {n} people — recorded as waived, not completed.");
          }}
          disabled={busy}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          Waive for everyone
        </button>
      </div>
    </div>
  );
}

// --- People table with filters + bulk actions -------------------------------

type PeopleFilter = "all" | "open" | "overdue" | "completed" | "waived";

function PeopleTable({
  deck,
  people,
  busy,
  post,
}: {
  deck: Deck;
  people: PersonRow[] | null;
  busy: boolean;
  post: (body: Record<string, unknown>, done: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState<PeopleFilter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const status = (p: PersonRow): PeopleFilter =>
    p.completed_at
      ? p.source === "waived"
        ? "waived"
        : "completed"
      : p.due_at && new Date(p.due_at).getTime() < Date.now()
        ? "overdue"
        : "open";

  const visible = useMemo(() => {
    let list = people ?? [];
    if (filter !== "all") list = list.filter((p) => status(p) === filter || (filter === "open" && status(p) === "overdue"));
    const needle = query.trim().toLowerCase();
    if (needle) list = list.filter((p) => `${p.name} ${p.username}`.toLowerCase().includes(needle));
    return list;
  }, [people, filter, query]);

  const openSelected = [...selected].filter((id) => {
    const p = (people ?? []).find((x) => x.assignment_id === id);
    return p && !p.completed_at;
  });

  function toggle(id: number) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function bulk(body: Record<string, unknown>, done: string) {
    await post(body, done);
    setSelected(new Set());
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        {(["all", "open", "overdue", "completed", "waived"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize ${
              filter === f ? "bg-compass-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {f}
          </button>
        ))}
        <div className="relative ml-auto min-w-44">
          <Search className="pointer-events-none absolute left-2.5 top-1.5 h-3.5 w-3.5 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a person…"
            className="w-full rounded-lg border border-slate-200 bg-surface py-1 pl-7 pr-2 text-sm outline-hidden placeholder:text-slate-400 focus:border-compass-400"
          />
        </div>
      </div>

      {openSelected.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-compass-200 bg-compass-50/60 px-3 py-2 text-sm dark:bg-compass-100/20">
          <span className="font-medium text-compass-800">{openSelected.length} selected</span>
          <button
            onClick={() => void bulk({ remind_assignment_ids: openSelected }, "Reminded {n} people.")}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-surface px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            <BellRing className="h-3 w-3" /> Remind
          </button>
          <button
            onClick={() => {
              const days = Number(prompt("Extend due date by how many days?", "7"));
              if (Number.isFinite(days) && days > 0)
                void bulk({ extend_assignment_ids: openSelected, extend_days: days }, `Extended {n} due dates.`);
            }}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-surface px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            <Timer className="h-3 w-3" /> Extend due
          </button>
          <button
            onClick={() => {
              if (confirm("Waive the selected open assignments? Recorded as waived, no notifications."))
                void bulk({ waive_assignment_ids: openSelected }, "Waived {n} people.");
            }}
            disabled={busy}
            className="rounded-md border border-slate-200 bg-surface px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            Waive
          </button>
          <button
            onClick={() => {
              if (confirm("Remove the selected open assignments? Completed records are never removed."))
                void bulk({ unassign_assignment_ids: openSelected }, "Removed {n} assignments.");
            }}
            disabled={busy}
            className="rounded-md border border-slate-200 bg-surface px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50"
          >
            Unassign
          </button>
        </div>
      )}

      <div className="mt-2 overflow-x-auto rounded-lg border border-slate-100">
        {!people ? (
          <p className="flex items-center gap-2 px-3 py-3 text-sm text-slate-400">
            <LoaderCircle className="h-4 w-4 animate-spin" /> Loading…
          </p>
        ) : visible.length === 0 ? (
          <p className="px-3 py-3 text-sm text-slate-400">
            {people.length === 0 ? "Nobody assigned yet." : "Nobody matches."}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-[11px] uppercase tracking-wide text-slate-400">
                <th className="w-8 px-3 py-1.5"></th>
                <th className="px-2 py-1.5">Person</th>
                <th className="px-2 py-1.5">Status</th>
                <th className="px-2 py-1.5">Due</th>
                <th className="px-2 py-1.5">Completed</th>
                <th className="px-2 py-1.5">Quiz</th>
                <th className="px-2 py-1.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visible.map((p) => {
                const st = status(p);
                return (
                  <tr key={p.assignment_id}>
                    <td className="px-3 py-1.5">
                      {!p.completed_at && (
                        <input
                          type="checkbox"
                          checked={selected.has(p.assignment_id)}
                          onChange={() => toggle(p.assignment_id)}
                          aria-label={`Select ${p.name}`}
                        />
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <Link
                        href={`/training/person/${p.user_id}`}
                        className="font-medium text-slate-700 hover:text-compass-600 hover:underline"
                      >
                        {p.name}
                      </Link>
                      {p.prior_completions > 0 && (
                        <span className="ml-1.5 text-xs text-slate-400">· {p.prior_completions} prior</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${
                          st === "completed"
                            ? "bg-emerald-100 text-emerald-700"
                            : st === "waived"
                              ? "bg-slate-100 text-slate-500"
                              : st === "overdue"
                                ? "bg-red-100 text-red-700"
                                : "bg-compass-50 text-compass-700"
                        }`}
                      >
                        {st}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-xs text-slate-500">{fmtDay(p.due_at) ?? "—"}</td>
                    <td className="px-2 py-1.5 text-xs text-slate-500">{fmtDay(p.completed_at) ?? "—"}</td>
                    <td className="px-2 py-1.5 text-xs text-slate-500">
                      {p.quiz_total ? `${p.quiz_score}/${p.quiz_total}` : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {!p.completed_at ? (
                        <button
                          onClick={() => void post({ remind_assignment_ids: [p.assignment_id] }, "Reminder sent.")}
                          disabled={busy}
                          title="Send a reminder now"
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                        >
                          <BellRing className="h-3 w-3" /> Remind
                        </button>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          {p.source !== "waived" && (
                            <a
                              href={`/training/certificate/${p.assignment_id}`}
                              title="Certificate"
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                            >
                              <Award className="h-3 w-3" /> Certificate
                            </a>
                          )}
                          <button
                            onClick={() => {
                              if (confirm(`Reopen this training for ${p.name}? Their completion moves to history and they're asked to retake it.`))
                                void post({ reopen_assignment_id: p.assignment_id }, "Reopened — prior completion kept in history.");
                            }}
                            disabled={busy}
                            title="Reopen for this person"
                            className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                          >
                            <RotateCcw className="h-3 w-3" /> Reopen
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
