// Helpdesk 1.19.3: the Snipe-IT client (an AssetProvider). Bearer-token JSON
// API, through lib/helpdesk/assets/http (https only, same-host redirects,
// 10 s, size cap, readable errors, the key never logged or echoed).
//
// Endpoints (Snipe-IT v6 to v8):
//   GET  /api/v1/hardware?limit&offset&sort=id&order=asc   paging (500 a page)
//   GET  /api/v1/hardware?search=…                          search
//   GET  /api/v1/hardware/bytag/{tag}                       one asset by tag
//   GET  /api/v1/hardware/byserial/{serial}                 assets by serial
//   GET  /api/v1/users?search={email}, then
//   GET  /api/v1/users/{id}/assets                          a person's assets
//   GET  /api/v1/hardware/{id}                              one asset
//   GET  /api/v1/maintenances?asset_id=…                    its maintenance
//   POST /api/v1/maintenances                               log one
//   GET  /api/v1/suppliers                                  the Supplier list
//
// Snipe-IT answers some failures with 200 and { status: "error", messages }
// (an unknown tag, a refused maintenance); those are read here. Its strings
// come HTML-escaped (&amp;, &#039;) and are unescaped once. Paging is
// sequential and backs off on 429 (Retry-After, at most 30 s, three tries),
// so a large estate never trips Snipe-IT's per-minute throttle for long.
// Server-only.

import "server-only";
import type { HdMaintenanceRecord } from "../assets-shared";
import { AssetHttpError, assetRequest, scrub, sourceMessage } from "./http";
import type { AssetProvider, MaintenanceInput, ProviderAsset, ProviderConfig } from "./providers";

export const SNIPEIT_PAGE = 500;
const MAX_PAGES = 400;

let testPaging: { page: number; maxPages: number } | null = null;
/** Tests: a smaller page and page cap (null restores 500 and 400). */
export function setSnipeItPagingForTests(p: { page: number; maxPages: number } | null): void {
  testPaging = p;
}
const LABEL = "Snipe-IT";

/** Undo Snipe-IT's HTML escaping of strings. */
export function unescapeHtml(s: unknown): string {
  if (typeof s !== "string") return typeof s === "number" ? String(s) : "";
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);

