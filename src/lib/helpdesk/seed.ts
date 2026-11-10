// Helpdesk 1.19.0: the starter set, written only when an admin asks for it
// (the setup checklist's "Use starter set", POST
// /api/helpdesk/admin/setup/starter), never on boot. Idempotent: every row
// is keyed (team name, request type and workflow slug, SLA priority, macro
// and rule title) and an existing one is left exactly as the admin has it,
// so running it twice, or after editing, adds only what is missing.
// Server-only.

import "server-only";
import { withTx } from "./db-core";
import { ensureStarterPolicies } from "./db-sla";
import { markSetupSteps } from "./settings";
import type { HdFormField, HdWorkflowDefinition } from "./types";
import type { PoolClient } from "pg";

export interface StarterResult {
  teams: number;
  request_types: number;
  workflows: number;
  sla_policies: number;
  macros: number;
  automations: number;
}

const TEAMS = [
  { name: "IT", description: "Laptops, accounts, VPN, software", icon: "monitor" },
  { name: "HR", description: "Leave, pay, benefits, policies", icon: "heart" },
  { name: "Facilities", description: "Desks, access cards, repairs", icon: "building" },
] as const;

type TeamName = (typeof TEAMS)[number]["name"];

const LAPTOP_FORM: HdFormField[] = [
  {
    key: "item",
    label: "What do you need?",
    type: "choice",
    required: true,
    options: [
      { value: "standard", label: "Standard laptop", hint: "14-inch, 16 GB" },
      { value: "dev", label: "Developer laptop", hint: "16-inch, 32 GB" },
      { value: "monitor", label: "Monitor", hint: "27-inch" },
      { value: "other", label: "Something else", hint: "Tell us below" },
    ],
  },
  { key: "reason", label: "Why do you need it?", type: "textarea", required: true },
  { key: "needed_by", label: "When do you need it by?", type: "date" },
];

const ACCESS_FORM: HdFormField[] = [
  { key: "what", label: "What do you need access to?", type: "text", required: true, help: "The space or app, as you would find it." },
  { key: "reason", label: "Why do you need it?", type: "textarea", required: true },
];

const PROBLEM_FORM: HdFormField[] = [
  {
    key: "impact",
    label: "How much does it stop you working?",
    type: "select",
    required: true,
    options: [
      { value: "blocked", label: "I can't work" },
      { value: "slowed", label: "It slows me down" },
      { value: "minor", label: "It's a small annoyance" },
    ],
  },
];

const STARTER_FORM: HdFormField[] = [
  { key: "starter_name", label: "New starter's name", type: "text", required: true },
  { key: "start_date", label: "Start date", type: "date", required: true },
  { key: "job_title", label: "Job title", type: "text", required: true },
  { key: "manager", label: "Manager", type: "user", required: true },
  {
    key: "location",
    label: "Where will they work?",
    type: "select",
    required: true,
    options: [
      { value: "office", label: "In the office" },
      { value: "hybrid", label: "Hybrid" },
      { value: "remote", label: "Remote" },
    ],
  },
  {
    key: "laptop",
    label: "Laptop",
    type: "choice",
    required: true,
    options: [
      { value: "standard", label: "Standard laptop", hint: "14-inch, 16 GB" },
      { value: "dev", label: "Developer laptop", hint: "16-inch, 32 GB" },
    ],
  },
];

const HR_FORM: HdFormField[] = [
  {
    key: "topic",
    label: "What is it about?",
    type: "select",
    required: true,
    options: [
      { value: "leave", label: "Leave" },
      { value: "pay", label: "Pay and expenses" },
      { value: "benefits", label: "Benefits" },
      { value: "policy", label: "A policy" },
      { value: "other", label: "Something else" },
    ],
  },
];

const REPAIR_FORM: HdFormField[] = [
  { key: "location", label: "Where is it?", type: "text", required: true, help: "Floor and room, or the nearest desk number." },
];

