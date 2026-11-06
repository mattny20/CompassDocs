// Composable email templates (1.19.0): the two tables behind Settings →
// Notifications → Email templates. Kept in a file of its own with no
// imports so lib/db can append it to SCHEMA_SQL without an import cycle
// (lib/email-parts, which queries these tables, imports lib/db).
//
//   email_template_parts         one reusable piece of an email: a header, a
//                                body (one per event, carrying the subject),
//                                a signature or a footer. Markdown with
//                                {{tags}}. builtin_key marks the seeded ones
//                                (header:standard, body:<event>, …), which
//                                can be edited and reset but never deleted.
//                                is_default picks the header, signature and
//                                footer an event uses when its composition
//                                names none (one per kind, partial unique).
//   email_template_compositions  which parts an event's email is built from,
//                                for every recipient ('all') or for one
//                                helpdesk team ('hd_team:<id>'). A null slot
//                                inherits: a team row from the event's 'all'
//                                row, the 'all' row from the kind's default
//                                (the event's built-in body for a body).
//
// Every column default is a constant and both tables are new, so a 1.18
// binary on the same database is unaffected (it keeps reading the old
// email_tpl_<key> settings, which the seed leaves in place).
export const EMAIL_PARTS_SCHEMA = `
  --- Composable email templates 1.19.0 ------------------------------------
  CREATE TABLE IF NOT EXISTS email_template_parts (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind text NOT NULL,
    name text NOT NULL,
    event_key text,
    subject text NOT NULL DEFAULT '',
    content text NOT NULL DEFAULT '',
    builtin_key text UNIQUE,
    is_default integer NOT NULL DEFAULT 0,
    created_by integer REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_email_parts_kind ON email_template_parts(kind, event_key);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_email_parts_default ON email_template_parts(kind) WHERE is_default = 1;
  CREATE TABLE IF NOT EXISTS email_template_compositions (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_key text NOT NULL,
    scope text NOT NULL DEFAULT 'all',
    header_id integer REFERENCES email_template_parts(id) ON DELETE SET NULL,
    body_id integer REFERENCES email_template_parts(id) ON DELETE SET NULL,
    signature_id integer REFERENCES email_template_parts(id) ON DELETE SET NULL,
    footer_id integer REFERENCES email_template_parts(id) ON DELETE SET NULL,
    updated_by integer REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (event_key, scope)
  );
  --- end Composable email templates 1.19.0 --------------------------------
`;
