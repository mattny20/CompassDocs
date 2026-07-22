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
  getDocument,
  createDocument,
  updateDocument,
  createChangeRequest,
  getApprovalMode,
} from "@/lib/db";
import { currentVersion } from "@/lib/version";
import { listTemplates, getTemplate, getTemplateByName, renderTemplate } from "@/lib/doc-templates";
import { getAppSettings } from "@/lib/settings-store";
import { formatDate } from "@/lib/format";
import { publicOrigin } from "@/lib/oauth";
import { notifyWebhooks } from "@/lib/webhooks";
import { notifySpaceSubscribers } from "@/lib/subscriptions";
import { audit, actorFrom } from "@/lib/audit";
import { spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import { roleAtLeast } from "@/lib/types";
import type { DocStatus, DocType, User } from "@/lib/types";

export const dynamic = "force-dynamic";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const TYPES: DocType[] = ["sop", "technical", "policy", "knowledge"];

// Everything the in-app editor can author, as markdown — returned by the
// writing_guide tool so connected assistants use the full block vocabulary
// instead of plain GFM. Keep in sync with src/lib/doc-blocks.ts and the
// editor toolbar (RichTextEditor).
const WRITING_GUIDE = `# CompassDocs writing guide

Documents are GitHub-flavored markdown (headings, bold/italic, links, quotes,
inline code, fenced code blocks, images) **plus** the rich blocks below. Use
them — they render as interactive components in the app and on the public
site, exactly like documents written in the built-in editor.

## Callouts
Five kinds: note, tip, warning, danger, info. Optional custom title in [ ].

:::tip[Pro tip]
Body supports full markdown.
:::

## Accordion (collapsed section)
:::details[Advanced configuration]
Hidden until the reader expands it.
:::

## Tabs
Four colons for the group, three for each tab:

::::tabs
:::tab[Windows]
Windows steps.
:::
:::tab[macOS]
macOS steps.
:::
::::

## Interactive checklists
GFM task lists become live checkboxes; each reader's ticks persist for them:

- [ ] First step
- [ ] Second step

## Tables — filtering & sorting are automatic
Every markdown table gets click-to-sort headers, and tables with 4+ rows get
a filter box. Just write a normal GFM table.

## Mermaid diagrams
\`\`\`mermaid
flowchart LR
  A[Start] --> B{Decision?}
  B -- Yes --> C[Do it]
  B -- No --> D[Skip]
\`\`\`
(Any mermaid type: flowchart, sequenceDiagram, stateDiagram-v2, gantt, pie, …)

## PlantUML diagrams
\`\`\`plantuml
Alice -> Bob: Request
Bob --> Alice: Response
\`\`\`

## Decision tree (interactive click-through guide)
Each node is "id: Question" followed by "- Answer -> target" lines. A target
that matches another node id continues the tree; any other text is a final
recommendation. The first node is the start.

\`\`\`decision
start: Is the service responding?
- Yes -> logs
- No -> Escalate to the on-call engineer.
logs: Any errors in the log?
- Yes -> Follow the runbook for that error.
- No -> Open a ticket with details.
\`\`\`

## Video embed
::video[Optional caption]{src="https://youtu.be/VIDEO_ID"}
Accepts YouTube, Vimeo, Loom, or a direct video-file URL.

## Website embed
::embed{src="https://status.example.com" height="500"}

## Images
Standard markdown images work: ![alt text](https://example.com/image.png).
To reference an image already uploaded to this workspace, use its
/api/attachments/… URL from the existing document markdown. (New binary
uploads happen in the app editor, not through this connector.)

## Notes
- Callout/details/tabs bodies nest full markdown, including other blocks.
- Unknown directives render as literal text — stick to the forms above.
- Keep a single H1 out of the body; the document title is rendered by the app.`;

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
    description:
      "Search across documents — keyword full-text plus semantic similarity when the workspace has semantic search configured. Returns matches with snippets.",
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
    name: "writing_guide",
    description:
      "The complete authoring reference for this workspace: every rich block the editor supports (callouts, tabs, accordions, interactive checklists, Mermaid and PlantUML diagrams, decision trees, video and website embeds, auto-filterable tables) with exact markdown syntax. Call this before writing or restructuring a document so you can use the full toolbox, not just plain markdown.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_templates",
    description:
      "List this workspace's document templates (SOP, runbook, policy, postmortem, …) with their full body scaffolds. When the user asks for a document of a kind that matches a template — a runbook, a postmortem, meeting notes — draft it following that template's structure and pass template to create_doc so it lands in the team's standard shape.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_doc",
    description:
      "Create a document from markdown (requires the editor role or higher). Documents support rich blocks far beyond plain GFM — call writing_guide for the syntax. Pass template (id or name from list_templates) to inherit the team's standard structure: the template supplies the doc type, tags, title pattern, and — when you send no markdown — its body scaffold with placeholders filled in. Your markdown, when given, is used as the body (draft it following the template's structure). New docs start as drafts unless publish=true — and publishing may still be downgraded to a draft when the workspace requires approval.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        markdown: { type: "string", description: "Document body, GitHub-flavored markdown. Optional when template is given (the template's scaffold is used)." },
        template: { type: "string", description: "Template id or name (from list_templates). Supplies type, tags, and title pattern; fills {{date}}/{{author}}/{{space}} placeholders." },
        space: { type: "string", description: "Space slug (from list_spaces). Omit for the first space." },
        parent: { type: "number", description: "Nest the new doc under this parent document id (same space; requires the workspace's nested-pages feature)." },
        type: { type: "string", enum: TYPES, description: "Document type (default knowledge, or the template's type)." },
        summary: { type: "string", description: "One-sentence summary shown in lists." },
        tags: { type: "array", items: { type: "string" }, description: "Merged with the template's tags when one is used." },
        publish: { type: "boolean", description: "Try to publish immediately (default false)." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "update_doc",
    description:
      "Update a document: markdown body, metadata (title, summary, tags, type), publish a draft, or move it to another space (requires editor or higher). Rich blocks are supported — call writing_guide for the syntax. Changes affecting published content follow the workspace's approval workflow: they may be queued as a change request for review instead of applying immediately — the response says which happened.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Document id." },
        markdown: { type: "string", description: "New full body (replaces the old one)." },
        title: { type: "string" },
        summary: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        type: { type: "string", enum: TYPES, description: "Change the document type." },
        space: { type: "string", description: "Move the document to this space (slug from list_spaces)." },
        parent: { type: ["number", "null"], description: "Nest under this parent document id, or null for top level (requires the workspace's nested-pages feature)." },
        publish: {
          type: "boolean",
          description:
            "Publish this document (drafts go live; may queue for approval instead, depending on workspace settings).",
        },
        note: { type: "string", description: "Short change note for the version history." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

// --- Tool implementations ---------------------------------------------------------

async function callTool(user: User, name: string, args: any, origin: string) {
  const isEditor = roleAtLeast(user.role, "editor");
  // The connector acts as the user, so it sees exactly the spaces they can:
  // public ones plus private ones granted via their groups (admins see all).
  const scope = await spaceScopeFor(user);

  switch (name) {
    case "list_spaces": {
      const spaces = await listSpaces(scope);
      return toolJson(
        spaces.map((s) => ({ slug: s.slug, name: s.name, description: s.description, docs: s.doc_count }))
      );
    }

    case "list_docs": {
      let docs;
      if (args?.space) {
        const space = await getSpaceBySlug(String(args.space));
        if (!space || !scopeAllows(scope, space.id)) {
          return toolText(`No space with slug "${args.space}".`, true);
        }
        docs = await listDocumentsBySpace(space.id, isEditor);
      } else {
        docs = await listRecentDocuments(30, isEditor, scope);
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
      const { hybridSearchDocuments } = await import("@/lib/embeddings");
      const hits = await hybridSearchDocuments(String(args?.query ?? ""), 15, isEditor, scope);
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
      if (!doc || !scopeAllows(scope, doc.space_id) || (doc.status === "draft" && !isEditor)) {
        return toolText(`No document with id ${args?.id}.`, true);
      }
      // Nested pages + backlinks context (each admin-gated).
      const appSettings = await getAppSettings();
      let structure = "";
      if (appSettings.nested_pages_enabled && doc.branch_of === null) {
        const { ancestorsOf, childrenOf } = await import("@/lib/doc-tree");
        const [ancestors, children] = await Promise.all([
          ancestorsOf(doc.id),
          childrenOf(doc.id, { includeDrafts: isEditor }),
        ]);
        if (ancestors.length) {
          structure += `\n> path: ${[...ancestors].reverse().map((a) => `${a.title} (id ${a.id})`).join(" › ")}`;
        }
        if (children.length) {
          structure += `\n> sub-pages: ${children.map((c) => `${c.title} (id ${c.id})`).join("; ")}`;
        }
      }
      if (appSettings.backlinks_enabled && doc.branch_of === null) {
        const { backlinksFor } = await import("@/lib/backlinks");
        const links = await backlinksFor(doc.id, scope, isEditor);
        if (links.length) {
          structure += `\n> linked from: ${links.map((b) => `${b.title} (id ${b.id})`).join("; ")}`;
        }
      }
      const header =
        `# ${doc.title}\n\n` +
        `> id: ${doc.id} · space: ${doc.space_slug} · type: ${doc.type} · status: ${doc.status}` +
        (doc.tags.length ? ` · tags: ${doc.tags.join(", ")}` : "") +
        (doc.summary ? `\n> summary: ${doc.summary}` : "") +
        structure +
        `\n\n---\n\n`;
      return toolText(header + doc.content);
    }

    case "list_templates": {
      const templates = await listTemplates(false);
      return toolJson({
        templates: templates.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          doc_type: t.doc_type,
          tags: t.tags,
          title_pattern: t.title_pattern,
          body: t.body,
        })),
        note: "Placeholders {{title}}, {{date}}, {{author}}, {{space}} fill automatically at creation; others (like {{owner}}) stay as prompts for the writer — fill them yourself when you know the value.",
      });
    }

    case "writing_guide":
      return toolText(WRITING_GUIDE);

    case "create_doc": {
      if (!isEditor) {
        return toolText("Your role (viewer) can't create documents — ask an admin for editor access.", true);
      }
      const title = String(args?.title ?? "").trim();
      const markdown = String(args?.markdown ?? "");
      if (!title) return toolText("A title is required.", true);
      if (!markdown.trim() && !args?.template) {
        return toolText("Provide markdown, or a template to start from (see list_templates).", true);
      }

      let spaceObj;
      if (args?.space) {
        spaceObj = await getSpaceBySlug(String(args.space));
        if (!spaceObj || !scopeAllows(scope, spaceObj.id)) {
          return toolText(`No space with slug "${args.space}" — call list_spaces first.`, true);
        }
      } else {
        spaceObj = (await listSpaces(scope))[0];
      }
      const spaceId = spaceObj?.id;
      if (!spaceId) return toolText("No space available to create the document in.", true);
      if (!(await canEditSpace(user, spaceId))) {
        return toolText("You don't have edit access to that space — pick another with list_spaces.", true);
      }

      // Resolve the template (by id or name) and fill its placeholders.
      let rendered: ReturnType<typeof renderTemplate> | undefined;
      if (args?.template) {
        const ref = String(args.template).trim();
        const tpl = /^\d+$/.test(ref) ? await getTemplate(Number(ref)) : await getTemplateByName(ref);
        if (!tpl || tpl.hidden === 1) {
          return toolText(`No template "${ref}" — call list_templates for the available ones.`, true);
        }
        rendered = renderTemplate(tpl, {
          title,
          author: user.name || user.username,
          space: spaceObj?.name ?? "",
          date: formatDate(new Date().toISOString(), await getAppSettings()),
        });
      }

      const canPublish = roleAtLeast(user.role, "approver") || (await getApprovalMode()) === "open";
      const wantPublish = args?.publish === true;
      const status: DocStatus = wantPublish && canPublish ? "published" : "draft";

      const ownTags: string[] = Array.isArray(args?.tags)
        ? args.tags.map((t: unknown) => String(t).trim()).filter(Boolean)
        : [];
      const doc = await createDocument({
        space_id: spaceId,
        title: rendered?.title || title,
        type: TYPES.includes(args?.type) ? args.type : rendered?.type ?? "knowledge",
        status,
        content: markdown.trim() ? markdown : rendered?.content ?? "",
        summary: String(args?.summary ?? "").trim() || rendered?.summary || "",
        tags: [...new Set([...(rendered?.tags ?? []), ...ownTags])],
        author: user.name || user.username,
      });
      if (doc.status === "published") {
        void notifyWebhooks("document.published", {
          title: doc.title,
          actor: user.name || user.username,
          url: `${origin}/doc/${doc.id}`,
          spaceId: doc.space_id,
          spaceName: doc.space_name,
        });
        void notifySpaceSubscribers({
          spaceId: doc.space_id,
          spaceName: doc.space_name,
          docId: doc.id,
          title: doc.title,
          kind: "published",
          actorUserId: user.id,
          actorName: user.name || user.username,
          origin,
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
      // Nested pages: optional parent (admin-gated; bad values degrade to a note).
      let parentNote: string | undefined;
      if (Number.isInteger(args?.parent)) {
        if ((await getAppSettings()).nested_pages_enabled) {
          const { setParent } = await import("@/lib/doc-tree");
          parentNote = await setParent(doc.id, Number(args.parent));
        } else {
          parentNote = "Nested pages are disabled in this workspace — the doc was created at top level.";
        }
      }
      return toolJson({
        ok: true,
        id: doc.id,
        status: doc.status,
        url: `/doc/${doc.id}`,
        note:
          wantPublish && status === "draft"
            ? "Created as a draft — this workspace requires approver review to publish."
            : parentNote,
      });
    }

    case "update_doc": {
      if (!isEditor) {
        return toolText("Your role (viewer) can't edit documents — ask an admin for editor access.", true);
      }
      const existing = await getDocument(Number(args?.id));
      if (!existing || !scopeAllows(scope, existing.space_id)) {
        return toolText(`No document with id ${args?.id}.`, true);
      }
      if (!(await canEditSpace(user, existing.space_id))) {
        return toolText("You don't have edit access to this document's space.", true);
      }

      // Optional move to another space — needs edit access on both sides.
      let targetSpaceId = existing.space_id;
      if (args?.space) {
        const space = await getSpaceBySlug(String(args.space));
        if (!space || !scopeAllows(scope, space.id)) {
          return toolText(`No space with slug "${args.space}" — call list_spaces first.`, true);
        }
        if (!(await canEditSpace(user, space.id))) {
          return toolText("You don't have edit access to that space.", true);
        }
        targetSpaceId = space.id;
      }
      const moving = targetSpaceId !== existing.space_id;

      const wantPublish = args?.publish === true;
      const proposed = {
        title: typeof args?.title === "string" && args.title.trim() ? args.title.trim() : existing.title,
        content: typeof args?.markdown === "string" ? args.markdown : existing.content,
        summary: typeof args?.summary === "string" ? args.summary.trim() : existing.summary,
        type: (TYPES.includes(args?.type) ? args.type : existing.type) as DocType,
        status: (wantPublish ? "published" : existing.status) as DocStatus,
        tags: Array.isArray(args?.tags)
          ? args.tags.map((t: unknown) => String(t).trim()).filter(Boolean)
          : existing.tags,
      };
      const note = String(args?.note ?? "").trim();

      // Same approval rule as the app: changes that touch live content (the
      // doc is published, or this edit would publish it) apply directly only
      // for approvers+ (or in open mode); otherwise they queue for review.
      const affectsLive = existing.status === "published" || proposed.status === "published";
      const canPublish = roleAtLeast(user.role, "approver") || (await getApprovalMode()) === "open";
      if (affectsLive && !canPublish) {
        const kind = existing.status === "draft" ? "publish" : "edit";
        const crId = await createChangeRequest({
          document_id: existing.id,
          kind,
          title: proposed.title,
          content: proposed.content,
          summary: proposed.summary,
          tags: proposed.tags,
          type: proposed.type,
          target_status: "published",
          note,
          created_by: user.id,
          space_id: moving ? targetSpaceId : null,
        });
        await audit({
          actor: actorFrom(user),
          action: "change_request.submit",
          targetType: "document",
          targetId: existing.id,
          targetLabel: proposed.title,
          details: { kind, via: "mcp" },
        });
        void notifyWebhooks("change_request.submitted", {
          title: proposed.title,
          kind,
          actor: user.name || user.username,
          url: `${origin}/review`,
          spaceId: existing.space_id,
          spaceName: existing.space_name,
        });
        return toolJson({
          ok: true,
          pending_review: true,
          change_request_id: crId,
          note:
            kind === "publish"
              ? "Publishing requires approval in this workspace — the draft was queued for an approver to review."
              : "This document is published and your role requires approval — the edit was queued for an approver to review, the live document is unchanged.",
        });
      }

      const doc = await updateDocument(existing.id, {
        ...proposed,
        space_id: targetSpaceId,
        author: user.name || user.username,
        versionNote: note || "Edited via Claude connector",
      });

      // Nested pages: parent moves are organizational and apply directly.
      let parentNote: string | undefined;
      if (args?.parent === null || Number.isInteger(args?.parent)) {
        if ((await getAppSettings()).nested_pages_enabled) {
          const { setParent } = await import("@/lib/doc-tree");
          parentNote = await setParent(existing.id, args.parent === null ? null : Number(args.parent));
        } else {
          parentNote = "Nested pages are disabled in this workspace — parent unchanged.";
        }
      }

      const justPublished = existing.status !== "published" && doc?.status === "published";
      if (doc && justPublished) {
        void notifyWebhooks("document.published", {
          title: doc.title,
          actor: user.name || user.username,
          url: `${origin}/doc/${doc.id}`,
          spaceId: doc.space_id,
          spaceName: doc.space_name,
        });
      }
      if (doc && doc.status === "published") {
        void notifySpaceSubscribers({
          spaceId: doc.space_id,
          spaceName: doc.space_name,
          docId: doc.id,
          title: doc.title,
          kind: justPublished ? "published" : "updated",
          actorUserId: user.id,
          actorName: user.name || user.username,
          origin,
        });
      }
      await audit({
        actor: actorFrom(user),
        action: justPublished ? "document.publish" : "document.update",
        targetType: "document",
        targetId: existing.id,
        targetLabel: proposed.title,
        details: { via: "mcp", ...(moving ? { moved_to: targetSpaceId } : {}) },
      });
      return toolJson({ ok: true, id: doc!.id, status: doc!.status, url: `/doc/${doc!.id}`, note: parentNote });
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
    const origin = await publicOrigin(req);
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

async function handleRpc(user: User, msg: any, origin: string): Promise<unknown | undefined> {
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
          "CompassDocs is this team's knowledge base. Use search_docs/read_doc to look things up, create_doc to save a drafted article as markdown, and update_doc to revise, retitle, retag, move, or publish an existing one. Call list_spaces first when creating, to pick the right space. When drafting a document of a standard kind (runbook, SOP, policy, postmortem, meeting notes, decision record), call list_templates and follow the matching template's structure, passing template to create_doc. IMPORTANT: before writing or restructuring a document, call writing_guide — CompassDocs documents support rich interactive blocks well beyond plain markdown (callouts, tabs, accordions, checklists, Mermaid/PlantUML diagrams, decision trees, video/website embeds, auto-filterable tables), and good documents use them.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      try {
        const result = await callTool(user, String(params?.name ?? ""), params?.arguments ?? {}, origin);
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

  const origin = await publicOrigin(req);
  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map((m) => handleRpc(user, m, origin)))).filter(
      (r) => r !== undefined
    );
    return replies.length ? json(replies) : new Response(null, { status: 202 });
  }
  const reply = await handleRpc(user, body, origin);
  return reply === undefined ? new Response(null, { status: 202 }) : json(reply);
}

// The connector is request/response only — no server-push stream to offer.
export function GET() {
  return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
}
