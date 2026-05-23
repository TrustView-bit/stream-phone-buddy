CREATE TABLE public.app_settings (
  id TEXT PRIMARY KEY,
  pad_code TEXT,
  quality TEXT NOT NULL DEFAULT 'HD',
  consent_text TEXT
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "App settings are readable by everyone"
ON public.app_settings
FOR SELECT
USING (true);

INSERT INTO public.app_settings (id, pad_code, quality, consent_text)
VALUES (
  'default',
  'APP63U6GYP7UDGQV',
  'HD',
  'When you press Start, this app will access your webcam and stream it into a remote Android phone. Continue only if you agree.'
);