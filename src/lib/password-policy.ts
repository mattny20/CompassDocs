// One password minimum everywhere (STYLEGUIDE §Forms): setup, the forced
// first-login change, Account → Security, and admin resets all used to
// disagree (8 vs 6). Pure, so client forms and API routes share it.

export const PASSWORD_MIN = 8;

export const PASSWORD_HELP = `At least ${PASSWORD_MIN} characters.`;

/** The reason a password is refused, or undefined when it is acceptable. */
export function passwordProblem(password: string): string | undefined {
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  return undefined;
}
