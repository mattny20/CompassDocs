"use client";

// Training home. "My training" for everyone; deck builder + progress
// dashboard for admins and Training-section grantees. Mirrors the
// CompliancePanel look so the two programs feel like siblings.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  CircleAlert,
  CircleCheck,
  Download,
  GraduationCap,
  LoaderCircle,
  Play,
  Plus,
  Send,
  Settings2,
  Users,
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
  assigned: number;
  completed: number;
}

const fmtDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : null);
const overdue = (it: MyItem) =>
  !it.completed_at && it.due_at !== null && new Date(it.due_at).getTime() < Date.now();

export function TrainingPanel({ licensed, manager }: { licensed: boolean; manager: boolean }) {
  const [tab, setTab] = useState<"mine" | "decks">("mine");
  const [mine, setMine] = useState<MyItem[] | null>(null);
  const [decks, setDecks] = useState<Deck[] | null>(null);
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
      ) : (
        <ManageDecks
          decks={decks}
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
            <Link
              href={`/training/take/${it.assignment_id}`}
              className={`mt-3 inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold ${
                it.completed_at
                  ? "border border-slate-200 text-slate-600 hover:bg-slate-50"
                  : "bg-compass-600 text-white hover:bg-compass-700"
              }`}
            >
              <Play className="h-4 w-4" />
              {it.completed_at ? "Review" : it.last_slide > 0 ? "Continue" : "Start"}
            </Link>
          </div>
        );
      })}
    </div>
  );
}

function ManageDecks({
  decks,
  candidates,
  userOpts,
  groupOpts,
  onError,
  onNotice,
  reload,
}: {
  decks: Deck[] | null;
  candidates: { id: number; title: string; space_name: string }[];
  userOpts: PickerOption[];
  groupOpts: PickerOption[];
  onError: (s: string) => void;
  onNotice: (s: string) => void;
  reload: () => Promise<void>;
}) {
  const [candidate, setCandidate] = useState("");
  const [dueDays, setDueDays] = useState("14");
  const [autoNew, setAutoNew] = useState(true);
  const [busy, setBusy] = useState(false);

  async function post(path: string, body: unknown, done: string) {
    setBusy(true);
    onError("");
    onNotice("");
    const res = await fetch(path, {
      method: path.includes("?patch") ? "PATCH" : "POST",
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
          <select
            value={candidate}
            onChange={(e) => setCandidate(e.target.value)}
            className="min-w-64 rounded-lg border border-slate-200 bg-surface px-2.5 py-1.5 text-sm text-slate-600 outline-hidden focus:border-compass-400"
          >
            <option value="">Choose a document…</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.space_name} — {c.title}
              </option>
            ))}
          </select>
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
                  document_id: Number(candidate),
                  due_days: dueDays ? Number(dueDays) : null,
                  assign_new_members: autoNew,
                },
                "Deck created — assign it below."
              )
            }
            disabled={!candidate || busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60"
          >
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create deck
          </button>
        </div>
      </section>

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
  const pct = deck.assigned ? Math.round((deck.completed / deck.assigned) * 100) : 0;

  async function assign(body: unknown) {
    setBusy(true);
    onError("");
    onNotice("");
    const res = await fetch(`/api/training/decks/${deck.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; assigned?: number; already?: number };
    if (!res.ok) onError(data.error || "Assignment failed.");
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
      </div>
    </section>
  );
}
