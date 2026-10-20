"use client";

// The end-of-document confirmation card (B1, 1.10.0): the one place a reader
// records that they have read a document, placed after the article so the
// reading comes first. Laid out like the training deck's final gate panel —
// an icon in a 48px circle, the title, the confirmation statement as the only
// sentence, a meta line naming the version being confirmed, and one large
// primary button. The statement printed beside the button is the question;
// it does not open a dialog (STYLEGUIDE §Overlays).
//
// Nothing here is gated (B5): the button is live from first paint. The POST
// carries the version id the page rendered, so a document that changed while
// the person was reading answers 409 {stale} and the page refreshes into the
// new text instead of recording a confirmation of words they never saw. It
// also carries `reached_end` (C3, 1.11.0): whether the end of the article
// has been on screen, read from the shared latch; a self-report, stored as
// evidence beside the server-measured reading time, never a gate.
//
// A re-confirmation (B3, 1.11.0) does not look like a first request: above
// the statement one line says why the reader is asked again (the change
// note, the manager's reason, or the annual cycle), and when the text
// changed a native <details> lists the versions since the one they
// confirmed with the rendered diff against it and a link to the same
// compare in version history. A manual or annual re-ask with no text change
// shows the reason line and no disclosure: nothing changed to show. The
// texts arrive as props from the page, so no endpoint serves them.
//
// The statement (C2, 1.12.0) is the policy's own when it has one, else the
// workspace default, rendered through MarkdownView directly above the
// button so pressing the button is the attestation. When the policy
// requires a typed signature, the "Sign to confirm" block from the training
// player sits between the statement and the button: the full name, and for
// a local account the password; the button is aria-disabled, with the help
// "Sign above to confirm", until the typed name matches the account's
// (nameKey, the same rule lib/attestation applies on the server). The one
// exception to "nothing is gated": a signature is the reader's own act, and
// a button that posts an empty name would only come back 409. The done
// state and the printed standing line then read "signed as {name}".
//
// A deadline (E1, 1.13.0) is information, never a wall: a chip under the
// title says "Due 29 Oct 2026" (neutral beyond three days, warn at three or
// fewer) or "Overdue since 29 Oct 2026" (error), and on an overdue policy
// one sentence above the button says that confirming now still records
// today's date. The page formats both from the reader's own row; the button
// is the same button.
//
// The card is print:hidden; a one-line standing statement takes its place on
// paper so a printed policy carries the printer's own status.
//
// The confirmed state is a sentence, not a link: "View your record" arrives
// with My policies (1.11.1), the one page every reader can open. /compliance
// is the program view, gated on compliance.program_read, so a link there
// would bounce most readers to the dashboard.

import { useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CalendarClock, CircleAlert, CircleCheckBig, History, PenLine, ShieldCheck } from "lucide-react";
import { Button } from "@/components/Button";
import { CARD_CLASS } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { CardTitle, SubHeading } from "@/components/Heading";
import { DocDiff } from "@/components/DocDiff";
import { Field, TextInput } from "@/components/form";
import { MarkdownView } from "@/components/MarkdownView";
import { useFormatDate } from "@/components/SettingsProvider";
import { monthsLabel, useAckState } from "@/components/AckState";
import type { AckReason } from "@/components/AckState";
import { recertMetaLine } from "@/lib/ack-recert";
import type { DueTone } from "@/lib/ack-due";
import { diffLines, diffStats } from "@/lib/diff";
import { useAction } from "@/lib/use-action";
import { CONFIRM_SECTION_ID } from "@/lib/use-reached-end";

/** The house statement; the workspace and each policy may override it (E4, C2). */
export const DEFAULT_CONFIRMATION_STATEMENT = "I confirm that I have read and understood this document.";

const STALE_MESSAGE =
  "This document changed while you were reading it. The page has been refreshed; please read the changes.";

/** The visible help under the button until the typed name matches (C2). */
export const SIGN_FIRST_HELP = "Sign above to confirm";

/** Whitespace-collapsed, case-insensitive name comparison: the rule lib/attestation applies on the server. */
const nameKey = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** A version written since the one the reader confirmed (B3). */
export interface VersionSince {
  id: number;
  rev: number;
  note: string;
  author: string;
  createdAt: string;
}

