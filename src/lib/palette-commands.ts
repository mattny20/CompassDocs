// Actions the command palette can run. Isomorphic; the server decides which
// ids a given user may see (lib/nav-capabilities → commandIds) so a gated
// command can't be rendered, hotkeyed, or activated on the client at all.
//
// Every target re-checks permission server-side — this list is a UX filter,
// never the enforcement boundary.

import type { LucideIcon } from "lucide-react";
import {
  DatabaseBackup,
  FilePlus2,
  FolderPlus,
  KeyRound,
  LayoutTemplate,
  Mail,
  Megaphone,
  Moon,
  Package,
  ScrollText,
  Users,
  UsersRound,
  Keyboard,
} from "lucide-react";
import type { CapKey } from "./nav-items";

export interface PaletteCommand {
  id: string;
  label: string;
  icon: LucideIcon;
  keywords: string;
  cap: CapKey | null;
  /** Where it goes. Commands without an href are handled by the client. */
  href?: string;
  /**
   * Set when the destination is a page the user still has to act on — shown
   * as a muted suffix so the palette doesn't promise more than it does.
   */
  hint?: string;
  /** Keyboard hint shown on the row. */
  keyHint?: string;
}

export const PALETTE_COMMANDS: PaletteCommand[] = [
  { id: "doc.new", label: "New document", icon: FilePlus2, keywords: "create write page add draft", cap: "canAuthor", href: "/doc/new", keyHint: "c" },
  { id: "space.new", label: "New space", icon: FolderPlus, keywords: "create team area section", cap: "isAdmin", href: "/admin/spaces", hint: "opens Spaces" },
  { id: "template.new", label: "New template", icon: LayoutTemplate, keywords: "create document template sop starter", cap: "isAdmin", href: "/admin/templates", hint: "opens Templates" },
  { id: "announcement.new", label: "New announcement", icon: Megaphone, keywords: "post broadcast news publish", cap: "showAnnouncements", href: "/announcements", hint: "opens Announcements" },
  { id: "newsletter.new", label: "New newsletter issue", icon: Mail, keywords: "email campaign digest draft", cap: "showNewsletter", href: "/newsletter", hint: "opens the newsletter workspace" },
  { id: "user.invite", label: "Add a user", icon: Users, keywords: "invite account people onboard new", cap: "isAdmin", href: "/admin/users", hint: "opens Users & roles" },
  { id: "group.new", label: "New group", icon: UsersRound, keywords: "team membership access create", cap: "isAdmin", href: "/admin/groups", hint: "opens Groups" },
  { id: "backup.open", label: "Backups", icon: DatabaseBackup, keywords: "restore snapshot schedule destination", cap: "isAdmin", href: "/admin/backups" },
  { id: "audit.open", label: "Audit log", icon: ScrollText, keywords: "security history who did what events", cap: "isAdmin", href: "/admin/audit" },
  { id: "license.open", label: "License", icon: KeyRound, keywords: "enterprise entitlements activate key", cap: "isAdmin", href: "/admin/license" },
  { id: "data.open", label: "Import & export", icon: Package, keywords: "markdown zip migrate confluence notion", cap: "isAdmin", href: "/admin/data" },
  { id: "theme.toggle", label: "Toggle dark mode", icon: Moon, keywords: "theme light night appearance", cap: null },
  { id: "help.shortcuts", label: "Keyboard shortcuts", icon: Keyboard, keywords: "hotkeys keys bindings help cheatsheet", cap: null, keyHint: "?" },
];
