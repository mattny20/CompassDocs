import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// The public REST API: token minting, scopes, and the auth matrix.
test("v1 tokens: scopes enforced, introspection works", async ({ page, request }) => {
  await login(page, ADMIN);

  const rw = await api(page, "/api/account/tokens", {
    method: "POST",
    body: { name: "e2e-rw", scopes: ["read", "write"] },
  });
  const ro = await api(page, "/api/account/tokens", {
    method: "POST",
    body: { name: "e2e-ro", scopes: ["read"] },
  });
  expect(rw.status).toBe(201);
  expect(ro.status).toBe(201);

  // No token → 401.
  expect((await request.get("/api/v1/me")).status()).toBe(401);

  // Introspection reflects the token's scopes.
  const me = await request.get("/api/v1/me", {
    headers: { authorization: `Bearer ${ro.body.token}` },
  });
  expect(me.status()).toBe(200);
  expect((await me.json()).scopes).toEqual(["read"]);

  // Read-only token is refused by a write endpoint.
  const write = await request.post("/api/v1/documents", {
    headers: { authorization: `Bearer ${ro.body.token}` },
    data: { space: "engineering", title: "x", content: "y" },
  });
  expect(write.status()).toBe(403);

  // Read works; spaces listing responds.
  const spaces = await request.get("/api/v1/spaces", {
    headers: { authorization: `Bearer ${rw.body.token}` },
  });
  expect(spaces.status()).toBe(200);

  // Revoke both so reruns stay clean.
  for (const t of [rw, ro]) {
    await api(page, `/api/account/tokens/${t.body.record.id}`, { method: "DELETE" });
  }
});
