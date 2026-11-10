"use client";

// The requester strip (1.20.3): who asked, across the top of the open
// ticket, between the header and the conversation. It replaces the side
// panel's "Requester" card and shows the same HdContactCard (the server has
// already narrowed it to what this agent may see: directory visibility,
// then Desk settings → Contact cards), so the strip only lays it out.
//
//   closed  row 1: photo with the presence dot, name (+ VIP), job title,
//           department · office · local time; one joined group of the ways
//           to reach them; the Show/Hide details button.
//           row 2: a quiet band of facts: up to two of their devices (with
//           compliance when the source reports it), "N open · M earlier"
//           tickets, their manager. A fact with no data is left out; with
//           no facts there is no band.
//   open    four tiles under it: Contact, Devices, Work, History.
//
// Open or closed is remembered per agent in this browser (localStorage).
// Devices come from GET /api/helpdesk/tickets/[number]/assets/requester
// (agents who work the ticket, a connected asset source, the cache only).
// A ticket with no requester has no strip; the side panel then lists
// everyone under "Also on this ticket" (contacts/TicketContacts).

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  Briefcase,
  CalendarPlus,
  ChevronDown,
  ChevronUp,
  Contact,
  ExternalLink,
  Laptop,
  Mail,
  MonitorSmartphone,
  MoreHorizontal,
  Phone,
  Reply,
  Smartphone,
  Ticket,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { CARD_CLASS } from "@/components/Card";
import { CopyButton } from "@/components/CopyButton";
import { Eyebrow } from "@/components/Heading";
import { Popover } from "@/components/Popover";
import { RelativeTime } from "@/components/RelativeTime";
import { LoadingRow } from "@/components/Spinner";
import { SectionEmpty } from "@/components/form";
import { toast } from "@/components/Toasts";
import { PresenceDot, presenceLabel, usePresence } from "@/components/directory/Presence";
import { ProfileActions } from "@/components/directory/ProfileActions";
import { AVAIL_DOT, BreakableEmail, CardAvatar, IM_ICON, linkTarget, useLocalTime } from "@/components/helpdesk/contacts/ContactCard";
import { VipChip } from "@/components/helpdesk/contacts/VipChip";
import { useTicketContacts } from "@/components/helpdesk/contacts/api";
import { mailtoHref, type HdCardPhone, type HdContactCard } from "@/lib/helpdesk/contact-cards-shared";
import { assetIcon, complianceLabel, complianceTone, intuneOs, seenAgo, type HdAsset, type HdRequesterDevices } from "@/lib/helpdesk/assets-shared";
import { HD_AVAILABILITY_LABEL, HD_STATUS_LABEL, type HdStatus } from "@/lib/helpdesk/types";
import { getJson } from "../api";
import { AssetGlyph, assetHref } from "../assets/TicketAssets";
import { useDeskMe } from "../me";
import { firstName, ticketHref } from "../ui";

/** How many ways to reach them the joined group shows before the rest move under "More". */
const METHODS_SHOWN = 4;
/** Devices named in the facts band; the rest are "+N". */
const DEVICES_IN_BAND = 2;

const storageKey = (userId: number) => `compass_hd_requester_strip_${userId}`;

/** Open or closed, remembered per agent in this browser; closed until they say otherwise. */
function useRememberedOpen(userId: number): [boolean, (next: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      setOpen(localStorage.getItem(storageKey(userId)) === "1");
    } catch {
      /* private mode, storage off: stays closed */
    }
  }, [userId]);
  const set = (next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(storageKey(userId), next ? "1" : "0");
    } catch {
      /* not remembered */
    }
  };
  return [open, set];
}

interface Method {
  key: string;
  label: string;
  /** Read out after the label: "Ana Diaz, desk phone". */
  detail: string;
  href: string;
  icon: LucideIcon;
  target?: string;
  rel?: string;
  /** "Call" with several numbers: the segment opens a menu of them instead of dialling one. */
  phones?: HdCardPhone[];
}

/**
 * The ways to reach them: Email, one Call for every dialable number (a link
 * with one number, a menu with several), then chat in the contact card's
 * order, so Teams and Webex stay in the group rather than behind the phones.
 */
