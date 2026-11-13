"use client";

// Private calendar feed links (1.20.6, lib/helpdesk/desk-calendar-feed;
// STYLEGUIDE §Helpdesk: the event calendar). A link lets Outlook, Google
// Calendar or Apple Calendar subscribe to the events of one team, or of every
// team the person works. It is the person's own: it shows what they may see,
// and stops working when they leave the team or the desk.
//
// A link's address is shown once, in the dialog that made it (the API
// tokens' "shown once" recipe): afterwards a row shows only a hint. Making a
// link again replaces it, and the old address stops working. With `all`
// (Desk settings → Event calendar, settings.manage) everyone's links are
// listed too, each with Revoke.

import { useCallback, useEffect, useId, useState } from "react";
import { Ban, KeyRound, RefreshCw, Rss, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { CopyButton } from "@/components/CopyButton";
import { confirmDialog } from "@/components/Dialog";
import { SectionEmpty } from "@/components/form";
import { Modal } from "@/components/Modal";
import { RelativeTime } from "@/components/RelativeTime";
import { LoadingRow } from "@/components/Spinner";
import { Table, TABLE_HEAD_ROW, TD, TH, TR } from "@/components/Table";
import { toast } from "@/components/Toasts";
import type { HdCalendarFeedView } from "@/lib/helpdesk/desk-calendar-shared";
import { getJson, sendJson } from "../api";

interface Feeds {
  feeds: HdCalendarFeedView[];
  teams: { id: number; name: string }[];
  can_manage: boolean;
}

export function FeedLinks({ all = false }: { /** Also list everyone's links (settings.manage). */ all?: boolean }) {
  const [data, setData] = useState<Feeds | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [made, setMade] = useState<{ url: string; scope: string; replaced: boolean } | null>(null);

  const load = useCallback(() => {
    getJson<Feeds>(`/api/helpdesk/calendar/feeds${all ? "?all=1" : ""}`, "Couldn't load the feed links.")
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  }, [all]);
  useEffect(() => load(), [load]);

  async function create(teamId: number | null, scope: string, existing: boolean) {
    if (existing) {
      const ok = await confirmDialog({
        title: "Replace this link?",
        body: "The old address stops working at once. Any calendar that uses it must be given the new one.",
        confirmLabel: "Replace link",
      });
      if (ok !== true) return;
    }
    setBusy(`c${teamId ?? 0}`);
    try {
      const r = await sendJson<{ url: string; replaced: boolean }>("/api/helpdesk/calendar/feeds", "POST", { team_id: teamId }, "Couldn't make the link.");
      setMade({ url: r.url, scope, replaced: r.replaced });
      load();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function revoke(f: HdCalendarFeedView) {
    const whose = f.mine ? "your" : `${f.owner_name}'s`;
    const ok = await confirmDialog({
      title: "Revoke this link?",
      body: `Calendars that subscribe to ${whose} ${f.team_name ?? "All my teams"} link stop getting events. This can't be undone, but a new link can be made.`,
      confirmLabel: "Revoke link",
      danger: true,
    });
    if (ok !== true) return;
    setBusy(`r${f.id}`);
    try {
      await sendJson(`/api/helpdesk/calendar/feeds/${f.id}`, "DELETE", undefined, "Couldn't revoke the link.");
      toast("ok", "Link revoked.");
      load();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (error && !data) return <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>;
  if (!data) return <LoadingRow className="py-6" />;

  const mine = data.feeds.filter((f) => f.mine);
  const scopes: { teamId: number | null; name: string; hint: string }[] = [
    { teamId: null, name: "All my teams", hint: "Every team you work, and tickets assigned to you" },
    ...data.teams.map((t) => ({ teamId: t.id, name: t.name, hint: "This team's events" })),
  ];
  const others = all ? data.feeds.filter((f) => !f.mine) : [];

  return (
    <div className="flex flex-col gap-4">
      <Card padding="none" title="Your calendar feed links" description="Subscribe from Outlook, Google Calendar or Apple Calendar. A link is private: anyone who has it can read those events." icon={<Rss />}>
        <ul className="divide-y divide-slate-100" data-testid="feed-links">
          {scopes.map((s) => {
            const f = mine.find((x) => (x.team_id ?? null) === s.teamId);
            return (
              <li key={s.teamId ?? 0} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-800">{s.name}</p>
                  <p className="text-xs text-slate-500">
                    {f ? (
                      <>
                        <code className="whitespace-nowrap rounded bg-slate-100 px-1 py-0.5 font-mono text-2xs text-slate-700">{f.hint}</code> · {f.last_used_at ? <>last read <RelativeTime value={f.last_used_at} /></> : "not read yet"}
                      </>
                    ) : (
                      s.hint
                    )}
                  </p>
                </div>
                {f ? (
                  <div className="flex items-center gap-1">
                    <Button variant="secondary" size="sm" icon={<RefreshCw />} busy={busy === `c${s.teamId ?? 0}`} onClick={() => create(s.teamId, s.name, true)}>
                      Replace
                    </Button>
                    <button type="button" onClick={() => revoke(f)} disabled={busy !== null} aria-label={`Revoke the ${s.name} link`} data-tt="Revoke" className={iconButtonClass("quiet", "sm", "hover-danger")}>
                      <Ban aria-hidden />
                    </button>
                  </div>
                ) : (
                  <Button variant="secondary" size="sm" busy={busy === `c${s.teamId ?? 0}`} onClick={() => create(s.teamId, s.name, false)} data-testid={`feed-create-${s.teamId ?? 0}`}>
                    Create link
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        <p className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">
          A feed lists each event with its ticket number and subject, its place and its setup time. It never carries the requester&apos;s details, messages or notes. It stops working when you leave the team or the desk.
        </p>
      </Card>

      {all && (
        <Card padding="none" title="Everyone's links" description="Links other agents have made. Revoke one if it may have been shared.">
          {others.length === 0 ? (
            <SectionEmpty className="px-4 py-6">Nobody else has made a feed link.</SectionEmpty>
          ) : (
            <Table scroll minWidth="36rem">
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th scope="col" className={TH}>Agent</th>
                  <th scope="col" className={TH}>Shows</th>
                  <th scope="col" className={`${TH} w-px whitespace-nowrap`}>Made</th>
                  <th scope="col" className={`${TH} w-px whitespace-nowrap`}>Last read</th>
                  <th scope="col" className={`${TH} relative w-px`}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {others.map((f) => (
                  <tr key={f.id} className={TR}>
                    <td className={`${TD} font-medium text-slate-800`}>{f.owner_name}</td>
                    <td className={TD}>
                      {f.team_name ?? "All their teams"} <code className="ml-1 whitespace-nowrap rounded bg-slate-100 px-1 py-0.5 font-mono text-2xs text-slate-700">{f.hint}</code>
                    </td>
                    <td className={`${TD} whitespace-nowrap text-slate-600`}>
                      <RelativeTime value={f.created_at} />
                    </td>
                    <td className={`${TD} whitespace-nowrap text-slate-600`}>{f.last_used_at ? <RelativeTime value={f.last_used_at} /> : "Never"}</td>
                    <td className={TD}>
                      <button type="button" onClick={() => revoke(f)} disabled={busy !== null} aria-label={`Revoke ${f.owner_name}'s ${f.team_name ?? "All their teams"} link`} data-tt="Revoke" className={iconButtonClass("quiet", "sm", "hover-danger")}>
                        <Ban aria-hidden />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {made && <LinkOnce made={made} onClose={() => setMade(null)} />}
    </div>
  );
}

/** The new link's address, shown once (the API tokens' recipe). Mounted only while open. */
function LinkOnce({ made, onClose }: { made: { url: string; scope: string; replaced: boolean }; onClose: () => void }) {
  const titleId = useId();
  return (
    <Modal open onClose={onClose} labelledBy={titleId} closeOnBackdrop={false} className="max-h-[calc(100dvh-2rem)] w-full max-w-xl overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <h2 id={titleId} className="text-base font-semibold text-slate-900">
          Calendar feed link: {made.scope}
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm")}>
          <X aria-hidden />
        </button>
      </div>
      <div className="mt-4 space-y-4">
        <div className="notice-ok rounded-lg border p-4 text-sm">
          <p className="flex items-center gap-2 font-semibold">
            <KeyRound className="h-4 w-4" aria-hidden />
            Copy the link now. It won&apos;t be shown again.
          </p>
          <p className="mt-1">Only a fingerprint of it is kept. {made.replaced ? "The link you had before has stopped working." : "If it is lost, replace it with a new one."}</p>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-slate-500">Feed address</p>
          <div className="flex flex-wrap items-center gap-2">
            <code data-testid="feed-url" className="min-w-0 max-w-full break-all rounded-md border border-slate-200 bg-canvas px-2 py-1.5 font-mono text-xs text-slate-700">
              {made.url}
            </code>
            <CopyButton text={made.url} label="Copy link" variant="primary" />
          </div>
        </div>
        <div className="text-sm text-slate-700">
          <p className="font-medium text-slate-800">Add it to your calendar</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-600">
            <li>Outlook: Add calendar, then Subscribe from web.</li>
            <li>Google Calendar: Other calendars, then From URL.</li>
            <li>Apple Calendar: File, then New Calendar Subscription.</li>
          </ul>
          <p className="mt-2 text-xs text-slate-500">Calendars read a feed every few hours, so a change can take a while to show. Treat the link like a password: anyone who has it can read these events.</p>
        </div>
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** The Calendar page's Subscribe dialog: the person's own links. */
export function FeedLinksDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  return (
    <Modal open onClose={onClose} labelledBy={titleId} className="max-h-[calc(100dvh-2rem)] w-full max-w-xl overflow-y-auto rounded-xl border border-slate-200 bg-canvas p-5 shadow-modal sm:p-6">
      <div className="mb-4 flex items-start justify-between gap-3">
        <h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold text-slate-900">
          <Rss className="h-5 w-5 shrink-0 text-slate-700" aria-hidden />
          Subscribe to the calendar
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm")}>
          <X aria-hidden />
        </button>
      </div>
      <FeedLinks />
    </Modal>
  );
}
