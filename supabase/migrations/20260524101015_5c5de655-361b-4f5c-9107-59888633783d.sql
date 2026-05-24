
CREATE TABLE public.links (
  id text PRIMARY KEY,
  label text NOT NULL,
  pad_code text NOT NULL,
  camera_mode text NOT NULL DEFAULT 'dynamic',
  back_definition_id int NOT NULL DEFAULT 17,
  back_framerate_id int NOT NULL DEFAULT 6,
  back_bitrate_id int NOT NULL DEFAULT 11,
  front_definition_id int NOT NULL DEFAULT 15,
  front_framerate_id int NOT NULL DEFAULT 8,
  front_bitrate_id int NOT NULL DEFAULT 8,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Links are readable by everyone"
  ON public.links FOR SELECT
  USING (true);

INSERT INTO public.links (id, label, pad_code, camera_mode,
  back_definition_id, back_framerate_id, back_bitrate_id,
  front_definition_id, front_framerate_id, front_bitrate_id)
SELECT 'phone-a', 'Phone A',
  COALESCE(s.pad_code, 'APP63U6GYP7UDGQV'),
  COALESCE(s.camera_mode, 'dynamic'),
  COALESCE(s.back_definition_id, 17),
  COALESCE(s.back_framerate_id, 6),
  COALESCE(s.back_bitrate_id, 11),
  COALESCE(s.front_definition_id, 15),
  COALESCE(s.front_framerate_id, 8),
  COALESCE(s.front_bitrate_id, 8)
FROM (SELECT * FROM public.app_settings WHERE id = 'default') s
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.links (id, label, pad_code)
VALUES ('phone-a', 'Phone A', 'APP63U6GYP7UDGQV')
ON CONFLICT (id) DO NOTHING;
