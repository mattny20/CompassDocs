import { test, expect, type APIRequestContext } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// The MCP connector's image path: upload a screenshot as base64, get the
// markdown snippet back, place it in a document, and confirm the attachment
// actually serves as an inline image.
//
// 1.1 widened this from one intake to four, because base64-in-a-tool-argument
// fails for the commonest request there is. The second test below covers the
// three that were added: copying an image already in the workspace, placing it
// in the body in the same call, and the drop link for a picture only a person
// can produce. `source_url` is not exercised here on purpose — safeFetch
// refuses private addresses, so the only URL the rig could serve is one the
// SSRF guard is built to block.

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

test("mcp add_image: copy, one-step insert, and the drop link", async ({ page, request }) => {
  await login(page, ADMIN);
  const minted = await api(page, "/api/account/tokens", {
    method: "POST",
    body: { name: `e2e-mcp-image-2-${Date.now()}`, scopes: ["read", "write"] },
  });
  expect(minted.status).toBe(201);
  const token = minted.body.token as string;

  const first = JSON.parse(
    (await mcp(request, token, "create_doc", { title: `E2E image source ${Date.now()}`, markdown: "Source doc." }))
      .text
  );
  const second = JSON.parse(
    (await mcp(request, token, "create_doc", { title: `E2E image target ${Date.now()}`, markdown: "Target doc." }))
      .text
  );

  // Nothing at all is an error that tells the model what to do instead —
  // this is the message that has to steer it off base64 for a pasted
  // screenshot, so its content matters as much as the failure.
  const empty = await mcp(request, token, "add_image", { doc_id: first.id });
  expect(empty.isError).toBe(true);
  expect(empty.text).toContain("request_upload");

  // Upload once, then copy it onto another document by id — no bytes cross
  // the connector the second time.
  const seeded = JSON.parse(
    (await mcp(request, token, "add_image", { doc_id: first.id, data: PNG_1PX, filename: "shot.png" })).text
  );
  const copied = await mcp(request, token, "add_image", {
    doc_id: second.id,
    from_attachment_id: seeded.attachment_id,
    insert: "append",
    alt: "Copied shot",
  });
  expect(copied.isError).toBe(false);
  const copiedOut = JSON.parse(copied.text);
  expect(copiedOut.inserted).toBe(true);
  // A copy, not a shared file: deleting the original must not blank this one.
  expect(copiedOut.attachment_id).not.toBe(seeded.attachment_id);

  // insert:"append" is the step that used to be a separate update_doc and got
  // skipped — the body must carry the markdown with no further call.
  const body = await mcp(request, token, "read_doc", { id: second.id });
  expect(body.text).toContain(`![Copied shot](${copiedOut.url})`);
  expect(body.text).toContain("Target doc.");

  // The drop link. request_upload mints it; the page renders; an anonymous
  // POST of the file attaches AND places it; the link then refuses a second
  // use.
  const req = await mcp(request, token, "request_upload", { doc_id: second.id, alt: "Dropped by hand" });
  expect(req.isError).toBe(false);
  const ticket = JSON.parse(req.text);
  const path = new URL(ticket.upload_url).pathname;
  expect(path).toMatch(/^\/upload\/[A-Za-z0-9_-]{20,}$/);

  // `request` carries no session cookie — it is a separate context from the
  // signed-in `page`, and no Authorization header is sent below. So this is
  // the anonymous case the drop link exists for: the person holding the
  // screenshot need not be logged in on the device that has it.
  const pageRes = await request.get(path);
  expect(pageRes.status()).toBe(200);
  expect(await pageRes.text()).toContain("Add an image to");

  const drop = (token = path.split("/").pop()!) =>
    request.post(`/api/upload-tickets/${token}`, {
      multipart: {
        file: { name: "dropped.png", mimeType: "image/png", buffer: Buffer.from(PNG_1PX, "base64") },
      },
    });

  const ok = await drop();
  expect(ok.status()).toBe(200);
  expect((await ok.json()).inserted).toBe(true);

  // Single-use: the second attempt is refused, not silently duplicated.
  const again = await drop();
  expect(again.status()).toBe(410);

  // And an unknown token is a 404, not a hint about what a real one looks like.
  const bogus = await drop("definitely-not-a-real-ticket-token");
  expect(bogus.status()).toBe(404);

  const afterDrop = await mcp(request, token, "read_doc", { id: second.id });
  expect(afterDrop.text).toContain("![Dropped by hand](/api/attachments/");

  // Non-images are refused on this path too — the drop link is not a way
  // around the sniffer.
  const req2 = JSON.parse((await mcp(request, token, "request_upload", { doc_id: second.id })).text);
  const bad = await request.post(
    `/api/upload-tickets/${new URL(req2.upload_url).pathname.split("/").pop()}`,
    {
      multipart: {
        file: { name: "photo.png", mimeType: "image/png", buffer: Buffer.from("not an image at all") },
      },
    }
  );
  expect(bad.status()).toBe(400);
});

test("the drop page uploads from the browser, then reports the link is spent", async ({ page, request }) => {
  await login(page, ADMIN);
  const minted = await api(page, "/api/account/tokens", {
    method: "POST",
    body: { name: `e2e-drop-ui-${Date.now()}`, scopes: ["read", "write"] },
  });
  const token = minted.body.token as string;
  const doc = JSON.parse(
    (await mcp(request, token, "create_doc", { title: `E2E drop UI ${Date.now()}`, markdown: "Before." })).text
  );
  const ticket = JSON.parse(
    (await mcp(request, token, "request_upload", { doc_id: doc.id, alt: "From the drop page" })).text
  );
  const path = new URL(ticket.upload_url).pathname;

  await page.goto(path);
  await expect(page.getByRole("heading", { name: /Add an image to/ })).toBeVisible();
  await page.setInputFiles('input[type="file"]', {
    name: "from-browser.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_1PX, "base64"),
  });
  await expect(page.getByRole("heading", { name: "Image added" })).toBeVisible();

  const body = await mcp(request, token, "read_doc", { id: doc.id });
  expect(body.text).toContain("![From the drop page](/api/attachments/");

  // Re-opening a spent link says so plainly rather than offering a drop zone
  // that would fail — the person is doing someone a favour, not debugging.
  await page.goto(path);
  await expect(page.getByRole("heading", { name: /already been used/ })).toBeVisible();
});
