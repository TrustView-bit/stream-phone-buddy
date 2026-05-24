ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS back_definition_id integer NOT NULL DEFAULT 17,
  ADD COLUMN IF NOT EXISTS back_framerate_id integer NOT NULL DEFAULT 6,
  ADD COLUMN IF NOT EXISTS back_bitrate_id integer NOT NULL DEFAULT 11,
  ADD COLUMN IF NOT EXISTS front_definition_id integer NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS front_framerate_id integer NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS front_bitrate_id integer NOT NULL DEFAULT 8;

UPDATE public.app_settings
SET back_definition_id = COALESCE(quality_definition_id, 17),
    back_framerate_id  = COALESCE(quality_framerate_id, 6),
    back_bitrate_id    = COALESCE(quality_bitrate_id, 11);

DROP POLICY IF EXISTS "App settings are writable by everyone" ON public.app_settings;
CREATE POLICY "App settings are writable by everyone"
  ON public.app_settings FOR UPDATE
  USING (true)
  WITH CHECK (true);
