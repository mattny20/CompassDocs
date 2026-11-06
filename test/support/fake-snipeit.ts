// A fake Snipe-IT API for tests and demo seeds (1.19.3, lib/helpdesk/assets).
// An in-process node:http server on 127.0.0.1 answering the endpoints the
// client uses (hardware paging and search, bytag, byserial, hardware/{id},
// users?search, users/{id}/assets, maintenances list and POST, suppliers),
// in Snipe-IT's shapes (HTML-escaped strings, 200 with status "error"),
// with the bearer key checked. `fail` cans a failure for one path, and a few
// test-only paths exercise the HTTP layer (slow, html, big, redirects,
// echo-key).
//
// The client only ever calls https:// addresses, so a test or a seed points
// it here with fakeSnipeItTransport (lib/helpdesk/assets/http
// setAssetTransportForTests): https://<host>/… is sent to this server.
//
//   const fake = await startFakeSnipeIt("the-key");
//   fake.state.hardware.push(fakeHardware(1, "ASSET-", { name: "MacBook Pro 14 (2024)" }));
//   setAssetTransportForTests(fakeSnipeItTransport(fake.port, "assets.acme.example"));
//   …
//   await fake.close();

import http from "node:http";
import type { AddressInfo } from "node:net";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Obj = Record<string, any>;

export interface FakeSnipeItState {
  hardware: Obj[];
  users: Obj[];
  maintenances: Obj[];
  suppliers: Obj[];
  /** path → a canned failure, used `times` times. */
  fail: Map<string, { status: number; body?: unknown; headers?: Record<string, string>; times: number }>;
  rejectMaintenance: string | null;
  seen: { method: string; path: string; auth: string; body: Obj | null }[];
  /** Added to the list's reported total (a list that shifts or lies mid-sync). */
  extraTotal: number;
  /** Ids left out of the list (and its total) but still answered by id. */
  hideFromList: Set<number>;
}

/** A hardware row as Snipe-IT's API returns it. */
export function fakeHardware(id: number, tagPrefix: string, extra: Obj = {}): Obj {
  return {
    id,
    name: `Laptop ${id}`,
    asset_tag: `${tagPrefix}-${String(id).padStart(5, "0")}`,
    serial: `SN${tagPrefix}${id}`,
    model: { id: 1, name: "MacBook Pro 14 (2024)" },
    model_number: "A2442",
    category: { id: 1, name: "Laptops" },
    manufacturer: { id: 1, name: "Apple" },
    status_label: { id: 1, name: "Ready to Deploy", status_type: "deployable", status_meta: "deployable" },
    assigned_to: null,
    location: { id: 1, name: "London office" },
    purchase_date: { date: "2024-03-11", formatted: "11 Mar 2024" },
    warranty_expires: { date: "2027-03-11", formatted: "11 Mar 2027" },
    custom_fields: { "Secret thing": { value: "should never be cached" } },
    ...extra,
  };
}

