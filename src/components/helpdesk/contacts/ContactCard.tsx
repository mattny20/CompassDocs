"use client";

// A contact card (Helpdesk 1.19.0): the person behind a ticket, or the
// agent working it, as the CompassDocs directory knows them. Built from an
// HdContactCard the server has already narrowed to what this viewer may
// see (directory visibility first, then the audience's parts in Desk
// settings → Contact cards), so this only lays it out.
//
//   panel    the ticket side panel and "Who's helping you": everything
//   popover  the hover card on a requester's name: no extras, no history list
//   compact  one row (photo, name, title, quick actions), for a stack
//
// Directory visuals are reused: the photo or initials, Teams presence
// (PresenceBadge), ProfileActions for the vCard and its QR. Calls are tel:
// links, email is mailto: (the viewer's own client), Teams/Webex/Slack open
// their web link in a new tab or their app link in place. Every value has a
// copy button. Actions hide on paper.

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  CalendarPlus,
  Clock,
  Hash,
  Laptop,
  Mail,
  MapPin,
  MessageSquare,
  Phone,
  Reply,
  Smartphone,
  Ticket,
  UserRound,
  Users,
  Video,
} from "lucide-react";
import { Button, buttonClass, iconButtonClass } from "@/components/Button";
import { CopyButton } from "@/components/CopyButton";
import { RelativeTime } from "@/components/RelativeTime";
import { toast } from "@/components/Toasts";
import { PresenceBadge } from "@/components/directory/Presence";
import { ProfileActions } from "@/components/directory/ProfileActions";
import { HD_AVAILABILITY_LABEL, HD_STATUS_LABEL, type HdStatus } from "@/lib/helpdesk/types";
import { localTimeIn, mailtoHref, type HdCardIm, type HdContactCard } from "@/lib/helpdesk/contact-cards-shared";
import { VipChip } from "./VipChip";

export type ContactCardVariant = "panel" | "popover" | "compact";

const IM_ICON: Record<HdCardIm["kind"], typeof MessageSquare> = { teams: MessageSquare, webex: Video, slack: Hash };
const AVAIL_DOT: Record<string, string> = { available: "bg-emerald-500", away: "bg-amber-400", offline: "bg-slate-300" };
const ICON = "h-4 w-4 shrink-0 text-slate-400";

