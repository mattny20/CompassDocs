"use client";

// Training home. "My training" for everyone; deck builder + progress
// dashboard for admins and Training-section grantees. Mirrors the
// CompliancePanel look so the two programs feel like siblings.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Archive,
  Award,
  BellRing,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Download,
  GraduationCap,
  Layers,
  LoaderCircle,
  Play,
  Plus,
  RotateCcw,
  Send,
  Settings2,
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
  assigned: number;
  completed: number;
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

export function TrainingPanel({ licensed, manager }: { licensed: boolean; manager: boolean }) {
  const [tab, setTab] = useState<"mine" | "overview" | "decks">("mine");
  const [mine, setMine] = useState<MyItem[] | null>(null);
  const [decks, setDecks] = useState<Deck[] | null>(null);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [archivedCount, setArchivedCount] = useState(0);
  const [candidates, setCandidates] = useState<{ id: number; title: string; space_name: string }[]>([]);
  const [userOpts, setUserOpts] = useState<PickerOption[]>([]);
  const [groupOpts, setGroupOpts] = useState<PickerOption[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    const my = await fetch("/api/training/my").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (my) setMine(my.items);
    if (manager) {
      const d = await fetch("/api/training/decks").then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (d) {
        setDecks(d.decks);
        setPrograms(d.programs ?? []);
        setArchivedCount(d.archived_count ?? 0);
        setCandidates(d.candidates);
        setUserOpts(d.users);
        setGroupOpts(d.groups);
      }
    }
  }, [manager]);
  useEffect(() => {
    if (licensed) void load();
  }, [licensed, load]);

  const Header = ({ extra }: { extra?: React.ReactNode }) => (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-slate-900">
          <GraduationCap className="h-5 w-5 text-compass-600" /> Training
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

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>
      )}
      {notice && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/40">
          {notice}
        </div>
      )}

      {tab === "mine" || !manager ? (
        <MyTraining mine={mine} />
      ) : tab === "overview" ? (
        <Overview />
      ) : (
        <ManageDecks
          decks={decks}
          programs={programs}
          archivedCount={archivedCount}
          candidates={candidates}
          userOpts={userOpts}
          groupOpts={groupOpts}
          onError={setError}
          onNotice={setNotice}
          reload={load}
        />
      )}
    </div>
  );
}

// --- Org-wide overview: KPIs, overdue list, whole-program CSV --------------

interface OverviewData {
  overview: {
    decks: number;
    people_assigned: number;
    open: number;
    overdue: number;
    completed: number;
    waived: number;
    overdue_people: { name: string; username: string; deck: string; due_at: string }[];
  };
  decks: Deck[];
}

