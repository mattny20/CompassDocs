// The Duo sign-in check (1.20.5): what one session owes.
//
// lib/auth currentSession calls this, and only when a Duo rule is switched
// on in the settings map it already read (lib/duo-policy duoSwitchedOn), so
// a workspace without Duo never loads this file. It adds no query of its
// own: the settings map and the session row are the ones the session check
// read anyway. The one write is the bypass note, once per session.

import "server-only";
import { audit } from "./audit";
import { markSessionBypassSeen, type SessionFacts } from "./db";
import { duoPolicyFromSettings } from "./duo-config";
import { duoStanding, type DuoStanding } from "./duo-policy";
import type { User } from "./types";

export async function duoSessionStanding(
  settings: Record<string, string>,
  session: User & SessionFacts,
  token: string
): Promise<DuoStanding> {
  const standing = duoStanding(duoPolicyFromSettings(settings), {
    userId: session.id,
    mfaAt: session.mfa_at,
    mfaMethod: session.mfa_method,
  });
  const { verdict } = standing;
  // A break-glass account skipping Duo is worth a line in the audit log, once
  // per session (when it is first seen), never once per request.
  if (verdict.bypassed && !session.mfa_bypass_at) {
    try {
      if (await markSessionBypassSeen(token)) {
        await audit({
          actor: { id: session.id, name: session.name || session.username, role: session.role },
          action: "auth.duo_bypass",
          targetType: "user",
          targetId: session.id,
          targetLabel: session.username,
        });
      }
    } catch {
      /* the note is best effort; the bypass itself does not depend on it */
    }
  }
  return standing;
}
