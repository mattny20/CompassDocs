"use client";

// A cross-reference to a settings page ("Settings → Notifications") that is a
// link when the viewer can open that section and plain text when they
// cannot — never a link that redirects home. Reachability comes from the
// app layout (reachableSettingsSections), through context, so any client
// component anywhere in the shell can use it.

import { createContext, useContext, type ReactNode } from "react";
import Link from "next/link";
import { SETTINGS_SECTIONS, settingsSection } from "@/lib/settings-sections";

const ReachableContext = createContext<string[] | null>(null);

export function ReachableSettingsProvider({ sections, children }: { sections: string[]; children: ReactNode }) {
  return <ReachableContext.Provider value={sections}>{children}</ReachableContext.Provider>;
}

/** The section an admin href belongs to (longest prefix wins). */
function sectionOf(href: string): string | undefined {
  const path = href.split(/[#?]/)[0];
  return SETTINGS_SECTIONS.filter((s) => path === s.href || path.startsWith(`${s.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

/** True when the viewer may open the section that `href` lives in. */
export function useCanOpenSettings(href: string): boolean {
  const reachable = useContext(ReachableContext);
  const section = sectionOf(href);
  if (!section) return false;
  return reachable ? reachable.includes(section) : false;
}

export function SettingsLink({
  href,
  children,
  className = "link font-medium",
}: {
  href: string;
  /** Defaults to "Settings → Section". */
  children?: ReactNode;
  className?: string;
}) {
  const can = useCanOpenSettings(href);
  const label = children ?? `Settings → ${settingsSection(sectionOf(href) ?? "")?.label ?? "Settings"}`;
  return can ? (
    <Link href={href} className={className}>
      {label}
    </Link>
  ) : (
    <span className="font-medium">{label}</span>
  );
}
