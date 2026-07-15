// CompassDocs MCP server (Claude connector). A minimal Streamable-HTTP MCP
// endpoint: JSON-RPC 2.0 over POST, authenticated with a personal API token
// (Account → API tokens), acting as that user with their role. Draft an
// article in Claude Desktop, push it here as markdown, pull it back later to
// revise — updates flow through the same approval workflow as the app.
//
// Connect from Claude Desktop (claude_desktop_config.json → mcpServers):
//   "compassdocs": { "command": "npx", "args": ["-y", "mcp-remote",
//     "https://YOUR-HOST/api/mcp", "--header", "Authorization: Bearer cdk_…"] }

import {
  getUserByApiToken,
  getUserByOAuthToken,
  listSpaces,
  getSpaceBySlug,
  listDocumentsBySpace,
  listRecentDocuments,
  searchDocuments,
  getDocument,
  createDocument,
  updateDocument,
  createChangeRequest,
  getApprovalMode,
} from "@/lib/db";
import { currentVersion } from "@/lib/version";
import { requestOrigin } from "@/lib/oauth";
import { notifyWebhooks } from "@/lib/webhooks";
import { audit, actorFrom } from "@/lib/audit";
import { roleAtLeast } from "@/lib/types";
import type { DocStatus, DocType, User } from "@/lib/types";

export const dynamic = "force-dynamic";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const TYPES: DocType[] = ["sop", "technical", "policy", "knowledge"];

// --- JSON-RPC plumbing ---------------------------------------------------------

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Tool output helpers — MCP text content, optionally flagged as an error. */
function toolText(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}
function toolJson(value: unknown) {
  return toolText(JSON.stringify(value, null, 2));
}

// --- Tool definitions ------------------------------------------------------------

