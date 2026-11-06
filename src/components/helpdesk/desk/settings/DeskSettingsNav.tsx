"use client";

// The desk's settings rail: one row per page (the house RailLink, dense),
// showing the pages the desk role's capabilities reach (agent J's roles):
// Notifications for every agent, the rest by capability. Under lg it becomes a row of links over
// the page that scrolls sideways inside itself.

import { usePathname } from "next/navigation";
import { RailLink, RAIL_GROUP_TEXT } from "@/components/RailLink";
import { settingsItems } from "./settings-nav";
import { DeskNewChip, useDeskNew } from "./DeskNew";

export function DeskSettingsNav({ caps }: { caps: readonly string[] }) {
  const pathname = usePathname() || "";
  const groups = settingsItems(caps);
  // 1.19.2 (agent W5): the New chip on pages this person hasn't opened yet.
  const fresh = useDeskNew();
  return (
    <nav
      aria-label="Desk settings"
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 bg-surface px-3 py-2 lg:block lg:w-rail lg:overflow-y-auto lg:border-b-0 lg:border-r lg:px-2 lg:py-4 print:hidden"
    >
      {groups.map((g) => (
        <div key={g.group} className="contents lg:mb-3 lg:block">
          <p className={`${RAIL_GROUP_TEXT} mb-1 hidden px-3 lg:block`}>{g.group}</p>
          {g.items.map((i) => (
            <div key={i.href} className="shrink-0 lg:shrink">
              <RailLink
                href={i.href}
                icon={i.icon}
                label={i.label}
                active={pathname === i.href || pathname.startsWith(`${i.href}/`)}
                badge={fresh?.isNew(i.href) ? <DeskNewChip /> : undefined}
              />
            </div>
          ))}
        </div>
      ))}
    </nav>
  );
}
