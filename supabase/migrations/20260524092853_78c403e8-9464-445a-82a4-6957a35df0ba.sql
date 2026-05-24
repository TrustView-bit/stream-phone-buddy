ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS required_camera text NOT NULL DEFAULT 'back',
  ADD COLUMN IF NOT EXISTS quality_definition_id int NOT NULL DEFAULT 17,
  ADD COLUMN IF NOT EXISTS quality_framerate_id int NOT NULL DEFAULT 6,
  ADD COLUMN IF NOT EXISTS quality_bitrate_id int NOT NULL DEFAULT 11;

ALTER TABLE public.app_settings
  ADD CONSTRAINT app_settings_required_camera_check
  CHECK (required_camera IN ('back','front')) NOT VALID;

INSERT INTO public.app_settings (id, quality, required_camera, quality_definition_id, quality_framerate_id, quality_bitrate_id)
VALUES ('default', 'HD', 'back', 17, 6, 11)
ON CONFLICT (id) DO NOTHING;