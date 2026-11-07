// Helpdesk 1.20.0: Claude in the desk (lib/helpdesk/claude). Kept apart from
// the server code so lib/db's SCHEMA string can append it without importing
// anything. Additive and idempotent. Append after hd_tickets (it references
// it, and users). The settings live in the settings table (key
// "hd_claude_desk", lib/helpdesk/claude/config), never here.
//
//   hd_claude_chats     one conversation an agent had with Claude, on one
//                       ticket (ticket_id) or on none. Kept for that agent
//                       only. Goes with its ticket and with every ticket it
//                       touched (hd_claude_chat_tickets), with the agent's
//                       account, and after 90 days idle when it has no
//                       ticket (chats.pruneClaudeChats).
//                       Replay works in epochs: `epoch` and `epoch_hash` (the
//                       system prompt, tools and model the epoch's blocks
//                       were made with) say which rows are replayed as
//                       blocks. A new epoch starts with a shortened
//                       plain-text transcript of everything before it, when
//                       settings change or the history outgrows its budget
//                       (chats.loadReplay), so what is replayed is always
//                       exactly what was sent. ticket_seen_at is the open
//                       ticket's updated_at as last sent in a kept turn;
//                       busy_until marks a turn in flight (one per chat).
//   hd_claude_chat_tickets  every ticket a chat touched: the open one, those
//                       read or listed by a tool, a card's target. No FK on
//                       ticket_id, so the link outlives a hard delete and
//                       the cleanup still finds the chats. Anonymise, delete
//                       and account removal delete every linked chat and the
//                       ticket's cards (chats.purgeClaudeForTicketTx).
//   hd_claude_messages  the chat's turns in order, each with its epoch.
//                       `api` holds the content blocks exactly as sent or
//                       received (thinking blocks, tool calls and results
//                       included) and is replayed unchanged within its epoch.
//                       It is `json`, not `jsonb`: jsonb reorders keys, and a
//                       replayed turn must keep its bytes for the prompt
//                       cache and preserved thinking. Null for a row the
//                       panel shows but the model never sees again (a
//                       refusal, an error, a stopped or cut-off turn).
//                       `display` is what the panel shows: the agent's words,
//                       Claude's text, the tool activity line, source chips.
//   hd_claude_cards     what a turn handed back for the agent to act on: a
//                       reply or internal-note draft, a proposed ticket change
//                       or checklist. Nothing is written by the model: Apply
//                       calls the desk's own routes with the agent's session,
//                       and the card only records what the agent decided.
//   hd_claude_usage     one row per turn: tokens (input, output, cache read,
//                       cache write), web searches, the model that answered
//                       and an estimated cost (shared.CLAUDE_PRICES). Never
//                       any content. Written when the turn starts
//                       (stop_reason 'running', cost = a reservation, in one
//                       transaction with the limit check under an advisory
//                       lock) and updated with the real usage when it ends,
//                       stopped, failed and retried steps included. Survives
//                       the chat and the account (user_id and chat_id go
//                       null), so the month's spending stays true.

export const HD_CLAUDE_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_claude_chats (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_id integer REFERENCES hd_tickets(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  epoch integer NOT NULL DEFAULT 0,
  epoch_hash text NOT NULL DEFAULT '',
  ticket_seen_at timestamptz,
  busy_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hd_claude_chats_user ON hd_claude_chats (user_id, ticket_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_hd_claude_chats_ticket ON hd_claude_chats (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hd_claude_chats_idle ON hd_claude_chats (updated_at) WHERE ticket_id IS NULL;
CREATE TABLE IF NOT EXISTS hd_claude_chat_tickets (
  chat_id integer NOT NULL REFERENCES hd_claude_chats(id) ON DELETE CASCADE,
  ticket_id integer NOT NULL,
  PRIMARY KEY (chat_id, ticket_id)
);
CREATE INDEX IF NOT EXISTS idx_hd_claude_chat_tickets_ticket ON hd_claude_chat_tickets (ticket_id);
CREATE TABLE IF NOT EXISTS hd_claude_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id integer NOT NULL REFERENCES hd_claude_chats(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  epoch integer NOT NULL DEFAULT 0,
  api json,
  display jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hd_claude_messages_chat ON hd_claude_messages (chat_id, id);
CREATE TABLE IF NOT EXISTS hd_claude_cards (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id integer NOT NULL REFERENCES hd_claude_chats(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_id integer REFERENCES hd_tickets(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('reply', 'note', 'change', 'checklist')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'offered' CHECK (state IN ('offered', 'applied', 'skipped')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_hd_claude_cards_chat ON hd_claude_cards (chat_id, id);
CREATE INDEX IF NOT EXISTS idx_hd_claude_cards_ticket ON hd_claude_cards (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hd_claude_cards_user ON hd_claude_cards (user_id, created_at);
CREATE TABLE IF NOT EXISTS hd_claude_usage (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  chat_id integer REFERENCES hd_claude_chats(id) ON DELETE SET NULL,
  ticket_number integer,
  model text NOT NULL DEFAULT '',
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cache_read_tokens integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,
  web_searches integer NOT NULL DEFAULT 0,
  requests integer NOT NULL DEFAULT 0,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  stop_reason text NOT NULL DEFAULT '',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hd_claude_usage_at ON hd_claude_usage (at);
CREATE INDEX IF NOT EXISTS idx_hd_claude_usage_user ON hd_claude_usage (user_id, at) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hd_claude_usage_chat ON hd_claude_usage (chat_id) WHERE chat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hd_claude_usage_running ON hd_claude_usage (user_id) WHERE stop_reason = 'running';
`;
