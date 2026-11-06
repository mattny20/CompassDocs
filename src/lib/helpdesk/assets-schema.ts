// Helpdesk 1.19.3: assets on tickets (Snipe-IT first). Kept apart from
// lib/helpdesk/assets (server code) so lib/db's SCHEMA string can append it
// without importing anything. Additive and idempotent; append after hd_tickets
// (it references it).
//
//   hd_assets         the local cache of each source's assets (provider: the
//                     source's key, "snipeit"; external_id: its id there),
//                     refreshed by the sweep every 30 minutes and on demand
//                     (Sync now, a live lookup by tag, serial or a person's
//                     address, opening the asset page). assigned_email is
//                     how an asset is matched to a person (lower-cased).
//                     raw keeps a few source fields, never custom fields.
//                     missing_since: first missed by a complete sync; a row
//                     missed by two complete syncs in a row (and not found
//                     by id) is deleted, or marked gone_at when a ticket
//                     links it. Changing the source's address retires the
//                     old rows (provider "snipeit:retired:<time>", gone).
//   hd_ticket_assets  an asset linked to a ticket, by whom and when. Goes
//                     with the ticket (deleted, anonymised) and moves with a
//                     merge.
//   hd_asset_maintenance_log  the claim behind each maintenance record
//                     posted on a solve: one per (ticket, asset, solve),
//                     taken before the post (INSERT … ON CONFLICT DO
//                     NOTHING) and released when the post fails, so no
//                     process posts the same record twice.

export const HD_ASSETS_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_assets (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL,
  external_id text NOT NULL,
  tag text NOT NULL DEFAULT '',
  serial text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT '',
  status_label text NOT NULL DEFAULT '',
  status_kind text NOT NULL DEFAULT '',
  assigned_email text NOT NULL DEFAULT '',
  assigned_name text NOT NULL DEFAULT '',
  location text NOT NULL DEFAULT '',
  purchase_date date,
  warranty_end date,
  url text NOT NULL DEFAULT '',
  raw jsonb NOT NULL DEFAULT '{}',
  synced_at timestamptz NOT NULL DEFAULT now(),
  missing_since timestamptz,
  gone_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hd_assets_source ON hd_assets (provider, external_id);
CREATE INDEX IF NOT EXISTS idx_hd_assets_email ON hd_assets (assigned_email) WHERE assigned_email <> '';
CREATE INDEX IF NOT EXISTS idx_hd_assets_tag ON hd_assets (lower(tag));
CREATE INDEX IF NOT EXISTS idx_hd_assets_serial ON hd_assets (lower(serial));
CREATE TABLE IF NOT EXISTS hd_ticket_assets (
  ticket_id integer NOT NULL REFERENCES hd_tickets(id) ON DELETE CASCADE,
  asset_id integer NOT NULL REFERENCES hd_assets(id) ON DELETE CASCADE,
  linked_by integer REFERENCES users(id) ON DELETE SET NULL,
  linked_by_name text NOT NULL DEFAULT '',
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_hd_ticket_assets_asset ON hd_ticket_assets (asset_id, ticket_id);
CREATE TABLE IF NOT EXISTS hd_asset_maintenance_log (
  ticket_id integer NOT NULL REFERENCES hd_tickets(id) ON DELETE CASCADE,
  asset_id integer NOT NULL REFERENCES hd_assets(id) ON DELETE CASCADE,
  solved_at timestamptz NOT NULL,
  claimed_by integer REFERENCES users(id) ON DELETE SET NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  record_id text NOT NULL DEFAULT '',
  PRIMARY KEY (ticket_id, asset_id, solved_at)
);
`;
