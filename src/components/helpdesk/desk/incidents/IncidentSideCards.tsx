"use client";

// A major incident's side cards (1.19.2, agent W1; mock-up a1), at the top
// of its ticket's side column:
//
//   Get help banner   who sees it (Everyone, the team's requesters, or
//     off; a menu for someone who runs the incident), a preview of the
//     banner as Get help shows it, and the "Me too" clicks.
//   Status page       only when the workspace's Status page has an internal
//     service: "Post updates to the Status page service VPN too." with a
//     switch (and the service, when there are several).

import { Check, ChevronDown, Siren } from "lucide-react";
import { buttonClass } from "@/components/Button";
import { CARD_CLASS } from "@/components/Card";
import { EYEBROW_TEXT } from "@/components/Heading";
import { Toggle } from "@/components/form";
import { toast } from "@/components/Toasts";
import {
  INCIDENT_BANNERS,
  type IncidentBanner,
  type IncidentView,
} from "@/lib/helpdesk/incidents-shared";
import { sendJson } from "../api";
import { PickMenu } from "../PickMenu";
import { incidentsChanged, useTicketIncident } from "./data";

export function IncidentSideCards({
  number,
  refreshKey,
}: {
  number: number;
  refreshKey?: unknown;
}) {
  const { data } = useTicketIncident(number, refreshKey);
  if (!data || data.role !== "incident") return null;
  return (
    <>
      <BannerCard i={data.incident} />
      {data.incident.status_page && <StatusPageCard i={data.incident} />}
    </>
  );
}

async function patch(number: number, p: Record<string, unknown>, ok: string) {
  try {
    await sendJson(
      `/api/helpdesk/incidents/${number}`,
      "PATCH",
      p,
      "Couldn't change the incident.",
    );
    toast("ok", ok);
    incidentsChanged();
  } catch (e) {
    toast("error", (e as Error).message);
  }
}

function audience(i: IncidentView, b: IncidentBanner): string {
  if (b === "workspace")
    return "Shown to everyone in Get help until the incident is solved.";
  if (b === "team")
    return `Shown in Get help to people who have asked ${i.team_name ?? "the team"} for help, and everyone on a linked ticket, until the incident is solved.`;
  return "Not shown in Get help. Linked tickets' requesters still hear each update.";
}

function BannerCard({ i }: { i: IncidentView }) {
  const latest = i.updates[0];
  const last = latest
    ? new Date(latest.created_at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  const label = (b: IncidentBanner) =>
    b === "workspace"
      ? "Everyone"
      : b === "team"
        ? `${i.team_name ?? "The team"}'s requesters`
        : "Off";
  return (
    <section
      aria-labelledby="inc-banner-h"
      className={`${CARD_CLASS} p-4`}
      data-testid="incident-banner-card"
    >
      <h3 id="inc-banner-h" className={EYEBROW_TEXT}>
        Get help banner
      </h3>
      <p className="mt-2 text-sm text-slate-600">{audience(i, i.banner)}</p>
      {i.can_manage && i.open && (
        <div className="mt-2 flex min-w-0 items-center gap-2 text-sm">
          <span className="shrink-0 text-slate-500">Shown to</span>
          <div className="min-w-0 flex-1">
            <PickMenu
              label="Shown to"
              value={i.banner}
              align="start"
              options={INCIDENT_BANNERS.map((b) => ({
                value: b,
                label: label(b),
              }))}
              onPick={(b) =>
                void patch(
                  i.number,
                  { banner: b },
                  b === "off"
                    ? "The banner is off."
                    : `The banner shows to ${label(b).toLowerCase()}.`,
                )
              }
              trigger={(p) => (
                <button
                  {...p}
                  type="button"
                  aria-label={`Shown to: ${label(i.banner)}`}
                  className={buttonClass("secondary", "sm", "max-w-full gap-1")}
                >
                  <span className="truncate">{label(i.banner)}</span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
                </button>
              )}
            />
          </div>
        </div>
      )}
      {i.banner !== "off" && i.open && (
        <div
          className="notice-error mt-3 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[0.8125rem]"
          aria-label="Banner preview"
        >
          <Siren className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <p className="min-w-0">
            <b className="font-semibold">{i.title}</b>
            <br />
            {last ? `We're on it. Last update ${last}.` : "We're on it."}
          </p>
        </div>
      )}
      <dl className="mt-3 space-y-1 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-slate-500">&ldquo;Me too&rdquo; clicks</dt>
          <dd className="font-semibold tabular-nums text-slate-900">
            {i.me_too}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-slate-500">People affected</dt>
          <dd
            className="tabular-nums text-slate-700"
            data-tt="Requesters of linked tickets and everyone who said Me too, each once"
          >
            {i.affected}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function StatusPageCard({ i }: { i: IncidentView }) {
  const sp = i.status_page!;
  const on = sp.service_id !== null;
  const editable = sp.can_manage && i.open;
  const pick = (id: number | null) =>
    void patch(
      i.number,
      { status_service_id: id },
      id === null
        ? "Updates stay off the Status page."
        : `Updates go to the Status page's ${sp.services.find((s) => s.id === id)?.name ?? "service"} too.`,
    );
  // The service named like the incident's team or title, else the first.
  const guess = () =>
    sp.services.find((s) =>
      i.title.toLowerCase().includes(s.name.toLowerCase()),
    )?.id ?? sp.services[0].id;
  return (
    <section
      aria-labelledby="inc-status-h"
      className={`${CARD_CLASS} p-4`}
      data-testid="incident-status-card"
    >
      <h3 id="inc-status-h" className={EYEBROW_TEXT}>
        Status page
      </h3>
      {editable ? (
        <Toggle
          className="mt-2"
          size="full"
          label={
            on ? (
              <span className="font-normal text-slate-600">
                Post updates to the Status page service{" "}
                <b className="font-semibold text-slate-800">
                  {sp.service_name}
                </b>{" "}
                too.
              </span>
            ) : (
              <span className="font-normal text-slate-600">
                Post updates to the Status page too.
              </span>
            )
          }
          help={on ? "Solving the incident resolves it there." : undefined}
          checked={on}
          onChange={(v) => pick(v ? guess() : null)}
        />
      ) : (
        <p className="mt-2 text-sm text-slate-600">
          {on ? (
            <>
              Updates also go to the Status page service{" "}
              <b className="font-semibold text-slate-800">{sp.service_name}</b>.
            </>
          ) : sp.can_manage ? (
            "The incident is solved."
          ) : (
            "Someone who may post on the Status page can mirror these updates there."
          )}
        </p>
      )}
      {editable && on && sp.services.length > 1 && (
        <PickMenu
          label="Status page service"
          value={sp.service_id}
          options={sp.services.map((s) => ({ value: s.id, label: s.name }))}
          onPick={(id) => pick(id)}
          align="start"
          trigger={(p) => (
            <button
              {...p}
              type="button"
              className={buttonClass("secondary", "sm", "mt-2 gap-1")}
            >
              <Check className="h-3.5 w-3.5" aria-hidden />
              {sp.service_name}
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        />
      )}
    </section>
  );
}
