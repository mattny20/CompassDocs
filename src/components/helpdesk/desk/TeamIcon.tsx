// A helpdesk team's (or request type's) icon: the icon column holds a lucide name ("monitor",
// "heart", "building"); unknown or empty names fall back to Users. A
// closed map rather than a dynamic import, so the bundle carries only
// these glyphs.

import {
  Briefcase,
  Building2,
  CircleHelp,
  FileText,
  Flag,
  UserPlus,
  UserRound,
  Car,
  Coins,
  GraduationCap,
  Hammer,
  Heart,
  KeyRound,
  Laptop,
  LifeBuoy,
  Monitor,
  Scale,
  ShieldCheck,
  Truck,
  Users,
  Wallet,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export const TEAM_ICONS: Record<string, LucideIcon> = {
  monitor: Monitor,
  laptop: Laptop,
  heart: Heart,
  building: Building2,
  wrench: Wrench,
  hammer: Hammer,
  wallet: Wallet,
  coins: Coins,
  key: KeyRound,
  shield: ShieldCheck,
  scale: Scale,
  briefcase: Briefcase,
  truck: Truck,
  car: Car,
  graduation: GraduationCap,
  lifebuoy: LifeBuoy,
  users: Users,
  user: UserRound,
  "user-plus": UserPlus,
  userPlus: UserPlus,
  flag: Flag,
  file: FileText,
  help: CircleHelp,
};

export const TEAM_ICON_NAMES = Object.keys(TEAM_ICONS);

export function TeamIcon({ name, className = "h-4 w-4" }: { name: string | null | undefined; className?: string }) {
  const Icon = (name && TEAM_ICONS[name]) || Users;
  return <Icon className={className} aria-hidden />;
}
