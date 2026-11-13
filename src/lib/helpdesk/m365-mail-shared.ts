// Helpdesk 1.20.7: Microsoft 365 mailbox connection, the pure half. The
// shapes the Email settings page reads, the limits, and the Exchange Online
// PowerShell commands that limit the app registration to the help mailboxes
// (Microsoft's "RBAC for Applications"; nothing in Microsoft Graph can do
// that step, so the admin runs it once). No database, no server-only
// imports.

export const M365_MAIL_LIMITS = {
  mailboxes: 25,
  folder: 60,
  pollMin: 1,
  pollMax: 60,
  /** A message that fails this many times is left alone, with a visible error. */
  attempts: 5,
} as const;

export const M365_DEFAULTS = { after: "read", folder: "Processed", notifications: true, poll_minutes: 2 } as const;

/** With notifications working, the timer still reads every this many minutes as a safety net. */
export const M365_SAFETY_NET_MINUTES = 15;
/** Subscriptions are asked for this long and renewed a day before they end (Microsoft allows just under 7 days). */
export const M365_SUBSCRIPTION_MINUTES = 2 * 24 * 60;
export const M365_RENEW_BEFORE_MINUTES = 24 * 60;

/** The Exchange Online application roles the desk needs, and what each is for. */
export const M365_ROLES = [
  { role: "Application Mail.ReadWrite", graph: "Mail.ReadWrite", why: "read new mail, mark it read or move it" },
  { role: "Application Mail.Send", graph: "Mail.Send", why: "send replies as the mailbox" },
] as const;

/** Graph application permissions that, granted in Entra, reach every mailbox in the organisation. */
export const M365_TENANT_WIDE = ["Mail.Read", "Mail.ReadWrite", "Mail.ReadBasic", "Mail.ReadBasic.All", "Mail.Send", "full_access_as_app"] as const;

export const M365_APP_NAME = "CompassDocs Helpdesk Mail";
export const M365_SCOPE_NAME = "CompassDocs help mailboxes";

export type M365AfterIntake = "read" | "move";

/** Why new mail is read the way it is, in one word; the page turns it into a sentence. */
export type M365Mode = "notifications" | "timer_off" | "timer_no_address" | "timer_refused" | "timer_pending";

export interface M365MailboxView {
  id: number;
  address: string;
  mode: M365Mode;
  /** Until when Microsoft keeps notifying (null = no subscription). */
  sub_expires_at: string | null;
  sub_error: string;
  sub_error_at: string | null;
  last_notified_at: string | null;
  last_poll_at: string | null;
  last_ok_at: string | null;
  last_error: string;
  last_error_at: string | null;
  taken_in: number;
  dropped: number;
  failed: number;
  connected_at: string;
  /** The help addresses that live on this mailbox. */
  addresses: { id: number; address: string; send_via: boolean }[];
}

export interface M365AccessCheck {
  at: string;
  /** Graph mail permissions granted in Entra itself: with any of these the app reaches every mailbox. */
  tenant_wide: string[];
  mailboxes: { address: string; ok: boolean; error: string }[];
  /** A mailbox the desk should NOT reach, when the admin named one. */
  probe: { address: string; reachable: boolean; note: string } | null;
}

export interface M365LinkView {
  /** The help address (hd_mailboxes.id). */
  mailbox_id: number;
  m365_mailbox_id: number;
  m365_address: string;
  /** "Send replies through Microsoft 365" is chosen and in force (no send-from address is picked instead). */
  send_via: boolean;
  send_error: string;
  send_error_at: string | null;
}

