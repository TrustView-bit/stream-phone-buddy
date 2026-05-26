
CREATE TABLE public.recording_links (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.recording_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rec_links_select_all" ON public.recording_links FOR SELECT USING (true);
CREATE POLICY "rec_links_insert_all" ON public.recording_links FOR INSERT WITH CHECK (true);
CREATE POLICY "rec_links_update_all" ON public.recording_links FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "rec_links_delete_all" ON public.recording_links FOR DELETE USING (true);

INSERT INTO storage.buckets (id, name, public) VALUES ('recordings', 'recordings', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "recordings_public_read" ON storage.objects FOR SELECT USING (bucket_id = 'recordings');
CREATE POLICY "recordings_public_insert" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'recordings');
CREATE POLICY "recordings_public_list" ON storage.objects FOR SELECT USING (bucket_id = 'recordings');
