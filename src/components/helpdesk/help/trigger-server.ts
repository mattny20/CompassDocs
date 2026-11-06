import "server-only";

// The server half of a CompassDocs trigger (1.19.0): null when the person
// may not raise a request (no licence, no helpdesk.request), else the
// request type the trigger starts for them, so the caller renders the
// trigger only when it can work and its dialog asks the right questions.

import { getCurrentUser } from "@/lib/auth";
import type { HdRequestType } from "@/lib/helpdesk/types";
import type { SessionUser } from "@/lib/types";
import { helpAccess } from "./access";
import { triggerRequestType, type TriggerSource } from "./trigger-type";

export interface TriggerSetup {
  type: HdRequestType | null;
}

export async function helpTrigger(user: SessionUser | null, source: TriggerSource): Promise<TriggerSetup | null> {
  const who = user ?? (await getCurrentUser());
  if (!who) return null;
  try {
    if (!(await helpAccess(who)).canRequest) return null;
    return { type: await triggerRequestType(who, source) };
  } catch {
    // A helpdesk that cannot answer hides its trigger; the page around it renders as before.
    return null;
  }
}
