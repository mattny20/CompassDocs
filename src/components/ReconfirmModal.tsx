"use client";

// The re-confirmation question (A3, 1.10.0): when the text of a confirmed
// document is about to be saved, the editor asks how readers should see the
// change. One choice dialog (STYLEGUIDE §Overlays): the question as the
// title, a lede with the numbers that matter, two stacked radio cards, one
// hint sentence from the change-size heuristic (lib/diff) that pre-selects a
// card, a "Show changes" disclosure for the evidence, one change note that
// both choices require, and a primary button whose label says what will
// happen. The promise is awaited BEFORE the caller sets any busy state, so
// Cancel (or Escape) leaves the form dirty and the Save button idle. Being a
// Modal, it sits on the overlay stack, so overlayOpen() keeps Ctrl+S from
// opening a second one.
//
//   const answer = await reconfirmDialog({ … });   // { policy, note } | null
//
// One <ReconfirmHost /> is mounted by the document editor. Without a host
// the promise resolves null, which a caller treats as Cancel: a save of a
// confirmed document can never proceed unasked.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "./Button";
import { DocDiff } from "./DocDiff";
import { Field, Textarea } from "./form";
import { Modal } from "./Modal";
import { changeSummary, describeChange, suggestReconfirm } from "@/lib/diff";
import type { ChangeSummary, ReconfirmSuggestion } from "@/lib/diff";
import type { EditDefault } from "@/lib/compliance-settings";

export type AckPolicy = "keep" | "reset";

export interface ReconfirmText {
  title: string;
  content: string;
}

export interface ReconfirmOptions {
  /** "save" publishes directly; "submit" sends the change to the review queue. */
  mode: "save" | "submit";
  docId: number;
  docTitle: string;
  /** People whose confirmation counts today, and the audience they are part of. */
  current: number;
  eligible: number;
  /** The confirmed version's number ("version 12"); null when unknown. */
  rev: number | null;
  /** The text readers last confirmed (or the loaded text when it could not be fetched). */
  baseline: ReconfirmText;
  /** The text about to be saved. */
  next: ReconfirmText;
  /** One sentence from describeChange, and the card it pre-selects. */
  hint: string;
  suggested: AckPolicy;
  /** Prefills the change note (the editor's own field). */
  initialNote: string;
  /**
   * The document's edit default (A5), for the help line: under 'material'
   * the question opened because the change does not look editorial.
   */
  editDefault?: EditDefault;
  /**
   * The workspace's "Require a reason for editorial fixes too" (E4). True
   * when absent. A material change always needs its note; with this off an
   * editorial fix may be saved without one (anything typed is still kept).
   */
  keepReasonRequired?: boolean;
}

export interface ReconfirmResult {
  policy: AckPolicy;
  /** Trimmed; at least NOTE_MIN characters. */
  note: string;
}

/** The server refuses a shorter reason for either policy (A2). */
export const NOTE_MIN = 10;
export const NOTE_MAX = 500;
export const NOTE_TOO_SHORT = `Add a change note of at least ${NOTE_MIN} characters.`;

export const RECONFIRM_TITLE: Record<ReconfirmOptions["mode"], string> = {
  save: "How should readers see this change?",
  submit: "Submit changes to a confirmed document?",
};

// The approved copy says the note "is shown with the re-confirmation request"
// and that readers "are notified and shown what changed"; the notice (H1/H4)
// and the what-changed view (B3) ship in 1.10.1, so until then the dialog
// promises only what this release does.
const HELP: Record<AckPolicy, string> = {
  keep: "Say why readers need not re-confirm. This is recorded on the compliance record.",
  reset: "Tell readers what changed. This note is kept in version history and on the compliance record.",
};
/** The keep side when the workspace does not require a reason for editorial fixes (E4). */
const HELP_KEEP_OPTIONAL =
  "Optional: say why readers need not re-confirm. Anything you write is recorded on the compliance record.";

/** The line under the hint that explains why the question opened under the document's setting (A5). */
const SETTING_NOTE: Partial<Record<EditDefault, string>> = {
  material: "This document asks only when a change looks material (its read confirmation setting).",
};

