import { test, expect, type APIRequestContext } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// The MCP connector's image path: upload a screenshot as base64, get the
// markdown snippet back, place it in a document, and confirm the attachment
// actually serves as an inline image.

// Tiny but real files, verified against the magic-byte sniffer.
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GIF_1PX = "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";

async function mcp(
  request: APIRequestContext,
  token: string,
  tool: string,
  args: Record<string, unknown>
) {
  const res = await request.post("/api/mcp", {
    headers: { authorization: `Bearer ${token}` },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const content = body.result?.content?.[0]?.text ?? "";
  return { isError: body.result?.isError === true, text: content };
}

test("mcp add_image: upload, embed, serve; non-images rejected", async ({ page, request }) => {
  await login(page, ADMIN);
  const minted = await api(page, "/api/account/tokens", {
    method: "POST",
    body: { name: "e2e-mcp-image", scopes: ["read", "write"] },
  });
  expect(minted.status).toBe(201);
  const token = minted.body.token as string;

  // A doc to attach to, created through the connector itself.
  const created = await mcp(request, token, "create_doc", {
    title: "E2E MCP Image Doc",
    markdown: "Body before the screenshot.",
  });
  expect(created.isError).toBe(false);
  const docId = JSON.parse(created.text).id as number;
  expect(docId).toBeTruthy();

  // Happy path: plain base64 PNG.
  const uploaded = await mcp(request, token, "add_image", {
    doc_id: docId,
    data: PNG_1PX,
    filename: "screenshot",
    alt: "The dashboard",
  });
  expect(uploaded.isError).toBe(false);
  const out = JSON.parse(uploaded.text);
  expect(out.ok).toBe(true);
  expect(out.url).toMatch(/^\/api\/attachments\/\d+$/);
  expect(out.markdown).toBe(`![The dashboard](${out.url})`);

  // The stored file serves inline as a real PNG (session-authenticated).
  const served = await page.evaluate(async (url) => {
    const res = await fetch(url);
    return { status: res.status, type: res.headers.get("content-type") || "" };
  }, out.url);
  expect(served.status).toBe(200);
  expect(served.type).toContain("image/png");

  // A data: URI works too (GIF this time), and the extension is derived
  // from the bytes, not the name.
  const gif = await mcp(request, token, "add_image", {
    doc_id: docId,
    data: `data:image/gif;base64,${GIF_1PX}`,
    filename: "wrong-name.png",
  });
  expect(gif.isError).toBe(false);
  expect(JSON.parse(gif.text).markdown).toContain("/api/attachments/");

  // Place the snippet in the body through the normal editing flow.
  const updated = await mcp(request, token, "update_doc", {
    id: docId,
    markdown: `Body before the screenshot.\n\n${out.markdown}\n`,
    note: "Add screenshot via connector",
  });
  expect(updated.isError).toBe(false);
  const readBack = await mcp(request, token, "read_doc", { id: docId });
  expect(readBack.text).toContain(out.markdown);

  // Non-image bytes are refused — the sniffer, not the filename, decides.
  const refused = await mcp(request, token, "add_image", {
    doc_id: docId,
    data: Buffer.from("#!/bin/sh\necho pwned\n").toString("base64"),
    filename: "totally-a-photo.png",
  });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("PNG, JPEG, GIF, and WebP");

  // Garbage base64 is refused cleanly.
  const garbage = await mcp(request, token, "add_image", { doc_id: docId, data: "%%%not-base64%%%" });
  expect(garbage.isError).toBe(true);

  // Unknown doc is refused.
  const noDoc = await mcp(request, token, "add_image", { doc_id: 99999999, data: PNG_1PX });
  expect(noDoc.isError).toBe(true);
});