const TOOLS = [
  {
    name: "list_spaces",
    description:
      "List the workspace's spaces (categories documents live in), with slugs and doc counts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_docs",
    description:
      "List documents, most recently updated first. Optionally filter to one space by slug.",
    inputSchema: {
      type: "object",
      properties: {
        space: { type: "string", description: "Space slug (from list_spaces). Omit for all." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_docs",
    description: "Full-text search across documents. Returns matches with snippets.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search terms." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_doc",
    description:
      "Read one document by id: title, space, status, tags, and the full markdown body. Use the id from list_docs / search_docs.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "Document id." } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_doc",
    description:
      "Create a document from markdown (requires the editor role or higher). New docs start as drafts unless publish=true — and publishing may still be downgraded to a draft when the workspace requires approval.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        markdown: { type: "string", description: "Document body, GitHub-flavored markdown." },
        space: { type: "string", description: "Space slug (from list_spaces). Omit for the first space." },
        type: { type: "string", enum: TYPES, description: "Document type (default knowledge)." },
        summary: { type: "string", description: "One-sentence summary shown in lists." },
        tags: { type: "array", items: { type: "string" } },
        publish: { type: "boolean", description: "Try to publish immediately (default false)." },
      },
      required: ["title", "markdown"],
      additionalProperties: false,
    },
  },
  {
    name: "update_doc",
    description:
      "Update a document's markdown and/or metadata (requires editor or higher). Edits to published documents follow the workspace's approval workflow: they may be queued as a change request for review instead of applying immediately — the response says which happened.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Document id." },
        markdown: { type: "string", description: "New full body (replaces the old one)." },
        title: { type: "string" },
        summary: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        note: { type: "string", description: "Short change note for the version history." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

// --- Tool implementations ---------------------------------------------------------

async function callTool(user: User, name: string, args: any) {
  const isEditor = roleAtLeast(user.role, "editor");

  switch (name) {
    case "list_spaces": {
      const spaces = await listSpaces();
      return toolJson(
        spaces.map((s) => ({ slug: s.slug, name: s.name, description: s.description, docs: s.doc_count }))
      );
    }

    case "list_docs": {
      let docs;
      if (args?.space) {
        const space = await getSpaceBySlug(String(args.space));
        if (!space) return toolText(`No space with slug "${args.space}".`, true);
        docs = await listDocumentsBySpace(space.id, isEditor);
      } else {
        docs = await listRecentDocuments(30, isEditor);
      }
      return toolJson(
        docs.map((d) => ({
          id: d.id,
          title: d.title,
          space: d.space_slug,
          type: d.type,
          status: d.status,
          tags: d.tags,
          updated_at: d.updated_at,
        }))
      );
    }

    case "search_docs": {
      const hits = await searchDocuments(String(args?.query ?? ""), 15, isEditor);
      return toolJson(
        hits.map((h) => ({
          id: h.id,
          title: h.title,
          space: h.space_slug,
          status: h.status,
          snippet: h.snippet.replace(/<\/?mark>/g, "**"),
        }))
      );
    }

    case "read_doc": {
      const doc = await getDocument(Number(args?.id));
      if (!doc || (doc.status === "draft" && !isEditor)) {
        return toolText(`No document with id ${args?.id}.`, true);
      }
      const header =
        `# ${doc.title}\n\n` +
        `> id: ${doc.id} · space: ${doc.space_slug} · type: ${doc.type} · status: ${doc.status}` +
        (doc.tags.length ? ` · tags: ${doc.tags.join(", ")}` : "") +
        (doc.summary ? `\n> summary: ${doc.summary}` : "") +
        `\n\n---\n\n`;
      return toolText(header + doc.content);
    }

    case "create_doc": {
      if (!isEditor) {
        return toolText("Your role (viewer) can't create documents — ask an admin for editor access.", true);
      }
      const title = String(args?.title ?? "").trim();
      const markdown = String(args?.markdown ?? "");
      if (!title || !markdown.trim()) return toolText("Both title and markdown are required.", true);

      let spaceId: number | undefined;
      if (args?.space) {
        const space = await getSpaceBySlug(String(args.space));
        if (!space) return toolText(`No space with slug "${args.space}" — call list_spaces first.`, true);
        spaceId = space.id;
      } else {
        spaceId = (await listSpaces())[0]?.id;
      }
      if (!spaceId) return toolText("No space available to create the document in.", true);

      const canPublish = roleAtLeast(user.role, "approver") || (await getApprovalMode()) === "open";
      const wantPublish = args?.publish === true;
      const status: DocStatus = wantPublish && canPublish ? "published" : "draft";

      const doc = await createDocument({
        space_id: spaceId,
        title,
        type: TYPES.includes(args?.type) ? args.type : "knowledge",
        status,
        content: markdown,
        summary: String(args?.summary ?? "").trim(),
        tags: Array.isArray(args?.tags) ? args.tags.map((t: unknown) => String(t).trim()).filter(Boolean) : [],
        author: user.name || user.username,
      });
      if (doc.status === "published") {
        void notifyWebhooks("document.published", {
          title: doc.title,
          actor: user.name || user.username,
          spaceId: doc.space_id,
          spaceName: doc.space_name,
        });
      }
      await audit({
        actor: actorFrom(user),
        action: status === "published" ? "document.publish" : "document.create",
        targetType: "document",
        targetId: doc.id,
        targetLabel: doc.title,
        details: { via: "mcp" },
      });
      return toolJson({
        ok: true,
        id: doc.id,
        status: doc.status,
        url: `/doc/${doc.id}`,
        note:
          wantPublish && status === "draft"
            ? "Created as a draft — this workspace requires approver review to publish."
            : undefined,
      });
    }

    case "update_doc": {
      if (!isEditor) {
        return toolText("Your role (viewer) can't edit documents — ask an admin for editor access.", true);
      }
      const existing = await getDocument(Number(args?.id));
      if (!existing) return toolText(`No document with id ${args?.id}.`, true);

      const proposed = {
        title: typeof args?.title === "string" && args.title.trim() ? args.title.trim() : existing.title,
        content: typeof args?.markdown === "string" ? args.markdown : existing.content,
        summary: typeof args?.summary === "string" ? args.summary.trim() : existing.summary,
        type: existing.type,
        status: existing.status,
        tags: Array.isArray(args?.tags)
          ? args.tags.map((t: unknown) => String(t).trim()).filter(Boolean)
          : existing.tags,
      };
      const note = String(args?.note ?? "").trim();

      // Same approval rule as the app: published content only changes directly
      // for approvers+ (or in open mode); otherwise the edit queues for review.
      const canPublish = roleAtLeast(user.role, "approver") || (await getApprovalMode()) === "open";
      if (existing.status === "published" && !canPublish) {
        const crId = await createChangeRequest({
          document_id: existing.id,
          kind: "edit",
          title: proposed.title,
          content: proposed.content,
          summary: proposed.summary,
          tags: proposed.tags,
          type: proposed.type,
          target_status: "published",
          note,
          created_by: user.id,
        });
        await audit({
          actor: actorFrom(user),
          action: "change_request.submit",
          targetType: "document",
          targetId: existing.id,
          targetLabel: proposed.title,
          details: { kind: "edit", via: "mcp" },
        });
        void notifyWebhooks("change_request.submitted", {
          title: proposed.title,
          kind: "edit",
          actor: user.name || user.username,
          spaceId: existing.space_id,
          spaceName: existing.space_name,
        });
        return toolJson({
          ok: true,
          pending_review: true,
          change_request_id: crId,
          note: "This document is published and your role requires approval — the edit was queued for an approver to review, the live document is unchanged.",
        });
      }

      const doc = await updateDocument(existing.id, {
        ...proposed,
        author: user.name || user.username,
        versionNote: note || "Edited via Claude connector",
      });
      await audit({
        actor: actorFrom(user),
        action: "document.update",
        targetType: "document",
        targetId: existing.id,
        targetLabel: proposed.title,
        details: { via: "mcp" },
      });
      return toolJson({ ok: true, id: doc!.id, status: doc!.status, url: `/doc/${doc!.id}` });
    }

    default:
      return toolText(`Unknown tool: ${name}`, true);
  }
}

// --- HTTP handlers -----------------------------------------------------------------

async function authenticate(req: Request): Promise<User | Response> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  // Two credential kinds: personal API tokens (cdk_) and OAuth access tokens
  // (cdo_) issued by the built-in authorization server for "one-click" clients.
  const user = token
    ? token.startsWith("cdo_")
      ? await getUserByOAuthToken(token)
      : await getUserByApiToken(token)
    : undefined;
  if (!user) {
    // Point OAuth-capable clients (Claude's custom-connector UI) at our
    // discovery document so they can start the authorization flow themselves.
    const origin = requestOrigin(req);
    return new Response(
      JSON.stringify({ error: "A valid API token is required (Account → API tokens)." }),
      {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp"`,
        },
      }
    );
  }
  return user;
}

async function handleRpc(user: User, msg: any): Promise<unknown | undefined> {
  const { id, method, params } = msg ?? {};

  // Notifications (no id) get no response body.
  if (id === undefined || id === null) return undefined;

  switch (method) {
    case "initialize": {
      const requested = String(params?.protocolVersion ?? "");
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "CompassDocs", version: currentVersion() },
        instructions:
          "CompassDocs is this team's knowledge base. Use search_docs/read_doc to look things up, create_doc to save a drafted article as markdown, and update_doc to revise an existing one. Call list_spaces first when creating, to pick the right space.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      try {
        const result = await callTool(user, String(params?.name ?? ""), params?.arguments ?? {});
        return rpcResult(id, result);
      } catch (e) {
        return rpcResult(id, toolText(e instanceof Error ? e.message : "Tool failed.", true));
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function POST(req: Request) {
  const user = await authenticate(req);
  if (user instanceof Response) return user;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }

  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map((m) => handleRpc(user, m)))).filter(
      (r) => r !== undefined
    );
    return replies.length ? json(replies) : new Response(null, { status: 202 });
  }
  const reply = await handleRpc(user, body);
  return reply === undefined ? new Response(null, { status: 202 }) : json(reply);
}

// The connector is request/response only — no server-push stream to offer.
export function GET() {
  return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
}