function people(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

/** The primary button always says what will happen. */
export function primaryLabel(mode: ReconfirmOptions["mode"], policy: AckPolicy, current: number): string {
  if (mode === "submit") {
    return policy === "keep" ? "Submit. Recommend keeping confirmations" : "Submit. Recommend re-confirmation";
  }
  if (policy === "keep") return "Save. Keep confirmations";
  return current > 0 ? `Save and ask ${people(current)} to re-confirm` : "Save and ask readers to re-confirm";
}

// ── The measurement (A4) ─────────────────────────────────────────────────────

/** Order of severity: a reset suggestion outranks a keep, and within a policy
 *  the higher confidence of a reset (or the lower confidence of a keep) ranks
 *  higher; ties go to the larger share of words changed. */
function rank(s: ReconfirmSuggestion): number {
  if (s.policy === "reset") return s.confidence === "high" ? 3 : 2;
  return s.confidence === "low" ? 1 : 0;
}

export interface ChangeAssessment {
  summary: ChangeSummary;
  suggestion: ReconfirmSuggestion;
  hint: string;
  suggested: AckPolicy;
  /** True when the sentence describes the drift since the confirmed version. */
  sinceBaseline: boolean;
}

/**
 * Measure the edit against the loaded text and against the confirmed
 * baseline, and keep the worse of the two: five small "editorial" saves in a
 * row each look tiny, while the drift since the last re-confirmation does
 * not. The sentence names the baseline ("since v12") when that is the
 * measurement shown.
 */
export function assessChange(args: {
  baseline: ReconfirmText | null;
  loaded: ReconfirmText;
  next: ReconfirmText;
  baselineLabel?: string;
}): ChangeAssessment {
  const vsLoaded = changeSummary(args.loaded.content, args.next.content, {
    oldTitle: args.loaded.title,
    newTitle: args.next.title,
  });
  const candidates: Array<{ summary: ChangeSummary; sinceBaseline: boolean }> = [
    { summary: vsLoaded, sinceBaseline: false },
  ];
  if (args.baseline) {
    const vsBaseline = changeSummary(args.baseline.content, args.next.content, {
      oldTitle: args.baseline.title,
      newTitle: args.next.title,
    });
    candidates.unshift({ summary: vsBaseline, sinceBaseline: true });
  }
  let worst = candidates[0];
  let worstRank = rank(suggestReconfirm(worst.summary));
  for (const c of candidates.slice(1)) {
    const r = rank(suggestReconfirm(c.summary));
    if (r > worstRank || (r === worstRank && c.summary.pct > worst.summary.pct)) {
      worst = c;
      worstRank = r;
    }
  }
  const suggestion = suggestReconfirm(worst.summary);
  return {
    summary: worst.summary,
    suggestion,
    suggested: suggestion.policy,
    hint: describeChange(worst.summary, worst.sinceBaseline ? args.baselineLabel : undefined),
    sinceBaseline: worst.sinceBaseline,
  };
}

// ── The promise API and its host ─────────────────────────────────────────────

type Request = { opts: ReconfirmOptions; resolve: (r: ReconfirmResult | null) => void };

let host: ((req: Request) => void) | null = null;

export function reconfirmDialog(opts: ReconfirmOptions): Promise<ReconfirmResult | null> {
  return new Promise((resolve) => {
    if (host) host({ opts, resolve });
    else resolve(null);
  });
}

/** Mounted once by the document editor (the Modal portals to <body>). */
export function ReconfirmHost() {
  const [queue, setQueue] = useState<Request[]>([]);
  const current = queue[0];

  useEffect(() => {
    host = (req) => setQueue((q) => [...q, req]);
    return () => {
      host = null;
    };
  }, []);

  const finish = useCallback(() => setQueue((q) => q.slice(1)), []);

  if (!current) return null;
  return <ReconfirmModal key={queue.length} opts={current.opts} onDone={current.resolve} onFinish={finish} />;
}

// ── The dialog ───────────────────────────────────────────────────────────────

export function ReconfirmModal({
  opts,
  onDone,
  onFinish,
}: {
  opts: ReconfirmOptions;
  /** The answer, or null for Cancel. */
  onDone: (result: ReconfirmResult | null) => void;
  /** Called once after onDone, when the host should drop the request. */
  onFinish?: () => void;
}) {
  const [policy, setPolicy] = useState<AckPolicy>(opts.suggested);
  const [note, setNote] = useState(opts.initialNote);
  const [error, setError] = useState<string | undefined>();
  const [showDiff, setShowDiff] = useState(false);
  const [settled, setSettled] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const titleId = "reconfirm-title";
  const ledeId = "reconfirm-lede";

  function settle(result: ReconfirmResult | null) {
    if (settled) return;
    setSettled(true);
    onDone(result);
    onFinish?.();
  }
  const cancel = useCallback(() => settle(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  // The keep side is excused only when the workspace says so; a reset
  // always needs its note (the server refuses the same way, A2).
  const noteRequired = policy === "reset" || opts.keepReasonRequired !== false;

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const trimmed = note.trim();
    if (noteRequired && trimmed.length < NOTE_MIN) {
      setError(NOTE_TOO_SHORT);
      noteRef.current?.focus();
      return;
    }
    settle({ policy, note: trimmed.slice(0, NOTE_MAX) });
  }

  const versionPhrase = opts.rev !== null ? `version ${opts.rev}` : "the current version";
  // The same agreement rule as the roster sentence (ack-sentence.ts): the
  // audience decides the noun, "1 of 1 person has", "3 of 50 people have".
  const audience = opts.eligible === 1 ? "person has" : "people have";
  const resets =
    opts.current === 1 ? "1 confirmation is reset" : `${opts.current} confirmations are reset`;
  const cards: Array<{ value: AckPolicy; label: string; description: string }> = [
    {
      value: "keep",
      label: "Editorial fix. Keep confirmations",
      description:
        "Typos, formatting, broken links, layout. No change in meaning or obligations. Nobody is asked again; the version is still recorded in history.",
    },
    {
      value: "reset",
      label: "Material change. Ask everyone to re-confirm",
      description: `The meaning, scope or an obligation changed. ${resets} and everyone is asked to read the new text.`,
    },
  ];

  return (
    <Modal
      open
      onClose={cancel}
      labelledBy={titleId}
      describedBy={ledeId}
      className="max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal"
    >
      <form onSubmit={submit}>
        <h2 id={titleId} className="text-base font-semibold text-slate-900">
          {RECONFIRM_TITLE[opts.mode]}
        </h2>
        <p id={ledeId} className="mt-1 text-sm text-slate-600">
          {opts.current} of {opts.eligible} {audience} confirmed {versionPhrase} of &ldquo;{opts.docTitle}&rdquo;.
        </p>

        {/* Native radios: Tab lands on the chosen card, arrows move the choice,
            Enter submits (handled here so every browser agrees). The wrapping
            label is the click target; the input's accessible name is the
            label line alone and the sentence under it is its description,
            so a screen reader does not read the whole card on every arrow. */}
        <div
          role="radiogroup"
          aria-labelledby={titleId}
          className="mt-4 space-y-2"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        >
          {cards.map((c) => {
            const checked = policy === c.value;
            const labelId = `ack-policy-${c.value}-label`;
            const descId = `ack-policy-${c.value}-desc`;
            return (
              <label
                key={c.value}
                className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition ${
                  checked ? "border-compass-300 bg-compass-50/60" : "border-slate-200 hover:bg-slate-50"
                }`}
              >
                <input
                  type="radio"
                  name="ack-policy"
                  value={c.value}
                  checked={checked}
                  onChange={() => setPolicy(c.value)}
                  aria-labelledby={labelId}
                  aria-describedby={descId}
                  data-autofocus={checked ? "" : undefined}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-compass-600"
                />
                <span className="min-w-0">
                  <span id={labelId} className="block text-sm font-medium text-slate-800">
                    {c.label}
                  </span>
                  <span id={descId} className="mt-0.5 block text-xs text-slate-500">
                    {c.description}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        <p className="mt-3 text-sm text-slate-600">{opts.hint}</p>
        {opts.editDefault && SETTING_NOTE[opts.editDefault] && (
          <p className="mt-1 text-xs text-slate-500">{SETTING_NOTE[opts.editDefault]}</p>
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={showDiff ? <ChevronDown /> : <ChevronRight />}
          aria-expanded={showDiff}
          onClick={() => setShowDiff((o) => !o)}
          className="mt-1 -ml-2.5"
        >
          {showDiff ? "Hide changes" : "Show changes"}
        </Button>
        {showDiff && (
          <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-slate-200">
            <DocDiff
              oldText={opts.baseline.content}
              newText={opts.next.content}
              oldTitle={opts.baseline.title}
              newTitle={opts.next.title}
              docKey={`reconfirm-${opts.docId}`}
            />
          </div>
        )}

        <div className="mt-4">
          <Field
            label={noteRequired ? "Change note" : "Change note (optional)"}
            help={noteRequired ? HELP[policy] : HELP_KEEP_OPTIONAL}
            error={error}
          >
            <Textarea
              ref={noteRef}
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                if (error) setError(undefined);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={2}
              maxLength={NOTE_MAX}
              placeholder="What changed and why? e.g. Expense cap raised to £75; receipts required over £20"
            />
          </Field>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            {primaryLabel(opts.mode, policy, opts.current)}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
