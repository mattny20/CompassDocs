"use client";

// The agent's menu in the desk's top bar: their avatar with a presence dot,
// their availability (Available / Away / Offline, stored through PATCH
// /api/helpdesk/me/availability) and the ways out (CompassDocs, account,
// sign out). Availability is a choice of one, so the rows are
// menuitemradio (STYLEGUIDE §Overlays, picker menu).

import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, ExternalLink, LogOut, UserRound } from "lucide-react";
import { Popover, MenuItem, MenuSeparator } from "@/components/Popover";
import { forgetPushOnThisDevice } from "./pwa/platform";
import { initialsOf } from "@/components/UserAvatar";
import { toast } from "@/components/Toasts";
import { RoleChip } from "./roles/role-ui";
import { isHdRole } from "@/lib/helpdesk/roles-shared";
import { HD_AVAILABILITY_LABEL, type HdAvailability } from "@/lib/helpdesk/types";
import { sendJson } from "./api";
import { AutoAssignToggle } from "./assignment/AutoAssignToggle";

const DOT: Record<HdAvailability, string> = {
  available: "bg-emerald-500",
  away: "bg-amber-500",
  offline: "bg-slate-400",
};

const HINT: Record<HdAvailability, string> = {
  available: "New tickets can be assigned to you",
  away: "Automatic assignment skips you",
  offline: "You're not working tickets now",
};

export function AvailabilityMenu({
  name,
  role,
  initial,
  extra,
}: {
  name: string;
  /** The desk role's key (newbie … admin), shown as J's role chip beside the name. */
  role: string | null;
  initial: HdAvailability;
  /** Extra rows above the ways out (the desk app's install prompt). */
  extra?: ReactNode;
}) {
  const [status, setStatus] = useState<HdAvailability>(initial);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const router = useRouter();

  async function choose(next: HdAvailability) {
    setOpen(false);
    btn.current?.focus();
    if (next === status) return;
    const prev = status;
    setStatus(next);
    try {
      await sendJson("/api/helpdesk/me/availability", "PATCH", { status: next }, "Couldn't change your availability.");
      toast("ok", `You're ${HD_AVAILABILITY_LABEL[next].toLowerCase()}.`);
    } catch (e) {
      setStatus(prev);
      toast("error", (e as Error).message);
    }
  }

  async function signOut() {
    // This device stops getting desk push notices once signed out.
    await forgetPushOnThisDevice();
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="relative">
      <button
        ref={btn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${name}: ${HD_AVAILABILITY_LABEL[status]}`}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 items-center gap-2 rounded-lg px-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
      >
        <span className="relative grid h-7 w-7 shrink-0 place-items-center rounded-full bg-compass-100 text-2xs font-bold text-compass-700">
          {initialsOf(name)}
          <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface ${DOT[status]}`} aria-hidden />
        </span>
        <span className="hidden sm:inline">{HD_AVAILABILITY_LABEL[status]}</span>
        <ChevronDown className="hidden h-3.5 w-3.5 text-slate-400 sm:block" aria-hidden />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={btn} role="menu" label="Your availability" align="end" width="w-64" className="mt-1">
        <p className="flex items-center gap-2 px-2 pb-1 pt-1.5 text-xs text-slate-500">
          <span className="min-w-0 truncate">{name}</span>
          {role && isHdRole(role) && <RoleChip role={role} size="sm" />}
        </p>
        {(Object.keys(HD_AVAILABILITY_LABEL) as HdAvailability[]).map((s) => {
          const on = s === status;
          return (
            <button
              key={s}
              type="button"
              role="menuitemradio"
              aria-checked={on}
              onClick={() => choose(s)}
              className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition ${
                on ? "bg-compass-50 text-compass-700" : "text-slate-700 hover:bg-slate-50"
              }`}
            >
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[s]}`} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{HD_AVAILABILITY_LABEL[s]}</span>
                <span className="block text-xs text-slate-500">{HINT[s]}</span>
              </span>
              {on && <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
            </button>
          );
        })}
        {/* Opt out of round robin and load balancing for a while (agent N). */}
        <AutoAssignToggle />
        {extra && (
          <>
            <MenuSeparator />
            {/* A row marked data-closes-menu (1.19.4: "Desk background…") opens a panel of its own, so the menu closes. */}
            <div role="none" onClick={(e) => (e.target as Element).closest("[data-closes-menu]") && setOpen(false)}>
              {extra}
            </div>
          </>
        )}
        <MenuSeparator />
        <MenuItem icon={<ExternalLink />} onClick={() => { setOpen(false); window.open("/", "_blank", "noopener"); }}>
          Open CompassDocs
        </MenuItem>
        <MenuItem icon={<UserRound />} onClick={() => { setOpen(false); window.open("/account", "_blank", "noopener"); }}>
          Your account
        </MenuItem>
        <MenuItem icon={<LogOut />} onClick={signOut}>
          Sign out
        </MenuItem>
      </Popover>
    </div>
  );
}
