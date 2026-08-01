// Auditor-grade training evidence (enterprise "training" entitlement):
// the people × decks compliance matrix, point-in-time snapshots hashed with
// SHA-256, per-question quiz analytics, and the one-click audit package (a
// ZIP of everything an auditor asks for, with a hash manifest). Server-only.

import "server-only";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import {
  listTrainingDecks,
  listTrainingHistory,
  listTrainingSnapshots,
  getTrainingSnapshot,
  insertTrainingSnapshot,
  trainingOrgRows,
  trainingOverview,
  trainingQuizResultRows,
  getTrainingDeck,
} from "@/lib/db";
import { deckQuestions } from "@/lib/training";
import { getAppSettings } from "@/lib/settings-store";
import { currentVersion } from "@/lib/version";

export const sha256Hex = (s: string | Buffer): string =>
  createHash("sha256").update(s).digest("hex");

export type MatrixCell = "completed" | "waived" | "overdue" | "open" | null;

export interface TrainingMatrix {
  decks: { id: number; title: string; tag: string }[];
  people: {
    user_id: number;
    name: string;
    username: string;
    /** Aligned with `decks`; null = not assigned. */
    cells: MatrixCell[];
  }[];
}

/**
 * The compliance matrix: every person with at least one assignment × every
 * active deck. Built from the org rows so counts match the CSV exactly.
 */
