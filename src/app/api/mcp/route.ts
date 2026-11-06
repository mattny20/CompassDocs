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
  ackSummary,
  AckReasonRequiredError,
  getSpaceById,
  listGroupNames,
  listMyPolicies,
  handbookDocumentRows,
} from "@/lib/db";
import { ackDecisionRequired, ACK_POLICY_ERROR } from "@/lib/ack-decision";
import { getComplianceSettings } from "@/lib/compliance-settings";
import { currentVersion } from "@/lib/version";
import { listTemplates, getTemplate, getTemplateByName, renderTemplate } from "@/lib/doc-templates";
import { getAppSettings } from "@/lib/settings-store";
import { formatDate } from "@/lib/format";
import { publicOrigin } from "@/lib/oauth";
import { notifyWebhooks } from "@/lib/webhooks";
import { findScopeFor } from "@/lib/handbook-visibility";
import * as hb from "@/lib/handbooks";
import type { FindMode, HandbookContentsInput, HandbookItem } from "@/lib/handbooks";
import { loadConfirmView } from "@/lib/handbook-confirm";
import { featureEnabled as licensedFor } from "@/lib/ee";
import { toSessionUser } from "@/lib/auth";
import { notifyCrSubmitted } from "@/lib/notifications";
import { notifySpaceSubscribers } from "@/lib/subscriptions";
import { audit, auditAckDecision, actorFrom, ipFrom } from "@/lib/audit";
import { callHelpdeskTool, helpdeskToolsFor, isHelpdeskTool } from "@/lib/mcp/helpdesk-tools";
import {
  intakeFromBase64,
  intakeFromUrl,
  intakeFromAttachment,
  storeImage,
  withImagePlaced,
  isInsertMode,
  imageAltText,
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
  EVERY_SPACE_UNFILTERED,
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
      "Update a document: markdown body, metadata (title, summary, tags, type), publish a draft, or move it to another space (requires editor or higher). Rich blocks are supported — call writing_guide for the syntax. Changes affecting published content follow the workspace's approval workflow: they may be queued as a change request for review instead of applying immediately — the response says which happened. A document that requires read confirmation (read_doc says so) needs ack_policy and ack_reason when its body or title changes, including when publish:true puts a changed draft live: without them the call saves nothing and returns decision_required with the numbers, so ask the person and call again.",
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
        ack_policy: {
          type: "string",
          enum: ["keep", "reset"],
          description:
            "Required when the document requires read confirmation and the body or title changes: keep = editorial fix (people are not asked again); reset = material change (everyone re-confirms). Always include ack_reason saying what changed and why.",
        },
        ack_reason: {
          type: "string",
          description:
            "What changed and why, 10 to 500 characters. Recorded on the compliance record with the decision; with reset it is also what readers are told in the re-confirmation notice.",
        },
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
  // Policy handbooks (1.18.2): the reader, the confirm page's standing and
  // the editor's Contents card, through lib/handbooks. No tool confirms a
  // handbook or a policy: a confirmation is the person's own act, in the app.
  {
    name: "list_handbooks",
    description:
      "List the policy handbooks you can read, plus the drafts you can edit: id, title, owner (the whole workspace or a space), status, policy and section counts, last update, whether it asks readers to confirm it as a whole, and (with the Read confirmation licence) your own progress, N of M policies confirmed. The handbook's editors, and people who hold Read compliance program, also get the audience progress the Handbooks page shows. Nothing here confirms anything: people confirm in the app, at the confirm_url given.",
    inputSchema: {
      type: "object",
      properties: {
        space: {
          type: "string",
          description: "Only handbooks owned by this space (slug from list_spaces), or \"workspace\" for workspace handbooks. Omit for all.",
        },
        status: { type: "string", enum: ["draft", "published"], description: "Only drafts or only published handbooks. Omit for both." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_handbook",
    description:
      "Read a policy handbook as its reader shows it: the introduction, then the sections in order with their numbered policies, each with its type, facts (owner, approved by, version, effective date, next review, applies to), In short points, the policy text as markdown and its reader URL. A published handbook opens every published policy in it to its readers, even from spaces they cannot otherwise open. Drafts are visible to their editors only. An editor sees a policy from a space they can't add from as a placeholder (\"A document you can't open\") with its doc id only. Pass doc_id to read one policy. Long handbooks are cut to a text budget; the result says which policies to read one at a time.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Handbook id (from list_handbooks)." },
        doc_id: { type: "number", description: "Optional: read just this policy (its document id) in the handbook." },
        include_text: {
          type: "boolean",
          description: "Include each policy's text (default true). false gives the outline: titles, facts and In short only.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "handbook_status",
    description:
      "Where you stand on a published handbook (Read confirmation licence): each policy as To confirm, Confirmed, Updated since you confirmed or For information, your progress, and whether your whole-handbook confirmation is on record for the handbook as it stands. For the handbook's editors, and people who hold Read compliance program, also the share and number of its audience who confirmed it as it stands (no names). This tool never confirms: the person confirms in the app, on each policy's page or at the confirm_url.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "Handbook id (from list_handbooks)." } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_handbook",
    description:
      "Create a policy handbook as a DRAFT (requires the Build handbooks permission for the chosen owner: held across the workspace for a workspace handbook, or on that space for a space handbook). It is never published by this tool: hand the person the edit_url so they review it and publish it in the app. Optional initial sections take published documents you may add (any space you can see for a workspace handbook; the spaces where you build handbooks for a space handbook). A space handbook is only ever read by people who can read its space, even with groups chosen.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Up to 160 characters." },
        owner: {
          type: ["string", "number"],
          description: "\"workspace\" (default) for a workspace handbook, or a space id or slug (from list_spaces) for a space handbook.",
        },
        introduction: { type: "string", description: "Markdown shown before the first policy; up to 20,000 characters." },
        audience: {
          type: "string",
          enum: ["all", "groups"],
          description: "all (default): everyone (workspace) or everyone who can read the space. groups: only the groups named in groups.",
        },
        groups: {
          type: "array",
          items: { type: ["string", "number"] },
          description:
            "With audience groups: group names or ids. A number, or a name made only of digits, is read as an id, so pass such a group by its id; a name shared by more than one group must be passed as an id too. Publishing needs at least one.",
        },
        confirm_whole: { type: "boolean", description: "Ask readers to confirm the whole handbook (default false)." },
        require_signature: { type: "boolean", description: "Require a typed signature for confirmations made in the handbook (default false)." },
        sections: {
          type: "array",
          description: "Optional initial contents, in order: up to 50 sections and 200 documents, each document once.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Section title, up to 120 characters." },
              documents: { type: "array", items: { type: "number" }, description: "Published document ids, in reading order." },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "update_handbook_contents",
    description:
      "Replace a handbook's contents: its sections in order, each with its documents in order (requires editing rights on the handbook). Send every section and document to keep: a section or document left out is removed (a section with an id from read_handbook keeps that section; without one it is new). Include placeholders (\"A document you can't open\") by their doc id to keep them. A document new to the handbook must be published and from a space you may add from. Pass if_updated_at (the updated_at from read_handbook) so the save is refused if someone else saved first; the result gives the new updated_at. If the handbook is published, the change is live for its readers at once, as the editor's Save is. This never publishes or unpublishes a handbook, and never confirms anything.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Handbook id." },
        sections: {
          type: "array",
          description: "The whole contents, in order: 1 to 50 sections, up to 200 documents, each document once.",
          items: {
            type: "object",
            properties: {
              id: { type: "number", description: "Keep this existing section (id from read_handbook). Omit for a new section." },
              title: { type: "string", description: "Section title, up to 120 characters." },
              documents: { type: "array", items: { type: "number" }, description: "Document ids, in reading order." },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
        if_updated_at: { type: "string", description: "The handbook's updated_at as you last read it. Recommended." },
        find_modes: {
          type: "array",
          description:
            "Optional: where people find documents in this handbook. space = in its space and the handbook; handbook_only = only in handbooks (for ordinary readers). Stored on the document, so it holds in every handbook it is in; needs the Build handbooks permission on the document's own space. Each document once, up to 200; one already set that way is left as it is.",
          items: {
            type: "object",
            properties: {
              doc_id: { type: "number" },
              find_mode: { type: "string", enum: ["space", "handbook_only"] },
            },
            required: ["doc_id", "find_mode"],
            additionalProperties: false,
          },
        },
      },
      required: ["id", "sections"],
      additionalProperties: false,
    },
  },
];

// --- Tool implementations ---------------------------------------------------------

// `ip` is the caller's address as lib/audit reads it from the request, so a
// decision taken through a token has the same audit echo (actor and address)
// as the same decision taken through PUT, v1 or the drop link.
async function callTool(user: User, name: string, args: any, origin: string, ip: string | null) {
  // Helpdesk tools (1.19.1): lib/mcp/helpdesk-tools decides and audits them.
  if (isHelpdeskTool(name)) return callHelpdeskTool(user, name, args, { origin, ip });
  // Drafts across spaces. Per-document and per-space reads below narrow this
  // to the space in hand; the writes re-check with canEditSpace either way.
  const seeDrafts = await canSeeDrafts(user);
  // The connector acts as the user, so it sees exactly the spaces they can:
  // public ones plus private ones granted via their groups (admins see all).
  const scope = await spaceScopeFor(user);

  switch (name) {
    case "list_spaces": {
      // Handbooks 1.18.0 (H6): handbook-only documents are not counted for a reader.
      const spaces = await listSpaces(scope, await findScopeFor(user));
      return toolJson(
        spaces.map((s) => ({ slug: s.slug, name: s.name, description: s.description, docs: s.doc_count }))
      );
    }

    case "list_docs": {
      // Handbooks 1.18.0 (H6): handbook-only documents stay out of a reader's listing.
      const find = await findScopeFor(user);
      let docs;
      if (args?.space) {
        const space = await getSpaceBySlug(String(args.space));
        if (!space || !scopeAllows(scope, space.id)) {
          return toolText(`No space with slug "${args.space}".`, true);
        }
        docs = await listDocumentsBySpace(space.id, await canSeeDrafts(user, space.id), find);
      } else {
        docs = await listRecentDocuments(30, seeDrafts, scope, find);
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
      // Handbooks 1.18.0 (H6): handbook-only documents stay out of a reader's results.
      const hits = await hybridSearchDocuments(String(args?.query ?? ""), 15, seeDrafts, scope, undefined, await findScopeFor(user));
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
          // Handbooks 1.18.0 (H6): handbook-only sub-pages stay out of a reader's context.
          childrenOf(doc.id, { includeDrafts: await canSeeDrafts(user, doc.space_id), find: await findScopeFor(user) }),
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
        const links = await backlinksFor(doc.id, scope, seeDrafts, await findScopeFor(user)); // Handbooks 1.18.0 (H6)
        if (links.length) {
          structure += `\n> linked from: ${links.map((b) => `${b.title} (id ${b.id})`).join("; ")}`;
        }
      }
      // Read confirmation (H2, 1.11.0): the standing, so an assistant knows
      // before it calls update_doc that a text change needs ack_policy.
      let ackLine = "";
      if (doc.ack_required === 1) {
        const ack = await ackSummary(doc.id);
        ackLine =
          `\n> read confirmation: required · ${ack.current} of ${ack.eligible} ${ack.eligible === 1 ? "person has" : "people have"} confirmed` +
          (ack.rev !== null ? ` v${ack.rev}` : "") +
          ` · a change to the body or title needs ack_policy (keep or reset) and ack_reason in update_doc`;
      }
      const header =
        `# ${doc.title}\n\n` +
        `> id: ${doc.id} · space: ${doc.space_slug} · type: ${doc.type} · status: ${doc.status}` +
        (doc.tags.length ? ` · tags: ${doc.tags.join(", ")}` : "") +
        (doc.summary ? `\n> summary: ${doc.summary}` : "") +
        ackLine +
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
        ip,
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
        // The caller's ack_policy travels with the request as the submitter's
        // recommendation (A6); the approver decides at approval. Only 'keep'
        // or 'reset' is one: a bad value is refused here as the direct path
        // refuses it, before anything is queued.
        if (args?.ack_policy != null && args.ack_policy !== "keep" && args.ack_policy !== "reset") {
          return toolJson({ ok: false, error: ACK_POLICY_ERROR });
        }
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
          ack_policy: args?.ack_policy,
          ack_reason: args?.ack_reason,
        });
        await audit({
          actor: actorFrom(user),
          action: "change_request.submit",
          targetType: "document",
          targetId: existing.id,
          targetLabel: proposed.title,
          details: { kind, via: "mcp" },
          ip,
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

      // The decision a confirmed policy needs (H2, 1.11.0), through the
      // pre-flight every write path that cannot ask shares (lib/ack-decision).
      // A change to the body or title of a published document that requires
      // read confirmation, or publish:true on such a draft whose text drifted
      // from the confirmed version (proposed.status is what the helper looks
      // at), saves nothing without ack_policy: the result carries the
      // standing and the measured change so the assistant asks the person
      // instead of guessing. A metadata-only change, a draft that stays a
      // draft and a document that does not require confirmation pass with
      // 'auto', exactly as before. The keep side's reason rule is the
      // workspace's, read once for the pre-flight and for updateDocument's
      // own check.
      const keepReasonRequired = (await getComplianceSettings()).ack_defaults.keep_reason_required;
      const { refusal, decision } = await ackDecisionRequired(
        existing,
        proposed,
        { ack_policy: args?.ack_policy, ack_reason: args?.ack_reason },
        { keepReasonRequired }
      );
      if (refusal) {
        if (refusal.status === 428) {
          const { error: _undecided, decision_required: _required, ...standing } = refusal.body;
          return toolJson({
            ok: false,
            decision_required: true,
            ...standing,
            hint: "Ask the person whether this is an editorial fix or a material change and why, then call update_doc again with ack_policy and ack_reason.",
          });
        }
        return toolJson({ ok: false, error: refusal.body.error });
      }

      let doc: Awaited<ReturnType<typeof updateDocument>>;
      try {
        doc = await updateDocument(existing.id, {
          ...proposed,
          space_id: targetSpaceId,
          author: user.name || user.username,
          // The reason is what readers see as the change note when no note came.
          versionNote: note || decision.ackReason || "Edited via Claude connector",
          ackPolicy: decision.ackPolicy,
          ackReason: decision.ackReason,
          ackKeepReasonRequired: keepReasonRequired,
          ackSource: "mcp",
          ackActor: { id: user.id, name: user.name || user.username },
          ackOrigin: origin,
        });
      } catch (e) {
        // The pre-flight already checked the reason; this is the race where
        // the document changed between the two reads.
        if (e instanceof AckReasonRequiredError) return toolJson({ ok: false, error: e.message });
        throw e;
      }

      // Nested pages: parent moves are organizational and apply directly.
      let parentNote: string | undefined;
      let parentMoved = false;
      let nextParent: number | null = null;
      if (args?.parent === null || Number.isInteger(args?.parent)) {
        if ((await getAppSettings()).nested_pages_enabled) {
          const { setParent } = await import("@/lib/doc-tree");
          nextParent = args.parent === null ? null : Number(args.parent);
          parentNote = await setParent(existing.id, nextParent);
          parentMoved = parentNote === undefined && (existing.parent_id ?? null) !== nextParent;
        } else {
          parentNote = "Nested pages are disabled in this workspace — parent unchanged.";
        }
      }

      // A save that changed nothing in the document is answered with the
      // unchanged document: no webhook, no subscriber notice, no audit row
      // claiming an edit that did not happen (A2, as the app's PUT does).
      // The parent move above is a separate record: it still applies, and
      // when it did move the page that write is audited on its own.
      if (doc?.ack_outcome?.changed === false) {
        if (parentMoved) {
          await audit({
            actor: actorFrom(user),
            action: "document.update",
            targetType: "document",
            targetId: existing.id,
            targetLabel: proposed.title,
            details: { via: "mcp", parent_id: nextParent },
            ip,
          });
        }
        return toolJson({
          ok: true,
          id: doc.id,
          status: doc.status,
          url: `/doc/${doc.id}`,
          unchanged: !parentMoved,
          note:
            parentNote ??
            (parentMoved
              ? "Moved under a different parent page; the title, text and metadata were already as given."
              : "Nothing changed: the document already had this title, text and metadata."),
        });
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
        details: {
          via: "mcp",
          ...(moving ? { moved_to: targetSpaceId } : {}),
          ...(parentMoved ? { parent_id: nextParent } : {}),
        },
        ip,
      });
      // The confirmation decision an edit of a confirmed, published document
      // took is echoed to the audit log like a PUT's (C1).
      await auditAckDecision(existing, doc, { actor: actorFrom(user), ip });
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
      // The alt is caller-controlled (the argument, else the file's own
      // name): one line of plain words, so the kept change below is exactly
      // one image line and never carries markdown of its own (imageAltText).
      const alt = imageAltText(String(args?.alt ?? "").trim() || att.filename);
      const markdown = `![${alt}](/api/attachments/${att.id})`;

      // Place it, if asked. This is the step that used to be a separate
      // update_doc and got skipped — or done as a whole-body rewrite that
      // clobbered someone else's concurrent edit.
      let placed = false;
      if (insert !== "none") {
        const fresh = await getDocument(doc.id);
        if (fresh) {
          const placedDoc = await updateDocument(doc.id, {
            content: withImagePlaced(fresh.content, markdown, insert),
            versionNote: "Added image",
            // A placed image is a text change the connector cannot ask
            // about, so it keeps confirmations (G2, 1.11.0) and is recorded
            // from source 'image': a 'kept' row on the History tab, counted
            // by the portal's drift chip, so a diagram that was the policy
            // is seen and re-asked by hand. The fixed reason stands in for
            // the editor's note, whatever Program settings asks of a person.
            ackPolicy: "keep",
            ackReason: "Added image",
            ackKeepReasonRequired: false,
            ackSource: "image",
            ackActor: { id: user.id, name: user.name || user.username },
            ackOrigin: origin,
          });
          // An image placed into a confirmed, published document is a text
          // change; its confirmation decision is echoed like a PUT's (C1).
          await auditAckDecision(fresh, placedDoc, { actor: actorFrom(user), ip });
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
        ip,
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
          ip,
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
          ip,
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

    case "list_handbooks":
    case "read_handbook":
    case "handbook_status":
    case "create_handbook":
    case "update_handbook_contents":
      return handbookTool(user, name, args, scope, ip);

    default:
      return toolText(`Unknown tool: ${name}`, true);
  }
}

// --- Policy handbooks (1.18.2) ------------------------------------------------------
//
// Every decision is lib/handbooks': who reads a handbook (getHandbook,
// getHandbookPolicy: the reader's access path, so a published handbook opens
// its policies to its audience whatever their spaces, a draft is its
// editors' alone, and an editor's view holds a placeholder for a document
// from a space they can't add from), who builds one (createHandbook's owner
// check), and what a contents change may hold (setHandbookContents,
// pendingFindModeChanges, setItemFindModes). The request parsing is the
// REST routes' own (parseHandbookInput, parseHandbookContents,
// parseIfUpdatedAt), and the audit rows are the routes' rows plus
// `via: "mcp"`. The reader's own
// standing is lib/handbook-confirm's loadConfirmView, the confirm page's.
// Nothing here confirms: a confirmation is the person's act, in the app.

/** The whole-handbook read's text budget: past it, policies are listed without their text. */
const HANDBOOK_TEXT_BUDGET = 150_000;

const STANDING_LABELS = {
  to_confirm: "To confirm",
  confirmed: "Confirmed",
  updated: "Updated since you confirmed",
  info: "For information",
} as const;

const handbookUrls = (id: number) => ({
  reader_url: `/handbooks/${id}`,
  confirm_url: `/handbooks/${id}/confirm`,
  edit_url: `/handbooks/${id}/edit`,
});

/** An ISO timestamp's date, or null. */
const isoDay = (at: string | null | undefined) => (at ? String(at).slice(0, 10) : null);

/** A refusal from lib/handbooks as a tool error; anything else is rethrown (handleRpc answers it). */
function handbookRefusal(e: unknown) {
  if (!(e instanceof hb.HandbookError)) throw e;
  if (e.message === hb.HANDBOOK_NOT_FOUND) return toolText("No handbook with that id.", true);
  if (e.message === hb.HANDBOOK_CHANGED_ELSEWHERE) {
    return toolText(
      "Someone else saved this handbook since you read it (409), so nothing was saved. Call read_handbook again for its current contents and updated_at, then try again.",
      true
    );
  }
  return toolText(e.message, true);
}

async function handbookTool(
  user: User,
  name: string,
  args: any,
  scope: Awaited<ReturnType<typeof spaceScopeFor>>,
  ip: string | null
) {
  const ctx = { via: "mcp" as const, ip };
  const id = Number(args?.id);
  const validId = Number.isSafeInteger(id) && id > 0;

  try {
    switch (name) {
      case "list_handbooks": {
        let rows = await hb.listHandbooks(user, { readableDocIds: true });
        if (args?.space !== undefined && args.space !== null && args.space !== "") {
          const want = String(args.space);
          if (want === "workspace") {
            rows = rows.filter((r) => r.space_id === null);
          } else {
            const space = await getSpaceBySlug(want);
            if (!space || !scopeAllows(scope, space.id)) return toolText(`No space with slug "${want}".`, true);
            rows = rows.filter((r) => r.space_id === space.id);
          }
        }
        if (args?.status === "draft" || args?.status === "published") rows = rows.filter((r) => r.status === args.status);

        // Your own progress, as the reader's contents show it (the reader's
        // assignment rows, every space: a handbook opens policies whose
        // space the reader can't browse), over the documents the reader view
        // of each published handbook holds for you (readable_doc_ids, from
        // the rows the list loaded: no query per handbook).
        const licensed = await licensedFor("policy_ack");
        const mine = new Map<number, string>();
        if (licensed && rows.some((r) => r.status === "published")) {
          for (const p of await listMyPolicies(user.id, EVERY_SPACE_UNFILTERED)) mine.set(p.id, p.state);
        }
        const out = [];
        for (const r of rows) {
          let yourProgress: { confirmed: number; of: number } | null = null;
          if (licensed && r.status === "published") {
            const asked = (r.readable_doc_ids ?? []).filter((d) => mine.has(d));
            if (asked.length > 0) {
              yourProgress = { confirmed: asked.filter((d) => mine.get(d) === "confirmed").length, of: asked.length };
            }
          }
          const urls = handbookUrls(r.id);
          out.push({
            id: r.id,
            title: r.title,
            owner: r.owner_label,
            owner_space: r.space_slug,
            status: r.status,
            audience: r.audience,
            policies: r.item_count,
            sections: r.section_count,
            updated_at: r.updated_at,
            confirm_whole: r.confirm_whole,
            require_signature: r.require_signature,
            can_edit: r.can_edit,
            your_progress: yourProgress,
            ...(r.progress ? { audience_progress: r.progress } : {}),
            reader_url: urls.reader_url,
            ...(r.can_edit ? { edit_url: urls.edit_url } : {}),
            ...(licensed && r.status === "published" && r.confirm_whole ? { confirm_url: urls.confirm_url } : {}),
          });
        }
        return toolJson({
          handbooks: out,
          note: licensed
            ? "Read handbooks with read_handbook and your standing with handbook_status. People confirm policies and handbooks themselves, in the app (on each policy's page, or at confirm_url); no tool confirms for them."
            : "Read confirmation isn't included in this workspace's licence, so handbooks are for reading only.",
        });
      }

      case "read_handbook": {
        if (!validId) return toolText("Pass the handbook id (from list_handbooks).", true);
        const includeText = args?.include_text !== false;

        // One policy: the reader's own access path.
        if (args?.doc_id !== undefined && args?.doc_id !== null) {
          const policy = await hb.getHandbookPolicy(user, id, Number(args.doc_id));
          if (!policy) {
            return (await hb.canRead(user, id))
              ? toolText(`No policy with id ${args.doc_id} that you can read in this handbook.`, true)
              : toolText(`No handbook with id ${id}.`, true);
          }
          return toolJson({
            handbook: { id: policy.handbook.id, title: policy.handbook.title, status: policy.handbook.status },
            section: { id: policy.section.id, number: policy.section.number, title: policy.section.title },
            policy: policyOut(id, policy.item, policy.document, includeText),
            prev: policy.prev ? { doc_id: policy.prev.doc_id, title: policy.prev.title } : null,
            next: policy.next ? { doc_id: policy.next.doc_id, title: policy.next.title } : null,
          });
        }

        // The whole handbook. Its reader view decides what may be read;
        // an editor's view adds the drafts and placeholders they keep in
        // the Contents card, never the text of either.
        const reader = await hb.getHandbook(user, id);
        if (!reader) return toolText(`No handbook with id ${id}.`, true);
        const view = reader.can_edit ? ((await hb.getHandbook(user, id, { forEdit: true })) ?? reader) : reader;
        const readable = new Set(reader.sections.flatMap((s) => s.items.map((i) => i.doc_id)));
        // The documents' text (when asked), status and next review, in one
        // query: never the text for an outline.
        const docRows = new Map(
          (await handbookDocumentRows([...readable], includeText)).map((d) => [d.id, d])
        );
        let budget = includeText ? HANDBOOK_TEXT_BUDGET : 0;
        const cut: number[] = [];
        const sections = [];
        for (const s of view.sections) {
          const policies = [];
          for (const it of s.items) {
            if (it.restricted) {
              policies.push({
                number: it.number,
                doc_id: it.doc_id,
                title: it.title,
                restricted: true,
                note: "From a space you can't add from: kept in the contents, never shown to you.",
              });
              continue;
            }
            if (!readable.has(it.doc_id)) {
              // An editor's draft document (or one their reader view leaves out): listed, no text.
              policies.push({
                ...policyOut(id, it, undefined, false),
                document_status: it.doc_status,
                note: it.doc_status === "published" ? "Not shown in the reader." : "A draft document: readers see it once it is published.",
              });
              continue;
            }
            const doc = docRows.get(it.doc_id);
            if (!doc || doc.status !== "published") continue; // getHandbookPolicy's rule
            const length = doc.content?.length ?? 0;
            let withText = includeText && budget > 0;
            if (withText && length > budget) {
              withText = false;
              budget = 0;
            }
            if (withText) budget -= length;
            else if (includeText) cut.push(it.doc_id);
            policies.push(policyOut(id, it, doc, withText));
          }
          sections.push({ id: s.id, number: s.number, title: s.title, policies });
        }
        const urls = handbookUrls(id);
        return toolJson({
          id: view.id,
          title: view.title,
          status: view.status,
          owner: view.owner_label,
          audience: view.audience,
          ...(view.can_edit ? { groups: view.groups.map((g) => g.name) } : {}),
          confirm_whole: view.confirm_whole,
          require_signature: view.require_signature,
          updated_at: view.updated_at,
          can_edit: view.can_edit,
          introduction: view.introduction,
          sections,
          reader_url: urls.reader_url,
          ...(view.can_edit ? { edit_url: urls.edit_url } : {}),
          ...(cut.length
            ? {
                truncated: true,
                note: `The text of ${cut.length} ${cut.length === 1 ? "policy was" : "policies were"} left out to keep this answer readable (doc ids ${cut.join(", ")}). Read each with read_handbook and doc_id.`,
              }
            : {}),
        });
      }

      case "handbook_status": {
        if (!validId) return toolText("Pass the handbook id (from list_handbooks).", true);
        const h = await hb.getHandbook(user, id);
        if (!h) return toolText(`No handbook with id ${id}.`, true);
        const urls = handbookUrls(id);
        const head = { id: h.id, title: h.title, status: h.status, confirm_whole: h.confirm_whole, reader_url: urls.reader_url };
        if (!(await licensedFor("policy_ack"))) {
          return toolJson({
            handbook: head,
            confirmation_available: false,
            note: "Read confirmation isn't included in this workspace's licence, so nothing in this handbook asks to be confirmed.",
          });
        }
        if (h.status !== "published") {
          return toolJson({
            handbook: head,
            confirmation_available: true,
            note: "This handbook is a draft: readers are asked to confirm it once it is published, in the app.",
          });
        }
        const view = await loadConfirmView(toSessionUser(user), id);
        if (!view) return toolText(`No handbook with id ${id}.`, true);
        const asked = view.counts.total - view.counts.info;
        return toolJson({
          handbook: head,
          confirmation_available: true,
          your_progress: {
            confirmed: view.counts.confirmed,
            of: asked,
            to_confirm: view.counts.to_confirm,
            updated: view.counts.updated,
            for_information: view.counts.info,
          },
          policies: view.items.map((i) => ({
            number: i.number,
            doc_id: i.doc_id,
            title: i.title,
            section: i.section_title,
            standing: STANDING_LABELS[i.standing],
            confirmed_at: i.confirmed_at,
            signature_required: i.standing === "to_confirm" || i.standing === "updated" ? i.signature : undefined,
            url: `/handbooks/${id}/${i.doc_id}`,
          })),
          whole_handbook: h.confirm_whole
            ? { asked: true, recorded: view.confirmed !== null, recorded_at: view.confirmed?.at ?? null, confirm_url: urls.confirm_url }
            : { asked: false },
          ...(h.progress ? { audience_progress: h.progress } : {}),
          note:
            "This tool never confirms. The person confirms in the app: " +
            (h.confirm_whole ? `all at once at ${urls.confirm_url}, or ` : "") +
            "each policy on its own page in the handbook reader.",
        });
      }

      case "create_handbook": {
        if (!(await hb.canCreateHandbooks(user))) {
          return toolText("You don't have permission to build handbooks (Build handbooks): ask an admin.", true);
        }
        // The owner: the workspace, or a space you can see by id or slug.
        let spaceId: number | null = null;
        const owner = args?.owner;
        if (owner !== undefined && owner !== null && owner !== "" && owner !== "workspace") {
          const space = /^\d+$/.test(String(owner)) ? await getSpaceById(Number(owner)) : await getSpaceBySlug(String(owner));
          if (!space || !scopeAllows(scope, space.id)) {
            return toolText(`No space "${owner}": pass "workspace" or a space id or slug from list_spaces.`, true);
          }
          spaceId = space.id;
        }
        // Groups by name or id. A number, or a string of digits, is an id
        // (so a group whose name is all digits is passed by its id); a name
        // matches case-insensitively and must name one group only.
        let groupIds: number[] | undefined;
        if (args?.groups !== undefined && args?.groups !== null) {
          if (!Array.isArray(args.groups)) return toolText(hb.HANDBOOK_GROUPS_INVALID, true);
          const all = await listGroupNames();
          groupIds = [];
          for (const g of args.groups) {
            if (typeof g !== "number" && typeof g !== "string") return toolText(hb.HANDBOOK_GROUPS_INVALID, true);
            if (typeof g === "number" || /^\d+$/.test(g.trim())) {
              const hit = all.find((x) => x.id === Number(g));
              if (!hit) return toolText(`No group with id ${g}.`, true);
              groupIds.push(hit.id);
              continue;
            }
            const key = g.trim().toLowerCase();
            const hits = all.filter((x) => x.name.trim().toLowerCase() === key);
            if (hits.length === 0) return toolText(`No group "${g}".`, true);
            if (hits.length > 1) {
              return toolText(
                `More than one group is named "${g}" (ids ${hits.map((x) => x.id).join(", ")}): pass the id of the one you mean.`,
                true
              );
            }
            groupIds.push(hits[0].id);
          }
        }
        const parsed = hb.parseHandbookInput({
          title: args?.title,
          space_id: spaceId,
          introduction: args?.introduction,
          audience: args?.audience,
          group_ids: groupIds,
          confirm_whole: args?.confirm_whole,
          require_signature: args?.require_signature,
        });
        if (!parsed.ok) return toolText(parsed.error, true);

        // The initial contents, checked in full before anything is written.
        let contents: HandbookContentsInput | null = null;
        if (args?.sections !== undefined) {
          const c = hb.parseHandbookContents({ sections: sectionsArg(args.sections) });
          if (!c.ok) return toolText(c.error, true);
          if (!(await hb.canManageOwner(user, spaceId))) return toolText(hb.HANDBOOK_OWNER_DENIED, true);
          const wanted = c.value.sections.flatMap((s) => s.doc_ids);
          const ok = new Set(await hb.addableDocumentIds(user, spaceId, wanted));
          const bad = wanted.filter((d) => !ok.has(d));
          if (bad.length) return toolText(`${hb.HANDBOOK_DOCS_INVALID} Not addable: ${bad.join(", ")}.`, true);
          contents = c.value;
        }

        let h = await hb.createHandbook(user, parsed.value, undefined, ctx);
        if (contents) {
          try {
            h = await hb.setHandbookContents(user, h.id, contents, undefined, { ctx });
          } catch (e) {
            // Checked above, so this is a race (a document unpublished or
            // moved meanwhile) or a fault: the new draft goes, audited as
            // the editor's Delete is, rather than stay behind empty.
            const why = e instanceof hb.HandbookError ? e.message : "The contents could not be saved.";
            if (!(e instanceof hb.HandbookError)) console.error(`[mcp] create_handbook: contents of handbook ${h.id} not saved:`, e);
            try {
              await hb.deleteHandbook(user, h.id, undefined, ctx);
            } catch (gone) {
              console.error(`[mcp] create_handbook: could not remove the empty draft ${h.id}:`, gone);
              return toolText(
                `${why} The handbook was created without its contents and could not be removed: delete it, or add its documents, at ${handbookUrls(h.id).edit_url}.`,
                true
              );
            }
            return toolText(`${why} Nothing was created: the new draft was removed again.`, true);
          }
        }
        const urls = handbookUrls(h.id);
        return toolJson({
          ok: true,
          id: h.id,
          title: h.title,
          status: h.status,
          owner: h.owner_label,
          audience: h.audience,
          groups: h.groups.map((g) => g.name),
          sections: h.sections.map((s) => ({ id: s.id, title: s.title, documents: s.items.map((i) => i.doc_id) })),
          updated_at: h.updated_at,
          edit_url: urls.edit_url,
          note: `Created as a draft. Nobody but its editors can see it until a person reviews and publishes it in the app, at ${urls.edit_url}; this tool never publishes.`,
        });
      }

      case "update_handbook_contents": {
        if (!validId) return toolText("Pass the handbook id (from list_handbooks).", true);
        if (!(await hb.canManage(user, id))) {
          return (await hb.canRead(user, id))
            ? toolText("You can't edit this handbook.", true)
            : toolText(`No handbook with id ${id}.`, true);
        }
        const parsed = hb.parseHandbookContents({ sections: sectionsArg(args?.sections) });
        if (!parsed.ok) return toolText(parsed.error, true);
        const token = hb.parseIfUpdatedAt({ if_updated_at: args?.if_updated_at });
        if (!token.ok) return toolText(token.error, true);

        // Where people find it: checked in full before the save, so a
        // refusal saves nothing (the editor's menu rule, setItemFindModes').
        // One entry per document (the same one twice is one; two modes for
        // one document are refused), at most a handbook's worth, and only
        // the ones that change what is stored are checked and written: one
        // permission load and one query for all of them.
        let modes: { doc_id: number; find_mode: FindMode }[] = [];
        if (args?.find_modes !== undefined && args?.find_modes !== null) {
          if (!Array.isArray(args.find_modes)) return toolText("find_modes must be a list of { doc_id, find_mode }.", true);
          if (args.find_modes.length > hb.HANDBOOK_ITEMS_MAX) return toolText(hb.HANDBOOK_FIND_MODES_RANGE, true);
          const kept = new Set(parsed.value.sections.flatMap((s) => s.doc_ids));
          const wanted = new Map<number, FindMode>();
          for (const m of args.find_modes) {
            const docId = Number(m?.doc_id);
            if (!hb.isFindMode(m?.find_mode)) return toolText(hb.HANDBOOK_FIND_MODE_INVALID, true);
            if (!kept.has(docId)) return toolText(`${hb.HANDBOOK_ITEM_NOT_FOUND} (doc_id ${m?.doc_id})`, true);
            const seen = wanted.get(docId);
            if (seen !== undefined && seen !== m.find_mode) {
              return toolText(`${hb.HANDBOOK_FIND_MODE_TWICE} (doc_id ${docId} is listed as both "space" and "handbook_only")`, true);
            }
            wanted.set(docId, m.find_mode);
          }
          modes = await hb.pendingFindModeChanges(
            user,
            [...wanted].map(([doc_id, find_mode]) => ({ doc_id, find_mode }))
          );
        }

        let h = await hb.setHandbookContents(user, id, parsed.value, undefined, { ifUpdatedAt: token.value, ctx });
        if (modes.length > 0) {
          try {
            h = await hb.setItemFindModes(user, id, modes, undefined, ctx);
          } catch (e) {
            // The contents are saved; the find modes (one statement) are not.
            const why = e instanceof hb.HandbookError ? e.message : "The find modes could not be saved.";
            if (!(e instanceof hb.HandbookError)) console.error(`[mcp] update_handbook_contents: find modes of handbook ${id} not saved:`, e);
            return toolText(
              `The contents were saved (the handbook's updated_at is now ${h.updated_at}), but where people find its documents was not changed: ${why} Send find_modes again with if_updated_at ${h.updated_at}.`,
              true
            );
          }
        }
        const urls = handbookUrls(id);
        return toolJson({
          ok: true,
          id: h.id,
          status: h.status,
          updated_at: h.updated_at,
          policies: h.item_count,
          sections: h.sections.map((s) => ({
            id: s.id,
            title: s.title,
            documents: s.items.map((i) => ({ doc_id: i.doc_id, title: i.title, find_mode: i.find_mode, ...(i.restricted ? { restricted: true } : {}) })),
          })),
          edit_url: urls.edit_url,
          note:
            h.status === "published"
              ? "Saved. This handbook is published, so the change is live for its readers now. Publishing and unpublishing stay in the app."
              : "Saved to the draft. A person publishes it in the app when it is ready.",
        });
      }
    }
    return toolText(`Unknown tool: ${name}`, true);
  } catch (e) {
    return handbookRefusal(e);
  }
}

/** The tools' { id?, title, documents } sections as the contents parser takes them ({ id?, title, doc_ids }). */
function sectionsArg(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((s) =>
    s && typeof s === "object" && !Array.isArray(s)
      ? { id: (s as any).id, title: (s as any).title, doc_ids: (s as any).documents }
      : s
  );
}

/** One policy as read_handbook answers it: the reader's facts (lib/handbooks listHandbookItemRows' rule, plus the review schedule's next review) and, when asked, its text. */
function policyOut(
  handbookId: number,
  it: HandbookItem,
  doc: { review_due_at?: string | null; content?: string } | undefined,
  withText: boolean
) {
  return {
    number: it.number,
    doc_id: it.doc_id,
    title: it.title,
    type: it.type,
    space: it.space_name,
    handbook_only: it.effective_find_mode === "handbook_only",
    facts: {
      owner: it.owner_name || null,
      approved_by: it.approver_name || null,
      version: it.version,
      effective: isoDay(it.effective_at),
      next_review: isoDay(doc?.review_due_at),
      applies_to: it.applies_to || null,
    },
    in_short: it.summary_points.filter((p) => p.trim() !== ""),
    asks_confirmation: it.ack_required === 1,
    url: `/handbooks/${handbookId}/${it.doc_id}`,
    ...(withText && doc?.content !== undefined ? { text: doc.content } : {}),
  };
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

async function handleRpc(user: User, msg: any, origin: string, ip: string | null): Promise<unknown | undefined> {
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
          "CompassDocs is this team's knowledge base. Use search_docs/read_doc to look things up, create_doc to save a drafted article as markdown, and update_doc to revise, retitle, retag, move, or publish an existing one. Call list_spaces first when creating, to pick the right space. When drafting a document of a standard kind (runbook, SOP, policy, postmortem, meeting notes, decision record), call list_templates and follow the matching template's structure, passing template to create_doc. To put an image into a document, call add_image with insert:\"append\" — pass source_url if the image has a public address, or from_attachment_id to reuse one already in the workspace; base64 data works only for small files. For a screenshot that exists only as a picture in the conversation there are no bytes you can send, so call request_upload and give the person the link it returns. Policy handbooks: list_handbooks and read_handbook to read them, handbook_status for where the person stands, create_handbook (always a draft, published by a person in the app) and update_handbook_contents (live at once on a published handbook) to build them; no tool confirms a handbook or a policy, so send the person to the confirm link instead. Helpdesk (when licensed, hd_* tools, within the person's desk role): hd_suggest_articles before hd_create_request; agents read with hd_queue / hd_read_ticket / hd_ticket_summary. Replies are drafts only: hd_draft_reply saves a draft an agent sends from the desk, and no tool sends a reply to a requester, approves or declines (hd_my_approvals gives approve_url), or publishes a workflow, request type or macro (the hd_draft_* tools save drafts). IMPORTANT: before writing or restructuring a document, call writing_guide — CompassDocs documents support rich interactive blocks well beyond plain markdown (callouts, tabs, accordions, checklists, Mermaid/PlantUML diagrams, decision trees, video/website embeds, auto-filterable tables), and good documents use them.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: [...TOOLS, ...(await helpdeskToolsFor(user))] });
    case "tools/call": {
      try {
        const result = await callTool(user, String(params?.name ?? ""), params?.arguments ?? {}, origin, ip);
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
  const ip = ipFrom(req);
  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map((m) => handleRpc(user, m, origin, ip)))).filter(
      (r) => r !== undefined
    );
    return replies.length ? json(replies) : new Response(null, { status: 202 });
  }
  const reply = await handleRpc(user, body, origin, ip);
  return reply === undefined ? new Response(null, { status: 202 }) : json(reply);
}

// The connector is request/response only — no server-push stream to offer.
export function GET() {
  return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
}
