// Helpdesk 1.19.2: Status page services per team (agent W6). Kept apart from
// lib/helpdesk/status-teams (server code) so lib/db's SCHEMA string can
// append it without importing anything. Additive and idempotent: new tables
// only, so a 1.19.1 binary on the same database ignores them. Append after
// hd_teams, the status board's status_services and hd_incidents (W1), which
// it references.
//
//   hd_team_status_services   the Status page services a team follows, with
//                             the pop-up level for each: 'degraded' (outage
//                             and degraded), 'outage' (outage only) or 'off'
//                             (top bar and queue banner, no pop-up). Goes
//                             with the team or the service.
//   hd_status_episodes        one spell of trouble per service: opened when
//                             the service turns degraded or outage, its worst
//                             state so far, closed when it is operational (or
//                             in maintenance) again, and reopened instead of
//                             a new one when trouble returns within ten
//                             minutes (a flapping feed is one spell).
//                             recovery_told: the "back" notice went out (once
//                             per episode). At most one open per service.
//   hd_status_told            the teams whose agents were told an episode
//                             reached their pop-up level (once per episode
//                             and team, whenever the team started following
//                             or raised its level); the recovery notice goes
//                             to the same teams.
//   hd_status_seen            per person and episode: when the pop-up was
//                             shown and dismissed, when the recovery note was
//                             dismissed, and until when the queue banner is
//                             hidden ("Hide for today").
//   hd_status_incident_watch  a major incident declared from a service (the
//                             service is kept only here, never in W1's
//                             hd_incidents.status_service_id): once the
//                             service has recovered, the people who can run
//                             the incident are asked (never automatically)
//                             to solve it with its linked tickets when
//                             ask_solve is set. asked_at: when the ask went
//                             out.
//   hd_status_asks            who was asked, per incident and person, and
//                             when they said "Not now". Goes with the
//                             incident or the person's account.

export const HD_STATUS_TEAMS_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_team_status_services (
  team_id integer NOT NULL REFERENCES hd_teams(id) ON DELETE CASCADE,
  service_id integer NOT NULL REFERENCES status_services(id) ON DELETE CASCADE,
  popup_level text NOT NULL DEFAULT 'degraded',
  added_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, service_id)
);
CREATE INDEX IF NOT EXISTS idx_hd_team_status_services_service ON hd_team_status_services(service_id);
CREATE TABLE IF NOT EXISTS hd_status_episodes (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  service_id integer NOT NULL REFERENCES status_services(id) ON DELETE CASCADE,
  state text NOT NULL,
  worst text NOT NULL,
  detail text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  recovery_told integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_status_episodes_open ON hd_status_episodes(service_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hd_status_episodes_ended ON hd_status_episodes(ended_at);
CREATE INDEX IF NOT EXISTS idx_hd_status_episodes_service ON hd_status_episodes(service_id, started_at);
CREATE TABLE IF NOT EXISTS hd_status_told (
  episode_id integer NOT NULL REFERENCES hd_status_episodes(id) ON DELETE CASCADE,
  team_id integer NOT NULL REFERENCES hd_teams(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (episode_id, team_id)
);
CREATE TABLE IF NOT EXISTS hd_status_seen (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  episode_id integer NOT NULL REFERENCES hd_status_episodes(id) ON DELETE CASCADE,
  shown_at timestamptz,
  dismissed_at timestamptz,
  recovery_dismissed_at timestamptz,
  banner_hidden_until timestamptz,
  PRIMARY KEY (user_id, episode_id)
);
CREATE INDEX IF NOT EXISTS idx_hd_status_seen_episode ON hd_status_seen(episode_id);
CREATE TABLE IF NOT EXISTS hd_status_incident_watch (
  incident_id integer PRIMARY KEY REFERENCES hd_incidents(id) ON DELETE CASCADE,
  service_id integer NOT NULL REFERENCES status_services(id) ON DELETE CASCADE,
  ask_solve integer NOT NULL DEFAULT 0,
  asked_at timestamptz,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hd_status_incident_watch_service ON hd_status_incident_watch(service_id);
CREATE TABLE IF NOT EXISTS hd_status_asks (
  incident_id integer NOT NULL REFERENCES hd_incidents(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_hd_status_asks_user ON hd_status_asks(user_id);
`;