/** YYYY-MM-DD out of Snipe-IT's { date, formatted } or a plain string. */
function isoDate(v: unknown): string | null {
  const raw = typeof v === "string" ? v : obj(v)?.date ?? obj(v)?.datetime;
  const m = typeof raw === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(raw) : null;
  if (!m) return null;
  // Snipe-IT can hold "0000-00-00" and the like: only a real calendar date reaches the cache.
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1900 || y > 2200 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** A hardware row as the cache keeps it. */
export function normaliseHardware(row: unknown, base: string): ProviderAsset | null {
  const r = obj(row);
  if (!r || (typeof r.id !== "number" && typeof r.id !== "string")) return null;
  const id = String(r.id);
  const model = unescapeHtml(obj(r.model)?.name);
  const status = obj(r.status_label);
  const who = obj(r.assigned_to);
  const person = who && (who.type === undefined || who.type === "user");
  const personName = person ? unescapeHtml(who?.name) || [unescapeHtml(who?.first_name), unescapeHtml(who?.last_name)].filter(Boolean).join(" ") : "";
  const tag = unescapeHtml(r.asset_tag);
  return {
    external_id: id,
    tag,
    serial: unescapeHtml(r.serial),
    name: unescapeHtml(r.name) || model || tag,
    model,
    category: unescapeHtml(obj(r.category)?.name),
    status_label: unescapeHtml(status?.name),
    status_kind: (typeof status?.status_meta === "string" ? status.status_meta : typeof status?.status_type === "string" ? status.status_type : "").toLowerCase().slice(0, 20),
    assigned_email: person ? unescapeHtml(who?.email).toLowerCase() : "",
    assigned_name: personName,
    location: unescapeHtml(obj(r.location)?.name) || unescapeHtml(obj(r.rtd_location)?.name),
    purchase_date: isoDate(r.purchase_date),
    warranty_end: isoDate(r.warranty_expires),
    url: `${base}/hardware/${encodeURIComponent(id)}`,
    raw: {
      manufacturer: unescapeHtml(obj(r.manufacturer)?.name) || undefined,
      model_number: unescapeHtml(r.model_number) || undefined,
      status_type: typeof status?.status_type === "string" ? status.status_type : undefined,
    },
  };
}

function rowsOf(json: unknown): unknown[] {
  const o = obj(json);
  return Array.isArray(o?.rows) ? (o!.rows as unknown[]) : [];
}

/** Snipe-IT's "200 but an error" answer. */
function isErrorAnswer(json: unknown): boolean {
  return obj(json)?.status === "error";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function snipeItProvider(cfg: ProviderConfig): AssetProvider {
  const base = cfg.url.replace(/\/+$/, "");
  const api = (path: string) => `${base}/api/v1${path}`;
  const get = (path: string) => assetRequest({ url: api(path), token: cfg.token, label: LABEL, timeoutMs: cfg.timeoutMs });
  const asset = (row: unknown) => normaliseHardware(row, base);
  /** The source's own sentence, the key scrubbed out of it. */
  const said = (json: unknown) => scrub(sourceMessage(json), cfg.token);
  const assets = (json: unknown) => rowsOf(json).map(asset).filter((a): a is ProviderAsset => a !== null);

  /** A GET that backs off on 429 (background paging only). */
  async function patientGet(path: string): Promise<{ json: unknown }> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await get(path);
      } catch (e) {
        if (e instanceof AssetHttpError && e.status === 429 && attempt < 3) {
          await sleep(Math.min(30_000, e.retryAfterMs ?? 5_000 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
  }

  /** A GET whose 404 (or 200 "does not exist") means nothing found. */
  async function maybe(path: string): Promise<unknown | null> {
    try {
      const { json } = await get(path);
      return isErrorAnswer(json) ? null : json;
    } catch (e) {
      if (e instanceof AssetHttpError && e.status === 404) return null;
      throw e;
    }
  }

  const provider: AssetProvider = {
    key: cfg.key,
    label: LABEL,

    async test() {
      const { json } = await get("/hardware?limit=1&offset=0");
      const o = obj(json);
      if (isErrorAnswer(json)) throw new AssetHttpError(`${LABEL} refused the request. ${said(json)}`.trim(), 200, "http");
      if (!o || (!("total" in o) && !("rows" in o))) throw new AssetHttpError(`That address didn't answer like the ${LABEL} API.`, 200, "not_json");
      return { total: Number(o.total) || 0 };
    },

    async listAll(onPage) {
      const size = testPaging?.page ?? SNIPEIT_PAGE;
      const maxPages = testPaging?.maxPages ?? MAX_PAGES;
      let offset = 0;
      let total = 0;
      let most = 0;
      let seen = 0;
      // Ordered by id so a page boundary moves only when assets are deleted mid-sync.
      for (let page = 0; page < maxPages; page++) {
        const { json } = await patientGet(`/hardware?limit=${size}&offset=${offset}&sort=id&order=asc`);
        if (isErrorAnswer(json)) throw new AssetHttpError(`${LABEL} refused the asset list. ${said(json)}`.trim(), 200, "http");
        total = Number(obj(json)?.total) || 0;
        most = Math.max(most, total);
        const rows = rowsOf(json);
        const list = assets(json);
        seen += list.length;
        if (list.length) await onPage(list);
        offset += rows.length;
        if (rows.length === 0 || offset >= total) break;
      }
      // Complete only when the loop reached the end and saw as many assets as the source ever reported.
      return { total: most, seen, complete: offset >= total && seen >= most };
    },

    async search(q, limit) {
      const { json } = await get(`/hardware?search=${encodeURIComponent(q)}&limit=${Math.min(50, Math.max(1, limit))}&offset=0`);
      return isErrorAnswer(json) ? [] : assets(json);
    },

    async byTag(tag) {
      const json = await maybe(`/hardware/bytag/${encodeURIComponent(tag)}`);
      if (json === null) return null;
      // Some versions wrap it like a list.
      return obj(json)?.rows ? assets(json)[0] ?? null : asset(json);
    },

    async bySerial(serial) {
      const json = await maybe(`/hardware/byserial/${encodeURIComponent(serial)}`);
      if (json === null) return [];
      if (obj(json)?.rows) return assets(json);
      const one = asset(json);
      return one ? [one] : [];
    },

    async forEmail(email) {
      const want = email.trim().toLowerCase();
      if (!want) return null;
      const { json } = await get(`/users?search=${encodeURIComponent(want)}&limit=50&offset=0`);
      const person = rowsOf(json)
        .map(obj)
        .find((u) => u && unescapeHtml(u.email).toLowerCase() === want);
      if (!person) return null;
      const { json: theirs } = await get(`/users/${encodeURIComponent(String(person.id))}/assets`);
      return assets(theirs);
    },

    async get(externalId) {
      const json = await maybe(`/hardware/${encodeURIComponent(externalId)}`);
      return json === null ? null : asset(json);
    },

    maintenance: {
      async list(externalId) {
        const { json } = await get(`/maintenances?asset_id=${encodeURIComponent(externalId)}&limit=50&offset=0&sort=created_at&order=desc`);
        if (isErrorAnswer(json)) return [];
        return rowsOf(json)
          .map(obj)
          .filter((m): m is Obj => m !== null)
          // Older versions ignore asset_id on this route: keep the asset's own.
          .filter((m) => !obj(m.asset) || String(obj(m.asset)!.id) === externalId)
          .map(
            (m): HdMaintenanceRecord => ({
              id: String(m.id ?? ""),
              type: unescapeHtml(m.asset_maintenance_type),
              title: unescapeHtml(m.title),
              notes: unescapeHtml(m.notes),
              supplier: unescapeHtml(obj(m.supplier)?.name),
              start_date: isoDate(m.start_date),
              completion_date: isoDate(m.completion_date),
            })
          );
      },

      async log(input: MaintenanceInput) {
        const { json } = await assetRequest({
          url: api("/maintenances"),
          method: "POST",
          token: cfg.token,
          label: LABEL,
          timeoutMs: cfg.timeoutMs,
          body: {
            asset_id: Number(input.external_id),
            asset_maintenance_type: input.type,
            title: input.title,
            start_date: input.date,
            completion_date: input.date,
            notes: input.note,
            is_warranty: 0,
            ...(input.supplier_id ? { supplier_id: input.supplier_id } : {}),
          },
        });
        if (isErrorAnswer(json)) {
          const why = said(json);
          throw new AssetHttpError(`${LABEL} didn't save the maintenance record.${why ? ` It said: ${why}` : ""}`, 200, "http", null, why);
        }
        const payload = obj(obj(json)?.payload) ?? obj(json);
        return { id: String(payload?.id ?? "") };
      },

      async suppliers() {
        const { json } = await get("/suppliers?limit=200&offset=0&sort=name&order=asc");
        return rowsOf(json)
          .map(obj)
          .filter((s): s is Obj => s !== null && (typeof s.id === "number" || typeof s.id === "string"))
          .map((s) => ({ id: Number(s.id), name: unescapeHtml(s.name) }))
          .filter((s) => Number.isInteger(s.id) && s.id > 0 && s.name);
      },
    },
  };
  return provider;
}
