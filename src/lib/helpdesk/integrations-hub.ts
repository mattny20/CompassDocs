// Helpdesk 1.20.2: Desk settings → Integrations as a hub. One read answers,
// for the person asking, which integration pages they may open and how each
// stands: "connected", "not_set_up" or "attention" (set up, but something
// needs a look), with one short line of fact. A tile the person could not
// open before is not in the answer at all, so the hub leaks no state: every
// status comes from the read its own page makes, behind that page's
// capability (settings.manage; alert sources also channels.manage).
// Server-only.

import "server-only";
import { hq } from "./db-core";
import { hdCan } from "./roles";
import type { SessionUser } from "../types";
import { HUB_TILES, type HubStatus, type HubTileKey, type HubTileState } from "./integrations-hub-shared";

export type { HubStatus, HubTileKey, HubTileState } from "./integrations-hub-shared";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
const st = (status: HubStatus, note = ""): HubTileState => ({ status, note });

/** The tiles this person may open, each with its state. A tile whose read fails says "attention" rather than vanishing. */
export async function integrationsHub(user: SessionUser): Promise<Partial<Record<HubTileKey, HubTileState>>> {
  const [settings, channels] = await Promise.all([hdCan(user, "settings.manage"), hdCan(user, "channels.manage")]);
  const out: Partial<Record<HubTileKey, HubTileState>> = {};
  const put = async (key: HubTileKey, read: () => Promise<HubTileState>) => {
    const need = HUB_TILES.find((t) => t.key === key)!.caps;
    if (!need.some((c) => (c === "settings.manage" ? settings : channels))) return;
    try {
      out[key] = await read();
    } catch (e) {
      console.error(`[helpdesk] integrations hub (${key}):`, e instanceof Error ? e.message : e);
      out[key] = st("attention", "Couldn't read its status. Open it to check.");
    }
  };

  // Assets: one view serves the three tiles.
  let assetView: Awaited<ReturnType<typeof import("./assets").assetSettingsView>> | null = null;
  const assets = async () => (assetView ??= await (await import("./assets")).assetSettingsView());
  await put("snipe-it", async () => {
    const s = (await assets()).snipeit;
    if (!s.url || !s.key_set) return st("not_set_up");
    if (s.sync.ok === false) return st("attention", s.sync.error || "The last sync failed.");
    return st("connected", `${plural(s.sync.count, "asset")}${s.sync.running ? ", syncing now" : ""}`);
  });
  await put("intune", async () => {
    const it = (await assets()).intune;
    if (!it.on) return st("not_set_up");
    if (it.unavailable === "legacy_gone") return st("attention", "Needs its own app registration.");
    if (it.check_error) return st("attention", it.check_error);
    if (it.sync.ok === false) return st("attention", it.sync.error || "The last sync failed.");
    return st("connected", `${plural(it.sync.count, "device")}${it.mode === "directory" ? ", using the directory sync app" : ""}`);
  });
  await put("assets", async () => st("none", (await assets()).agents_search_all ? "Agents can search all assets" : "Agents see their people's assets"));

  // Chat apps: one view, two tiles.
  let chatView: Awaited<ReturnType<typeof import("./chat/settings").chatSettingsView>> | null = null;
  const chat = async () => (chatView ??= await (await import("./chat/settings")).chatSettingsView(""));
  await put("teams", async () => ((await chat()).teams.connected ? st("connected") : st("not_set_up")));
  await put("slack", async () => {
    const s = (await chat()).slack;
    return s.connected ? st("connected", s.team_name || "") : st("not_set_up");
  });

  await put("claude-connector", async () => {
    const level = await (await import("./claude-connector")).getClaudeLevel();
    // The connector is always there for people who connect it; the workspace sets how far it may go.
    return st("connected", level === "read" ? "Reads only" : level === "notes" ? "Reads and adds notes" : "Reads and updates tickets");
  });
  await put("claude-desk", async () => {
    const cfg = await (await import("./claude/config")).getClaudeDeskConfig();
    return cfg.enabled ? st("connected") : st("not_set_up");
  });

  await put("api-tokens", async () => {
    const live = (await (await import("./api-tokens")).listApiTokenViews()).filter((t) => !t.revoked_at && !t.expired);
    return live.length ? st("connected", plural(live.length, "token")) : st("not_set_up");
  });
  await put("webhooks", async () => {
    const hooks = await (await import("./webhooks")).listWebhookViews();
    if (!hooks.length) return st("not_set_up");
    const failing = hooks.filter((h) => h.health === "failing" || (!h.enabled && !!h.disabled_reason));
    if (failing.length) return st("attention", `${plural(failing.length, "webhook")} failing`);
    const on = hooks.filter((h) => h.enabled).length;
    return on ? st("connected", plural(on, "webhook")) : st("not_set_up", "All switched off");
  });

  await put("alerts", async () => {
    const n = (await hq<{ n: number }>("SELECT count(*)::int AS n FROM hd_integrations"))[0]?.n ?? 0;
    return n ? st("connected", plural(n, "source")) : st("not_set_up");
  });
  return out;
}
