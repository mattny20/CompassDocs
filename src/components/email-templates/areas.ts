// Which area of the product an email event belongs to, for the Templates
// tab's groups. The engine may name the area itself (EmailEvent.area); this
// is the fallback by key, and the order the groups are listed in.

export const AREA_ORDER = [
  "Documents",
  "Read confirmation",
  "Training",
  "Directory",
  "Newsletter",
  "Helpdesk",
  "Account and security",
  "Other",
] as const;

export function areaForKey(key: string): string {
  if (key.startsWith("ack_")) return "Read confirmation";
  if (key.startsWith("training_")) return "Training";
  if (key.startsWith("hd_")) return "Helpdesk";
  if (key.startsWith("directory_")) return "Directory";
  if (key.startsWith("newsletter")) return "Newsletter";
  if (/^(account|password|security|signin|sign_in|mfa|invite|login)/.test(key)) return "Account and security";
  if (["doc_update", "mention", "review_due", "workflow_event", "announcement"].includes(key)) return "Documents";
  return "Other";
}

export function areaRank(area: string): number {
  const i = (AREA_ORDER as readonly string[]).indexOf(area);
  return i < 0 ? AREA_ORDER.length - 1 : i;
}