function Overview() {
  const [data, setData] = useState<OverviewData | null>(null);
  useEffect(() => {
    void fetch("/api/training/overview")
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => {});
  }, []);
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

      <section className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">Decks</h2>
          <a
            href="/api/training/overview?format=csv"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            <Download className="h-4 w-4" /> All records (CSV)
          </a>
        </div>
        <ul className="mt-3 space-y-2">
          {data.decks.map((d) => {
            const p = d.assigned ? Math.round((d.completed / d.assigned) * 100) : 0;
            return (
              <li key={d.id} className="flex items-center gap-3 text-sm">
                <span className="w-56 truncate font-medium text-slate-700">{d.title}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-compass-500" style={{ width: `${p}%` }} />
                </div>
                <span className="w-24 text-right text-xs text-slate-400">
                  {d.completed}/{d.assigned} done
                </span>
              </li>
            );
          })}
          {data.decks.length === 0 && (
            <li className="text-sm text-slate-400">No decks yet — create one under Manage decks.</li>
          )}
        </ul>
      </section>

      <section className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
          <CircleAlert className="h-4 w-4 text-red-500" /> Overdue
        </h2>
        {o.overdue_people.length === 0 ? (
          <p className="mt-2 text-sm text-slate-400">Nobody is overdue.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100">
            {o.overdue_people.map((p, i) => (
              <li key={i} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                <span className="font-medium text-slate-700">{p.name}</span>
                <span className="min-w-0 flex-1 truncate text-slate-500">{p.deck}</span>
                <span className="shrink-0 text-xs font-medium text-red-600">
                  due {fmtDay(p.due_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function MyTraining({ mine }: { mine: MyItem[] | null }) {
  if (!mine) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-slate-400">
        <LoaderCircle className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (!mine.length) {
    return (
      <p className="rounded-xl border border-slate-200 bg-surface px-4 py-10 text-center text-sm text-slate-400 shadow-xs">
        Nothing assigned — when training lands here, you&apos;ll also get a notification.
      </p>
    );
  }
  return (
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
                {it.completed_at ? "Completed" : `${pct}% · ${it.slide_count} slides`}
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
  );
}

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

  // Most-recently-updated first (the API returns them that way); the picker
  // shows the top 10 on focus and filters as you type.
  const candidateOpts: PickerOption[] = candidates.map((c) => ({
    id: c.id,
    label: c.title,
    sublabel: c.space_name,
  }));
  const chosen = candidates.find((c) => c.id === candidate);

  async function post(path: string, body: unknown, done: string) {
    setBusy(true);
    onError("");
    onNotice("");
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) onError(data.error || "Something went wrong.");
    else onNotice(done);
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
          Pick a published document — slides split on <code>---</code> lines, and an optional{" "}
          <code>:::compliance</code> block at the end sets the confirmation wording.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="min-w-72 flex-1 sm:max-w-md">
            {chosen ? (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-compass-200 bg-compass-50 px-3 py-1.5 text-sm font-medium text-compass-800">
                {chosen.title}
                <span className="text-xs font-normal text-compass-600">{chosen.space_name}</span>
                <button
                  onClick={() => setCandidate(null)}
                  aria-label="Clear document choice"
                  className="opacity-60 hover:opacity-100"
                >
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
            onClick={() =>
              candidate &&
              void post(
                "/api/training/decks",
                {
                  document_id: candidate,
                  due_days: dueDays ? Number(dueDays) : null,
                  assign_new_members: autoNew,
                },
                "Deck created — assign it below."
              ).then(() => setCandidate(null))
            }
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

      {/* Decks */}
      {!decks ? (
        <div className="flex items-center gap-2 py-10 text-sm text-slate-400">
          <LoaderCircle className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : decks.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-surface px-4 py-8 text-center text-sm text-slate-400 shadow-xs">
          No training decks yet — create one above.
        </p>
      ) : (
        decks.map((d) => (
          <DeckCard key={d.id} deck={d} userOpts={userOpts} groupOpts={groupOpts} onError={onError} onNotice={onNotice} reload={reload} />
        ))
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

// --- Onboarding programs: named bundles of decks -----------------------------

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
  const [busy, setBusy] = useState(false);
  const deckOpts: PickerOption[] = decks.map((d) => ({
    id: d.id,
    label: d.title,
    sublabel: d.space_name,
  }));

  async function create() {
    setBusy(true);
    onError("");
    onNotice("");
    const res = await fetch("/api/training/programs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, deck_ids: deckIds }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) onError(data.error || "Could not create the program.");
    else {
      onNotice("Program created — new members will get every deck in it.");
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
            Bundle decks into a package — active programs are auto-assigned to every new member,
            and can be assigned to people or groups as one unit.
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
          <div className="flex items-center gap-2">
            <button
              onClick={() => void create()}
              disabled={busy || !name.trim() || !deckIds.length}
              className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60"
            >
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Create program
            </button>
            <button
              onClick={() => setCreating(false)}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-50"
            >
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
  userOpts,
  groupOpts,
  onError,
  onNotice,
  reload,
}: {
  program: Program;
  userOpts: PickerOption[];
  groupOpts: PickerOption[];
  onError: (s: string) => void;
  onNotice: (s: string) => void;
  reload: () => Promise<void>;
}) {
  const [assigning, setAssigning] = useState(false);
  const [userIds, setUserIds] = useState<number[]>([]);
  const [groupIds, setGroupIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  async function call(method: string, body?: unknown, done?: string) {
    setBusy(true);
    onError("");
    onNotice("");
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
            onClick={() => void call("PATCH", { active: program.active === 0 }, program.active === 0 ? "Program activated." : "Program deactivated — it will no longer auto-assign.")}
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
  const [showPeople, setShowPeople] = useState(false);
  const [people, setPeople] = useState<PersonRow[] | null>(null);
  const [dropoff, setDropoff] = useState<{ slide: number; n: number }[]>([]);
  const [passPct, setPassPct] = useState(String(deck.pass_pct));
  const [recert, setRecert] = useState(deck.recert_months ? String(deck.recert_months) : "");
  const pct = deck.assigned ? Math.round((deck.completed / deck.assigned) * 100) : 0;

  async function loadPeople() {
    const res = await fetch(`/api/training/decks/${deck.id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (res) {
      setPeople(res.rows);
      setDropoff(res.dropoff ?? []);
    }
  }

  async function assign(
    body: {
      waive?: boolean;
      remind_assignment_id?: number;
      reopen_completed?: boolean;
    } & Record<string, unknown>
  ) {
    setBusy(true);
    onError("");
    onNotice("");
    const res = await fetch(`/api/training/decks/${deck.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      assigned?: number;
      waived?: number;
      already?: number;
      reopened?: number;
    };
    if (!res.ok) onError(data.error || "Assignment failed.");
    else if (body.remind_assignment_id) onNotice("Reminder sent.");
    else if (body.reopen_completed)
      onNotice(`Reopened for ${data.reopened} ${data.reopened === 1 ? "person" : "people"} — prior completions kept in history.`);
    else if (body.waive)
      onNotice(
        `Waived for ${data.waived} ${data.waived === 1 ? "person" : "people"}${
          data.already ? ` (${data.already} already completed)` : ""
        } — recorded as waived, not completed.`
      );
    else
      onNotice(
        `Assigned to ${data.assigned} ${data.assigned === 1 ? "person" : "people"}${
          data.already ? ` (${data.already} already had it)` : ""
        }.`
      );
    setUserIds([]);
    setGroupIds([]);
    setBusy(false);
    await reload();
    if (people) await loadPeople();
  }

  async function patch(body: unknown) {
    setBusy(true);
    await fetch(`/api/training/decks/${deck.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    await reload();
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-slate-900">
            {deck.title}
            {deck.active === 0 && (
              <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium uppercase text-slate-500">
                inactive
              </span>
            )}
          </h3>
          <div className="text-xs text-slate-400">
            {deck.space_icon} {deck.space_name}
            {deck.due_days ? ` · due within ${deck.due_days} days` : ""}
            {deck.assign_new_members === 1 ? " · auto-assigns to new members" : ""}
            {deck.recert_months ? ` · recertifies every ${deck.recert_months} mo` : ""}
            {` · quiz pass ${deck.pass_pct}%`}
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <a
            href={`/api/training/decks/${deck.id}?format=csv`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50"
          >
            <Download className="h-4 w-4" /> CSV
          </a>
          <button
            onClick={() => void patch({ active: deck.active === 0 })}
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
                void patch({ archived: true });
            }}
            disabled={busy}
            title="Archive deck"
            aria-label={`Archive ${deck.title}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50"
          >
            <Archive className="h-4 w-4" /> Archive
          </button>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-compass-500" style={{ width: `${pct}%` }} />
        </div>
        <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-500">
          <Users className="h-3.5 w-3.5" /> {deck.completed}/{deck.assigned} complete
        </span>
      </div>

      {/* Quiz threshold + recertification cadence */}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-slate-600">
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
        <button
          onClick={() => {
            if (
              confirm(
                `Reopen "${deck.title}" for everyone who completed it? Use this after a material update — prior completions stay in the history, and everyone is asked to retake it.`
              )
            )
              void assign({ reopen_completed: true } as never);
          }}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Reopen completed
        </button>
        {dropoff.length > 0 && (
          <span className="text-xs text-slate-400">
            Most in-progress stop at slide{" "}
            {dropoff.reduce((a, b) => (b.n > a.n ? b : a), dropoff[0]).slide}
          </span>
        )}
      </div>

      {/* Per-person status */}
      <button
        onClick={() => {
          setShowPeople((s) => !s);
          if (!people) void loadPeople();
        }}
        className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-compass-600 hover:underline"
      >
        {showPeople ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        People ({deck.assigned})
      </button>
      {showPeople && (
        <div className="mt-2 overflow-x-auto rounded-lg border border-slate-100">
          {!people ? (
            <p className="flex items-center gap-2 px-3 py-3 text-sm text-slate-400">
              <LoaderCircle className="h-4 w-4 animate-spin" /> Loading…
            </p>
          ) : people.length === 0 ? (
            <p className="px-3 py-3 text-sm text-slate-400">Nobody assigned yet.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100">
                {people.map((p) => {
                  const status = p.completed_at
                    ? p.source === "waived"
                      ? "Waived"
                      : "Completed"
                    : p.due_at && new Date(p.due_at).getTime() < Date.now()
                      ? "Overdue"
                      : "Open";
                  return (
                    <tr key={p.assignment_id}>
                      <td className="px-3 py-1.5 font-medium text-slate-700">{p.name}</td>
                      <td className="px-2 py-1.5">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            status === "Completed"
                              ? "bg-emerald-100 text-emerald-700"
                              : status === "Waived"
                                ? "bg-slate-100 text-slate-500"
                                : status === "Overdue"
                                  ? "bg-red-100 text-red-700"
                                  : "bg-compass-50 text-compass-700"
                          }`}
                        >
                          {status}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-xs text-slate-400">
                        {p.quiz_total ? `quiz ${p.quiz_score}/${p.quiz_total}` : ""}
                        {p.prior_completions > 0 ? ` · ${p.prior_completions} prior` : ""}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {!p.completed_at ? (
                          <button
                            onClick={() =>
                              void assign({ remind_assignment_id: p.assignment_id } as never)
                            }
                            disabled={busy}
                            title="Send a reminder now"
                            className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                          >
                            <BellRing className="h-3 w-3" /> Remind
                          </button>
                        ) : p.source !== "waived" ? (
                          <a
                            href={`/training/certificate/${p.assignment_id}`}
                            title="Certificate"
                            className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                          >
                            <Award className="h-3 w-3" /> Certificate
                          </a>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2">
        <EntityPicker options={userOpts} value={userIds} onChange={setUserIds} placeholder="Add people…" />
        <EntityPicker options={groupOpts} value={groupIds} onChange={setGroupIds} placeholder="Add groups…" />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => void assign({ user_ids: userIds, group_ids: groupIds })}
          disabled={busy || (!userIds.length && !groupIds.length)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60"
        >
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Assign
        </button>
        <button
          onClick={() => {
            if (confirm(`Assign "${deck.title}" to every active member?`)) void assign({ everyone: true });
          }}
          disabled={busy}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          Assign to everyone
        </button>
        <span className="mx-1 h-4 border-l border-slate-200" aria-hidden />
        <button
          onClick={() => void assign({ user_ids: userIds, group_ids: groupIds, waive: true })}
          disabled={busy || (!userIds.length && !groupIds.length)}
          title="Mark as already done elsewhere — recorded as waived, no notification sent"
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
        >
          Waive selected
        </button>
        <button
          onClick={() => {
            if (
              confirm(
                `Waive "${deck.title}" for every current member? Use this when staff already did this training before CompassDocs — it's recorded as waived, not completed, and nobody is notified. New members added later still get assigned normally.`
              )
            )
              void assign({ everyone: true, waive: true });
          }}
          disabled={busy}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          Waive for everyone
        </button>
      </div>
    </section>
  );
}
