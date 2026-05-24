
ALTER TABLE public.links
  ADD COLUMN IF NOT EXISTS session_status text NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS session_user_agent text,
  ADD COLUMN IF NOT EXISTS session_connected_at timestamptz,
  ADD COLUMN IF NOT EXISTS session_updated_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'links' AND policyname = 'Links session is writable by everyone'
  ) THEN
    CREATE POLICY "Links session is writable by everyone"
      ON public.links FOR UPDATE
      TO public
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

ALTER TABLE public.links REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'links'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.links';
  END IF;
END $$;
