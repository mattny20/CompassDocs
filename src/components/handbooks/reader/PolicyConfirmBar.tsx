"use client";

// The bar at the end of a policy in the handbook reader (1.18.0): confirm
// this policy, then go on to the next one. It is the document page's read
// confirmation in a handbook's clothes, not a second flow: the same
// AckProvider state (seeded by the page exactly as /doc/{id} seeds it), the
// same POST /api/documents/{id}/ack with the version on screen and the
// reached-the-end latch, the same 409 {stale} refresh, and the same typed
// signature (the "Sign to confirm" block, the name matched under nameKey,
// the password for a local account) when the policy requires one or the
// handbook's "Require a typed signature" is on. The POST names the handbook
// (`handbook_id`), so the server applies the handbook's switch itself and
// admits a reader the handbook let in; the bar's `signature` only mirrors
// that rule. The server records the policy's own confirmation statement,
// so that is the sentence beside the tick box, never one written here.
//
// The tick box is the mock-up's: the button stays aria-disabled (focusable,
// with a visible reason under it) until the statement is ticked and, on a
// signature policy, the name matches. After a confirmation the page
// refreshes, so the contents rail's tick, the progress bar and the status
// chip follow the server's record; focus lands on the bar's done state.
//
// Three shapes: asked (the tick box and Confirm), confirmed (the done
// sentence, "View your record"), and not asked (one "For information"
// sentence when read confirmation is licensed; nothing but the navigation
// otherwise). "Next: {title}" is in every shape; on the last policy of a
// handbook that asks to be confirmed as a whole it becomes "Confirm
// handbook".

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Check, CircleCheckBig, PenLine, ShieldCheck } from "lucide-react";
import { Button } from "@/components/Button";
import { SubHeading } from "@/components/Heading";
import { Field, TextInput } from "@/components/form";
import { MarkdownView } from "@/components/MarkdownView";
import { useFormatDate } from "@/components/SettingsProvider";
import { useAckState } from "@/components/AckState";
import { DEFAULT_CONFIRMATION_STATEMENT, SIGN_FIRST_HELP } from "@/components/AckCard";
import { useAction } from "@/lib/use-action";
import { CONFIRM_SECTION_ID } from "@/lib/use-reached-end";

const STALE_MESSAGE =
  "This policy changed while you were reading it. The page has been refreshed; please read the changes.";

/** The visible reason under Confirm until the statement is ticked. */
export const TICK_FIRST_HELP = "Tick the statement to confirm";

/** Whitespace-collapsed, case-insensitive name comparison: the rule lib/attestation applies on the server. */
const nameKey = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

export interface ReaderLink {
  href: string;
  label: string;
}

