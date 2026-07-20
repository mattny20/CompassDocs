// Document templates: reusable starting points for new documents. Six
// built-ins are seeded by key on first use — admins can edit, hide, or reset
// them, and add custom templates (including "Save as template" from any
// document). Placeholders fill at creation time: {{title}}, {{date}},
// {{author}}, {{space}} substitute automatically; anything else (like
// {{owner}}) is left visible as a prompt for the writer. Server-only.

import "server-only";
import { pool } from "./db";
import type { DocType } from "./types";

async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return (await pool().query(sql, params)).rows as T[];
}

export interface DocTemplate {
  id: number;
  builtin_key: string | null;
  name: string;
  description: string;
  doc_type: DocType;
  title_pattern: string;
  summary: string;
  tags: string;
  body: string;
  hidden: number;
}

interface BuiltinDef {
  key: string;
  name: string;
  description: string;
  doc_type: DocType;
  title_pattern: string;
  summary: string;
  tags: string;
  body: string;
}

export const BUILTIN_TEMPLATES: BuiltinDef[] = [
  {
    key: "sop",
    name: "Standard operating procedure",
    description: "Step-by-step instructions with purpose, scope, and revision notes.",
    doc_type: "sop",
    title_pattern: "{{title}}",
    summary: "How to {{title}}.",
    tags: "sop",
    body: `## Purpose

What this procedure accomplishes and when to use it.

## Scope

Who this applies to: {{space}} team members performing this task.

:::info[Before you start]
List prerequisites, required access, and anything to check first.
:::

## Steps

1. First step — be specific enough that someone new can follow it.
2. Second step.
3. Third step.

## Verification

- [ ] How do you know it worked?
- [ ] What should you check before closing this out?

## Escalation

If something goes wrong, contact {{owner}} or follow the escalation playbook.

---

*Last reviewed {{date}} by {{author}}.*`,
  },
  {
    key: "runbook",
    name: "Runbook",
    description: "Operational response guide: triage flow, severity table, escalation.",
    doc_type: "technical",
    title_pattern: "Runbook — {{title}}",
    summary: "How to respond when {{title}} misbehaves.",
    tags: "runbook, on-call",
    body: `:::warning[Page first, debug second]
If customer impact is visible, page the on-call before investigating.
:::

## Symptoms

What alerts fire, and what users report.

## Triage

\`\`\`mermaid
flowchart LR
  A[Alert fires] --> B{Customer impact?}
  B -- Yes --> C[Declare incident]
  B -- No --> D[Ticket + monitor]
\`\`\`

## Severity

| Level | Impact | Response |
| --- | --- | --- |
| SEV-1 | Full outage | Page immediately |
| SEV-2 | Degraded for many | Page on-call |
| SEV-3 | Single-team impact | Business hours |

## Diagnosis

Commands, dashboards, and log queries to run — with expected output.

## Mitigation

Known fixes, rollback steps, and feature flags to flip.

## Escalation

Who to wake up when the mitigation doesn't work: {{owner}}.`,
  },
  {
    key: "policy",
    name: "Policy",
    description: "A formal policy with scope, requirements, exceptions, and enforcement.",
    doc_type: "policy",
    title_pattern: "{{title}} Policy",
    summary: "",
    tags: "policy",
    body: `## Purpose

Why this policy exists and what risk it addresses.

## Scope

Who and what this policy covers.

## Policy

The requirements themselves — numbered, specific, and testable.

1. Requirement one.
2. Requirement two.

## Exceptions

How to request an exception, who approves it, and how long it lasts.

## Enforcement

What happens when the policy isn't followed.

:::tip[Keep procedures separate]
Link the step-by-step "how" as related documents (*Procedures*) so this
policy stays stable while procedures evolve.
:::

---

*Owner: {{owner}} · Effective {{date}} · Review annually.*`,
  },
  {
    key: "meeting-notes",
    name: "Meeting notes",
    description: "Agenda, decisions, and action items with owners.",
    doc_type: "knowledge",
    title_pattern: "{{title}} — {{date}}",
    summary: "",
    tags: "meeting",
    body: `**Date:** {{date}} · **Facilitator:** {{author}} · **Attendees:** {{attendees}}

## Agenda

1. Topic one
2. Topic two

## Notes

Discussion notes go here.

## Decisions

- Decision made, and who made it.

## Action items

- [ ] Action — owner, due date
- [ ] Action — owner, due date`,
  },
  {
    key: "postmortem",
    name: "Incident postmortem",
    description: "Blameless review: timeline, impact, root cause, follow-ups.",
    doc_type: "technical",
    title_pattern: "Postmortem — {{title}}",
    summary: "",
    tags: "postmortem, incident",
    body: `:::info[Blameless]
Focus on systems and processes, not people. Assume everyone acted with the
best intent given what they knew at the time.
:::

## Summary

One paragraph: what broke, for how long, who was affected.

## Impact

| Metric | Value |
| --- | --- |
| Duration | |
| Users affected | |
| Severity | |

## Timeline

- **HH:MM** — Alert fired
- **HH:MM** — Incident declared
- **HH:MM** — Mitigated
- **HH:MM** — Resolved

## Root cause

What actually happened, as deep as you can go.

## What went well / what didn't

- Went well:
- Could improve:

## Follow-ups

- [ ] Action — owner, due date`,
  },
  {
    key: "decision-record",
    name: "Decision record",
    description: "Context, options considered, and the decision — so future readers know why.",
    doc_type: "knowledge",
    title_pattern: "Decision — {{title}}",
    summary: "",
    tags: "decision",
    body: `**Status:** Proposed · **Date:** {{date}} · **Deciders:** {{author}}

## Context

What situation forces a decision, and what constraints apply.

## Options considered

### Option A

Pros and cons.

### Option B

Pros and cons.

## Decision

What we chose and the main reason.

## Consequences

What becomes easier, what becomes harder, and what we'll revisit.`,
  },
];

