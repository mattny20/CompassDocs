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
  getAttachment,
  createTrainingDeck,
  getTrainingDeck,
  listTrainingDecks,
  trainingDeckStatus,
  assignTraining,
  expandTrainingAudience,
  listUsers,
} from "@/lib/db";
import { currentVersion } from "@/lib/version";
import { listTemplates, getTemplate, getTemplateByName, renderTemplate } from "@/lib/doc-templates";
import { getAppSettings } from "@/lib/settings-store";
import { formatDate } from "@/lib/format";
import { publicOrigin } from "@/lib/oauth";
import { notifyWebhooks } from "@/lib/webhooks";
import { notifyCrSubmitted } from "@/lib/notifications";
import { notifySpaceSubscribers } from "@/lib/subscriptions";
import { audit, actorFrom } from "@/lib/audit";
import {
  intakeFromBase64,
  intakeFromUrl,
  intakeFromAttachment,
  storeImage,
  withImagePlaced,
  isInsertMode,
  createUploadTicket,
  type InsertMode,
} from "@/lib/image-intake";
import {
  canSeeDrafts,
  canPublishDirectly,
  userHolds,
  spaceScopeFor,
  scopeAllows,
  canEditSpace,
} from "@/lib/access";
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
/api/attachments/… URL from the existing document markdown. To add a NEW image
(a screenshot, a diagram export), call add_image — prefer source_url so the
server fetches it, and set insert to place it in the body in the same call.
If the picture only exists as something you can see in the conversation, call
request_upload and give the person the drop link; base64 cannot carry it.

