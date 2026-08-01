// Training decks (enterprise "training" entitlement). A published document
// becomes a slide deck: slides split on `---` lines, and an optional
// `:::compliance` block at the end supplies the wording for the final
// confirmation gate. Assignment, progress, and completion live in db.ts;
// this module owns slide parsing and the notification/reminder flows.

import {
  claimTrainingReminders,
  claimTrainingEscalations,
  claimRecertifications,
  getNotifyPrefsFor,
  listUsers,
} from "@/lib/db";
import { notify, notifyPrefAllows } from "@/lib/notifications";
import { renderEmail } from "@/lib/email-templates";
import { sendMail } from "@/lib/mailer";
import { getSmtpConfig, smtpConfigured } from "@/lib/smtp-config";
import { getAppSettings } from "@/lib/settings-store";
import { featureEnabled } from "@/lib/ee";
import { formatDate } from "@/lib/format";

export interface DeckSlides {
  slides: string[];
  /** Markdown body of the trailing :::compliance block, or null for the default wording. */
  complianceText: string | null;
}

export interface QuizQuestion {
  /** Markdown of the question line (after "Q:"). */
  text: string;
  options: string[];
  /** Indexes of the correct options. NEVER send this to the trainee. */
  correct: number[];
}

export interface Deck {
  slides: string[];
  complianceText: string | null;
  /** Quiz questions per slide (aligned with slides; empty array = no quiz on that slide). */
  quizzes: QuizQuestion[][];
}

/** Trainee-safe view of a question — the answer key stripped. */
export function publicQuiz(quizzes: QuizQuestion[][]): { text: string; options: string[]; multi: boolean }[][] {
  return quizzes.map((qs) =>
    qs.map((q) => ({ text: q.text, options: q.options, multi: q.correct.length > 1 }))
  );
}

const DEFAULT_COMPLIANCE =
  "I confirm that I have completed this training and understood the material.";

export function defaultComplianceText(): string {
  return DEFAULT_COMPLIANCE;
}

/**
 * Parse the body of a :::quiz block. Format:
 *   Q: question text
 *   - [ ] wrong option
 *   - [x] right option
 * Multiple `[x]` options make the question multi-select.
 */
function parseQuizBody(lines: string[]): QuizQuestion[] {
  const questions: QuizQuestion[] = [];
  let q: QuizQuestion | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    const qm = /^Q:\s*(.+)$/.exec(line);
    if (qm) {
      if (q && q.options.length) questions.push(q);
      q = { text: qm[1], options: [], correct: [] };
      continue;
    }
    const om = /^[-*]\s*\[( |x|X)\]\s*(.+)$/.exec(line);
    if (om && q) {
      if (om[1].toLowerCase() === "x") q.correct.push(q.options.length);
      q.options.push(om[2]);
    }
  }
  if (q && q.options.length) questions.push(q);
  // A question nobody can answer correctly is an authoring mistake — drop it.
  return questions.filter((x) => x.correct.length > 0 && x.options.length >= 2);
}

/**
 * Parse deck content: slides split on `---` lines (ignoring `---` inside
 * fenced code blocks), a trailing :::compliance block, and per-slide
 * :::quiz blocks. Quiz blocks are REMOVED from the slide markdown — the
 * player renders them interactively and the answer key stays server-side.
 * Pure.
 */
