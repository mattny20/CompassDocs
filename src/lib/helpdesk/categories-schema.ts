// Helpdesk 1.20.6: managed categories and sub-categories. Kept apart from
// lib/helpdesk/categories (server code) so lib/db's SCHEMA string can append
// it without importing anything. Additive and idempotent, one ALTER per
// column; append after hd_tickets and hd_request_types (it alters both).
//
//   hd_categories              the list the desk admin keeps (Desk settings →
//                              Categories). One table for both levels:
//     parent_id                NULL = a category; else the category this
//                              sub-category belongs to. Two levels only (the
//                              server never nests deeper).
//     name                     unique within its level whatever its case
//                              (idx on parent and lower(name)).
//     position                 the order within its level.
//     archived_at              set = archived: hidden from pickers, kept on
//                              the tickets that have it.
//   hd_tickets.subcategory     the ticket's sub-category, by name, beside the
//                              1.19.0 `category` column. '' = none.
//   hd_request_types.subcategory  the sub-category a request type sets on its
//                              tickets, beside its `category`.
//
// A ticket carries its category and sub-category BY NAME, as it always has
// (hd_tickets.category): the list says which names may be set, and a rename
// or a merge rewrites the name on the tickets, request types and rules that
// carry it, in one transaction. So there is one fact, the same one a 1.20.5
// binary reads and writes: rolling back leaves every ticket's category where
// it was, and the new columns and table are simply ignored. What a 1.20.5
// binary typed in the meantime joins the list the next time 1.20.6 starts
// (lib/helpdesk/categories adoptCategories).
// The list is the workspace's configuration, not personal data.

export const HD_CATEGORIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_categories (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id integer REFERENCES hd_categories(id) ON DELETE CASCADE,
  name text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_categories_name ON hd_categories (COALESCE(parent_id, 0), lower(name));
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS subcategory text NOT NULL DEFAULT '';
ALTER TABLE hd_request_types ADD COLUMN IF NOT EXISTS subcategory text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_hd_tickets_category ON hd_tickets (lower(category)) WHERE category <> '';
`;