function methodsOf(card: HdContactCard): Method[] {
  const out: Method[] = [];
  const mail = mailtoHref(card.email);
  if (mail) out.push({ key: "email", label: "Email", detail: card.name, href: mail, icon: Mail });
  const phones = card.phones.filter((p) => p.tel_href);
  if (phones.length === 1) {
    const p = phones[0];
    out.push({ key: "call", label: "Call", detail: `${card.name}, ${p.label.toLowerCase()} ${p.value}`, href: p.tel_href, icon: Phone });
  } else if (phones.length > 1) {
    out.push({ key: "call", label: "Call", detail: card.name, href: "", icon: Phone, phones });
  }
  for (const m of card.im) out.push({ key: m.kind, label: m.label, detail: card.name, href: m.href, icon: IM_ICON[m.kind], ...linkTarget(m.href) });
  return out;
}

/** Computers first, then phones and tablets, then the rest: the two the band names are the ones tickets are about. */
const KIND_RANK: Record<string, number> = { laptop: 0, desktop: 1, phone: 2, tablet: 3, monitor: 4, printer: 5, other: 6 };
function byKind(list: HdAsset[]): HdAsset[] {
  return list
    .map((a, i) => ({ a, i, rank: KIND_RANK[assetIcon(a)] ?? 6 }))
    .sort((x, y) => x.rank - y.rank || x.i - y.i)
    .map((x) => x.a);
}

const DOT_TONE = { ok: "bg-emerald-500", warn: "bg-amber-500", neutral: "bg-slate-300" } as const;
// One segment of the joined contact group. The group is a one-row grid of equal columns on a
// narrow pane and a flex row from @2xl; it draws the hairlines and rounds the end segments, so a
// segment is the same whether it is the link itself or a menu button inside its `relative` holder.
const SEGMENT =
  "inline-flex h-8 min-w-0 items-center justify-center gap-1.5 whitespace-nowrap px-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 @2xl:px-3 [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0 [&>svg]:text-compass-600";
const SEGMENT_GROUP =
  "order-3 grid w-full auto-cols-fr grid-flow-col rounded-lg border border-slate-200 bg-surface print:hidden @2xl:order-none @2xl:flex @2xl:w-auto @2xl:shrink-0 [&>*]:border-l [&>*]:border-slate-200 [&>*:first-child]:rounded-l-[0.4375rem] [&>*:first-child]:border-l-0 [&>*:last-child]:rounded-r-[0.4375rem]";
const MENU_LINK = "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50";
const VALUE_LINK = "font-medium text-slate-800 hover:underline";
// A control at the strip's right edge: its bubble ends at the control's right edge instead of
// being centred on it, so a long label never hangs past the pane (a hidden bubble still widens
// its scroller). `!`: the [data-tt] rules are unlayered.
const TT_END = "after:left-auto! after:right-0! after:[transform:none]!";
/** The same for every control inside (a row's actions, the Contact tile's footer with the directory's own buttons). */
const TT_END_IN = "[&_[data-tt]]:after:left-auto! [&_[data-tt]]:after:right-0! [&_[data-tt]]:after:[transform:none]!";

export function RequesterStrip({
  number,
  canWork,
  onReply,
  refreshKey,
}: {
  /** The ticket's display number (#1047). */
  number: number;
  /** The agent works the ticket: their devices are read (the asset routes answer nobody else). */
  canWork: boolean;
  /** "Reply in ticket" beside the email: focus the composer. Left out where there is no composer. */
  onReply?: () => void;
  /** Change it to read the card again (after a new message, say). */
  refreshKey?: unknown;
}) {
  const { data, error } = useTicketContacts(number, refreshKey);
  if (error && !data) {
    return (
      <section aria-label="Requester" className={`${CARD_CLASS} mt-3 p-4 text-sm text-slate-500`}>
        {error}
      </section>
    );
  }
  if (data === undefined) {
    return (
      <section aria-label="Requester" aria-busy className={`${CARD_CLASS} mt-3 p-4`}>
        <LoadingRow>Loading the contact card…</LoadingRow>
      </section>
    );
  }
  const card = data?.contacts[0];
  // No requester on the ticket (an alert, say): no strip. Everyone else stays in the side panel.
  if (!card || card.relation !== "requester") return null;
  return <Strip card={card} number={number} canWork={canWork} onReply={onReply} />;
}