/** "14:05", re-read every half minute while the card is open. */
function useLocalTime(tz: string | null | undefined, initial: string | null): string | null {
  const [now, setNow] = useState<string | null>(initial);
  useEffect(() => {
    if (!tz) return;
    const tick = () => setNow(localTimeIn(tz)?.time ?? null);
    tick();
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, [tz]);
  return now;
}

/** Opens in a new tab when it is a web link; an app link (msteams:, slack:, webexteams:) opens in place. */
function linkTarget(href: string): { target?: string; rel?: string } {
  return /^https:\/\//.test(href) ? { target: "_blank", rel: "noopener noreferrer" } : {};
}

export function CardAvatar({ card, size = "lg" }: { card: Pick<HdContactCard, "photo_url" | "initials">; size?: "sm" | "md" | "lg" }) {
  const dim = size === "lg" ? "h-14 w-14 text-lg" : size === "md" ? "h-10 w-10 text-sm" : "h-8 w-8 text-xs";
  if (card.photo_url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={card.photo_url} alt="" className={`${dim} shrink-0 rounded-full object-cover ring-2 ring-slate-100`} />;
  }
  return (
    <span className={`${dim} grid shrink-0 place-items-center rounded-full bg-compass-100 font-semibold text-compass-700`} aria-hidden>
      {card.initials}
    </span>
  );
}

function copied(label: string) {
  toast("ok", `${label} copied.`);
}

export function ContactCard({
  card,
  variant = "panel",
  onReply,
  profileTarget = "_blank",
  actions = true,
  className = "",
}: {
  card: HdContactCard;
  variant?: ContactCardVariant;
  /** Agents: "Reply in ticket" beside the email (focuses the composer). */
  onReply?: () => void;
  /** Where "Open profile" opens: a new tab from the desk, in place from Get help. */
  profileTarget?: "_blank" | "_self";
  /** compact: the quick call/email/chat icons (off where the row expands instead). */
  actions?: boolean;
  className?: string;
}) {
  const localTime = useLocalTime(card.office?.timezone, card.office?.local_time ?? null);
  if (variant === "compact") return <CompactRow card={card} className={className} actions={actions} />;
  const popover = variant === "popover";
  const subtitle = [card.title, card.department].filter(Boolean).join(" · ");
  const profileProps = profileTarget === "_blank" ? { target: "_blank", rel: "noopener" } : {};
  const mail = mailtoHref(card.email);

  return (
    <div className={`flex min-w-0 flex-col gap-3 text-sm ${className}`}>
      {/* Who */}
      <div className="flex min-w-0 items-start gap-3">
        <CardAvatar card={card} size={popover ? "md" : "lg"} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {card.profile_url ? (
              <a href={card.profile_url} {...profileProps} className="min-w-0 break-words text-base font-semibold text-slate-900 hover:underline">
                {card.name}
              </a>
            ) : (
              <span className="min-w-0 break-words text-base font-semibold text-slate-900">{card.name}</span>
            )}
            {card.vip.vip && <VipChip reason={card.vip.reason} />}
          </p>
          {subtitle && <p className="break-words text-slate-500">{subtitle}</p>}
          {card.pronouns && <p className="text-xs text-slate-500">{card.pronouns}</p>}
          {card.minimal && !subtitle && (
            <p className="text-xs text-slate-500">Not in the directory</p>
          )}
        </div>
      </div>

      {/* Where they are and who they work with */}
      {(card.office || card.manager || card.team || card.availability || (card.presence && card.directory_id)) && (
        <ul className="flex flex-col gap-1.5 text-slate-600">
          {card.office && (card.office.name || localTime) && (
            <li className="flex items-start gap-2">
              {card.office.name ? <MapPin className={`${ICON} mt-0.5`} aria-hidden /> : <Clock className={`${ICON} mt-0.5`} aria-hidden />}
              <span className="min-w-0">
                {card.office.name && <>{card.office.name}</>}
                {card.office.name && localTime && <span className="text-slate-400"> · </span>}
                {localTime && (
                  <span data-tt={card.office.timezone ? `${card.office.timezone}${card.office.utc_offset ? ` (${card.office.utc_offset})` : ""}` : undefined} tabIndex={0}>
                    local time <span className="font-medium tabular-nums text-slate-800">{localTime}</span>
                  </span>
                )}
              </span>
            </li>
          )}
          {card.manager && (
            <li className="flex items-start gap-2">
              <UserRound className={`${ICON} mt-0.5`} aria-hidden />
              <span className="min-w-0">
                Reports to{" "}
                {card.manager.directory_id ? (
                  <a href={`/directory/${card.manager.directory_id}`} {...profileProps} className="link font-medium">
                    {card.manager.name}
                  </a>
                ) : (
                  <span className="font-medium text-slate-800">{card.manager.name}</span>
                )}
              </span>
            </li>
          )}
          {card.team && (card.team.names.length > 0 || card.team.role_label) && (
            <li className="flex items-start gap-2">
              <Users className={`${ICON} mt-0.5`} aria-hidden />
              <span className="min-w-0">{[card.team.names.join(", "), card.team.role_label].filter(Boolean).join(" · ")}</span>
            </li>
          )}
          {(card.availability || (card.presence && card.directory_id)) && (
            <li className="flex flex-wrap items-center gap-2">
              {card.availability && (
                <span className="inline-flex items-center gap-2">
                  <span className={`ml-1 mr-0.5 block h-2.5 w-2.5 rounded-full ${AVAIL_DOT[card.availability] ?? "bg-slate-300"}`} aria-hidden />
                  <span>
                    {HD_AVAILABILITY_LABEL[card.availability]}
                    <span className="text-slate-400"> on the desk</span>
                  </span>
                </span>
              )}
              {card.presence && card.directory_id && <PresenceBadge personId={card.directory_id} enabled name={card.name} />}
            </li>
          )}
        </ul>
      )}

      {/* How to reach them */}
      {(card.phones.length > 0 || card.email) && (
        <ul className="flex flex-col divide-y divide-slate-100 rounded-lg border border-slate-200">
          {card.phones.map((p, i) => {
            const Icon = p.kind === "cell" ? Smartphone : Phone;
            return (
              <li key={`${p.kind}-${i}`} className="flex min-h-11 items-center gap-2 px-2.5 py-1.5">
                <Icon className={ICON} aria-hidden />
                <span className="min-w-0 flex-1">
                  {p.tel_href ? (
                    <a href={p.tel_href} className="block break-words font-medium text-slate-800 hover:underline">
                      {p.value}
                    </a>
                  ) : (
                    <span className="block break-words font-medium text-slate-800">{p.value}</span>
                  )}
                  <span className="block text-xs text-slate-500">{p.label}</span>
                </span>
                <span className="print:hidden">
                  <CopyButton text={p.value} label={`Copy ${p.label.toLowerCase()}`} iconOnly variant="ghost" onCopied={() => copied(p.label)} />
                </span>
              </li>
            );
          })}
          {card.email && (
            <li className="flex min-h-11 items-center gap-2 px-2.5 py-1.5">
              <Mail className={ICON} aria-hidden />
              <span className="min-w-0 flex-1">
                {mail ? (
                  <a href={mail} className="block break-words font-medium text-slate-800 hover:underline">
                    <BreakableEmail email={card.email} />
                  </a>
                ) : (
                  <span className="block break-words font-medium text-slate-800"><BreakableEmail email={card.email} /></span>
                )}
                <span className="block text-xs text-slate-500">Email</span>
              </span>
              <span className="flex items-center gap-0.5 print:hidden">
                {onReply && (
                  <button type="button" onClick={onReply} className={iconButtonClass("quiet", "sm")} data-tt="Reply in ticket" aria-label="Reply in ticket">
                    <Reply />
                  </button>
                )}
                <CopyButton text={card.email} label="Copy email" iconOnly variant="ghost" onCopied={() => copied("Email")} />
              </span>
            </li>
          )}
        </ul>
      )}

      {/* Chat */}
      {card.im.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 print:hidden">
          {card.im.map((m) => {
            const Icon = IM_ICON[m.kind];
            return (
              <span key={m.kind} className="inline-flex items-center">
                <a href={m.href} {...linkTarget(m.href)} className={buttonClass("secondary", "sm")}>
                  <Icon className="h-3.5 w-3.5" aria-hidden /> {m.label}
                </a>
                {m.app_href && m.app_href !== m.href && (
                  <a
                    href={m.app_href}
                    className={iconButtonClass("quiet", "sm")}
                    data-tt={`Open in the ${m.kind === "teams" ? "Teams" : m.kind === "slack" ? "Slack" : "Webex"} app`}
                    aria-label={`Open ${card.name} in the ${m.kind === "teams" ? "Teams" : m.kind === "slack" ? "Slack" : "Webex"} app`}
                  >
                    <Laptop />
                  </a>
                )}
              </span>
            );
          })}
        </div>
      )}

      {/* More from the directory */}
      {!popover && card.extra.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          {card.extra.map((x) => (
            <div key={x.key} className="contents">
              <dt className="text-slate-500">{x.label}</dt>
              <dd className="break-words text-slate-800">{x.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {/* Their history (agents) */}
      {card.earlier_tickets && <EarlierTickets card={card} list={!popover} />}

      {/* Directory actions */}
      {(card.profile_url || card.vcard_url || card.calendar_href) && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-3 print:hidden">
          {card.profile_url && (
            <Button href={card.profile_url} variant="secondary" size="sm" icon={<UserRound />} {...profileProps}>
              Open profile
            </Button>
          )}
          <span className="ml-auto flex items-center gap-1.5">
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
            {card.vcard_url && card.directory_id && !popover && (
              <ProfileActions personId={card.directory_id} name={card.name} email={card.email} microsoft={false} qr={card.qr} />
            )}
          </span>
        </div>
      )}
    </div>
  );
}

/** An address that wraps before the @ (and at dots) rather than mid-word. */
function BreakableEmail({ email }: { email: string }) {
  // A break chance before the @ and before each dot of the domain.
  const parts = email.split(/(?=@)|(?<=@[^.]*)(?=\.)|(?<=@.*)(?=\.)/);
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && <wbr />}
          {p}
        </span>
      ))}
    </>
  );
}

