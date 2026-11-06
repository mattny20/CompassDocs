// Helpdesk 1.19.1: saved queue views (agent V4). Kept apart from
// lib/helpdesk/saved-views (server code) so lib/db's SCHEMA string can
// append it without importing anything. Additive and idempotent. Append
// after hd_teams (it references hd_teams and users).
//
//   hd_saved_views   a named queue filter. Personal (owner_id set: only its
//                    owner sees it, under My views) or shared with a team
//                    (team_id set: the team's members see it under
//                    "<Team> views"; team leads and up change it). Exactly
//                    one of the two is set. `filters` holds the tickets
//                    API's queue parameters (lib/helpdesk/ticket-filters
//                    whitelist), as strings. `position` orders a list.

export const HD_SAVED_VIEWS_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_saved_views (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  owner_id integer REFERENCES users(id) ON DELETE CASCADE,
  team_id integer REFERENCES hd_teams(id) ON DELETE CASCADE,
  filters jsonb NOT NULL DEFAULT '{}',
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_id IS NULL) <> (team_id IS NULL))
);
CREATE INDEX IF NOT EXISTS hd_saved_views_owner ON hd_saved_views (owner_id, position) WHERE owner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hd_saved_views_team ON hd_saved_views (team_id, position) WHERE team_id IS NOT NULL;
`;