export async function buildTrainingMatrix(): Promise<TrainingMatrix> {
  const [decks, rows] = await Promise.all([listTrainingDecks(), trainingOrgRows()]);
  const deckIndex = new Map<string, number>();
  decks.forEach((d, i) => deckIndex.set(d.title, i));

  const byUser = new Map<number, { name: string; username: string; cells: MatrixCell[] }>();
  const now = Date.now();
  for (const r of rows) {
    let u = byUser.get(r.user_id);
    if (!u) {
      u = { name: r.name, username: r.username, cells: decks.map(() => null) };
      byUser.set(r.user_id, u);
    }
    const di = deckIndex.get(r.deck);
    if (di === undefined) continue;
    u.cells[di] = r.completed_at
      ? r.source === "waived"
        ? "waived"
        : "completed"
      : r.due_at && new Date(r.due_at).getTime() < now
        ? "overdue"
        : "open";
  }
  return {
    decks: decks.map((d) => ({ id: d.id, title: d.title, tag: d.tag })),
    people: [...byUser.entries()]
      .map(([user_id, u]) => ({ user_id, ...u }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const csvEsc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

export function matrixCsv(m: TrainingMatrix): string {
  const lines = [["person", "username", ...m.decks.map((d) => d.title)].map(csvEsc).join(",")];
  for (const p of m.people) {
    lines.push(
      [p.name, p.username, ...p.cells.map((c) => c ?? "not assigned")].map(csvEsc).join(",")
    );
  }
  return lines.join("\n") + "\n";
}

export function assignmentsCsv(rows: Awaited<ReturnType<typeof trainingOrgRows>>): string {
  const lines = [
    "training,name,username,email,assigned_at,due_at,completed_at,confirmed_version,quiz_score,quiz_total,prior_completions,signed_name,content_sha256,status",
  ];
  for (const r of rows) {
    const status = r.completed_at ? (r.source === "waived" ? "waived" : "completed") : "open";
    lines.push(
      [
        r.deck, r.name, r.username, r.email, r.assigned_at, r.due_at ?? "",
        r.completed_at ?? "", r.confirmed_version ?? "", r.quiz_score ?? "",
        r.quiz_total ?? "", r.prior_completions, r.signed_name ?? "",
        r.content_sha256 ?? "", status,
      ]
        .map(csvEsc)
        .join(",")
    );
  }
  return lines.join("\n") + "\n";
}

export function historyCsv(rows: Awaited<ReturnType<typeof listTrainingHistory>>): string {
  const lines = [
    "training,name,email,assigned_at,completed_at,confirmed_version,quiz_score,quiz_total,source,signed_name,content_sha256,closed_at",
  ];
  for (const r of rows) {
    lines.push(
      [
        r.deck_title, r.user_name, r.user_email, r.assigned_at, r.completed_at ?? "",
        r.confirmed_version ?? "", r.quiz_score ?? "", r.quiz_total ?? "", r.source,
        r.signed_name ?? "", r.content_sha256 ?? "", r.closed_at,
      ]
        .map(csvEsc)
        .join(",")
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * The canonical snapshot body: totals, per-deck stats, the matrix, and every
 * assignment row — serialized ONCE to a stable JSON string. The SHA-256 is
 * computed over exactly this text, and exactly this text is stored and
 * downloaded, so `sha256sum` on the file always reproduces the stored hash.
 */
export async function buildTrainingSnapshot(): Promise<{ text: string; sha256: string }> {
  const [settings, overview, decks, matrix, rows] = await Promise.all([
    getAppSettings(),
    trainingOverview(),
    listTrainingDecks(),
    buildTrainingMatrix(),
    trainingOrgRows(),
  ]);
  const body = {
    format: "compassdocs-training-snapshot/1",
    app_version: currentVersion(),
    workspace: settings.company_name,
    totals: {
      decks: overview.decks,
      people_assigned: overview.people_assigned,
      open: overview.open,
      overdue: overview.overdue,
      completed: overview.completed,
      waived: overview.waived,
    },
    decks: decks.map((d) => ({
      id: d.id, title: d.title, tag: d.tag, active: d.active === 1,
      due_days: d.due_days, pass_pct: d.pass_pct, recert_months: d.recert_months,
      require_signature: d.require_signature === 1,
      assigned: d.assigned, completed: d.completed, waived: d.waived, overdue: d.overdue,
    })),
    matrix,
    assignments: rows.map((r) => ({
      deck: r.deck, name: r.name, username: r.username, email: r.email,
      assigned_at: r.assigned_at, due_at: r.due_at, completed_at: r.completed_at,
      confirmed_version: r.confirmed_version, quiz_score: r.quiz_score,
      quiz_total: r.quiz_total, source: r.source, prior_completions: r.prior_completions,
      signed_name: r.signed_name, content_sha256: r.content_sha256,
    })),
  };
  const text = JSON.stringify(body, null, 2) + "\n";
  return { text, sha256: sha256Hex(text) };
}

/** Take + store a snapshot. Returns null when a monthly period is already taken. */
export async function takeTrainingSnapshot(
  kind: "manual" | "monthly",
  period: string,
  takenBy: string
): Promise<{ id: number; sha256: string } | null> {
  const { text, sha256 } = await buildTrainingSnapshot();
  const id = await insertTrainingSnapshot({ kind, period, takenBy, sha256, data: text });
  return id === null ? null : { id, sha256 };
}

export interface QuestionStat {
  question: string;
  attempts: number;
  correct: number;
  pct: number;
}

/**
 * Per-question quiz analytics for one deck: how often each question was
 * answered correctly across stored attempts (live + prior cycles). Attempts
 * recorded against an older question set (different length) are skipped —
 * the stats must line up with the questions as they stand.
 */
export async function deckQuestionStats(
  deckId: number,
  content: string
): Promise<QuestionStat[]> {
  const questions = deckQuestions(content);
  if (!questions.length) return [];
  const attempts = (await trainingQuizResultRows(deckId)).filter(
    (r) => r.length === questions.length
  );
  return questions.map((question, i) => {
    const correct = attempts.filter((r) => r[i]).length;
    return {
      question: question.text,
      attempts: attempts.length,
      correct,
      pct: attempts.length ? Math.round((correct / attempts.length) * 100) : 0,
    };
  });
}

/**
 * The one-click audit package: a ZIP with a manifest (file hashes), the
 * summary, matrix + assignments + history CSVs, and every stored snapshot.
 */
export async function buildAuditPackage(): Promise<Buffer> {
  const [settings, overview, decks, matrix, rows, history, snapshots] = await Promise.all([
    getAppSettings(),
    trainingOverview(),
    listTrainingDecks(),
    buildTrainingMatrix(),
    trainingOrgRows(),
    listTrainingHistory(),
    listTrainingSnapshots(),
  ]);

  const files: { name: string; content: string }[] = [
    {
      name: "summary.json",
      content:
        JSON.stringify(
          {
            format: "compassdocs-training-audit/1",
            generated_at: new Date().toISOString(),
            app_version: currentVersion(),
            workspace: settings.company_name,
            totals: {
              decks: overview.decks,
              people_assigned: overview.people_assigned,
              open: overview.open,
              overdue: overview.overdue,
              completed: overview.completed,
              waived: overview.waived,
            },
            decks: decks.map((d) => ({
              id: d.id, title: d.title, tag: d.tag, active: d.active === 1,
              due_days: d.due_days, pass_pct: d.pass_pct, recert_months: d.recert_months,
              require_signature: d.require_signature === 1,
              assigned: d.assigned, completed: d.completed, waived: d.waived,
              overdue: d.overdue,
            })),
          },
          null,
          2
        ) + "\n",
    },
    { name: "matrix.csv", content: matrixCsv(matrix) },
    { name: "assignments.csv", content: assignmentsCsv(rows) },
    { name: "history.csv", content: historyCsv(history) },
  ];
  for (const s of snapshots) {
    const full = await getTrainingSnapshot(s.id);
    if (!full) continue;
    const label = s.kind === "monthly" ? s.period : `manual-${s.id}`;
    files.push({ name: `snapshots/${label}.json`, content: full.data });
  }

  const zip = new JSZip();
  for (const f of files) zip.file(f.name, f.content);
  zip.file(
    "manifest.json",
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        app_version: currentVersion(),
        workspace: settings.company_name,
        files: files.map((f) => ({ name: f.name, sha256: sha256Hex(f.content) })),
      },
      null,
      2
    ) + "\n"
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** Deck lookup + question stats for the deck detail API. */
export async function deckStatsFor(deckId: number, content: string): Promise<QuestionStat[]> {
  const deck = await getTrainingDeck(deckId);
  if (!deck) return [];
  return deckQuestionStats(deckId, content);
}
