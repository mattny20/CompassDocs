"use client";

// Confirm the whole handbook (1.18.0): the list of every policy with where
// it stands for the reader, then one card with the statement to tick, the
// typed signature when one is asked, and the button that confirms every
// policy still waiting.
//
// A policy that asks to be confirmed in its own words (its own
// confirmation statement, not the handbook's sentence) is listed under the
// statement: the one box covers the handbook's statement and every listed
// one, and each listed policy's row stores its own words (lib/handbook-confirm).
//
// The statement printed beside the box is the question; the button does
// not open a dialog (STYLEGUIDE §Feedback, "An attestation whose statement
// is printed beside the button is the question"). The button stays
// focusable while it waits (aria-disabled with a visible reason, never
// disabled), as the policy card's does. The POST carries the version each
// outstanding policy showed here, so a policy that changed meanwhile
// answers 409 {stale} and the page refreshes into it instead of recording
// a confirmation of words nobody saw.
//
// The done state is a sentence in the same card ("You confirmed this
// handbook on …") with the reader's record beside it; the toast is the
// announcement and focus moves to the card.

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, CircleCheckBig, ClipboardCheck, PenLine } from "lucide-react";
import { Button } from "@/components/Button";
import { CARD_CLASS, Card } from "@/components/Card";
import { CardTitle, SubHeading } from "@/components/Heading";
import { Field, TextInput } from "@/components/form";
import { MarkdownView } from "@/components/MarkdownView";
import { useFormatDate } from "@/components/SettingsProvider";
import { toast } from "@/components/Toasts";
import { useAction } from "@/lib/use-action";
import {
  CONFIRM_STALE,
  OWN_STATEMENTS_INTRO,
  SIGN_FIRST_HELP,
  TICK_FIRST_HELP,
  confirmButtonLabel,
  confirmedToast,
  countsLine,
  nameKey,
  signatureReason,
} from "@/lib/handbook-confirm-shared";
import type { ConfirmResult, HandbookConfirmView } from "@/lib/handbook-confirm-shared";
import { StandingChip } from "./StandingChip";