async function upsertTeam(client: PoolClient, t: (typeof TEAMS)[number], position: number): Promise<{ id: number; added: boolean }> {
  const ins = await client.query<{ id: number }>(
    `INSERT INTO hd_teams (name, description, icon, position) VALUES ($1, $2, $3, $4)
     ON CONFLICT (name) DO NOTHING RETURNING id`,
    [t.name, t.description, t.icon, position]
  );
  if (ins.rows[0]) return { id: ins.rows[0].id, added: true };
  const row = await client.query<{ id: number }>("SELECT id FROM hd_teams WHERE name = $1", [t.name]);
  return { id: row.rows[0].id, added: false };
}

async function upsertWorkflow(
  client: PoolClient,
  slug: string,
  title: string,
  description: string,
  def: HdWorkflowDefinition
): Promise<{ id: number; added: boolean }> {
  const ins = await client.query<{ id: number }>(
    `INSERT INTO hd_workflows (slug, title, description, definition, published, version)
     VALUES ($1, $2, $3, $4::jsonb, 1, 1) ON CONFLICT (slug) DO NOTHING RETURNING id`,
    [slug, title, description, JSON.stringify(def)]
  );
  if (ins.rows[0]) return { id: ins.rows[0].id, added: true };
  const row = await client.query<{ id: number }>("SELECT id FROM hd_workflows WHERE slug = $1", [slug]);
  return { id: row.rows[0].id, added: false };
}

interface RtSeed {
  slug: string;
  title: string;
  description: string;
  icon: string;
  team: TeamName;
  category: string;
  form: HdFormField[];
  workflow_id: number | null;
  sla_priority: "low" | "normal" | "high" | "urgent";
  eta_label: string;
}

async function upsertRequestType(client: PoolClient, r: RtSeed, teamId: number, position: number): Promise<{ id: number; added: boolean }> {
  const ins = await client.query<{ id: number }>(
    `INSERT INTO hd_request_types (slug, title, description, icon, team_id, category, form, workflow_id, sla_priority, position, eta_label)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11) ON CONFLICT (slug) DO NOTHING RETURNING id`,
    [r.slug, r.title, r.description, r.icon, teamId, r.category, JSON.stringify(r.form), r.workflow_id, r.sla_priority, position, r.eta_label]
  );
  if (ins.rows[0]) return { id: ins.rows[0].id, added: true };
  const row = await client.query<{ id: number }>("SELECT id FROM hd_request_types WHERE slug = $1", [r.slug]);
  return { id: row.rows[0].id, added: false };
}