function EarlierTickets({ card, list }: { card: HdContactCard; list: boolean }) {
  const e = card.earlier_tickets!;
  const first = card.name.split(" ")[0] || card.name;
  if (e.count === 0) {
    return (
      <p className="flex items-center gap-2 text-slate-500">
        <Ticket className={ICON} aria-hidden /> First ticket from {first}
      </p>
    );
  }
  const summary = (
    <>
      {e.count} earlier {e.count === 1 ? "ticket" : "tickets"}
      {e.last_at && (
        <span className="text-slate-500">
          {" "}· last one <RelativeTime value={e.last_at} />
        </span>
      )}
    </>
  );
  if (!list || e.recent.length === 0) {
    return (
      <p className="flex items-center gap-2 text-slate-600">
        <Ticket className={ICON} aria-hidden />
        <Link href={e.link} className="link">{summary}</Link>
      </p>
    );
  }
  return (
    <details className="group text-slate-600">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md hover:text-slate-900 [&::-webkit-details-marker]:hidden">
        <Ticket className={ICON} aria-hidden />
        <span className="min-w-0 flex-1">{summary}</span>
        <span className="text-xs font-medium text-compass-700 group-open:hidden">Show</span>
        <span className="hidden text-xs font-medium text-compass-700 group-open:inline">Hide</span>
      </summary>
      <ul className="mt-1.5 flex flex-col gap-0.5 pl-6">
        {e.recent.map((r) => (
          <li key={r.number} className="flex min-w-0 items-baseline gap-2">
            <Link href={`/desk/tickets/${r.number}`} className="min-w-0 flex-1 truncate hover:underline">
              <span className="tabular-nums text-slate-500">#{r.number}</span> {r.subject}
            </Link>
            <span className="shrink-0 text-xs text-slate-500">{HD_STATUS_LABEL[r.status as HdStatus] ?? r.status}</span>
          </li>
        ))}
        {e.count > e.recent.length && (
          <li>
            <Link href={e.link} className="link text-xs font-medium">
              All {e.count} tickets
            </Link>
          </li>
        )}
      </ul>
    </details>
  );
}