export interface M365MailView {
  connected: boolean;
  tenant: string;
  client_id: string;
  /** The enterprise application's object ID (the commands need it); '' until the app has signed in once. */
  sp_object_id: string;
  secret_set: boolean;
  secret_expires: string;
  setup: "one_click" | "manual" | "";
  /** False while Microsoft is still activating a new app registration. */
  verified: boolean;
  after: M365AfterIntake;
  folder: string;
  notifications: boolean;
  poll_minutes: number;
  /** Where Microsoft would send notifications ('' = this desk has no address Microsoft can reach). */
  notify_url_ok: boolean;
  notify_origin: string;
  mailboxes: M365MailboxView[];
  links: M365LinkView[];
  access: M365AccessCheck | null;
  limit: number;
  /** Mailboxes are still listed from a connection that was removed. */
  orphaned: boolean;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = (v: string) => GUID.test(v.trim());

/** Why what was typed into the manual form is refused ('' = fine). The API answers the same sentences. */
export function m365CredentialsProblem(raw: { tenant?: unknown; client_id?: unknown; secret?: unknown }, secretOptional = false): string {
  const tenant = typeof raw.tenant === "string" ? raw.tenant.trim() : "";
  const client = typeof raw.client_id === "string" ? raw.client_id.trim() : "";
  const secret = typeof raw.secret === "string" ? raw.secret.trim() : "";
  if (!tenant) return "Enter the tenant ID.";
  if (!isGuid(tenant) && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(tenant)) return "The tenant is its ID (a GUID) or a domain such as contoso.onmicrosoft.com.";
  if (!isGuid(client)) return "The application (client) ID is a GUID. Copy it from the app registration's Overview page.";
  if (!secret && !secretOptional) return "Enter the client secret's value.";
  if (secret.length > 400) return "That is too long to be a client secret.";
  return "";
}

/** A folder name as stored: no slashes or control characters, at most 60 characters. */
export function cleanFolderName(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/[\u0000-\u001f\\/]/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, M365_MAIL_LIMITS.folder) : "";
}

/** A value inside a PowerShell single-quoted string. */
const psq = (v: string) => v.replace(/'/g, "''");

/** The recipient filter that names exactly these mailboxes. */
export function scopeFilter(addresses: readonly string[]): string {
  return addresses.map((a) => `PrimarySmtpAddress -eq '${psq(a)}'`).join(" -or ");
}

/**
 * The Exchange Online PowerShell block that lets the app reach the help
 * mailboxes and nothing else. `first`: the whole setup (register the app's
 * service principal in Exchange, make the scope, assign the two roles);
 * otherwise only the scope is rewritten (a mailbox was added or removed).
 * Null when there is nothing to name yet.
 */
export function restrictCommands(opts: { clientId: string; spObjectId: string; addresses: readonly string[]; first: boolean }): string | null {
  const addresses = [...new Set(opts.addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  if (!addresses.length || !isGuid(opts.clientId) || !isGuid(opts.spObjectId)) return null;
  const filter = scopeFilter(addresses);
  const test = `Test-ServicePrincipalAuthorization -Identity ${opts.spObjectId} -Resource ${addresses[0]} | Format-Table Role, InScope`;
  if (!opts.first) {
    return [`Connect-ExchangeOnline`, `Set-ManagementScope -Identity "${M365_SCOPE_NAME}" -RecipientRestrictionFilter "${filter}"`, test].join("\n");
  }
  return [
    `Connect-ExchangeOnline`,
    `New-ServicePrincipal -AppId ${opts.clientId} -ObjectId ${opts.spObjectId} -DisplayName "${M365_APP_NAME}"`,
    `New-ManagementScope -Name "${M365_SCOPE_NAME}" -RecipientRestrictionFilter "${filter}"`,
    ...M365_ROLES.map((r) => `New-ManagementRoleAssignment -Name "CompassDocs ${r.graph}" -App ${opts.spObjectId} -Role "${r.role}" -CustomResourceScope "${M365_SCOPE_NAME}"`),
    test,
  ].join("\n");
}

/** One sentence for how a mailbox's new mail arrives. */
export function modeSentence(mode: M365Mode, pollMinutes: number, origin: string): string {
  const every = pollMinutes === 1 ? "every minute" : `every ${pollMinutes} minutes`;
  if (mode === "notifications") return `Microsoft tells the desk when mail arrives. The desk also checks every ${M365_SAFETY_NET_MINUTES} minutes.`;
  if (mode === "timer_off") return `Notifications are off, so the desk checks ${every}.`;
  if (mode === "timer_no_address") return `Microsoft can't reach this desk${origin ? ` at ${origin}` : ""} (it needs a public https address), so the desk checks ${every}.`;
  if (mode === "timer_refused") return `Microsoft refused notifications for this mailbox, so the desk checks ${every}.`;
  return `Notifications are being set up. Until then the desk checks ${every}.`;
}
