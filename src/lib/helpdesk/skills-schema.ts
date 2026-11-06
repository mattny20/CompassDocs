// Helpdesk 1.19.2: skills and languages' schema (agent W2). Kept apart from
// lib/helpdesk/skills (server code) so lib/db's SCHEMA string can append it
// without importing anything. Additive and idempotent; append after
// hd_tickets and the assignment tables (it references hd_tickets and users).
//
//   hd_skills              the workspace's skills ("Mac", "Payroll"): a name,
//                          unique ignoring case, and a list position.
//   hd_languages           the languages the workspace routes on, as ISO
//                          639-1 codes ("fr"); names come from the catalogue
//                          in lib/helpdesk/skills/shared.
//   hd_agent_skills        which agent has which skill.
//   hd_agent_languages     which agent speaks which language.
//   hd_tickets.language    the ticket's language (ISO 639-1), or NULL when
//                          unknown.
//   hd_tickets.language_source  where it came from: 'directory' (the
//                          requester's directory entry), 'detected' (the
//                          first message, detected on this server) or
//                          'agent' (set by hand). '' when unknown.

export const HD_SKILLS_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_skills (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_skills_name ON hd_skills (lower(name));
CREATE TABLE IF NOT EXISTS hd_languages (
  code text PRIMARY KEY,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hd_agent_skills (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id integer NOT NULL REFERENCES hd_skills(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, skill_id)
);
CREATE INDEX IF NOT EXISTS idx_hd_agent_skills_skill ON hd_agent_skills (skill_id);
CREATE TABLE IF NOT EXISTS hd_agent_languages (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code text NOT NULL REFERENCES hd_languages(code) ON DELETE CASCADE,
  PRIMARY KEY (user_id, code)
);
CREATE INDEX IF NOT EXISTS idx_hd_agent_languages_code ON hd_agent_languages (code);
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS language text;
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS language_source text NOT NULL DEFAULT '';
`;
