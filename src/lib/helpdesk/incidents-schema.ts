// Helpdesk 1.19.2: major incidents (agent W1). Kept apart from
// lib/helpdesk/incidents (server code) so lib/db's SCHEMA string can append
// it without importing anything. Additive and idempotent: new tables only,
// so a 1.19.1 binary on the same database ignores them. Append after
// hd_tickets and the status board's tables (status_services,
// status_incidents), which it references.
//
//   hd_incidents           one per major incident: the parent ticket (the
//                          incident is open while that ticket is), the title
//                          people see in Get help, who declared it, the
//                          auto-link rule (match_text, '' = off), the Get
//                          help banner's audience (banner: 'workspace' |
//                          'team' | 'off'), whether linking tells the
//                          requester (notify_on_link), and the Status page
//                          service its updates are mirrored to (with the
//                          board incident they open there).
//   hd_incident_links      a ticket linked to an incident (at most one
//                          incident per ticket: ticket_id is the key), how
//                          ('declare' | 'manual' | 'rule') and by whom.
//   hd_incident_updates    each update posted to everyone affected, with how
//                          many linked tickets it reached.
//   hd_incident_affected   "Me too" in Get help: a person counted as
//                          affected without raising a ticket.

export const HD_INCIDENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_incidents (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id integer NOT NULL UNIQUE REFERENCES hd_tickets(id) ON DELETE CASCADE,
  title text NOT NULL,
  declared_by integer REFERENCES users(id) ON DELETE SET NULL,
  declared_by_name text NOT NULL DEFAULT '',
  declared_at timestamptz NOT NULL DEFAULT now(),
  match_text text NOT NULL DEFAULT '',
  banner text NOT NULL DEFAULT 'workspace',
  notify_on_link integer NOT NULL DEFAULT 1,
  status_service_id integer REFERENCES status_services(id) ON DELETE SET NULL,
  status_incident_id integer REFERENCES status_incidents(id) ON DELETE SET NULL,
  solved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hd_incident_links (
  ticket_id integer PRIMARY KEY REFERENCES hd_tickets(id) ON DELETE CASCADE,
  incident_id integer NOT NULL REFERENCES hd_incidents(id) ON DELETE CASCADE,
  via text NOT NULL DEFAULT 'manual',
  linked_by integer REFERENCES users(id) ON DELETE SET NULL,
  linked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hd_incident_links_incident ON hd_incident_links(incident_id);
CREATE TABLE IF NOT EXISTS hd_incident_updates (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id integer NOT NULL REFERENCES hd_incidents(id) ON DELETE CASCADE,
  body text NOT NULL,
  author_id integer REFERENCES users(id) ON DELETE SET NULL,
  author_name text NOT NULL DEFAULT '',
  sent_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hd_incident_updates_incident ON hd_incident_updates(incident_id, created_at);
CREATE TABLE IF NOT EXISTS hd_incident_affected (
  incident_id integer NOT NULL REFERENCES hd_incidents(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, user_id)
);
`;