/** Write the starter set (what is missing of it) and tick the checklist's first two steps. */
export async function seedStarterSet(createdBy: number | null = null): Promise<StarterResult> {
  const result: StarterResult = { teams: 0, request_types: 0, workflows: 0, sla_policies: 0, macros: 0, automations: 0 };
  await withTx(async (client) => {
    const team: Record<TeamName, number> = { IT: 0, HR: 0, Facilities: 0 };
    for (const [i, t] of TEAMS.entries()) {
      const r = await upsertTeam(client, t, i);
      team[t.name] = r.id;
      if (r.added) result.teams++;
    }
    result.sla_policies = await ensureStarterPolicies(client);

    const wfLaptop = await upsertWorkflow(client, "new-laptop-or-device", "New laptop or device", "Manager approves, IT orders and sets it up.", {
      trigger: {},
      steps: [
        { key: "approve", kind: "approval", title: "Your manager approves", approver: { kind: "manager" }, on_decline: "close", remind_after_hours: 24 },
        { key: "setup", kind: "task", title: "Order and set up", team_id: team.IT, due: { after_hours: 72 }, description: "Order the device, set it up and arrange collection." },
        { key: "done", kind: "finish", title: "Ready to collect", csat: true },
      ],
    });
    const wfAccess = await upsertWorkflow(client, "access-to-a-space", "Access to a space or app", "The space's owner approves; read access is granted.", {
      trigger: {},
      steps: [
        { key: "approve", kind: "approval", title: "The owner approves", approver: { kind: "space_owner" }, on_decline: "close", remind_after_hours: 24 },
        { key: "done", kind: "finish", title: "Access granted", csat: false },
      ],
    });
    const wfStarter = await upsertWorkflow(client, "new-starter", "New starter", "HR approves, then IT, Facilities and HR get everything ready for day one.", {
      trigger: {},
      steps: [
        { key: "approve", kind: "approval", title: "HR approves the hire", approver: { kind: "team", team_id: team.HR }, on_decline: "close", remind_after_hours: 8 },
        {
          key: "prepare",
          kind: "parallel",
          title: "Get ready for day one",
          steps: [
            { key: "it", kind: "task", title: "Laptop and accounts", team_id: team.IT, due: { field: "start_date", offset_days: -3 }, description: "Laptop, email, accounts and VPN." },
            { key: "facilities", kind: "task", title: "Desk and access card", team_id: team.Facilities, due: { field: "start_date", offset_days: -2 }, description: "A desk and an access card." },
            { key: "hr", kind: "task", title: "Contract and payroll", team_id: team.HR, due: { field: "start_date", offset_days: -5 }, description: "Contract signed, payroll set up." },
          ],
        },
        { key: "wait", kind: "wait", title: "Until the start date", until: { field: "start_date" } },
        { key: "tell", kind: "notify", title: "Tell the requester", to: "requester", message: "Everything is ready for {{starter_name}}'s first day." },
        { key: "done", kind: "finish", title: "Solve the request", csat: true },
      ],
    });
    for (const w of [wfLaptop, wfAccess, wfStarter]) if (w.added) result.workflows++;

    const types: RtSeed[] = [
      { slug: "new-laptop-or-device", title: "New laptop or device", description: "A laptop, monitor or other equipment.", icon: "laptop", team: "IT", category: "Hardware", form: LAPTOP_FORM, workflow_id: wfLaptop.id, sla_priority: "normal", eta_label: "Usually 3 to 5 days" },
      { slug: "access-to-a-space", title: "Access to a space or app", description: "Ask for access to a private space or an app.", icon: "key-round", team: "IT", category: "Access", form: ACCESS_FORM, workflow_id: wfAccess.id, sla_priority: "normal", eta_label: "Usually within a day" },
      { slug: "report-a-problem", title: "Report a problem", description: "Something is broken or not working as it should.", icon: "bug", team: "IT", category: "Problem", form: PROBLEM_FORM, workflow_id: null, sla_priority: "normal", eta_label: "We reply within 4 working hours" },
      { slug: "new-starter", title: "New starter", description: "Everything a new colleague needs for day one.", icon: "user-plus", team: "HR", category: "Onboarding", form: STARTER_FORM, workflow_id: wfStarter.id, sla_priority: "normal", eta_label: "Start at least 2 weeks ahead" },
      { slug: "ask-hr", title: "Ask HR", description: "Leave, pay, benefits and policies.", icon: "heart", team: "HR", category: "Question", form: HR_FORM, workflow_id: null, sla_priority: "normal", eta_label: "We reply within 4 working hours" },
      { slug: "facilities-repair", title: "Facilities repair", description: "Something in the building needs fixing.", icon: "wrench", team: "Facilities", category: "Repair", form: REPAIR_FORM, workflow_id: null, sla_priority: "low", eta_label: "Usually within 2 days" },
    ];
    for (const [i, t] of types.entries()) {
      const r = await upsertRequestType(client, t, team[t.team], i);
      if (r.added) {
        result.request_types++;
        if (t.workflow_id) {
          // The workflow's trigger names its request type (only for a workflow this run created).
          await client.query(
            `UPDATE hd_workflows SET definition = jsonb_set(definition, '{trigger}', jsonb_build_object('request_type_id', $2::int))
              WHERE id = $1 AND (definition->'trigger'->>'request_type_id') IS NULL`,
            [t.workflow_id, r.id]
          );
        }
      }
    }

    const macros = [
      {
        title: "Ask for more detail",
        body: "Hi {{requester.first_name}},\n\nThanks for getting in touch. Could you tell us a little more, and send a screenshot if you can? We'll pick it up as soon as we hear back.\n\n{{agent.name}}",
        actions: { status: "pending" },
        team_id: null as number | null,
      },
      {
        title: "Solved: reply if not",
        body: "Hi {{requester.first_name}},\n\nThis should be sorted now. If it isn't, just reply and the request opens again.\n\n{{agent.name}}",
        actions: { status: "solved" },
        team_id: null as number | null,
      },
      {
        title: "Reset your password",
        body: "Hi {{requester.first_name}},\n\nYou can reset your password yourself from the sign-in page: choose \"Forgot password\" and follow the email. Let us know if the email doesn't arrive.\n\n{{agent.name}}",
        actions: { status: "pending", tags_add: ["password"] },
        team_id: team.IT as number | null,
      },
    ];
    for (const m of macros) {
      const ins = await client.query(
        `INSERT INTO hd_macros (title, body, actions, team_id, created_by)
         SELECT $1, $2, $3::jsonb, $4, $5 WHERE NOT EXISTS (SELECT 1 FROM hd_macros WHERE title = $1)
         RETURNING id`,
        [m.title, m.body, JSON.stringify(m.actions), m.team_id, createdBy]
      );
      result.macros += ins.rowCount ?? 0;
    }

    const rule = await client.query(
      `INSERT INTO hd_automations (name, event, conditions, actions, active, position)
       SELECT $1, 'ticket_created', $2::jsonb, $3::jsonb, 1, 0
        WHERE NOT EXISTS (SELECT 1 FROM hd_automations WHERE name = $1)
       RETURNING id`,
      [
        "VPN and network",
        JSON.stringify({ keywords: ["vpn", "network", "wifi", "wi-fi"] }),
        JSON.stringify({ team_id: team.IT, tags_add: ["network"] }),
      ]
    );
    result.automations += rule.rowCount ?? 0;
  });
  await markSetupSteps(["teams", "hours"], true);
  return result;
}