function Strip({ card, number, canWork, onReply }: { card: HdContactCard; number: number; canWork: boolean; onReply?: () => void }) {
  const me = useDeskMe();
  const [open, setOpen] = useRememberedOpen(me.id);
  const [devices, setDevices] = useState<HdRequesterDevices | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const [callOpen, setCallOpen] = useState(false);
  const callBtn = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const localTime = useLocalTime(card.office?.timezone, card.office?.local_time ?? null);
  const teams = usePresence(card.presence && card.directory_id ? [card.directory_id] : [], !!(card.presence && card.directory_id));
  const presence = card.directory_id ? teams[card.directory_id] : undefined;

  useEffect(() => {
    if (!canWork) {
      setDevices(null);
      return;
    }
    let live = true;
    getJson<HdRequesterDevices>(`/api/helpdesk/tickets/${number}/assets/requester`)
      .then((d) => live && setDevices(d))
      .catch(() => live && setDevices(null));
    return () => {
      live = false;
    };
  }, [number, canWork]);

  const methods = methodsOf(card);
  const shown = methods.length > METHODS_SHOWN ? methods.slice(0, METHODS_SHOWN - 1) : methods;
  const more = methods.slice(shown.length);
  const mail = mailtoHref(card.email);
  const devs = devices?.connected ? byKind(devices.devices) : [];
  const e = card.earlier_tickets;
  // Their other tickets, in two parts: still open, and the rest (solved or closed).
  const openCount = e?.open ?? 0;
  const earlierCount = e ? Math.max(0, e.count - openCount) : 0;
  const dotLabel = presence
    ? `${card.name} in Teams: ${presenceLabel(presence)}`
    : card.availability
      ? `${HD_AVAILABILITY_LABEL[card.availability]} on the desk`
      : "";
  const zone = card.office?.timezone ? `${card.office.timezone}${card.office.utc_offset ? ` (${card.office.utc_offset})` : ""}` : "";
  const where: ReactNode[] = [];
  if (card.department) where.push(card.department);
  if (card.office?.name) where.push(card.office.name);
  if (localTime) {
    where.push(
      <span data-tt={zone || undefined} tabIndex={zone ? 0 : undefined}>
        <span className="tabular-nums">{localTime}</span> local time
      </span>
    );
  }
  const profileProps = { target: "_blank", rel: "noopener" };

  // --- Row 2: facts (each only when there is something to say) ---------------------------
  const facts: { key: string; node: ReactNode }[] = [];
  for (const a of devs.slice(0, DEVICES_IN_BAND)) facts.push({ key: `d${a.id}`, node: <DeviceFact a={a} /> });
  if (devs.length > DEVICES_IN_BAND) {
    const n = devs.length - DEVICES_IN_BAND;
    facts.push({
      key: "more-devices",
      node: (
        <button type="button" onClick={() => setOpen(true)} className="rounded-sm font-semibold text-slate-700 hover:underline print:hidden">
          +{n} more
          <span className="sr-only"> {n === 1 ? "device" : "devices"}: show requester details</span>
        </button>
      ),
    });
  }
  if (e) {
    facts.push({
      key: "tickets",
      node: (
        <>
          <Ticket className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
          {e.count === 0 ? (
            <span className="text-slate-500">First ticket from {firstName(card.name)}</span>
          ) : (
            <Link href={e.link} className="min-w-0 truncate hover:underline" data-testid="requester-tickets">
              {openCount > 0 && <span className="font-semibold text-slate-800">{openCount} open</span>}
              {openCount > 0 && earlierCount > 0 && <span className="text-slate-500"> · </span>}
              {earlierCount > 0 && <span className={openCount > 0 ? "text-slate-500" : "font-semibold text-slate-800"}>{earlierCount} earlier</span>}
              <span className="sr-only"> {e.count === 1 ? "ticket" : "tickets"}</span>
            </Link>
          )}
        </>
      ),
    });
  }
  if (card.manager) {
    facts.push({
      key: "manager",
      node: (
        <>
          <UserRound className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
          <span className="shrink-0 text-slate-500">Manager</span>
          {card.manager.directory_id ? (
            <a href={`/directory/${card.manager.directory_id}`} {...profileProps} className="min-w-0 truncate font-semibold text-slate-800 hover:underline">
              {card.manager.name}
            </a>
          ) : (
            <span className="min-w-0 truncate font-semibold text-slate-800">{card.manager.name}</span>
          )}
        </>
      ),
    });
  }

  // --- The open view's Work rows -----------------------------------------------------------
  const work: { label: string; value: ReactNode }[] = [];
  if (card.manager) {
    work.push({
      label: "Manager",
      value: card.manager.directory_id ? (
        <a href={`/directory/${card.manager.directory_id}`} {...profileProps} className={VALUE_LINK}>
          {card.manager.name}
        </a>
      ) : (
        card.manager.name
      ),
    });
  }
  if (card.department) work.push({ label: "Department", value: card.department });
  if (card.office?.name) work.push({ label: "Office", value: card.office.name });
  if (localTime) work.push({ label: "Local time", value: <><span className="tabular-nums">{localTime}</span>{zone && <span className="text-slate-500"> · {zone}</span>}</> });
  if (card.pronouns) work.push({ label: "Pronouns", value: card.pronouns });
  if (card.team && (card.team.names.length > 0 || card.team.role_label)) {
    work.push({ label: "Desk team", value: [card.team.names.join(", "), card.team.role_label].filter(Boolean).join(" · ") });
  }
  if (card.availability) work.push({ label: "Desk", value: `${HD_AVAILABILITY_LABEL[card.availability]} on the desk` });
  if (presence) work.push({ label: "Teams", value: presenceLabel(presence) });
  for (const x of card.extra) work.push({ label: x.label, value: x.value });

  const hasContact = !!card.email || card.phones.length > 0 || card.im.length > 0 || !!card.profile_url || !!card.vcard_url || !!card.calendar_href;
  const subtitle = card.title || (card.minimal ? "Not in the directory" : "");

  return (
    <section aria-label="Requester" data-testid="requester-strip" data-open={open ? "true" : "false"} className={`${CARD_CLASS} mt-3 break-inside-avoid`}>
      {/* Row 1: who, how to reach them, show or hide the details. */}
      <div className="flex flex-wrap items-center gap-3 px-3 py-2.5 @2xl:flex-nowrap">
        <span className="relative shrink-0" {...(dotLabel ? { "data-tt": dotLabel, "data-tt-align": "start", tabIndex: 0 } : {})}>
          <CardAvatar card={card} size="strip" />
          {presence ? (
            <PresenceDot presence={presence} />
          ) : card.availability ? (
            <span className={`absolute bottom-0 right-0 block h-3 w-3 rounded-full border-2 border-surface ${AVAIL_DOT[card.availability] ?? "bg-slate-300"}`} aria-hidden />
          ) : null}
          {dotLabel && <span className="sr-only">{dotLabel}</span>}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.9375rem] font-bold leading-tight text-slate-900">
            {card.profile_url ? (
              <a href={card.profile_url} {...profileProps} className="min-w-0 break-words hover:underline" data-testid="requester-name">
                {card.name}
              </a>
            ) : (
              <span className="min-w-0 break-words" data-testid="requester-name">{card.name}</span>
            )}
            {card.vip.vip && <VipChip reason={card.vip.reason} />}
          </p>
          {subtitle && <p className="mt-px truncate text-[0.8125rem] text-slate-700">{subtitle}</p>}
          {where.length > 0 && (
            <p className="mt-px text-xs text-slate-500 @2xl:truncate">
              {where.map((w, i) => (
                <span key={i}>
                  {i > 0 && " · "}
                  {w}
                </span>
              ))}
            </p>
          )}
          {/* On paper the buttons go; the ways to reach them stay as text. */}
          {(card.email || card.phones.length > 0) && (
            <p className="mt-1 hidden text-xs text-slate-700 print:block">{[card.email, ...card.phones.map((p) => `${p.label} ${p.value}`)].filter(Boolean).join(" · ")}</p>
          )}
        </div>
        {methods.length > 0 && (
          <div role="group" aria-label={`Contact ${card.name}`} data-testid="requester-methods" className={SEGMENT_GROUP}>
            {shown.map((m) =>
              m.phones ? (
                // Several numbers: Call opens the list rather than choosing one for the agent.
                <div key={m.key} className="relative flex min-w-0">
                  <button ref={callBtn} type="button" aria-haspopup="menu" aria-expanded={callOpen} onClick={() => setCallOpen((o) => !o)} className={`${SEGMENT} flex-1 rounded-[inherit]`}>
                    <m.icon aria-hidden />
                    <span className="truncate">{m.label}</span>
                    <span className="sr-only"> {m.detail}: choose a number</span>
                    <ChevronDown className="-ml-0.5 h-3! w-3! text-slate-400!" aria-hidden />
                  </button>
                  <Popover open={callOpen} onClose={() => setCallOpen(false)} triggerRef={callBtn} role="menu" label={`Call ${card.name}`} align="start" width="w-60">
                    {m.phones.map((p, i) => {
                      const Icon = p.kind === "cell" ? Smartphone : Phone;
                      return (
                        <a key={`${p.kind}-${i}`} role="menuitem" href={p.tel_href} onClick={() => setCallOpen(false)} className={MENU_LINK}>
                          <Icon className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                          <span className="min-w-0 flex-1 truncate">{p.label}</span>
                          <span className="shrink-0 text-xs tabular-nums text-slate-500">{p.value}</span>
                        </a>
                      );
                    })}
                  </Popover>
                </div>
              ) : (
                <a key={m.key} href={m.href} target={m.target} rel={m.rel} className={SEGMENT}>
                  <m.icon aria-hidden />
                  <span className="truncate">{m.label}</span>
                  <span className="sr-only">: {m.detail}</span>
                </a>
              )
            )}
            {more.length > 0 && (
              <div className="relative flex min-w-0">
                <button ref={moreBtn} type="button" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)} className={`${SEGMENT} flex-1 rounded-[inherit]`}>
                  <MoreHorizontal aria-hidden />
                  <span className="truncate">More</span>
                  <span className="sr-only"> ways to contact {card.name}</span>
                </button>
                <Popover open={moreOpen} onClose={() => setMoreOpen(false)} triggerRef={moreBtn} role="menu" label={`More ways to contact ${card.name}`} align="end" width="w-56">
                  {more.map((m) => (
                    <a key={m.key} role="menuitem" href={m.href} target={m.target} rel={m.rel} onClick={() => setMoreOpen(false)} className={MENU_LINK}>
                      <m.icon className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{m.label}</span>
                    </a>
                  ))}
                </Popover>
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-label={open ? "Hide requester details" : "Show requester details"}
          data-tt={open ? "Hide requester details" : "Show requester details"}
          data-testid="requester-toggle"
          className={`ml-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-surface text-slate-500 transition hover:bg-slate-50 hover:text-slate-700 print:hidden @2xl:ml-0 [&>svg]:h-4 [&>svg]:w-4 ${TT_END}`}
        >
          {open ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
        </button>
      </div>

      {/* Row 2: the facts band. */}
      {facts.length > 0 && (
        <ul
          aria-label="At a glance"
          data-testid="requester-facts"
          className="flex flex-col gap-1.5 border-t border-slate-100 bg-canvas px-3 py-2 text-[0.8125rem] text-slate-700 last:rounded-b-[0.6875rem] print:hidden @2xl:flex-row @2xl:items-center @2xl:gap-0 @2xl:overflow-hidden @2xl:whitespace-nowrap"
        >
          {facts.map((f) => (
            <li key={f.key} className="flex min-w-0 items-center gap-1.5 @2xl:border-l @2xl:border-slate-200 @2xl:px-3 @2xl:first:border-l-0 @2xl:first:pl-0">
              {f.node}
            </li>
          ))}
        </ul>
      )}

      {/* The open view: four tiles (one column on a narrow pane). Never printed: paper gets the closed strip. */}
      {open && (
        <div id={panelId} className="grid grid-cols-1 gap-2.5 border-t border-slate-100 p-3 print:hidden @2xl:grid-cols-2" data-testid="requester-details">
          {hasContact && (
            <Tile icon={<Contact />} title="Contact">
              <dl>
                {card.email && (
                  <Row
                    label="Email"
                    actions={
                      <>
                        {onReply && (
                          <button type="button" onClick={onReply} className={iconButtonClass("quiet", "sm")} data-tt="Reply in ticket" aria-label="Reply in ticket">
                            <Reply />
                          </button>
                        )}
                        <CopyButton text={card.email} label="Copy email" iconOnly variant="ghost" onCopied={() => toast("ok", "Email copied.")} />
                      </>
                    }
                  >
                    {mail ? (
                      <a href={mail} className={`${VALUE_LINK} break-words`}>
                        <BreakableEmail email={card.email} />
                      </a>
                    ) : (
                      <span className="break-words font-medium"><BreakableEmail email={card.email} /></span>
                    )}
                  </Row>
                )}
                {card.phones.map((p, i) => (
                  <Row
                    key={`${p.kind}-${i}`}
                    label={p.label}
                    actions={<CopyButton text={p.value} label={`Copy ${p.label.toLowerCase()}`} iconOnly variant="ghost" onCopied={() => toast("ok", `${p.label} copied.`)} />}
                  >
                    {p.tel_href ? (
                      <a href={p.tel_href} className={`${VALUE_LINK} break-words`}>
                        {p.value}
                      </a>
                    ) : (
                      <span className="break-words font-medium">{p.value}</span>
                    )}
                  </Row>
                ))}
                {card.im.map((m) => {
                  const app = m.kind === "teams" ? "Teams" : m.kind === "slack" ? "Slack" : "Webex";
                  return (
                    <Row
                      key={m.kind}
                      label={m.label}
                      actions={
                        <>
                          {m.app_href && m.app_href !== m.href && (
                            <a href={m.app_href} className={iconButtonClass("quiet", "sm")} data-tt={`Open in the ${app} app`} aria-label={`Open ${card.name} in the ${app} app`}>
                              <Laptop />
                            </a>
                          )}
                          <a href={m.href} {...linkTarget(m.href)} className={iconButtonClass("quiet", "sm")} data-tt={`Open ${app}`} aria-label={`${m.label}: ${card.name}`}>
                            <ExternalLink />
                          </a>
                        </>
                      }
                    >
                      <a href={m.href} {...linkTarget(m.href)} className={`${VALUE_LINK} break-words`}>
                        {/* An address that only repeats the email says what the link does instead. */}
                        {m.value && m.value.toLowerCase() !== card.email.toLowerCase() ? m.value : `Chat in ${app}`}
                      </a>
                    </Row>
                  );
                })}
              </dl>
              {(card.profile_url || card.vcard_url || card.calendar_href) && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2">
                  {card.profile_url && (
                    <Button href={card.profile_url} variant="secondary" size="sm" icon={<UserRound />} {...profileProps}>
                      Open profile
                    </Button>
                  )}
                  <span className={`ml-auto flex items-center gap-1.5 ${TT_END_IN}`}>
                    {card.calendar_href && (
                      <a
                        href={card.calendar_href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={iconButtonClass("bordered", "md")}
                        data-tt="Schedule a meeting"
                        aria-label={`Schedule a meeting with ${card.name}`}
                      >
                        <CalendarPlus />
                      </a>
                    )}
                    {card.vcard_url && card.directory_id && <ProfileActions personId={card.directory_id} name={card.name} email={card.email} microsoft={false} qr={card.qr} />}
                  </span>
                </div>
              )}
            </Tile>
          )}

          {devices?.connected && (
            <Tile icon={<MonitorSmartphone />} title="Devices" testid="requester-devices">
              {devs.length === 0 ? (
                <SectionEmpty className="py-1">Nothing assigned to them in the asset list.</SectionEmpty>
              ) : (
                <ul>
                  {devs.map((a) => (
                    <DeviceRow key={a.id} a={a} />
                  ))}
                </ul>
              )}
            </Tile>
          )}

          {work.length > 0 && (
            <Tile icon={<Briefcase />} title="Work">
              <dl>
                {work.map((w) => (
                  <Row key={w.label} label={w.label}>
                    {w.value}
                  </Row>
                ))}
              </dl>
            </Tile>
          )}

          {e && <History card={card} />}
        </div>
      )}
    </section>
  );
}

function Tile({ icon, title, testid, children }: { icon: ReactNode; title: string; testid?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} data-testid={testid} className="min-w-0 rounded-lg border border-slate-100 px-3 py-2.5">
      <Eyebrow as="h3" icon={icon} className="mb-1 [&>span]:text-slate-400">
        <span id={id} className="text-slate-500!">{title}</span>
      </Eyebrow>
      {children}
    </section>
  );
}

/** One label/value line of a tile, its actions at the right; `below` hangs a list under it. */
function Row({ label, actions, below, children }: { label: string; actions?: ReactNode; below?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-7 grid-cols-[5.25rem_minmax(0,1fr)] items-center gap-x-2 text-[0.8125rem]">
      <dt className="truncate text-xs text-slate-500" title={label.length > 12 ? label : undefined}>
        {label}
      </dt>
      <dd className="flex min-w-0 items-center gap-1 text-slate-800">
        <span className="min-w-0 flex-1 break-words">{children}</span>
        {actions && <span className={`flex shrink-0 items-center gap-0.5 print:hidden ${TT_END_IN}`}>{actions}</span>}
      </dd>
      {below && <dd className="col-span-2 min-w-0">{below}</dd>}
    </div>
  );
}

/** What the source says about a device's compliance: the dot's tone and the words, or null when it says nothing. */
function complianceOf(a: HdAsset): { tone: "ok" | "warn" | "neutral"; label: string } | null {
  return a.intune ? { tone: complianceTone(a.intune.compliance), label: complianceLabel(a.intune.compliance) } : null;
}

/**
 * A device in the facts band: glyph, name (to its page) and, only when the source reports
 * compliance one way or the other, the status dot with "Compliant" / "Not compliant".
 * Exported for test/helpdesk-intune (the rig has no Intune).
 */
export function DeviceFact({ a }: { a: HdAsset }) {
  const c = complianceOf(a);
  return (
    <>
      <AssetGlyph a={a} size="sm" />
      <Link href={assetHref(a.id)} className="min-w-0 truncate font-semibold text-slate-800 hover:underline">
        {a.name}
      </Link>
      {c && c.tone !== "neutral" && (
        <>
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_TONE[c.tone]}`} data-compliance={c.tone} aria-hidden />
          <span className="shrink-0 text-slate-500">{c.label}</span>
        </>
      )}
    </>
  );
}

/** A device in the Devices tile. Exported for test/helpdesk-intune. */
export function DeviceRow({ a }: { a: HdAsset }) {
  const c = complianceOf(a);
  const seen = a.intune ? seenAgo(a.intune.last_seen) : "";
  const model = a.model && a.model.toLowerCase() !== a.name.toLowerCase() ? a.model : "";
  const sub = a.intune
    ? [model, intuneOs(a.intune), seen ? `seen ${seen}` : "", a.gone ? "no longer in the source" : ""]
    : [model, a.tag || a.serial, a.provider_label, a.gone ? "no longer in the source" : ""];
  return (
    <li className="flex items-start gap-2 py-1.5" data-testid="requester-device">
      <span className="mt-0.5">
        <AssetGlyph a={a} size="sm" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 text-[0.8125rem]">
          <Link href={assetHref(a.id)} className="min-w-0 break-words font-semibold text-slate-800 hover:underline">
            {a.name}
          </Link>
          {c && (
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-600">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_TONE[c.tone]}`} data-compliance={c.tone} aria-hidden />
              {c.label}
            </span>
          )}
        </p>
        <p className="truncate text-xs text-slate-500">{sub.filter(Boolean).join(" · ")}</p>
      </div>
      {a.url && (
        <a
          href={a.url}
          target="_blank"
          rel="noopener noreferrer"
          className={iconButtonClass("quiet", "sm", TT_END)}
          data-tt={a.provider_label}
          aria-label={`Open ${a.name} in ${a.provider_label} (opens in a new tab)`}
        >
          <ExternalLink />
        </a>
      )}
    </li>
  );
}