export function parseDeck(content: string): Deck {
  const lines = content.replace(/\r\n/g, "\n").split("\n");

  const slides: string[] = [];
  const quizzes: QuizQuestion[][] = [];
  let current: string[] = [];
  let currentQuiz: QuizQuestion[] = [];
  let fence: string | null = null;
  let compliance: string[] | null = null;
  let inCompliance = false;
  let quizBody: string[] | null = null;

  const flushSlide = () => {
    slides.push(current.join("\n").trim());
    quizzes.push(currentQuiz);
    current = [];
    currentQuiz = [];
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const mark = fenceMatch[1][0].repeat(3);
      if (!fence) fence = mark;
      else if (fence === mark) fence = null;
    }

    if (!fence && quizBody === null && !inCompliance && /^:::quiz\s*$/.test(line.trim())) {
      quizBody = [];
      continue;
    }
    if (quizBody !== null) {
      if (/^:::\s*$/.test(line.trim())) {
        currentQuiz.push(...parseQuizBody(quizBody));
        quizBody = null;
        continue;
      }
      quizBody.push(line);
      continue;
    }

    if (!fence && !inCompliance && /^:::compliance\s*$/.test(line.trim())) {
      inCompliance = true;
      compliance = [];
      continue;
    }
    if (inCompliance) {
      if (/^:::\s*$/.test(line.trim())) {
        inCompliance = false;
        continue;
      }
      compliance!.push(line);
      continue;
    }

    if (!fence && /^\s*---+\s*$/.test(line) && !/^\s*----/.test(line)) {
      flushSlide();
      continue;
    }
    current.push(line);
  }
  // An unterminated quiz block still counts.
  if (quizBody !== null) currentQuiz.push(...parseQuizBody(quizBody));
  flushSlide();

  // Drop empty slides (but keep their quizzes attached to the nearest kept
  // slide is overkill — an empty slide with a quiz keeps the slide).
  const kept: string[] = [];
  const keptQuizzes: QuizQuestion[][] = [];
  for (let i = 0; i < slides.length; i++) {
    if (slides[i].length > 0 || quizzes[i].length > 0) {
      kept.push(slides[i]);
      keptQuizzes.push(quizzes[i]);
    }
  }
  return {
    slides: kept.length ? kept : [""],
    quizzes: kept.length ? keptQuizzes : [[]],
    complianceText: compliance ? compliance.join("\n").trim() || null : null,
  };
}

/** Back-compat wrapper: slides + compliance only. */
export function splitSlides(content: string): DeckSlides {
  const d = parseDeck(content);
  return { slides: d.slides, complianceText: d.complianceText };
}

export function slideCount(content: string): number {
  return parseDeck(content).slides.length;
}

/** All quiz questions across the deck, in slide order. */
export function deckQuestions(content: string): QuizQuestion[] {
  return parseDeck(content).quizzes.flat();
}

/**
 * Grade submitted answers against the deck's questions. `answers[i]` is the
 * selected option indexes for question i (deck order). A question is right
 * only when the selected set equals the correct set exactly.
 */
export function gradeQuiz(
  content: string,
  answers: number[][]
): { score: number; total: number; results: boolean[] } {
  const questions = deckQuestions(content);
  const results = questions.map((q, i) => {
    const picked = [...new Set((answers[i] ?? []).filter(Number.isInteger))].sort((a, b) => a - b);
    const correct = [...q.correct].sort((a, b) => a - b);
    return picked.length === correct.length && picked.every((v, j) => v === correct[j]);
  });
  return { score: results.filter(Boolean).length, total: questions.length, results };
}

/** In-app + (pref-gated) email fan-out when a deck is assigned. */
export async function notifyTrainingAssigned(input: {
  userIds: number[];
  deckTitle: string;
  dueAt: string | null;
  assignerName: string;
  origin: string;
}): Promise<void> {
  if (!input.userIds.length) return;
  const settings = await getAppSettings();
  void notify(input.userIds, {
    kind: "training_assigned",
    title: `Training assigned: ${input.deckTitle}`,
    body: input.dueAt ? `Due by ${formatDate(input.dueAt, settings)}.` : "",
    link: "/training",
    actorName: input.assignerName,
  });

  const smtp = await getSmtpConfig();
  if (!smtpConfigured(smtp)) return;
  const users = (await listUsers()).filter(
    (u) => input.userIds.includes(u.id) && u.email && u.status === "active"
  );
  if (!users.length) return;
  const prefs = await getNotifyPrefsFor(users.map((u) => u.id));
  const origin = input.origin || (settings.custom_domain ? `https://${settings.custom_domain}` : "");
  const { subject, text, html } = await renderEmail(
    "training_assigned",
    {
      assigner_name: input.assignerName,
      deck_title: input.deckTitle,
      due_line: input.dueAt ? ` It's due by ${formatDate(input.dueAt, settings)}.` : "",
      training_url: `${origin}/training`,
    },
    origin
  );
  for (const u of users) {
    if (!notifyPrefAllows(prefs.get(u.id), "training_assigned", "email")) continue;
    await sendMail([u.email], subject, text, html).catch(() => {});
  }
}

/**
 * Hourly sweep entry (instrumentation.ts): remind assignees whose training
 * is due within 3 days or overdue — at most once per 3 days per assignment,
 * claimed atomically so restarts can't double-send.
 */
