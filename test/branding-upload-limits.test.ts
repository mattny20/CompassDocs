// The branding upload routes' body cap (1.16.0): POST
// /api/admin/branding/artwork and POST /api/admin/branding/logo buffer the
// whole body (req.formData(), req.json()) and nothing in front of the app
// caps it, so the declared Content-Length is the cap. A body without one (a
// chunked upload) is refused with 411 and one declared too big with 413,
// both before a byte of it is read; a body that declares a fair length is
// read as before. Nothing here stores an image.
//
// The routes are called directly, as test/compliance-settings.test.ts calls
// its route: next/headers resolves to a stub serving the request under test.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/branding-upload-limits.test.ts

import Module from "node:module";
import path from "node:path";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

let currentRequest: Request | null = null;
{
  const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.branding-upload-limits.virtual.js");
  const jar = () => {
    const out = new Map<string, string>();
    for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) out.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
    }
    return out;
  };
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => {
      const c = jar();
      return {
        get: (name: string) => (c.has(name) ? { name, value: c.get(name) } : undefined),
        getAll: () => [...c].map(([name, value]) => ({ name, value })),
        has: (name: string) => c.has(name),
      };
    },
    draftMode: async () => ({ isEnabled: false }),
  };
  require.cache[HEADERS_STUB] = headers;
  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
  };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const { pool, getSetting, createRole, assignRole, createSession } = require("../src/lib/db") as typeof import("../src/lib/db");
const { newToken } = require("../src/lib/password") as typeof import("../src/lib/password");
const { fixtureQuery } = require("./support/retry") as typeof import("./support/retry");
const artwork = require("../src/app/api/admin/branding/artwork/route") as typeof import("../src/app/api/admin/branding/artwork/route");
const logo = require("../src/app/api/admin/branding/logo/route") as typeof import("../src/app/api/admin/branding/logo/route");
/* eslint-enable @typescript-eslint/no-require-imports */

const STAMP = `brandcap${Date.now()}`;
const NO_LENGTH = "The request must state its size (a Content-Length header).";
let userId = 0;
let roleId = 0;
let token = "";

before(async () => {
  await getSetting("__schema_bootstrap__"); // run the schema and migrations first
  const r = await fixtureQuery(
    "INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id",
    [STAMP, `Brand ${STAMP}`, `${STAMP}@example.test`]
  );
  userId = (r.rows[0] as { id: number }).id;
  const role = await createRole({ name: `Branding ${STAMP}`, permissions: ["workspace.branding_manage"] });
  assert.ok("id" in role, "the custom role exists");
  roleId = role.id;
  await assignRole({ roleId, userId });
  token = newToken();
  await createSession(token, userId, new Date(Date.now() + 3_600_000).toISOString());
});

after(async () => {
  await pool().query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  if (roleId) await pool().query("DELETE FROM roles WHERE id = $1", [roleId]);
  await pool().query("DELETE FROM users WHERE id = $1", [userId]);
});

/** A body that notes whether anything asked for its bytes (highWaterMark 0: nothing is read ahead). */
function watchedBody(bytes: Uint8Array) {
  const seen = { read: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        seen.read = true;
        controller.enqueue(bytes);
        controller.close();
      },
    },
    { highWaterMark: 0 }
  );
  return { body, seen };
}

async function post(
  route: { POST: (req: Request) => Promise<Response> },
  at: string,
  init: { headers?: Record<string, string>; body: BodyInit | ReadableStream<Uint8Array>; signedIn?: boolean }
) {
  const req = new Request(`http://localhost${at}`, {
    method: "POST",
    headers: { ...(init.signedIn === false ? {} : { cookie: `compass_session=${token}` }), ...init.headers },
    body: init.body as BodyInit,
    duplex: "half",
  } as RequestInit);
  currentRequest = req;
  try {
    const res = await route.POST(req);
    return { status: res.status, body: (await res.json().catch(() => null)) as { error?: string } | null };
  } finally {
    currentRequest = null;
  }
}

const multipart = (boundary: string, parts: string) => ({
  type: `multipart/form-data; boundary=${boundary}`,
  bytes: new TextEncoder().encode(`${parts}--${boundary}--\r\n`),
});

