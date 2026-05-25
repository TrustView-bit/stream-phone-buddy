ALTER TABLE public.links
  ADD COLUMN IF NOT EXISTS user_stage text,
  ADD COLUMN IF NOT EXISTS user_detail text,
  ADD COLUMN IF NOT EXISTS user_heartbeat timestamptz;