/** One row: photo, name, title, and the quickest ways to reach them. */
function CompactRow({ card, className, actions }: { card: HdContactCard; className: string; actions: boolean }) {
  const phone = card.phones.find((p) => p.tel_href);
  const mail = mailtoHref(card.email);
  const im = card.im[0];
  const ImIcon = im ? IM_ICON[im.kind] : null;
  return (
    <div className={`flex min-w-0 items-center gap-2.5 text-sm ${className}`}>
      <CardAvatar card={card} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium text-slate-900">{card.name}</span>
          {card.vip.vip && <VipChip reason={card.vip.reason} inLink />}
        </p>
        <p className="truncate text-xs text-slate-500">{[card.relation_label, card.title].filter(Boolean).join(" · ")}</p>
      </div>
      {actions && <span className="flex shrink-0 items-center print:hidden">
        {phone && (
          <a href={phone.tel_href} className={iconButtonClass("quiet", "sm")} data-tt={`Call ${phone.value}`} aria-label={`Call ${card.name}, ${phone.label.toLowerCase()}`}>
            <Phone />
          </a>
        )}
        {mail && (
          <a href={mail} className={iconButtonClass("quiet", "sm")} data-tt="Email" aria-label={`Email ${card.name}`}>
            <Mail />
          </a>
        )}
        {im && ImIcon && (
          <a href={im.href} {...linkTarget(im.href)} className={iconButtonClass("quiet", "sm")} data-tt={im.label} aria-label={`${im.label}: ${card.name}`}>
            <ImIcon />
          </a>
        )}
      </span>}
    </div>
  );
}
