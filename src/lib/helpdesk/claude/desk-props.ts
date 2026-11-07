// Helpdesk 1.20.0: what the desk shell needs to show Claude to one agent
// (the button, the panel's context chips), or null when Claude is not on for
// them. Read by app/(desk)/layout. Server-only.

import "server-only";
import { getAiModel } from "../../ai-config";
import { claudeDeskAvailableFor, getClaudeDeskConfig, webSearchAvailable } from "./config";

export interface ClaudeDeskClientProps {
  caps: { read: boolean; drafts: boolean; changes: boolean; web: boolean };
  webLabel: string | null;
}

export async function claudeDeskClientProps(user: { id: number; role: import("../../types").Role }): Promise<ClaudeDeskClientProps | null> {
  if (!(await claudeDeskAvailableFor(user))) return null;
  const [cfg, model] = await Promise.all([getClaudeDeskConfig(), getAiModel()]);
  const web = cfg.caps.web && cfg.web_domains.length > 0 && webSearchAvailable(model);
  return {
    caps: { read: cfg.caps.read, drafts: cfg.caps.drafts, changes: cfg.caps.changes, web },
    webLabel: web ? (cfg.web_domains.length === 1 ? `Web: ${cfg.web_domains[0]}` : "Web: vendor sites") : null,
  };
}