export function HandbookConfirm({ view, readerName }: { view: HandbookConfirmView; readerName: string }) {
  const fmt = useFormatDate();
  const router = useRouter();
  const { run, isBusy } = useAction();
  const card = useRef<HTMLElement>(null);
  const helpId = useId();
  const titleId = useId();
  const ownId = useId();
  const [agreed, setAgreed] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [password, setPassword] = useState("");

  const { handbook, items, counts, signature } = view;
  const own = view.own_statements;
  const base = `/handbooks/${handbook.id}`;
  const busy = isBusy("confirm");
  const done = view.confirmed !== null;

  const signed = !signature.required || (typedName.trim() !== "" && nameKey(typedName) === nameKey(readerName));
  const ready = agreed && signed;
  const waitingHelp = !agreed ? TICK_FIRST_HELP : !signed ? SIGN_FIRST_HELP : null;

  async function confirm() {
    if (!ready) return;
    const outcome: { stale: boolean; result: ConfirmResult | null } = { stale: false, result: null };
    // Every outstanding policy at the version this page showed.
    const versions = Object.fromEntries(
      items
        .filter((i) => (i.standing === "to_confirm" || i.standing === "updated") && i.version_id !== null)
        .map((i) => [i.doc_id, i.version_id])
    );
    const ok = await run(
      "confirm",
      async () => {
        const res = await fetch(`/api/handbooks/${handbook.id}/confirm`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agreed: true,
            versions,
            ...(signature.required
              ? { signed_name: typedName.trim(), ...(signature.local_account ? { password } : {}) }
              : {}),
          }),
        });
        if (res.status === 409) {
          const data = (await res.json().catch(() => ({}))) as { stale?: boolean; error?: string };
          // The house sentence for a stale page, through the same toast
          // path as every other failure; the refresh below makes it true.
          if (data?.stale) outcome.stale = true;
          return new Response(JSON.stringify({ error: data?.stale ? CONFIRM_STALE : data?.error }), {
            status: 409,
            headers: { "content-type": "application/json" },
          });
        }
        if (res.ok) {
          outcome.result = (await res.json().catch(() => null)) as ConfirmResult | null;
          // A policy that changed between the check and its own write:
          // the others are recorded; say so and show what changed.
          if (outcome.result && outcome.result.stale.length > 0) {
            outcome.stale = true;
            return new Response(JSON.stringify({ error: CONFIRM_STALE }), {
              status: 409,
              headers: { "content-type": "application/json" },
            });
          }
        }
        return res;
      },
      // No fixed ok sentence: the toast below carries the count.
      { fallback: "Couldn't record your confirmation." }
    );
    if (outcome.stale) {
      router.refresh();
      return;
    }
    if (ok && outcome.result) {
      setPassword("");
      toast("ok", confirmedToast(outcome.result));
      card.current?.focus({ preventScroll: true });
    }
  }

  return (
    <div className="space-y-5">
      <Card padding="none">
        {/* The card's own header row (Card's recipe), so the count line can
            wrap under the title on a phone and the title is this page's h2. */}
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-slate-100 px-4 py-3">
          <CardTitle as="h2" className="">
            {counts.total} {counts.total === 1 ? "policy" : "policies"}
          </CardTitle>
          <p className="text-sm text-slate-500">{countsLine(counts)}</p>
        </div>
        <ol className="divide-y divide-slate-100">
          {items.map((i) => (
            <li key={i.doc_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
              <Link
                href={`${base}/${i.doc_id}`}
                className="min-w-0 flex-1 text-sm font-medium text-slate-800 hover:text-compass-700 hover:underline"
              >
                <span className="sr-only">Policy {i.number}: </span>
                {i.title}
              </Link>
              <StandingChip standing={i.standing} />
            </li>
          ))}
        </ol>
      </Card>

      <section
        ref={card}
        tabIndex={-1}
        aria-labelledby={titleId}
        className={`${CARD_CLASS} scroll-mt-20 p-5 print:hidden`}
      >
        <h2 id={titleId} className="sr-only">
          {done ? "Handbook confirmed" : "Confirm the handbook"}
        </h2>
        {done && view.confirmed ? (
          <>
            <p className="flex items-start gap-2 text-sm text-slate-700">
              <CircleCheckBig className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
              <span>You confirmed this handbook on {fmt.dateTime(view.confirmed.at)}.</span>
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              {/* The reader's own record: every policy, with the evidence. */}
              <Link
                href="/compliance/person/me"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-compass-700 hover:underline"
              >
                <ClipboardCheck className="h-4 w-4" aria-hidden />
                View your record
              </Link>
              <Button variant="secondary" href={base}>
                Back to the handbook
              </Button>
            </div>
          </>
        ) : (
          <>
            <label className="flex items-start gap-2.5 text-base text-slate-800">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                disabled={busy}
                aria-describedby={own.length > 0 ? ownId : undefined}
              />
              <span>{view.statement}</span>
            </label>
            {own.length > 0 && (
              // Under the statement, in line with its text: the box above covers these too.
              <div id={ownId} className="mt-3 pl-6.5 text-sm text-slate-600">
                <p>{OWN_STATEMENTS_INTRO}</p>
                <ul className="mt-2 space-y-2.5">
                  {own.map((o) => (
                    <li key={o.doc_id} className="border-l-2 border-slate-200 pl-3">
                      <p className="font-medium text-slate-800">{o.title}</p>
                      {/* !important: the prose rules in globals.css are unlayered,
                          so a plain utility cannot size them down. */}
                      <div className="mt-0.5 text-slate-700 [&_.doc-prose]:text-sm! [&_.doc-prose]:leading-6! [&_.doc-prose_p]:my-0!">
                        <MarkdownView content={o.statement} docKey={`hb-own-statement-${o.doc_id}`} inline />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {signature.required && (
              <div className="mt-4">
                <SubHeading as="h3" icon={<PenLine />} className="mb-2">
                  Sign to confirm
                </SubHeading>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Type your full name to sign" help={`Exactly as it appears on your account: ${readerName}`}>
                    <TextInput
                      autoComplete="name"
                      value={typedName}
                      onChange={(e) => setTypedName(e.target.value)}
                      disabled={busy}
                    />
                  </Field>
                  {signature.local_account && (
                    <Field label="Re-enter your account password">
                      <TextInput
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        disabled={busy}
                      />
                    </Field>
                  )}
                </div>
                <p className="mt-2 text-xs text-slate-500">{signatureReason(signature)}</p>
              </div>
            )}

            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
              <Button variant="secondary" href={base} className="w-full sm:w-auto">
                Back to the handbook
              </Button>
              <Button
                variant="primary"
                icon={<Check />}
                busy={busy}
                onClick={() => void confirm()}
                {...(ready ? {} : { "aria-disabled": true, "aria-describedby": helpId })}
                className={`w-full sm:w-auto ${ready ? "" : "aria-disabled:cursor-not-allowed aria-disabled:opacity-60"}`.trim()}
              >
                {confirmButtonLabel(counts.outstanding)}
              </Button>
            </div>
            {waitingHelp && (
              <p id={helpId} className="mt-2 text-right text-xs text-slate-500">
                {waitingHelp}
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
