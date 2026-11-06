"use client";

// The customer portal's one-question survey (Helpdesk 1.19.2, mock e3):
// "This request is solved. How did we do?", Good / OK / Not good as three
// radio tiles, an optional comment, Send. A rating link from the solved
// email preselects its answer (?rate=…&t=…) and carries its token; the
// person still presses Send. Once rated it says thanks and shows the answer.
// Posts to /support/api/requests/[n]/csat (lib/helpdesk/portal-csat).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Frown, Meh, Smile, type LucideIcon } from "lucide-react";
import { Button } from "@/components/Button";
import { FormError, Textarea } from "@/components/form";
import { PORTAL_RATINGS, PORTAL_RATING_LABEL, type PortalRating, type PortalSurveyState } from "@/lib/helpdesk/portal-csat-shared";
import { portalFetch } from "./client";

const ICON: Record<PortalRating, LucideIcon> = { good: Smile, ok: Meh, not_good: Frown };

export function PortalSurvey({
  number,
  state,
  preset,
  token,
}: {
  number: number;
  state: PortalSurveyState;
  /** From an email rating link. */
  preset?: PortalRating | null;
  token?: string;
}) {
  const router = useRouter();
  const [rating, setRating] = useState<PortalRating | null>(preset ?? null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<PortalSurveyState["rated"]>(state.rated);

  if (done) {
    const Icon = ICON[done.rating];
    return (
      <section aria-label="Your rating" className="rounded-xl border border-slate-200 bg-surface px-4 py-4 text-sm shadow-xs sm:px-6">
        <p className="flex items-center gap-2 font-semibold text-slate-900">
          <Icon className="h-5 w-5 shrink-0 text-compass-600" aria-hidden />
          Thanks for telling us. You rated this request {PORTAL_RATING_LABEL[done.rating]}.
        </p>
        {done.comment && <p className="mt-1.5 whitespace-pre-line break-words text-slate-700">“{done.comment}”</p>}
      </section>
    );
  }
  if (!state.can_rate) return null;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!rating) {
      setError("Choose Good, OK or Not good.");
      return;
    }
    setBusy(true);
    const r = await portalFetch<{ csat: NonNullable<PortalSurveyState["rated"]> }>(
      `/support/api/requests/${number}/csat`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rating, comment, token: token ?? "" }) },
      "Couldn't send your rating. Try again."
    );
    setBusy(false);
    if (!r.ok) {
      if (r.status === 401) window.location.assign(`/support?next=/support/requests/${number}`);
      setError(r.error);
      return;
    }
    setDone(r.data.csat);
    // Drop ?rate= from the address so a reload doesn't preselect again.
    router.replace(`/support/requests/${number}`, { scroll: false });
  }

  return (
    <form onSubmit={send} aria-labelledby="portal-survey-title" className="rounded-xl border border-slate-200 bg-surface px-4 py-5 shadow-xs sm:px-6">
      <h2 id="portal-survey-title" className="text-center text-base font-bold text-slate-900 sm:text-lg">
        This request is solved. How did we do?
      </h2>
      <div role="radiogroup" aria-labelledby="portal-survey-title" className="mt-4 flex justify-center gap-2 sm:gap-3.5">
        {PORTAL_RATINGS.map((r) => {
          const Icon = ICON[r];
          const on = rating === r;
          return (
            <label
              key={r}
              className={`flex w-24 cursor-pointer flex-col items-center gap-1 rounded-xl border-[1.5px] px-2 py-3 text-sm font-semibold transition sm:w-28 ${
                on ? "border-compass-500 bg-compass-50 text-slate-900" : "border-slate-200 text-slate-700 hover:bg-slate-50"
              }`}
            >
              <input type="radio" name="portal-rating" value={r} checked={on} onChange={() => setRating(r)} className="sr-only" />
              <Icon className={`h-7 w-7 ${on ? "text-compass-600" : "text-slate-400"}`} aria-hidden />
              {PORTAL_RATING_LABEL[r]}
            </label>
          );
        })}
      </div>
      <label htmlFor="portal-survey-comment" className="mt-4 block text-sm font-semibold text-slate-800">
        Anything to add? (optional)
      </label>
      <Textarea id="portal-survey-comment" rows={3} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} className="mt-1.5" />
      {error && <FormError className="mt-2">{error}</FormError>}
      <div className="mt-3 flex justify-end">
        <Button type="submit" busy={busy}>
          Send
        </Button>
      </div>
    </form>
  );
}
