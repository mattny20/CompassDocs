"use client";

// The ticket's language in the desk's Properties card (1.19.2, agent W2): a
// pill menu like Priority and Team (STYLEGUIDE §Status chips, "A choice is
// a pill menu button"), with where the language came from as the trigger's
// tooltip (the requester's directory entry, detected from the first
// message, or set by an agent). Agents who can work the ticket change it;
// the change is an internal line on the timeline, never seen by the
// requester. Its own route (PATCH /api/helpdesk/tickets/[number]/language),
// so the core ticket PATCH is untouched.

import { useEffect, useState } from "react";
import { ChevronDown, Languages } from "lucide-react";
import { toast } from "@/components/Toasts";
import { HD_DETECTABLE_LANGUAGES, HD_LANGUAGE_SOURCE_LABEL, languageName, languageOptions, type HdLanguageSource } from "@/lib/helpdesk/skills/shared";
import { PickMenu } from "../PickMenu";
import { sendJson } from "../api";

const ROW = "flex min-h-11 items-center justify-between gap-3 border-b border-slate-100 py-1.5 last:border-b-0";
const VALUE_BTN =
  "inline-flex min-w-0 max-w-44 items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-medium text-slate-800 transition hover:bg-slate-100 disabled:hover:bg-transparent";

/** The common languages first (the ones the detector knows), then the rest by name. */
const OPTIONS = (() => {
  const first = languageOptions(HD_DETECTABLE_LANGUAGES);
  const rest = languageOptions().filter((o) => !first.some((f) => f.value === o.value));
  return [{ value: "", label: "Unknown" }, ...first, ...rest];
})();

interface View {
  language: string | null;
  source: string;
  source_label: string;
}

export function TicketLanguageRow({
  ticket,
  can,
  onChanged,
}: {
  ticket: { number: number; language?: string | null; language_source?: string | null };
  can: boolean;
  /** Reload the ticket (the timeline gains a line). */
  onChanged?: () => void;
}) {
  const [lang, setLang] = useState<string | null>(ticket.language ?? null);
  const [source, setSource] = useState<string>(ticket.language_source ?? "");
  useEffect(() => {
    setLang(ticket.language ?? null);
    setSource(ticket.language_source ?? "");
  }, [ticket.number, ticket.language, ticket.language_source]);

  async function pick(code: string) {
    try {
      const v = await sendJson<View>(`/api/helpdesk/tickets/${ticket.number}/language`, "PATCH", { language: code || null }, "Couldn't change the language.");
      setLang(v.language);
      setSource(v.source);
      toast("ok", v.language ? `Language set to ${languageName(v.language)}.` : "Language cleared.");
      onChanged?.();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  const name = lang ? languageName(lang) : "Unknown";
  const why = source ? HD_LANGUAGE_SOURCE_LABEL[source as HdLanguageSource] ?? "" : "";
  return (
    <div className={ROW}>
      <span className="text-sm text-slate-500">Language</span>
      <PickMenu
        label="Language"
        value={lang ?? ""}
        options={OPTIONS}
        onPick={pick}
        trigger={(p) => (
          <button
            {...p}
            type="button"
            disabled={!can}
            aria-label={`Language: ${name}${why ? ` (${why.toLowerCase()})` : ""}${can ? ". Change" : ""}`}
            data-tt={why || undefined}
            className={VALUE_BTN}
          >
            <Languages className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
            <span className={`truncate ${lang ? "" : "text-slate-500"}`}>{name}</span>
            {can && <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />}
          </button>
        )}
      />
    </div>
  );
}
