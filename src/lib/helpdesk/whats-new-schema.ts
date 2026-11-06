// Helpdesk 1.19.2: "New" badges in the desk settings rail (agent W5,
// lib/helpdesk/whats-new). Dependency-free so lib/db.ts can interpolate it
// into SCHEMA_SQL. Additive and idempotent.
//
//   hd_desk_seen   what one person has seen: a page of the versioned
//                  "New" list they opened (item = its path, e.g.
//                  "/desk/settings/checklists"), or the release strip they
//                  dismissed (item = "strip:1.19.2"). A row, once there, is
//                  never changed; deleting an account deletes its rows.
export const HD_WHATS_NEW_SCHEMA = `
  CREATE TABLE IF NOT EXISTS hd_desk_seen (
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item text NOT NULL,
    seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, item)
  );
`;