// --- The checklist ---------------------------------------------------------------

export interface SetupStepState {
  key: import("./types").HdSetupStep;
  done: boolean;
  /** "3 teams · 6 agents", "Using the starter targets", "" */
  summary: string;
}

/** The five setup steps (/desk/setup): done when ticked, or when the data shows it. */
export async function setupChecklist(): Promise<{ steps: SetupStepState[]; done: number; total: number; setup_complete: boolean }> {
  const { getHelpdeskSettings } = await import("./settings");
  const { hqOne } = await import("./db-core");
  // Agents are counted the one way the licence's allowance counts them
  // (everyone on Settings → Agents), not by team membership.
  const { countDeskAgents } = await import("./roles-agents");
  const [s, counts, agents] = await Promise.all([
    getHelpdeskSettings(),
    hqOne<{ teams: number; sla: number; types: number }>(
      `SELECT (SELECT count(*)::int FROM hd_teams) AS teams,
              (SELECT count(*)::int FROM hd_sla_policies) AS sla,
              (SELECT count(*)::int FROM hd_request_types WHERE active = 1) AS types`
    ),
    countDeskAgents(),
  ]);
  const c = { ...counts!, agents };
  // 1.20.2 (lib/helpdesk/mailboxes): the default address, "and N more" when several are listed; the old single address when none is.
  const boxes = await import("./mailboxes").then((m) => m.listMailboxes()).catch(() => []);
  const first = boxes.find((m) => m.is_default) ?? boxes[0];
  const emailSummary = first ? (boxes.length > 1 ? `${first.address} and ${boxes.length - 1} more` : first.address) : s.inbound_address;
  const ticked = new Set(s.setup_steps_done);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const steps: SetupStepState[] = [
    { key: "teams", done: ticked.has("teams") || c.teams > 0, summary: c.teams ? `${plural(c.teams, "team")} · ${plural(c.agents, "agent")}` : "" },
    { key: "hours", done: ticked.has("hours") || c.sla > 0, summary: c.sla ? "Using your reply targets" : "" },
    { key: "email", done: ticked.has("email") || !!s.inbound_secret, summary: emailSummary },
    { key: "forms", done: ticked.has("forms") || c.types > 0, summary: c.types ? plural(c.types, "request type") : "" },
    { key: "csat", done: ticked.has("csat"), summary: s.csat_enabled ? "Asking after every solved request" : "" },
  ];
  const done = steps.filter((x) => x.done).length;
  return { steps, done, total: steps.length, setup_complete: s.setup_complete || c.teams > 0 };
}