/** Their other tickets: the open ones as links, the earlier count with its Show list, and how they rated the desk. */
function History({ card }: { card: HdContactCard }) {
  const e = card.earlier_tickets!;
  const [list, setList] = useState(false);
  const listId = useId();
  const openRecent = e.open_recent ?? [];
  const openCount = e.open ?? 0;
  // The rest: solved or closed. (A server that sends no split yet counts them all as earlier.)
  const earlierCount = Math.max(0, e.count - openCount);
  const earlier = e.earlier_recent ?? e.recent;
  const lastAt = e.earlier_recent ? (e.earlier_last_at ?? null) : e.last_at;
  return (
    <Tile icon={<Ticket />} title="History" testid="requester-history">
      {e.count === 0 && <p className="py-1 text-[0.8125rem] text-slate-500">First ticket from {firstName(card.name)}</p>}
      <dl>
        {openCount > 0 && (
          <Row label="Open">
            <span className="flex flex-wrap gap-x-2">
              {openRecent.map((r) => (
                <Link key={r.number} href={ticketHref(r.number)} className="max-w-full truncate hover:underline">
                  <span className="font-semibold tabular-nums text-compass-700">#{r.number}</span> {r.subject}
                </Link>
              ))}
              {openCount > openRecent.length && (
                <Link href={e.link} className="link font-medium">
                  +{openCount - openRecent.length} more
                </Link>
              )}
            </span>
          </Row>
        )}
        {earlierCount > 0 && (
          <Row
            label="Earlier"
            actions={
              earlier.length > 0 && (
                <button
                  type="button"
                  aria-expanded={list}
                  aria-controls={listId}
                  onClick={() => setList((v) => !v)}
                  className="rounded-md px-1.5 py-0.5 text-xs font-medium text-compass-700 hover:bg-compass-50"
                >
                  {list ? "Hide" : "Show"}
                  <span className="sr-only"> earlier tickets</span>
                </button>
              )
            }
            below={
              earlier.length > 0 && (
                <ul id={listId} hidden={!list} className="mb-1 mt-0.5 flex flex-col gap-0.5">
                  {earlier.map((r) => (
                    <li key={r.number} className="flex min-w-0 items-baseline gap-2">
                      <Link href={ticketHref(r.number)} className="min-w-0 flex-1 truncate hover:underline">
                        <span className="tabular-nums text-slate-500">#{r.number}</span> {r.subject}
                      </Link>
                      <span className="shrink-0 text-xs text-slate-500">{HD_STATUS_LABEL[r.status as HdStatus] ?? r.status}</span>
                    </li>
                  ))}
                  {e.count > earlier.length && (
                    <li>
                      <Link href={e.link} className="link text-xs font-medium">
                        All {e.count} tickets
                      </Link>
                    </li>
                  )}
                </ul>
              )
            }
          >
            <Link href={e.link} className={VALUE_LINK}>
              {earlierCount} earlier {earlierCount === 1 ? "ticket" : "tickets"}
            </Link>
            {lastAt && (
              <span className="text-slate-500">
                {" "}· last one <RelativeTime value={lastAt} />
              </span>
            )}
          </Row>
        )}
        {e.satisfaction && (
          <Row label="Satisfaction">
            {e.satisfaction.average} of 5 <span className="text-slate-500">· {e.satisfaction.ratings} {e.satisfaction.ratings === 1 ? "rating" : "ratings"}</span>
          </Row>
        )}
      </dl>
    </Tile>
  );
}