let seeded = false;

/** Insert any missing built-ins (idempotent, cheap after the first call). */
export async function ensureBuiltinTemplates(): Promise<void> {
  if (seeded) return;
  for (const t of BUILTIN_TEMPLATES) {
    await q(
      `INSERT INTO doc_templates (builtin_key, name, description, doc_type, title_pattern, summary, tags, body)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (builtin_key) DO NOTHING`,
      [t.key, t.name, t.description, t.doc_type, t.title_pattern, t.summary, t.tags, t.body]
    );
  }
  seeded = true;
}

export async function listTemplates(includeHidden = false): Promise<DocTemplate[]> {
  await ensureBuiltinTemplates();
  return q<DocTemplate>(
    `SELECT * FROM doc_templates ${includeHidden ? "" : "WHERE hidden = 0"}
     ORDER BY builtin_key IS NULL, name`
  );
}

export async function getTemplate(id: number): Promise<DocTemplate | undefined> {
  await ensureBuiltinTemplates();
  return (await q<DocTemplate>("SELECT * FROM doc_templates WHERE id = $1", [id]))[0];
}

export async function getTemplateByName(name: string): Promise<DocTemplate | undefined> {
  await ensureBuiltinTemplates();
  return (
    await q<DocTemplate>(
      "SELECT * FROM doc_templates WHERE hidden = 0 AND (LOWER(name) = LOWER($1) OR builtin_key = LOWER($1)) LIMIT 1",
      [name]
    )
  )[0];
}

export async function createTemplate(input: {
  name: string;
  description: string;
  doc_type: DocType;
  title_pattern: string;
  summary: string;
  tags: string;
  body: string;
  created_by: number;
}): Promise<DocTemplate> {
  const rows = await q<DocTemplate>(
    `INSERT INTO doc_templates (name, description, doc_type, title_pattern, summary, tags, body, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [input.name, input.description, input.doc_type, input.title_pattern, input.summary, input.tags, input.body, input.created_by]
  );
  return rows[0];
}

export async function updateTemplate(
  id: number,
  patch: Partial<Pick<DocTemplate, "name" | "description" | "doc_type" | "title_pattern" | "summary" | "tags" | "body" | "hidden">>
): Promise<DocTemplate | undefined> {
  const cur = await getTemplate(id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch };
  const rows = await q<DocTemplate>(
    `UPDATE doc_templates
     SET name=$2, description=$3, doc_type=$4, title_pattern=$5, summary=$6, tags=$7, body=$8, hidden=$9, updated_at=now()
     WHERE id=$1 RETURNING *`,
    [id, next.name, next.description, next.doc_type, next.title_pattern, next.summary, next.tags, next.body, next.hidden]
  );
  return rows[0];
}

/** Custom templates only; built-ins are hidden or reset instead. */
export async function deleteTemplate(id: number): Promise<boolean> {
  const res = await pool().query(
    "DELETE FROM doc_templates WHERE id = $1 AND builtin_key IS NULL",
    [id]
  );
  return (res.rowCount ?? 0) > 0;
}

/** Restore a built-in's shipped content (keeps id and hidden state). */
export async function resetBuiltinTemplate(id: number): Promise<DocTemplate | undefined> {
  const cur = await getTemplate(id);
  if (!cur?.builtin_key) return undefined;
  const def = BUILTIN_TEMPLATES.find((t) => t.key === cur.builtin_key);
  if (!def) return undefined;
  return updateTemplate(id, {
    name: def.name,
    description: def.description,
    doc_type: def.doc_type,
    title_pattern: def.title_pattern,
    summary: def.summary,
    tags: def.tags,
    body: def.body,
  });
}

/**
 * Fill a template's automatic placeholders. {{title}}, {{date}}, {{author}},
 * and {{space}} substitute; unknown tags stay visible as writer prompts.
 * The rendered title comes from title_pattern (or the given title as-is).
 */
export function renderTemplate(
  tpl: Pick<DocTemplate, "title_pattern" | "summary" | "tags" | "body" | "doc_type">,
  ctx: { title?: string; author: string; space: string; date: string }
): { title: string; summary: string; tags: string[]; content: string; type: DocType } {
  const auto: Record<string, string> = {
    title: ctx.title ?? "",
    date: ctx.date,
    author: ctx.author,
    space: ctx.space,
  };
  const fill = (s: string) =>
    s.replace(/\{\{\s*(title|date|author|space)\s*\}\}/g, (_m, k) => auto[k] ?? "");
  // With no title yet (the UI picker), the pattern remainder ("Runbook —")
  // stays as a typing cue; leading orphaned separators are cleaned up.
  const title = fill(tpl.title_pattern || "{{title}}")
    .replace(/\s+/g, " ")
    .replace(/^[ —–-]+/, "")
    .trimEnd();
  return {
    title,
    summary: fill(tpl.summary),
    tags: tpl.tags.split(",").map((t) => t.trim()).filter(Boolean),
    content: fill(tpl.body),
    type: tpl.doc_type,
  };
}
