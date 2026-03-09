CREATE TABLE messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel    text NOT NULL,         -- 'admin_chat', 'telegram'
  direction  text NOT NULL,         -- 'inbound', 'outbound'
  sender     text NOT NULL,         -- 'operator', agent name, or 'system'
  content    text NOT NULL,
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  task_id    uuid REFERENCES tasks(id),
  processed  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_unprocessed ON messages(channel, processed) WHERE processed = false;
CREATE INDEX idx_messages_created ON messages(created_at DESC);

-- Enable Supabase Realtime on this table
-- The supabase_realtime publication is created by the Supabase Postgres image.
-- If it doesn't exist (e.g. plain Postgres), create it first.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
