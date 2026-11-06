// Canned responses, the bits other desk settings pages need (1.19.2, agent
// W4). Client-safe.

import { getJson } from "../api";

/**
 * The Delete team dialog's sentence about the team's canned responses,
 * which are deleted with it ("" when it has none or the count can't be read).
 */
export async function cannedTeamDeleteNote(teamId: number): Promise<string> {
  try {
    const d = await getJson<{ count?: number }>(`/api/helpdesk/admin/canned/team-count?team=${teamId}`);
    const n = typeof d.count === "number" ? d.count : 0;
    if (!n) return "";
    return n === 1 ? " Its canned response is deleted with it." : ` Its ${n.toLocaleString("en")} canned responses are deleted with it.`;
  } catch {
    return " Any canned responses shared with it are deleted with it.";
  }
}