export function PolicyConfirmBar({
  docId,
  handbookId,
  title,
  statement = DEFAULT_CONFIRMATION_STATEMENT,
  signature = false,
  localAccount = false,
  signedName = null,
  readerName,
  forInformation = false,
  prev = null,
  next = null,
  finish = null,
}: {
  docId: number;
  /** The handbook this policy is read in: sent as handbook_id, so its signature switch applies on the server. */
  handbookId: number;
  /** The policy's title, for the version line under the statement. */
  title: string;
  /** The confirmation statement the server records (the policy's own, else the workspace default). */
  statement?: string;
  /** A typed signature is asked (C2): the policy requires one, or the handbook does. */
  signature?: boolean;
  /** The reader's account has a password to re-enter. */
  localAccount?: boolean;
  /** The typed name on the reader's current confirmation, when it was signed. */
  signedName?: string | null;
  /** The name a signature must match. */
  readerName: string;
  /** Read confirmation is licensed but this policy does not ask this reader. */
  forInformation?: boolean;
  prev?: ReaderLink | null;
  next?: ReaderLink | null;
  /** On the last policy: "Confirm handbook" (the whole-handbook page). */
  finish?: ReaderLink | null;
}) {
  const ack = useAckState();
  const fmt = useFormatDate();
  const router = useRouter();
  const { run, isBusy } = useAction();
  const section = useRef<HTMLElement>(null);
  const helpId = useId();
  const [ticked, setTicked] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [password, setPassword] = useState("");
  const [signedAs, setSignedAs] = useState<string | null>(signedName);

  const asked = Boolean(ack && ack.canSubmit);
  const confirmed = asked && ack!.ackedAt !== null;
  // A kept edit (A2): the confirmation counts but cites an older version
  // than the text on screen, so the bar offers the re-confirmation.
  const canReconfirm =
    confirmed && ack!.ackedVersionId !== null && ack!.versionId !== null && ack!.ackedVersionId !== ack!.versionId;
  const showForm = asked && (!confirmed || canReconfirm);
  const signed = !signature || (typedName.trim() !== "" && nameKey(typedName) === nameKey(readerName));
  const ready = ticked && signed;

  async function confirm() {
    if (!ack || !ready) return;
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
          body: JSON.stringify({
            version_id: ack.versionId,
            reached_end: ack.reachedEnd,
            handbook_id: handbookId,
            ...(signature ? { signed_name: typedName.trim(), ...(localAccount ? { password } : {}) } : {}),
          }),
        });
        if (res.status === 409) {
          const data = (await res.json().catch(() => ({}))) as { stale?: boolean; error?: string };
          outcome.stale = Boolean(data?.stale);
          return new Response(JSON.stringify(data?.stale ? { error: STALE_MESSAGE } : data), {
            status: 409,
            headers: { "content-type": "application/json" },
          });
        }
        if (res.ok) outcome.recorded = (await res.json().catch(() => null)) as typeof outcome.recorded;
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
      ack.setAckedAt(recorded?.acknowledged_at ?? new Date().toISOString(), {
        versionId: recorded?.version_id ?? ack.versionId,
        rev: recorded?.rev ?? ack.rev,
      });
      if (signature) {
        setSignedAs(recorded?.signed_name ?? typedName.trim());
        setPassword("");
      }
      setTicked(false);
      section.current?.focus({ preventScroll: true });
    }
  }

  const versionLine = ack?.rev != null ? `${title} · version ${ack.rev}` : title;
  const gateHelp = !ticked ? TICK_FIRST_HELP : !signed ? SIGN_FIRST_HELP : null;
  const gateProps: { "aria-disabled"?: true; "aria-describedby"?: string } = ready
    ? {}
    : { "aria-disabled": true, "aria-describedby": helpId };

  // min-w-0 max-w-full, never shrink-0: a long title truncates inside its
  // button instead of pushing a 375px phone sideways.
  const nav = (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 sm:ml-auto">
      {prev && !next && !finish && (
        <Button href={prev.href} variant="secondary" icon={<ArrowLeft />} className="max-w-full">
          <span className="min-w-0 truncate">{prev.label}</span>
        </Button>
      )}
      {next && (
        <Button href={next.href} variant="secondary" className="max-w-full">
          <span className="min-w-0 truncate">Next: {next.label}</span>
          <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
        </Button>
      )}
      {!next && finish && (
        <Button href={finish.href} variant={confirmed || !asked ? "primary" : "secondary"} icon={<ShieldCheck />}>
          {finish.label}
        </Button>
      )}
    </div>
  );

  const statementBox = (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        className="mt-0.5 h-4.5 w-4.5 shrink-0"
        checked={ticked}
        onChange={(e) => setTicked(e.target.checked)}
        disabled={isBusy("ack")}
      />
      <span className="min-w-0">
        {/* !important: the prose rules in globals.css are unlayered,
            so a plain utility cannot size them down. */}
        <span className="block text-sm text-slate-700 [&_.doc-prose]:text-sm! [&_.doc-prose]:leading-6! [&_.doc-prose_p]:my-0!">
          <MarkdownView content={statement} docKey={`hb-ack-statement-${docId}`} inline />
        </span>
        <span className="mt-0.5 block text-xs text-slate-500">
          {canReconfirm ? `Re-confirm the current text: ${versionLine}` : versionLine}
        </span>
      </span>
    </label>
  );

  const confirmButton = (
    <div className="shrink-0">
      <Button
        variant="primary"
        icon={<Check />}
        busy={isBusy("ack")}
        onClick={() => void confirm()}
        {...gateProps}
        className="w-full aria-disabled:cursor-not-allowed aria-disabled:opacity-60 sm:w-auto"
      >
        {canReconfirm ? "Re-confirm" : "Confirm"}
      </Button>
    </div>
  );

  return (
    <section
      id={CONFIRM_SECTION_ID}
      ref={section}
      tabIndex={-1}
      aria-label={showForm ? "Confirm this policy" : confirmed ? "Confirmation recorded" : "Next policy"}
      className="mt-8 scroll-mt-20 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3.5 print:hidden"
    >
      {showForm && signature ? (
        // The style guide's order, which is also the tab order: the
        // statement, the "Sign to confirm" block, then Confirm and the
        // navigation, so a keyboard reader signs before reaching Confirm.
        <>
          {statementBox}
          <div className="mt-3 w-full max-w-md rounded-lg border border-slate-200 bg-canvas p-4 text-left sm:ml-7 sm:w-[calc(100%-1.75rem)]">
            <SubHeading as="h3" icon={<PenLine />}>
              Sign to confirm
            </SubHeading>
            <Field label="Type your full name to sign" help={`Exactly as it appears on your account: ${readerName}`} className="mt-2">
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
          <div className="mt-3 flex flex-col gap-3 sm:ml-7 sm:flex-row sm:items-center">
            {confirmButton}
            {nav}
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            {showForm ? (
              statementBox
            ) : confirmed ? (
              <p className="flex items-start gap-2 text-sm text-slate-700">
                <CircleCheckBig className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
                <span>
                  {ack!.ackedRev !== null
                    ? `You confirmed version ${ack!.ackedRev} on ${fmt.dateTime(ack!.ackedAt)}`
                    : `You confirmed this policy on ${fmt.dateTime(ack!.ackedAt)}`}
                  {signedAs ? `, signed as ${signedAs}` : ""}.{" "}
                  {/* A link inside the sentence: `link`, underlined. */}
                  <Link href="/compliance/person/me" className="link font-medium">
                    View your record
                  </Link>
                </span>
              </p>
            ) : forInformation ? (
              <p className="text-sm text-slate-600">For information. This policy doesn&apos;t ask you to confirm it.</p>
            ) : prev && (next || finish) ? (
              <Button href={prev.href} variant="ghost" icon={<ArrowLeft />} className="-ml-2 max-w-full">
                <span className="min-w-0 truncate">{prev.label}</span>
              </Button>
            ) : null}
          </div>
          {showForm && confirmButton}
          {nav}
        </div>
      )}
      {showForm && gateHelp && (
        <p id={helpId} className="mt-2 text-xs text-slate-500 sm:ml-7">
          {gateHelp}
        </p>
      )}
    </section>
  );
}
