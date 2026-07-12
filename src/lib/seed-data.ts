import type { DocType } from "./types";

export interface SeedSpace {
  slug: string;
  name: string;
  description: string;
  icon: string;
  color: string;
}

export interface SeedDoc {
  space: string;
  title: string;
  type: DocType;
  status: "draft" | "published";
  author: string;
  tags: string[];
  summary: string;
  content: string;
}

export const SEED_SPACES: SeedSpace[] = [
  {
    slug: "engineering",
    name: "Engineering",
    description: "Architecture, runbooks, deployment, and on-call docs.",
    icon: "⚙️",
    color: "#3366f2",
  },
  {
    slug: "people-ops",
    name: "People Ops",
    description: "HR policies, onboarding, benefits, and time-off.",
    icon: "🌱",
    color: "#16a34a",
  },
  {
    slug: "customer-success",
    name: "Customer Success",
    description: "Playbooks, escalation paths, and support SOPs.",
    icon: "💬",
    color: "#db2777",
  },
  {
    slug: "security",
    name: "Security & Compliance",
    description: "Access control, incident response, and audit policies.",
    icon: "🔐",
    color: "#ea580c",
  },
];

export const SEED_DOCS: SeedDoc[] = [
  {
    space: "engineering",
    title: "Production Deployment SOP",
    type: "sop",
    status: "published",
    author: "Priya Menon",
    tags: ["deploy", "ci-cd", "release"],
    summary: "The canonical step-by-step process for shipping code to production safely.",
    content: `# Production Deployment SOP

This procedure describes how to deploy a change to production. Follow every step — skipping steps is the leading cause of incidents.

## Prerequisites
- Your change is merged to \`main\` and CI is green.
- You have an approved release ticket.
- You are on the on-call rotation or paired with someone who is.

## Steps
1. **Announce** the deploy in \`#deploys\` with the ticket link.
2. **Cut a release tag**: \`git tag -a vX.Y.Z -m "release notes"\` and push it.
3. **Trigger the pipeline** from the release tag. Watch the canary stage.
4. **Verify the canary**: error rate < 0.5%, p95 latency within 10% of baseline.
5. **Promote to 100%** only after the canary bakes for 10 minutes.
6. **Post-deploy checks**: run the smoke suite and confirm dashboards are green.
7. **Close the release ticket** and post the outcome in \`#deploys\`.

## Rollback
If the canary regresses, click **Rollback** in the pipeline UI. Rollbacks are always safe and never need approval. Announce the rollback and open an incident.

## Related
See the Incident Response Runbook and the On-Call Handbook.`,
  },
  {
    space: "engineering",
    title: "Incident Response Runbook",
    type: "technical",
    status: "published",
    author: "Marcus Lee",
    tags: ["incident", "on-call", "sev"],
    summary: "How to declare, run, and close out a production incident.",
    content: `# Incident Response Runbook

## Severity levels
- **SEV1** — full outage or data loss. Page everyone.
- **SEV2** — major feature broken for many users.
- **SEV3** — degraded experience or a workaround exists.

## Declaring an incident
1. Post in \`#incidents\` with \`/incident declare\`.
2. The bot assigns an **Incident Commander (IC)**.
3. The IC opens a video bridge and a shared doc.

## Roles
- **IC** — coordinates, does not fix. Owns comms.
- **Ops lead** — drives mitigation.
- **Scribe** — timestamps every action.

## Communication cadence
Post a status update every 15 minutes for SEV1/SEV2, even if the update is "still investigating."

## Closing out
- Confirm the fix and monitor for 30 minutes.
- Schedule a blameless postmortem within 48 hours.
- File follow-up tickets for every action item.`,
  },
  {
    space: "engineering",
    title: "Local Development Setup",
    type: "knowledge",
    status: "published",
    author: "Dana Whitfield",
    tags: ["onboarding", "setup", "dev-env"],
    summary: "Get a working local environment in under 30 minutes.",
    content: `# Local Development Setup

## Requirements
- Node.js 22+
- Docker Desktop
- A GitHub account with SSO enabled

## Steps
1. Clone the monorepo and run \`make bootstrap\`.
2. Copy \`.env.example\` to \`.env\` and fill in the values from the vault.
3. Start dependencies: \`docker compose up -d\`.
4. Run the app: \`npm run dev\`.
5. Seed test data: \`npm run seed\`.

## Common issues
- **Port already in use**: another service is bound to 3000. Run \`lsof -i :3000\`.
- **Migrations fail**: reset the local DB with \`make db-reset\`.

Ping \`#eng-help\` if you're stuck for more than 15 minutes.`,
  },
  {
    space: "people-ops",
    title: "Paid Time Off Policy",
    type: "policy",
    status: "published",
    author: "Aisha Rahman",
    tags: ["pto", "benefits", "time-off"],
    summary: "How PTO accrues, how to request it, and blackout guidance.",
    content: `# Paid Time Off Policy

## Accrual
Full-time employees accrue **1.67 days per month** (20 days/year). PTO begins accruing on your start date.

## Requesting time off
1. Submit a request in the HR portal at least **two weeks** in advance for anything over 3 days.
2. Your manager approves or declines within 3 business days.
3. Once approved, block your calendar and set an out-of-office.

## Carryover
You may carry over up to **5 unused days** into the next calendar year. Anything beyond that is forfeited on Jan 1.

## Sick leave
Sick leave is separate and unlimited within reason. You do not need to use PTO for illness.

## Questions
Reach out to People Ops in \`#people-help\`.`,
  },
  {
    space: "people-ops",
    title: "New Hire Onboarding Checklist",
    type: "sop",
    status: "published",
    author: "Aisha Rahman",
    tags: ["onboarding", "checklist", "hr"],
    summary: "Everything a new teammate and their manager complete in week one.",
    content: `# New Hire Onboarding Checklist

## Before day one (manager)
- [ ] Send a welcome email with the first-week schedule.
- [ ] Assign an onboarding buddy.
- [ ] File the equipment request.

## Day one (new hire)
- [ ] Sign remaining paperwork in the HR portal.
- [ ] Set up SSO, email, and 2FA.
- [ ] Join core team channels.

## Week one
- [ ] Complete security awareness training.
- [ ] Read your team's charter and top 5 docs.
- [ ] Ship a tiny "hello world" change to production.

## End of week one
- [ ] 1:1 with your manager to set 30/60/90 goals.`,
  },
  {
    space: "customer-success",
    title: "Escalation Playbook",
    type: "sop",
    status: "published",
    author: "Tom Becker",
    tags: ["support", "escalation", "playbook"],
    summary: "When and how to escalate a customer issue to engineering.",
    content: `# Escalation Playbook

## When to escalate
Escalate when **any** of these are true:
- The customer is on an Enterprise plan and blocked.
- You suspect a bug affecting more than one account.
- A security or data-privacy concern is raised.

## How to escalate
1. Capture repro steps, account ID, and impact in the ticket.
2. Tag the issue with \`needs-eng\` and set priority.
3. Post a summary in \`#cs-escalations\` and link the ticket.
4. For SEV-level customer impact, follow the Incident Response Runbook.

## Setting expectations
Tell the customer a realistic next-update time and honor it. Under-promise, over-deliver.`,
  },
  {
    space: "customer-success",
    title: "Refund Approval Policy",
    type: "policy",
    status: "draft",
    author: "Tom Becker",
    tags: ["billing", "refunds", "policy"],
    summary: "Thresholds and approvals for issuing customer refunds.",
    content: `# Refund Approval Policy

> **Status: Draft** — pending Finance sign-off.

## Thresholds
- Up to **$200** — any CS agent may approve.
- $200–$2,000 — requires a team lead approval.
- Over $2,000 — requires Finance approval.

## Process
1. Confirm the charge and reason in the billing system.
2. Apply the smallest refund that resolves the issue.
3. Log the reason code for monthly reporting.

## Non-refundable
Setup fees and usage already consumed are non-refundable unless a service credit is warranted.`,
  },
  {
    space: "security",
    title: "Access Control Policy",
    type: "policy",
    status: "published",
    author: "Nina Costa",
    tags: ["access", "least-privilege", "compliance"],
    summary: "How access is granted, reviewed, and revoked across systems.",
    content: `# Access Control Policy

## Principles
- **Least privilege** — grant the minimum access needed for the role.
- **Time-bound** — elevated access expires automatically.
- **Auditable** — every grant is logged and reviewable.

## Granting access
1. Request access through the IAM portal with a business justification.
2. The system owner approves or denies within one business day.
3. Access is provisioned automatically on approval.

## Quarterly reviews
Every quarter, system owners recertify who has access. Anyone not recertified is deprovisioned.

## Offboarding
Access is revoked within **one hour** of an employee's departure, coordinated by People Ops and Security.`,
  },
  {
    space: "security",
    title: "Data Classification Standard",
    type: "technical",
    status: "published",
    author: "Nina Costa",
    tags: ["data", "classification", "compliance"],
    summary: "The four data tiers and how each must be handled.",
    content: `# Data Classification Standard

## Tiers
| Tier | Examples | Handling |
| --- | --- | --- |
| **Public** | Marketing pages | No restrictions |
| **Internal** | Runbooks, roadmaps | Employees only |
| **Confidential** | Customer PII, contracts | Encrypted, access-logged |
| **Restricted** | Secrets, keys, health data | Vault-only, MFA required |

## Storage rules
- Confidential and Restricted data must be encrypted at rest and in transit.
- Never paste Restricted data into chat, tickets, or AI tools.

## Retention
Confidential data is retained for 7 years, then securely deleted. Restricted secrets rotate every 90 days.`,
  },
];