export async function remindDueTraining(): Promise<void> {
  if (!(await featureEnabled("training"))) return;
  const due = await claimTrainingReminders();
  if (!due.length) return;

  const settings = await getAppSettings();
  const origin = settings.custom_domain ? `https://${settings.custom_domain}` : "";

  for (const r of due) {
    void notify([r.user_id], {
      kind: "training_due",
      title: `Training due: ${r.title}`,
      body: `Due by ${formatDate(r.due_at, settings)}.`,
      link: "/training",
    });
  }

  const smtp = await getSmtpConfig();
  if (!smtpConfigured(smtp)) return;
  for (const r of due) {
    if (!r.email) continue;
    if (!notifyPrefAllows(r.notify_prefs, "training_due", "email")) continue;
    const { subject, text, html } = await renderEmail(
      "training_due",
      {
        deck_title: r.title,
        due_date: formatDate(r.due_at, settings),
        training_url: `${origin}/training`,
      },
      origin
    );
    await sendMail([r.email], subject, text, html).catch(() => {});
  }
}

/**
 * Manager "Remind now": immediate in-app notification plus (pref-gated)
 * email for the given open assignments of one deck. Returns the assignment
 * ids actually reminded — the caller stamps reminded_at so the hourly sweep
 * doesn't double-nudge within hours.
 */
export async function remindAssignmentsNow(
  deck: { id: number; title: string },
  assignmentIds: number[],
  actorName: string
): Promise<number[]> {
  const { trainingDeckStatus } = await import("@/lib/db");
  const settings = await getAppSettings();
  const wanted = new Set(assignmentIds);
  const rows = (await trainingDeckStatus(deck.id)).filter(
    (r) => wanted.has(r.assignment_id) && !r.completed_at
  );
  if (!rows.length) return [];

  for (const r of rows) {
    void notify([r.user_id], {
      kind: "training_due",
      title: `Reminder: ${deck.title}`,
      body: r.due_at ? `Due ${formatDate(r.due_at, settings)}.` : "Please complete this training.",
      link: "/training",
      actorName,
    });
  }

  const smtp = await getSmtpConfig();
  if (smtpConfigured(smtp)) {
    const prefs = await getNotifyPrefsFor(rows.map((r) => r.user_id));
    const origin = settings.custom_domain ? `https://${settings.custom_domain}` : "";
    for (const r of rows) {
      if (!r.email) continue;
      if (!notifyPrefAllows(prefs.get(r.user_id), "training_due", "email")) continue;
      const { subject, text, html } = await renderEmail(
        "training_due",
        {
          deck_title: deck.title,
          due_date: r.due_at ? formatDate(r.due_at, settings) : "soon",
          training_url: `${origin}/training`,
        },
        origin
      );
      await sendMail([r.email], subject, text, html).catch(() => {});
    }
  }
  return rows.map((r) => r.assignment_id);
}

/**
 * Escalation sweep: when someone is more than 7 days overdue, tell the deck's
 * creator once (per assignment). In-app only — this is a manager nudge, not a
 * broadcast.
 */
export async function escalateOverdueTraining(): Promise<void> {
  const rows = await claimTrainingEscalations();
  if (!rows.length) return;
  // One notification per deck per sweep, however many people crossed the line.
  const byDeck = new Map<number, { creator: number; title: string; count: number }>();
  for (const r of rows) {
    const cur = byDeck.get(r.deck_id);
    if (cur) cur.count += 1;
    else byDeck.set(r.deck_id, { creator: r.creator_id, title: r.title, count: 1 });
  }
  for (const d of byDeck.values()) {
    void notify([d.creator], {
      kind: "training_due",
      title: `Overdue training: ${d.title}`,
      body: `${d.count} ${d.count === 1 ? "person is" : "people are"} more than a week overdue.`,
      link: "/training",
    });
  }
}

/**
 * Recertification sweep: completed assignments on decks with a recert
 * interval reopen once the interval elapses. The prior completion is archived
 * to history first (claimRecertifications does both atomically).
 */
export async function recertifyDueTraining(): Promise<void> {
  const reopened = await claimRecertifications();
  if (!reopened.length) return;
  const settings = await getAppSettings();
  for (const r of reopened) {
    void notify([r.user_id], {
      kind: "training_assigned",
      title: `Recertification due: ${r.title}`,
      body: r.due_at ? `Complete it again by ${formatDate(r.due_at, settings)}.` : "Time to take this training again.",
      link: "/training",
    });
  }
}

/** Hourly orchestrator for all training sweeps (instrumentation.ts). */
export async function trainingHourly(): Promise<void> {
  if (!(await featureEnabled("training"))) return;
  await remindDueTraining().catch(() => {});
  await escalateOverdueTraining().catch(() => {});
  await recertifyDueTraining().catch(() => {});
}