describe("POST /api/admin/branding/artwork", () => {
  const AT = "/api/admin/branding/artwork";

  test("a body with no Content-Length (chunked) is refused with 411, unread", async () => {
    const form = multipart("x", "");
    const { body, seen } = watchedBody(form.bytes);
    const r = await post(artwork, AT, { headers: { "content-type": form.type }, body });
    assert.equal(r.status, 411);
    assert.equal(r.body?.error, NO_LENGTH);
    assert.equal(seen.read, false, "not a byte was read");
  });

  test("a length that is not a number is refused the same way", async () => {
    const form = multipart("x", "");
    const r = await post(artwork, AT, { headers: { "content-type": form.type, "content-length": "lots" }, body: form.bytes });
    assert.equal(r.status, 411);
  });

  test("a length over 15 MB and the envelope is refused with 413, unread", async () => {
    const form = multipart("x", "");
    const { body, seen } = watchedBody(form.bytes);
    const declared = String(15 * 1024 * 1024 + 512 * 1024 + 1);
    const r = await post(artwork, AT, { headers: { "content-type": form.type, "content-length": declared }, body });
    assert.equal(r.status, 413);
    assert.equal(r.body?.error, "Artwork is limited to 15 MB.");
    assert.equal(seen.read, false, "not a byte was read");
  });

  test("a body that declares its length is read: a form with no file gets the form's sentence", async () => {
    const form = multipart("x", '--x\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n');
    const r = await post(artwork, AT, {
      headers: { "content-type": form.type, "content-length": String(form.bytes.byteLength) },
      body: form.bytes,
    });
    assert.equal(r.status, 400);
    assert.equal(r.body?.error, "Choose an image to upload.");
  });

  test("signed out, the gate answers first", async () => {
    const { body, seen } = watchedBody(new Uint8Array(1));
    const r = await post(artwork, AT, { headers: { "content-type": "multipart/form-data; boundary=x" }, body, signedIn: false });
    assert.equal(r.status, 401);
    assert.equal(seen.read, false);
  });
});

describe("POST /api/admin/branding/logo", () => {
  const AT = "/api/admin/branding/logo";

  test("an upload with no Content-Length (chunked) is refused with 411, unread", async () => {
    const form = multipart("x", "");
    const { body, seen } = watchedBody(form.bytes);
    const r = await post(logo, AT, { headers: { "content-type": form.type }, body });
    assert.equal(r.status, 411);
    assert.equal(r.body?.error, NO_LENGTH);
    assert.equal(seen.read, false, "not a byte was read");
  });

  test("so is a site address sent without one", async () => {
    const { body, seen } = watchedBody(new TextEncoder().encode(JSON.stringify({ site_url: "acme.example" })));
    const r = await post(logo, AT, { headers: { "content-type": "application/json" }, body });
    assert.equal(r.status, 411);
    assert.equal(seen.read, false);
  });

  test("a length over 1 MB and the envelope is refused with 413, unread", async () => {
    const form = multipart("x", "");
    const { body, seen } = watchedBody(form.bytes);
    const r = await post(logo, AT, { headers: { "content-type": form.type, "content-length": String(1024 * 1024 + 512 * 1024 + 1) }, body });
    assert.equal(r.status, 413);
    assert.equal(r.body?.error, "Logos are limited to 1 MB.");
    assert.equal(seen.read, false, "not a byte was read");
  });

  test("a body that declares its length is read as before", async () => {
    const json = new TextEncoder().encode(JSON.stringify({ site_url: "https://" }));
    const r = await post(logo, AT, {
      headers: { "content-type": "application/json", "content-length": String(json.byteLength) },
      body: json,
    });
    assert.equal(r.status, 400);
    assert.equal(r.body?.error, "Enter a valid website URL.");

    const form = multipart("x", '--x\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n');
    const up = await post(logo, AT, {
      headers: { "content-type": form.type, "content-length": String(form.bytes.byteLength) },
      body: form.bytes,
    });
    assert.equal(up.status, 400);
    assert.equal(up.body?.error, "No file provided.");
  });
});
