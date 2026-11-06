// hd_asset_lookup in the Claude connector (1.19.3, lib/helpdesk/assets):
// look an asset up by tag, serial, name, model or person, read only, with
// the same rules as the desk's picker: every asset when "Agents can search
// all assets" is on, otherwise only the assets of people whose tickets the
// person works. Listed and dispatched by lib/mcp/helpdesk-tools (agent
// side; no workspace level, it writes nothing). Linking stays in the desk.

import { assetLookupForMcp } from "../helpdesk/assets";
import type { User } from "../types";

export const ASSET_TOOL_DEF = {
  name: "hd_asset_lookup",
  side: "agent" as const,
  description:
    "Helpdesk desk: look up assets (laptops, phones, monitors) synced from Snipe-IT by asset tag, serial number, name, model or the person they're assigned to. Read only: each comes back with its status, who has it, location, warranty end, how many tickets it is linked to and a link to it in Snipe-IT. Linking an asset to a ticket is done in the desk. hd_read_ticket lists a ticket's linked assets.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "An asset tag (ASSET-00421), serial, name, model or person's name or address." },
      limit: { type: "number", description: "1 to 20 (default 10)." },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

type Answer = { ok: true; value: unknown } | { ok: false; error: string };

export async function assetLookupTool(user: User, a: Record<string, unknown>): Promise<Answer> {
  const query = typeof a.query === "string" ? a.query.trim().slice(0, 120) : "";
  if (!query) return { ok: false, error: "Say what to look for: an asset tag, serial, name or person." };
  const limit = Math.min(20, Math.max(1, Number.isFinite(Number(a.limit)) ? Math.floor(Number(a.limit)) : 10));
  const r = await assetLookupForMcp(user, query, limit);
  return { ok: true, value: { assets: r.assets, ...(r.notice ? { notice: r.notice } : {}) } };
}
