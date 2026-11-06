"use client";

// The Templates tab (1.19.0, STYLEGUIDE §Email templates in parts): every
// email CompassDocs sends, grouped by the area that sends it, each row
// naming the four parts it is built from ("Standard header · Policy
// reminder · No signature · Standard footer") and marked Customized when
// that differs from what ships. A row is one link into the composer; the
// chips inside it are plain text (a chip is never a link of its own).

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, Mail } from "lucide-react";
import { Card } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { ListFilter } from "@/components/ListFilter";
import { EmptyState, SectionEmpty } from "@/components/form";
import { areaRank } from "./areas";
import { summarize } from "./summary";
import { KIND_LABEL, eventHref } from "./types";
import type { EmailComposition, EventInfo, PartWithUsage, Surface, TeamOption } from "./types";

export function TemplatesList({
  surface,
  events,
  compositions,
  variants,
  parts,
  teams,
}: {
  surface: Surface;
  events: EventInfo[];
  compositions: EmailComposition[];
  variants: Record<string, number[]>;
  parts: PartWithUsage[];
  teams: TeamOption[];
}) {
  const [q, setQ] = useState("");
  const byKey = useMemo(() => new Map(compositions.map((c) => [c.event_key, c])), [compositions]);
  const needle = q.trim().toLowerCase();
  const shown = events.filter(
    (e) => !needle || e.label.toLowerCase().includes(needle) || e.description.toLowerCase().includes(needle) || e.area.toLowerCase().includes(needle)
  );
  const groups = useMemo(() => {
    const m = new Map<string, EventInfo[]>();
    for (const e of shown) m.set(e.area, [...(m.get(e.area) ?? []), e]);
    return [...m.entries()].sort((a, b) => areaRank(a[0]) - areaRank(b[0]));
  }, [shown]);

  if (events.length === 0) {
    return (
      <EmptyState
        icon={<Mail />}
        title="No emails to set up yet"
        body="The emails this area sends appear here once the feature that sends them is turned on."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 max-w-2xl text-sm text-slate-500">
          Each email is built from a header, a body, a signature and a footer, chosen from the libraries in the
          other tabs. Open an email to choose its parts and preview it.
        </p>
        <ListFilter value={q} onChange={setQ} label="Filter emails" noun="emails" shown={shown.length} total={events.length} />
      </div>

      {groups.length === 0 && (
        <Card padding="p-4">
          <SectionEmpty>No emails match your filter.</SectionEmpty>
        </Card>
      )}

      {groups.map(([area, list]) => (
        <Card key={area} padding="none" title={area} as="section">
          <ul role="list" className="divide-y divide-slate-100">
            {list.map((e) => {
              const comp = byKey.get(e.key);
              const sum = comp ? summarize(comp, parts) : null;
              const teamCount = (variants[e.key] ?? []).length;
              return (
                <li key={e.key}>
                  <Link
                    href={eventHref(surface, e.key)}
                    className="group flex items-start gap-3 px-4 py-3 transition hover:bg-slate-50"
                    data-testid={`template-row-${e.key}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-800 group-hover:text-compass-700">{e.label}</span>
                        {sum?.customized && (
                          <span className={chipClass("warn", "sm")}>
                            <span className="sr-only">, </span>Customized
                          </span>
                        )}
                        {e.teamScopes && teamCount > 0 && (
                          <span className={chipClass("info", "sm")}>
                            <span className="sr-only">, </span>
                            {teamCount === 1 ? "1 team version" : `${teamCount} team versions`}
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-sm text-slate-500 sm:truncate">{e.description}</span>
                      {sum && (
                        <span className="mt-1.5 flex flex-wrap items-center gap-1">
                          <span className="sr-only">, built from </span>
                          {sum.slots.map((s, i) => (
                            <span key={s.kind} className="inline-flex items-center gap-1">
                              {i > 0 && (
                                <span className="text-slate-400" aria-hidden>
                                  ·
                                </span>
                              )}
                              <span className={chipClass(s.changed ? "accent" : "neutral", "sm")}>
                                <span className="sr-only">{KIND_LABEL[s.kind]}: </span>
                                {s.name}
                              </span>
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                    <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      ))}
      {teams.length === 0 && surface.mode === "desk" && (
        <p className="text-xs text-slate-500">Team versions appear here once the helpdesk has teams.</p>
      )}
    </div>
  );
}
