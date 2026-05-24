ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS camera_mode text NOT NULL DEFAULT 'dynamic';
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_camera_mode_check;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_camera_mode_check CHECK (camera_mode IN ('dynamic','locked_back','locked_front'));
UPDATE public.app_settings SET camera_mode = 'dynamic' WHERE id = 'default' AND camera_mode IS NULL;