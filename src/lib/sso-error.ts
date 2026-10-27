// The sentence for a ?sso_error on /login (1.16.0). Short codes (not raw
// messages) cross the redirect from the SSO callback so nothing sensitive
// lands in the URL. Only the table's own keys count: "constructor",
// "__proto__" and the like are unknown codes, never Object.prototype's
// members. Pure.

const SSO_ERRORS: Record<string, string> = {
  not_configured: "Single sign-on isn't fully configured. Ask your administrator.",
  idp: "Your identity provider reported an error. Please try again.",
  state: "The sign-in attempt expired or was tampered with. Please try again.",
  exchange: "Couldn't complete sign-in with your identity provider.",
  token: "Your identity provider returned an invalid token.",
  no_email: "Your identity provider didn't share an email address.",
  domain: "Your email domain isn't allowed to sign in here.",
  no_account: "No account exists for you, and automatic account creation is off.",
  // Why an existing account with the email was not linked, one code per cause
  // (overlay ee/sso-shared); link_denied is the generic one older overlays send.
  link_unconfirmed:
    "An account here already uses your email address, but the address hasn't been confirmed as yours, so single sign-on can't link to it. Ask your administrator to check which account uses your address.",
  link_ambiguous:
    "More than one account here uses your email address, so single sign-on can't tell which one is yours. Ask your administrator.",
  link_admin:
    "Your email address belongs to an administrator account, and single sign-on never links administrator accounts. Sign in with your username and password instead (at /login?local=1 when single sign-on is required).",
  link_other_provider:
    "Your email address belongs to an account that signs in with a different identity provider. Ask your administrator.",
  link_denied:
    "An account with your email already exists and can't be linked to single sign-on automatically. Ask your administrator.",
  disabled: "Your account is disabled. Ask your administrator.",
  internal: "Something went wrong during sign-in. Please try again.",
};

/** No code → nothing; a known code → its sentence; anything else (a repeated parameter too) → "internal". */
export function ssoErrorMessage(code: string | string[] | undefined): string | undefined {
  if (!code) return undefined;
  return typeof code === "string" && Object.hasOwn(SSO_ERRORS, code) ? SSO_ERRORS[code] : SSO_ERRORS.internal;
}
