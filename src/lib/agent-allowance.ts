// Helpdesk agent allowances: the client-safe half (the Agents page, the
// License page and lib/license share it). The licence's `agents` claim and
// the allowance in force live in lib/license (server-only); this module
// holds only what a screen prints. No server imports.

/** Helpdesk agents every licence with the helpdesk includes. */
export const INCLUDED_AGENTS = 3;

/** "3 included, 2 bought" / "3 included" / "" (an allowance below the included 3, minted by hand). */
export function allowanceBreakdown(licensed: number): string {
  if (licensed > INCLUDED_AGENTS) return `${INCLUDED_AGENTS} included, ${licensed - INCLUDED_AGENTS} bought`;
  if (licensed === INCLUDED_AGENTS) return `${INCLUDED_AGENTS} included`;
  return "";
}

/** "1 agent" / "2 agents". */
export function agentsNoun(n: number): string {
  return `${n} agent${n === 1 ? "" : "s"}`;
}