## Training decks
A published document can be assigned as a training deck (Training tab).
Slides split on \`---\` lines; an optional terminal block sets the wording of
the final confirmation gate:

:::compliance
I confirm that I have completed this training and understood the material.
:::

Add graded questions with a quiz block on any slide — [x] marks the correct
option(s); the player grades server-side and a passing score (deck setting)
is required before the confirmation unlocks:

:::quiz
Q: Which cable goes in first?
- [ ] Power
- [x] Ground
:::

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
  {
    name: "add_image",
    description:
      "Put an image (screenshot, diagram export, photo) into a document (requires authoring access). Give the image ONE of three ways: source_url — the server fetches it, which is the best option whenever the image has a public address, because the bytes never pass through this conversation and size stops being a problem; from_attachment_id — reuse an image already attached somewhere in this workspace; data — the raw bytes base64-encoded, which only works for small images because base64 inflates by a third and tool arguments are capped. If the picture exists only as something you can SEE (a screenshot pasted into this conversation), you cannot produce its bytes at any size — call request_upload instead and hand the person the link. PNG, JPEG, GIF, and WebP are accepted; the type is read from the bytes, not the filename. Set insert to place it in the body in the same call — with insert:\"none\" (the default) you get the markdown snippet back and must place it yourself.",
    inputSchema: {
      type: "object",
      properties: {
        doc_id: { type: "number", description: "Document the image belongs to (from list_docs / create_doc)." },
        source_url: {
          type: "string",
          description:
            "Public https URL of the image; the server fetches it. Preferred — no size limit beyond the workspace attachment cap. Must return the image file itself, not a page that displays it.",
        },
        from_attachment_id: {
          type: "number",
          description:
            "Copy an image already attached to a document you can read (attachment id from a previous add_image or from the markdown URL /api/attachments/N).",
        },
        data: {
          type: "string",
          description:
            "The image bytes, base64-encoded (a data: URI is also accepted). Small images only — larger ones overrun the client's tool-argument cap. Use source_url or request_upload instead.",
        },
        insert: {
          type: "string",
          enum: ["none", "append", "top"],
          description:
            "Where to place the image in the document body: \"append\" at the end, \"top\" at the beginning, \"none\" (default) to leave the body alone and place the returned snippet yourself. append/top edit only the body text around it and are safe against concurrent edits.",
        },
        filename: { type: "string", description: "Display name, e.g. dashboard-screenshot.png. Optional." },
        alt: { type: "string", description: "Alt text for the image. Optional but recommended." },
      },
      required: ["doc_id"],
      additionalProperties: false,
    },
  },
  {
    name: "request_upload",
    description:
      "Get a single-use link the person can drop an image file into, which attaches it to a document and places it in the body automatically. Use this when the image cannot be sent as bytes or fetched from a URL — above all when it is a screenshot pasted into this conversation, which reaches you as a picture and has no byte form you can re-emit. Show the returned link and ask them to open it. The link works once, for this one document, and expires in an hour; nothing further is needed from you after they drop the file.",
    inputSchema: {
      type: "object",
      properties: {
        doc_id: { type: "number", description: "Document the image should be added to." },
        insert: {
          type: "string",
          enum: ["none", "append", "top"],
          description: "Where to place the dropped image in the body. Default \"append\".",
        },
        alt: { type: "string", description: "Alt text for the image. Optional." },
      },
      required: ["doc_id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_training_deck",
    description:
      "Turn a published document into a training deck (enterprise training entitlement; requires training-manager access). Slides split on --- lines; a trailing :::compliance block sets the confirmation wording; :::quiz blocks add graded questions. Returns the deck id.",
    inputSchema: {
      type: "object",
      properties: {
        doc_id: { type: "number", description: "A published document (from list_docs / create_doc)." },
        due_days: { type: "number", description: "Due within N days of assignment (1-365). Optional." },
        assign_new_members: { type: "boolean", description: "Auto-assign to every new member. Default false." },
      },
      required: ["doc_id"],
      additionalProperties: false,
    },
  },
  {
    name: "assign_training",
    description:
      "Assign a training deck to people (enterprise training entitlement; requires training-manager access). Pass usernames and/or everyone. Assignees are notified; already-assigned people are skipped.",
    inputSchema: {
      type: "object",
      properties: {
        deck_id: { type: "number", description: "The deck (from create_training_deck or training_status)." },
        usernames: { type: "array", items: { type: "string" }, description: "Usernames to assign." },
        everyone: { type: "boolean", description: "Assign to every active member instead." },
      },
      required: ["deck_id"],
      additionalProperties: false,
    },
  },
  {
    name: "training_status",
    description:
      "Training progress (enterprise training entitlement; requires training-manager access). Without deck_id: every deck with completion counts. With deck_id: per-person status — completed, waived, open, overdue, quiz scores.",
    inputSchema: {
      type: "object",
      properties: {
        deck_id: { type: "number", description: "Optional: one deck's per-person detail." },
      },
      additionalProperties: false,
    },
  },
];

// --- Tool implementations ---------------------------------------------------------

async function callTool(user: User, name: string, args: any, origin: string) {
  // Drafts across spaces. Per-document and per-space reads below narrow this
  // to the space in hand; the writes re-check with canEditSpace either way.
  const seeDrafts = await canSeeDrafts(user);
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
        docs = await listDocumentsBySpace(space.id, await canSeeDrafts(user, space.id));
      } else {
        docs = await listRecentDocuments(30, seeDrafts, scope);
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
      const hits = await hybridSearchDocuments(String(args?.query ?? ""), 15, seeDrafts, scope);
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
      if (
        !doc ||
        !scopeAllows(scope, doc.space_id) ||
        (doc.status === "draft" && !(await canSeeDrafts(user, doc.space_id)))
      ) {
        return toolText(`No document with id ${args?.id}.`, true);
      }
      // Nested pages + backlinks context (each admin-gated).
      const appSettings = await getAppSettings();
      let structure = "";
      if (appSettings.nested_pages_enabled && doc.branch_of === null) {
        const { ancestorsOf, childrenOf } = await import("@/lib/doc-tree");
        const [ancestors, children] = await Promise.all([
          ancestorsOf(doc.id),
          childrenOf(doc.id, { includeDrafts: await canSeeDrafts(user, doc.space_id) }),
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
        const links = await backlinksFor(doc.id, scope, seeDrafts);
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
      if (!(await userHolds(user, "document.create"))) {
        return toolText("You don't have permission to create documents — ask an admin for authoring access.", true);
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

      const canPublish = await canPublishDirectly(user, spaceId);
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
      if (!(await userHolds(user, "document.update"))) {
        return toolText("You don't have permission to edit documents — ask an admin for authoring access.", true);
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
      const canPublish = await canPublishDirectly(user, existing.space_id);
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
        void notifyCrSubmitted({
          spaceId: existing.space_id,
          title: proposed.title,
          actorId: user.id,
          actorName: user.name || user.username,
          origin,
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

    case "add_image": {
      if (!(await userHolds(user, "document.update"))) {
        return toolText("You don't have permission to upload images — ask an admin for authoring access.", true);
      }
      const doc = await getDocument(Number(args?.doc_id));
      if (!doc || !scopeAllows(scope, doc.space_id)) {
        return toolText(`No document with id ${args?.doc_id}.`, true);
      }
      if (!(await canEditSpace(user, doc.space_id))) {
        return toolText("You don't have edit access to this document's space.", true);
      }

      const insert: InsertMode = isInsertMode(args?.insert) ? args.insert : "none";

      // Three ways in, one validator. `data` is kept for small images, but it
      // is the fragile one: base64 inflates by a third and clients cap tool
      // arguments, so anything real overruns them — and a picture that only
      // exists in the conversation has no byte form to send at all.
      let intake: Awaited<ReturnType<typeof intakeFromBase64>>;
      if (args?.source_url) {
        intake = await intakeFromUrl(String(args.source_url));
      } else if (args?.from_attachment_id !== undefined) {
        // Scope check before the read: getAttachment takes an id, not a scope,
        // so without this an id from another space would be copied out of it.
        const srcAtt = await getAttachment(Number(args.from_attachment_id));
        const srcDoc = srcAtt ? await getDocument(srcAtt.document_id) : undefined;
        if (!srcAtt || !srcDoc || !scopeAllows(scope, srcDoc.space_id)) {
          return toolText(`No attachment with id ${args.from_attachment_id}.`, true);
        }
        intake = await intakeFromAttachment(srcAtt.id);
      } else if (args?.data) {
        intake = await intakeFromBase64(String(args.data));
      } else {
        return toolText(
          "Give the image one of three ways: `source_url` (we fetch it — best for anything with an address), " +
            "`from_attachment_id` (reuse an image already in this workspace), or `data` (base64, small images only). " +
            "If the picture only exists in this conversation, you cannot send its bytes — call `request_upload` " +
            "to get a link the person can drop the file into.",
          true
        );
      }
      if (!intake.ok) return toolText(intake.error, true);

      const att = await storeImage({
        documentId: doc.id,
        userId: user.id,
        buf: intake.buf,
        kind: intake.kind,
        filename: args?.filename,
      });
      const alt = String(args?.alt ?? "").trim() || att.filename;
      const markdown = `![${alt}](/api/attachments/${att.id})`;

      // Place it, if asked. This is the step that used to be a separate
      // update_doc and got skipped — or done as a whole-body rewrite that
      // clobbered someone else's concurrent edit.
      let placed = false;
      if (insert !== "none") {
        const fresh = await getDocument(doc.id);
        if (fresh) {
          await updateDocument(doc.id, {
            content: withImagePlaced(fresh.content, markdown, insert),
          });
          placed = true;
        }
      }

      await audit({
        actor: actorFrom(user),
        action: "attachment.upload",
        targetType: "document",
        targetId: doc.id,
        targetLabel: doc.title,
        details: {
          via: "mcp",
          filename: att.filename,
          size: intake.buf.length,
          mime: intake.kind.mime,
          source: args?.source_url ? "url" : args?.from_attachment_id !== undefined ? "attachment" : "base64",
          inserted: placed,
        },
      });
      return toolJson({
        ok: true,
        attachment_id: att.id,
        url: `/api/attachments/${att.id}`,
        markdown,
        inserted: placed,
        note: placed
          ? "The image is attached AND placed in the document body — nothing further to do."
          : "Attached but NOT displayed yet. Either re-run with insert:\"append\", or put the markdown snippet in the body via update_doc.",
      });
    }

    case "request_upload": {
      // The handoff. When the picture exists only as something the person can
      // see — a screenshot in this conversation, a file on their desktop —
      // no tool argument can carry it. Hand them a link instead.
      if (!(await userHolds(user, "document.update"))) {
        return toolText("You don't have permission to add images — ask an admin for authoring access.", true);
      }
      const doc = await getDocument(Number(args?.doc_id));
      if (!doc || !scopeAllows(scope, doc.space_id)) {
        return toolText(`No document with id ${args?.doc_id}.`, true);
      }
      if (!(await canEditSpace(user, doc.space_id))) {
        return toolText("You don't have edit access to this document's space.", true);
      }
      const ticket = await createUploadTicket({
        documentId: doc.id,
        userId: user.id,
        insert: isInsertMode(args?.insert) ? args.insert : "append",
        alt: String(args?.alt ?? ""),
      });
      const link = `${origin}/upload/${ticket.token}`;
      return toolJson({
        ok: true,
        upload_url: link,
        expires_at: ticket.expires_at,
        document: doc.title,
        note:
          `Show this link to the person and ask them to open it and drop the image in: ${link} ` +
          "It works once, for this document, and expires in an hour. The image is attached and placed automatically " +
          "when they drop it — you do not need to call anything else afterwards.",
      });
    }

    case "create_training_deck":
    case "assign_training":
    case "training_status": {
      // Entitlement + delegated-section gate, mirroring the training APIs.
      const { featureEnabled } = await import("@/lib/ee");
      const { canAccessSection } = await import("@/lib/section-access");
      if (!(await featureEnabled("training"))) {
        return toolText("Training is not included in this workspace's license.", true);
      }
      if (!(await canAccessSection(user, "training"))) {
        return toolText("Training management requires admin or Training-section access.", true);
      }

      if (name === "create_training_deck") {
        const doc = await getDocument(Number(args?.doc_id));
        if (!doc || doc.status !== "published" || !scopeAllows(scope, doc.space_id)) {
          return toolText("Pick a published document you can see.", true);
        }
        const dueDays = args?.due_days
          ? Math.min(365, Math.max(1, Math.floor(Number(args.due_days)))) || null
          : null;
        const created = await createTrainingDeck(
          doc.id,
          { due_days: dueDays, assign_new_members: args?.assign_new_members === true },
          user.id
        );
        if (!created) return toolText("That document is already a training deck.", true);
        await audit({
          actor: actorFrom(user),
          action: "training.deck_create",
          targetType: "document",
          targetId: doc.id,
          targetLabel: doc.title,
          details: { via: "mcp" },
        });
        return toolJson({ ok: true, deck_id: created.id, title: doc.title });
      }

      if (name === "assign_training") {
        const deck = await getTrainingDeck(Number(args?.deck_id));
        if (!deck || deck.archived_at) return toolText("No such training deck.", true);
        let ids: number[] = [];
        if (args?.everyone === true) {
          ids = await expandTrainingAudience([], [], true);
        } else {
          const wanted = new Set(
            (Array.isArray(args?.usernames) ? args.usernames : []).map((u: unknown) =>
              String(u).toLowerCase()
            )
          );
          ids = (await listUsers())
            .filter((u) => u.status === "active" && wanted.has(u.username.toLowerCase()))
            .map((u) => u.id);
        }
        if (!ids.length) return toolText("Nobody matched — pass usernames or everyone: true.", true);
        const dueAt = deck.due_days
          ? new Date(Date.now() + deck.due_days * 86_400_000).toISOString()
          : null;
        const assigned = await assignTraining(deck.id, ids, user.name || user.username, "manual", dueAt);
        if (assigned.length) {
          const { notifyTrainingAssigned } = await import("@/lib/training");
          void notifyTrainingAssigned({
            userIds: assigned,
            deckTitle: deck.title,
            dueAt,
            assignerName: user.name || user.username,
            origin,
          });
        }
        await audit({
          actor: actorFrom(user),
          action: "training.assigned",
          targetType: "document",
          targetId: deck.document_id,
          targetLabel: deck.title,
          details: { via: "mcp", newly_assigned: assigned.length, audience: ids.length },
        });
        return toolJson({ ok: true, assigned: assigned.length, already: ids.length - assigned.length });
      }

      // training_status
      if (args?.deck_id) {
        const deck = await getTrainingDeck(Number(args.deck_id));
        if (!deck) return toolText("No such training deck.", true);
        const rows = await trainingDeckStatus(deck.id);
        return toolJson({
          deck: { id: deck.id, title: deck.title, due_days: deck.due_days, pass_pct: deck.pass_pct },
          people: rows.map((r) => ({
            name: r.name,
            username: r.username,
            status: r.completed_at
              ? r.source === "waived"
                ? "waived"
                : "completed"
              : r.due_at && new Date(r.due_at).getTime() < Date.now()
                ? "overdue"
                : "open",
            due_at: r.due_at,
            completed_at: r.completed_at,
            quiz: r.quiz_total ? `${r.quiz_score}/${r.quiz_total}` : null,
            prior_completions: r.prior_completions,
          })),
        });
      }
      const decks = await listTrainingDecks();
      return toolJson(
        decks.map((d) => ({
          deck_id: d.id,
          title: d.title,
          active: d.active === 1,
          assigned: d.assigned,
          completed: d.completed,
          due_days: d.due_days,
          recert_months: d.recert_months,
        }))
      );
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
  // The connector edits as the user, so a read-only token isn't enough —
  // refuse up front with a clear reason instead of failing on the first write.
  const scopes = (user as { token_scopes?: string[] } | undefined)?.token_scopes;
  if (user && Array.isArray(scopes) && !scopes.includes("write")) {
    return new Response(
      JSON.stringify({
        error: "This token is read-only. The Claude connector needs a read + write token.",
      }),
      { status: 403, headers: { "content-type": "application/json" } }
    );
  }
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
          "CompassDocs is this team's knowledge base. Use search_docs/read_doc to look things up, create_doc to save a drafted article as markdown, and update_doc to revise, retitle, retag, move, or publish an existing one. Call list_spaces first when creating, to pick the right space. When drafting a document of a standard kind (runbook, SOP, policy, postmortem, meeting notes, decision record), call list_templates and follow the matching template's structure, passing template to create_doc. To put an image into a document, call add_image with insert:\"append\" — pass source_url if the image has a public address, or from_attachment_id to reuse one already in the workspace; base64 data works only for small files. For a screenshot that exists only as a picture in the conversation there are no bytes you can send, so call request_upload and give the person the link it returns. IMPORTANT: before writing or restructuring a document, call writing_guide — CompassDocs documents support rich interactive blocks well beyond plain markdown (callouts, tabs, accordions, checklists, Mermaid/PlantUML diagrams, decision trees, video/website embeds, auto-filterable tables), and good documents use them.",
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
