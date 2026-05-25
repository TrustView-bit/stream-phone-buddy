CREATE POLICY "Allow anon to insert links"
ON public.links
FOR INSERT
TO anon
WITH CHECK (true);