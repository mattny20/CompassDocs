// Helpdesk 1.19.2: who manages checklist templates (agent W3). Plain module:
// the admin routes, app/(desk)/desk-access and the settings rail read it.
// Templates are configuration next to request types and workflows, so any
// of the three configuration capabilities opens Desk settings → Checklists.

export const CHECKLIST_MANAGE_CAPS = ["settings.manage", "request_types.manage", "workflows.manage"] as const;
