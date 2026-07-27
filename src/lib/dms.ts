// Document-management-system links: detection + validation. These render like
// attachments on a document but store nothing — just a titled deep link into
// iManage, NetDocuments, SharePoint, or any other https URL.

export type DmsSystem = "imanage" | "netdocuments" | "sharepoint" | "link";

export const DMS_LABEL: Record<DmsSystem, string> = {
  imanage: "iManage",
  netdocuments: "NetDocuments",
  sharepoint: "SharePoint",
  link: "Link",
};

/**
 * Which system a URL points into, by host (or the iManage `iwl:` scheme).
 * Unknown hosts are perfectly fine — they land in the generic "link" bucket.
 */
export function detectDmsSystem(url: string): DmsSystem {
  const lower = url.trim().toLowerCase();
  if (lower.startsWith("iwl:")) return "imanage";
  let host = "";
  try {
    host = new URL(lower).hostname;
  } catch {
    return "link";
  }
  const within = (domain: string) => host === domain || host.endsWith("." + domain);
  if (within("cloudimanage.com") || within("imanage.work") || within("imanage.com")) {
    return "imanage";
  }
  if (within("netdocuments.com") || within("netvoyage.com") || within("nddocs.com")) {
    return "netdocuments";
  }
  if (
    within("sharepoint.com") ||
    within("sharepoint-df.com") ||
    within("sharepoint.us") ||
    within("sharepoint.cn")
  ) {
    return "sharepoint";
  }
  return "link";
}

/**
 * Accept https URLs plus iManage's `iwl:` desktop-link scheme. Everything
 * else (http, javascript:, file:, …) is refused — these render as clickable
 * links for every reader of the doc.
 */
export function validateDmsUrl(url: string): string | null {
  const t = url.trim();
  if (!t) return "A URL is required.";
  if (t.length > 2000) return "URL is too long (2000 characters max).";
  if (/^iwl:/i.test(t)) return null;
  try {
    const u = new URL(t);
    if (u.protocol !== "https:") return "Only https:// (or iManage iwl:) links are allowed.";
  } catch {
    return "That doesn't look like a valid URL.";
  }
  return null;
}

/** A human fallback title when the user doesn't supply one. */
export function defaultDmsTitle(url: string, system: DmsSystem): string {
  if (system !== "link") return `${DMS_LABEL[system]} document`;
  try {
    return new URL(url).hostname;
  } catch {
    return "External document";
  }
}