/** A title and a text to compare (the confirmed version and the text on screen). */
export interface AckText {
  title: string;
  content: string;
}

/**
 * The one line above the statement that says why the reader is asked again.
 * Every text change reads as an update with its note; the manual and
 * per-person re-asks name who asked and why; the annual cycle says how long
 * it has been.
 */
export function reasonSentence(r: AckReason, date: (iso: string) => string): string {
  const quoted = (note: string) => (note ? `: "${note}"` : ".");
  switch (r.kind) {
    case "edit":
      return `Updated ${date(r.at)}${r.by ? ` by ${r.by}` : ""}${quoted(r.note)}`;
    case "manual":
      return `${r.by || "A manager"} asked everyone to confirm this document again on ${date(r.at)}${quoted(r.note)}`;
    case "person":
      return `${r.by || "A manager"} asked you to confirm this document again on ${date(r.at)}${quoted(r.note)}`;
    case "recurrence":
      return `Annual re-confirmation. It has been ${monthsLabel(r.months)} since you confirmed this document. Please read it again and confirm.`;
  }
}

export function AckCard({
  docId,
  statement = DEFAULT_CONFIRMATION_STATEMENT,
  signature = false,
  localAccount = false,
  signedName = null,
  meta,
  effectiveAt = null,
  recertMonths = null,
  due = null,
  readerName,
  current,
  baseline = null,
  changesSince = [],
}: {
  docId: number;
  /** The confirmation statement (the only sentence on the card), rendered as Markdown. */
  statement?: string;
  /** The policy requires a typed signature (C2): the Sign to confirm block gates the button. */
  signature?: boolean;
  /** The reader's account has a password to re-enter (a local account); SSO accounts sign with the name alone. */
  localAccount?: boolean;
  /** The typed name on the reader's current confirmation, when it was signed (C2). */
  signedName?: string | null;
  /** The version being confirmed: "Version 12 · published {date} by {author} · approved by {approvedBy}" (C6). */
  meta: { rev: number | null; publishedLabel: string | null; author: string; approvedBy?: string };
  /** The policy's effective date ('YYYY-MM-DD') and re-confirmation interval (G1): "Effective 1 Jan 2026 · re-confirm yearly" under the version line. */
  effectiveAt?: string | null;
  recertMonths?: number | null;
  /**
   * The reader's deadline (E1): dueChip's tone and label ("Due 29 Oct 2026"
   * / "Overdue since 29 Oct 2026") and, once overdue, overdueConfirmCopy's
   * sentence for the line above the button; null without a deadline. The
   * page formats them from the reader's own row; the chip and the sentence
   * leave with the pending state.
   */
  due?: { tone: DueTone; label: string; overdueCopy: string | null } | null;
  /** The signed-in reader: the name a signature must match, and the printed standing line's subject. */
  readerName: string;
  /** The text on screen, for the what-changed diff (B3). */
  current?: AckText;
  /** The text the reader confirmed (B3); null when it cannot be read. */
  baseline?: AckText | null;
  /** Versions written since the confirmed one, newest first (B3). */
  changesSince?: VersionSince[];
}) {
  const ack = useAckState();
  const fmt = useFormatDate();
  const router = useRouter();
  const { run, isBusy } = useAction();
  const section = useRef<HTMLElement>(null);
  const signHelpId = useId();
  // The signature as typed (C2). The name the record shows follows the
  // server's answer after a POST, so the done state never trusts the input.
  const [typedName, setTypedName] = useState("");
  const [password, setPassword] = useState("");
  const [signedAs, setSignedAs] = useState<string | null>(signedName);
  // Lines added and removed since the confirmed version: the disclosure's
  // header. Measured once per pair of texts, and only when there is a pair.
  const stats = useMemo(
    () => (baseline && current ? diffStats(diffLines(baseline.content, current.content)) : null),
    [baseline, current]
  );

  if (!ack || !ack.canSubmit) return null;

  const confirmed = ack.ackedAt !== null;
  const prior = confirmed ? null : (ack.prior ?? null);
  const versionLabel = (rev: number | null) => (rev !== null ? `version ${rev}` : null);
  // A kept edit (A2): the confirmation still counts but cites an older
  // version than the text on screen, so the card offers a re-confirmation.
  const canReconfirm =
    confirmed && ack.ackedVersionId !== null && ack.versionId !== null && ack.ackedVersionId !== ack.versionId;
  // The typed name matches the account's: the button is live (C2). Without
  // a signature requirement it always is.
  const signed = !signature || (typedName.trim() !== "" && nameKey(typedName) === nameKey(readerName));
  const showSignBlock = signature && (!confirmed || canReconfirm);

  async function confirm() {
    if (!ack || !signed) return;
    // Holders rather than plain lets: the assignments happen inside run()'s
    // callback, which TypeScript's narrowing cannot see.
    const outcome: {
      stale: boolean;
      recorded: { acknowledged_at: string; version_id: number | null; rev: number | null; signed_name?: string | null } | null;
    } = { stale: false, recorded: null };
    const ok = await run(
      "ack",
      async () => {
        const res = await fetch(`/api/documents/${docId}/ack`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          // The self-reported evidence (C3) rides with the version: the
          // server measures the reading time itself and trusts nothing else.
          // The signature (C2) rides along only when the policy asks for
          // one; the password only when the account has one to re-enter.
          body: JSON.stringify({
            version_id: ack.versionId,
            reached_end: ack.reachedEnd,
            ...(signature ? { signed_name: typedName.trim(), ...(localAccount ? { password } : {}) } : {}),
          }),
        });
        if (res.status === 409) {
          const data = (await res.json().catch(() => ({}))) as { stale?: boolean; error?: string };
          if (data?.stale) {
            // The house sentence for this case, through the same toast path
            // as every other failure; the refresh below makes it true.
            outcome.stale = true;
            return new Response(JSON.stringify({ error: STALE_MESSAGE }), {
              status: 409,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(JSON.stringify(data), { status: 409, headers: { "content-type": "application/json" } });
        }
        if (res.ok) {
          outcome.recorded = (await res.json().catch(() => null)) as typeof outcome.recorded;
        }
        return res;
      },
      { ok: "Confirmation recorded.", fallback: "Couldn't record your confirmation." }
    );
    if (outcome.stale) {
      router.refresh();
      return;
    }
    if (ok) {
      const { recorded } = outcome;
      const at = recorded?.acknowledged_at ?? new Date().toISOString();
      ack.setAckedAt(at, {
        versionId: recorded?.version_id ?? ack.versionId,
        rev: recorded?.rev ?? ack.rev,
      });
      if (signature) {
        setSignedAs(recorded?.signed_name ?? typedName.trim());
        setPassword("");
      }
      // The toast announces; focus lands on the section so the confirmed
      // state is the next thing a keyboard or screen-reader user meets.
      section.current?.focus({ preventScroll: true });
    }
  }

  const metaLine = [
    versionLabel(meta.rev) ? `Version ${meta.rev}` : null,
    meta.publishedLabel ? `published ${meta.publishedLabel}${meta.author ? ` by ${meta.author}` : ""}` : null,
    meta.approvedBy ? `approved by ${meta.approvedBy}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // The policy's dates (G1): the day it came into force and how often it
  // asks again; null when it has neither, and then no line. The effective
  // date is a calendar day ('YYYY-MM-DD'), so the day formatter: the
  // instant formatter would print the day before in any zone west of UTC.
  const recertLine = recertMetaLine(
    { ack_effective_at: effectiveAt, ack_recert_months: recertMonths, ack_next_recert_at: null },
    fmt.day
  );

  const signedClause = signedAs ? `, signed as ${signedAs}` : "";
  const confirmedSentence = confirmed
    ? versionLabel(ack.ackedRev)
      ? `You confirmed ${versionLabel(ack.ackedRev)} on ${fmt.dateTime(ack.ackedAt)}${signedClause}.`
      : `You confirmed reading this document on ${fmt.dateTime(ack.ackedAt)}${signedClause}.`
    : "";

  // The disclosure exists only when the text changed since the confirmed
  // version; a manual or annual re-ask without a text change has nothing
  // to show, and the reason line stands alone.
  const showChanges = Boolean(prior && prior.changed && changesSince.length > 0);
  const historyHref = prior && prior.versionId !== null ? `/doc/${docId}/history?from=${prior.versionId}&to=current` : null;

  // The "Sign to confirm" block (C2), the training player's recipe: a
  // bounded panel on the canvas tint, the name field with the account's
  // name as its help, and the password field for a local account.
  const signBlock = showSignBlock ? (
    <div className="mt-5 w-full max-w-md rounded-lg border border-slate-200 bg-canvas p-4 text-left">
      <SubHeading as="h3" icon={<PenLine />}>
        Sign to confirm
      </SubHeading>
      <Field
        label="Type your full name to sign"
        help={`Exactly as it appears on your account: ${readerName}`}
        className="mt-2"
      >
        <TextInput
          autoComplete="name"
          value={typedName}
          onChange={(e) => setTypedName(e.target.value)}
          disabled={isBusy("ack")}
        />
      </Field>
      {localAccount && (
        <Field label="Re-enter your account password" className="mt-3">
          <TextInput
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={isBusy("ack")}
          />
        </Field>
      )}
    </div>
  ) : null;

  // The button stays focusable while it waits for the signature
  // (aria-disabled, not disabled), so the help under it is discoverable
  // and read with the button's name; the click is ignored until then.
  const gateProps: { "aria-disabled"?: true; "aria-describedby"?: string; className?: string } = signed
    ? {}
    : { "aria-disabled": true, "aria-describedby": signHelpId, className: "aria-disabled:cursor-not-allowed aria-disabled:opacity-60" };
  const signHelp = !signed ? (
    <p id={signHelpId} className="mt-2 text-xs text-slate-500">
      {SIGN_FIRST_HELP}
    </p>
  ) : null;

  return (
    <>
      <section
        id={CONFIRM_SECTION_ID}
        ref={section}
        tabIndex={-1}
        aria-labelledby={`${CONFIRM_SECTION_ID}-title`}
        // scroll-mt-20 is the same 5rem the headings use to clear the sticky bar.
        className={`${CARD_CLASS} mt-10 scroll-mt-20 p-6 print:hidden sm:p-8`}
      >
        <div className="flex flex-col items-center text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-compass-50 text-compass-600">
            {confirmed ? (
              <CircleCheckBig className="h-6 w-6 text-emerald-500" aria-hidden />
            ) : (
              <ShieldCheck className="h-6 w-6" aria-hidden />
            )}
          </span>
          <CardTitle as="h2" id={`${CONFIRM_SECTION_ID}-title`} className="mt-3">
            {confirmed ? "Confirmation recorded" : "Confirm you've read this document"}
          </CardTitle>

          {confirmed ? (
            <>
              <p className="mt-2 max-w-md text-sm text-slate-600">{confirmedSentence}</p>
              {/* A kept edit (A2): the confirmation still counts but cites an
                  older version than the text on screen. Re-confirming posts
                  the latest version id; the ledger keeps both rows, and a
                  signature policy asks for the signature again. */}
              {canReconfirm && (
                <>
                  {signBlock}
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<ShieldCheck />}
                    busy={isBusy("ack")}
                    onClick={() => void confirm()}
                    {...gateProps}
                    className={`mt-3 ${gateProps.className ?? ""}`.trim()}
                  >
                    Re-confirm the current text{ack.rev !== null ? ` (v${ack.rev})` : ""}
                  </Button>
                  {signHelp}
                </>
              )}
            </>
          ) : (
            <>
              {/* The deadline (E1): a status chip, never a gate. */}
              {due && (
                <span className={chipClass(due.tone, "md", "mt-2")}>
                  {due.tone === "error" ? (
                    <CircleAlert className="h-3 w-3" aria-hidden />
                  ) : (
                    <CalendarClock className="h-3 w-3" aria-hidden />
                  )}
                  {due.label}
                </span>
              )}
              {prior?.reason && (
                <p className="mt-2 max-w-md text-sm font-medium text-slate-700">
                  {reasonSentence(prior.reason, fmt.date)}
                </p>
              )}
              {/* The statement as Markdown, at the card's own size (the
                  prose recipe is the document's; this is one sentence).
                  Inline-only: emphasis, a link, code; never an image, an
                  embed, a directive or a task list in what a reader signs. */}
              <div className="mt-2 max-w-md text-sm text-slate-600 [&_.doc-prose]:text-sm [&_.doc-prose]:leading-6 [&_.doc-prose]:text-slate-600 [&_.doc-prose_p]:my-0">
                <MarkdownView content={statement} docKey={`ack-statement-${docId}`} inline />
              </div>
              {metaLine && <p className="mt-1 text-xs text-slate-500">{metaLine}</p>}
              {recertLine && <p className="mt-0.5 text-xs text-slate-500">{recertLine}</p>}

              {showChanges && prior && (
                <details className="mt-5 w-full rounded-lg border border-slate-200 bg-surface text-left [&[open]>summary]:border-b [&[open]>summary]:border-slate-100">
                  <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-semibold text-slate-700 hover:text-compass-700 marker:text-compass-500">
                    What changed since you last confirmed ({changesSince.length} version
                    {changesSince.length === 1 ? "" : "s"})
                  </summary>
                  {prior.rev !== null && (
                    <p className="px-4 pt-3 text-xs text-slate-500">
                      Compared with version {prior.rev}
                      {prior.inferred ? " (version inferred)" : ""}, which you confirmed on {fmt.date(prior.ackedAt)}.
                    </p>
                  )}
                  <ol className="divide-y divide-slate-100 px-4 py-1 text-sm">
                    {changesSince.map((v) => (
                      <li key={v.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2">
                        <span className="font-medium text-slate-800">v{v.rev}</span>
                        {v.note && <span className="min-w-0 flex-1 text-slate-700">{v.note}</span>}
                        <span className="text-xs text-slate-500">
                          {v.author}
                          {v.author ? " · " : ""}
                          {fmt.date(v.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ol>
                  {stats && baseline && current && (
                    <>
                      <div className="border-t border-slate-100 px-4 py-2 text-xs font-medium text-slate-700">
                        <span className="text-emerald-600">+{stats.added}</span> /{" "}
                        <span className="text-red-500">−{stats.removed}</span> lines
                      </div>
                      {/* Bounded so a long policy's diff never swallows the
                          page; the diff folds unchanged runs on its own. */}
                      <div className="max-h-[max(24rem,50vh)] overflow-auto border-t border-slate-100">
                        <DocDiff
                          oldText={baseline.content}
                          newText={current.content}
                          oldTitle={baseline.title}
                          newTitle={current.title}
                          docKey={`since-${docId}`}
                          className="overflow-x-auto"
                        />
                      </div>
                    </>
                  )}
                  {historyHref && (
                    <div className="border-t border-slate-100 px-4 py-2.5 text-sm">
                      <Link
                        href={historyHref}
                        className="inline-flex items-center gap-1.5 font-medium text-compass-700 hover:underline"
                      >
                        <History className="h-4 w-4" aria-hidden />
                        Open in version history
                      </Link>
                    </div>
                  )}
                </details>
              )}

              {signBlock}

              {/* Overdue (E1): the same button; only the copy says the date
                  recorded is today's, not the one that passed. */}
              {due?.overdueCopy && <p className="mt-4 max-w-md text-sm text-slate-700">{due.overdueCopy}</p>}

              <Button
                variant="primary"
                size="lg"
                icon={<ShieldCheck />}
                busy={isBusy("ack")}
                onClick={() => void confirm()}
                {...gateProps}
                className={`mt-5 w-full sm:w-auto ${gateProps.className ?? ""}`.trim()}
              >
                I&apos;ve read and understood this
              </Button>
              {signHelp}
            </>
          )}
        </div>
      </section>

      {/* The printed policy carries the printer's standing instead of the card. */}
      <p className="mt-6 hidden text-xs text-slate-500 print:block">
        {confirmed
          ? `Read confirmation recorded for ${readerName} on ${fmt.dateTime(ack.ackedAt)}${
              versionLabel(ack.ackedRev) ? ` · ${versionLabel(ack.ackedRev)}` : ""
            }${signedAs ? ` · signed as ${signedAs}` : ""}`
          : `Read confirmation required. Not yet confirmed by ${readerName}`}
      </p>
    </>
  );
}