/** A user as Snipe-IT's API returns it (also the assigned_to of a checked-out asset). */
export function fakePerson(id: number, emailAddr: string, name: string): Obj {
  return { id, username: emailAddr.split("@")[0], name, first_name: name.split(" ")[0], last_name: name.split(" ")[1] ?? "", email: emailAddr, type: "user" };
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export async function startFakeSnipeIt(key: string): Promise<{ state: FakeSnipeItState; port: number; close: () => Promise<void> }> {
  const fake: FakeSnipeItState = { hardware: [], users: [], maintenances: [], suppliers: [], fail: new Map(), rejectMaintenance: null, seen: [], extraTotal: 0, hideFromList: new Set() };
  const server = http.createServer(async (rq, rs) => {
    const u = new URL(rq.url ?? "/", "http://x");
    const p = u.pathname;
    let raw = "";
    for await (const chunk of rq) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    fake.seen.push({ method: rq.method ?? "", path: `${p}${u.search}`, auth: String(rq.headers.authorization ?? ""), body });
    // Test-only paths for the HTTP layer.
    if (p === "/api/v1/slow") return setTimeout(() => json(rs, 200, { ok: true }), 1500);
    if (p === "/api/v1/html") {
      rs.writeHead(200, { "content-type": "text/html" });
      return rs.end("<html><body>Snipe-IT login</body></html>");
    }
    if (p === "/api/v1/big") {
      rs.writeHead(200, { "content-type": "application/json" });
      const chunk = "x".repeat(64 * 1024);
      for (let i = 0; i < 40; i++) rs.write(chunk);
      return rs.end();
    }
    if (p === "/api/v1/big-declared") {
      rs.writeHead(200, { "content-type": "application/json", "content-length": String(50 * 1024 * 1024) });
      return rs.end("{}");
    }
    if (p === "/api/v1/redirect-out") return json(rs, 302, {}, { location: "https://evil.test/api/v1/hardware" });
    if (p === "/api/v1/redirect-http") return json(rs, 301, {}, { location: "http://snipe.test/api/v1/hardware" });
    if (p === "/api/v1/redirect-in") return json(rs, 302, {}, { location: "/api/v1/hardware?limit=1&offset=0" });
    if (p === "/api/v1/echo-key") return json(rs, 422, { status: "error", messages: `Bad request for ${String(rq.headers.authorization).replace("Bearer ", "")}` });
    if (rq.headers.authorization !== `Bearer ${key}`) return json(rs, 401, { message: "Unauthenticated." });
    for (const [where, f] of fake.fail) {
      if (p === where && f.times > 0) {
        f.times--;
        return json(rs, f.status, f.body ?? { status: "error", messages: "Nope" }, f.headers ?? {});
      }
    }
    let m: RegExpExecArray | null;
    if (p === "/api/v1/hardware" && rq.method === "GET") {
      const search = (u.searchParams.get("search") ?? "").toLowerCase();
      const limit = Number(u.searchParams.get("limit") ?? 50);
      const offset = Number(u.searchParams.get("offset") ?? 0);
      let rows = [...fake.hardware].filter((h) => !fake.hideFromList.has(h.id)).sort((a, b) => a.id - b.id);
      if (search) rows = rows.filter((h) => `${h.asset_tag} ${h.serial} ${h.name}`.toLowerCase().includes(search));
      return json(rs, 200, { total: rows.length + fake.extraTotal, rows: rows.slice(offset, offset + limit) });
    }
    if ((m = /^\/api\/v1\/hardware\/bytag\/(.+)$/.exec(p))) {
      const h = fake.hardware.find((x) => x.asset_tag.toLowerCase() === decodeURIComponent(m![1]).toLowerCase());
      return h ? json(rs, 200, h) : json(rs, 200, { status: "error", messages: "Asset does not exist.", payload: null });
    }
    if ((m = /^\/api\/v1\/hardware\/byserial\/(.+)$/.exec(p))) {
      const rows = fake.hardware.filter((x) => x.serial.toLowerCase() === decodeURIComponent(m![1]).toLowerCase());
      return json(rs, 200, { total: rows.length, rows });
    }
    if ((m = /^\/api\/v1\/hardware\/(\d+)$/.exec(p))) {
      const h = fake.hardware.find((x) => x.id === Number(m![1]));
      return h ? json(rs, 200, h) : json(rs, 404, { status: "error", messages: "Asset not found" });
    }
    if (p === "/api/v1/users") {
      const s = (u.searchParams.get("search") ?? "").toLowerCase();
      const rows = fake.users.filter((x) => `${x.email} ${x.name}`.toLowerCase().includes(s));
      return json(rs, 200, { total: rows.length, rows });
    }
    if ((m = /^\/api\/v1\/users\/(\d+)\/assets$/.exec(p))) {
      const rows = fake.hardware.filter((h) => h.assigned_to?.id === Number(m![1]));
      return json(rs, 200, { total: rows.length, rows });
    }
    if (p === "/api/v1/maintenances" && rq.method === "GET") {
      const id = Number(u.searchParams.get("asset_id"));
      const rows = fake.maintenances.filter((x) => x.asset.id === id).reverse();
      return json(rs, 200, { total: rows.length, rows });
    }
    if (p === "/api/v1/maintenances" && rq.method === "POST") {
      if (fake.rejectMaintenance) return json(rs, 200, { status: "error", messages: { supplier_id: [fake.rejectMaintenance] }, payload: null });
      const rec = {
        id: 900 + fake.maintenances.length,
        asset: { id: body.asset_id },
        title: body.title,
        asset_maintenance_type: body.asset_maintenance_type,
        supplier: body.supplier_id ? fake.suppliers.find((s) => s.id === body.supplier_id) ?? null : null,
        start_date: { date: body.start_date, formatted: body.start_date },
        completion_date: { date: body.completion_date, formatted: body.completion_date },
        notes: body.notes,
      };
      fake.maintenances.push(rec);
      return json(rs, 200, { status: "success", messages: "Maintenance created.", payload: { id: rec.id } });
    }
    if (p === "/api/v1/suppliers") return json(rs, 200, { total: fake.suppliers.length, rows: fake.suppliers });
    return json(rs, 404, { status: "error", messages: "Not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { state: fake, port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** A transport that sends https://<host>/… to the fake (any other host fails like an unknown name). */
export function fakeSnipeItTransport(port: number, host = "snipe.test"): (url: string, init: RequestInit) => Promise<Response> {
  return (url, init) => {
    const u = new URL(url);
    if (u.host !== host) return Promise.reject(new Error(`Could not resolve host: ${u.host}`));
    return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
  };
}
