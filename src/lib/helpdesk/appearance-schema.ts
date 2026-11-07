// Helpdesk 1.19.4: the desk's background artwork (lib/helpdesk/appearance;
// mock-ups t1 to t5). Dependency-free so lib/db.ts can interpolate it into
// SCHEMA_SQL. Additive and idempotent.
//
//   hd_desk_art     an uploaded artwork. owner_user_id NULL: the
//                   workspace's library (Desk settings → Appearance, any
//                   desk user may see it). Set: one agent's own upload
//                   ("My desk background"), seen only by them; at most one
//                   per person, and it goes with the account (the rows
//                   cascade; lib/helpdesk/retention deletes the files).
//                   files maps each stored width ("480", "1280", "1920",
//                   "2560") to the re-encoded WebP's stored name in the
//                   uploads volume. need_light / need_dark: how opaque the
//                   desk's scrim must be in each mode for text to keep 4.5:1
//                   on this picture (lib/helpdesk/appearance-contrast),
//                   measured once at upload. Rows never change after the
//                   insert, so a URL with the id may be cached for good.
//   hd_desk_look    one agent's own choice: the workspace artwork, their
//                   own, or none, and their transparency level ('' follows
//                   the workspace). Only read while the workspace lets
//                   agents choose. Deleting the account deletes the row.
//
// The workspace's own choice is one JSON value in settings
// (helpdesk_appearance), like the other helpdesk settings.
export const HD_APPEARANCE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS hd_desk_art (
    id serial PRIMARY KEY,
    owner_user_id integer REFERENCES users(id) ON DELETE CASCADE,
    label text NOT NULL DEFAULT '',
    files jsonb NOT NULL DEFAULT '{}'::jsonb,
    width integer NOT NULL DEFAULT 0,
    height integer NOT NULL DEFAULT 0,
    tint text NOT NULL DEFAULT '#64748b',
    need_light real NOT NULL DEFAULT 1,
    need_dark real NOT NULL DEFAULT 1,
    created_by integer REFERENCES users(id) ON DELETE SET NULL,
    created_by_name text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS hd_desk_art_owner_idx ON hd_desk_art (owner_user_id);
  CREATE TABLE IF NOT EXISTS hd_desk_look (
    user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    choice text NOT NULL DEFAULT 'workspace',
    level text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`;
