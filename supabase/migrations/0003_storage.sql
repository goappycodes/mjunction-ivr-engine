-- =====================================================================
-- Migration 0003: private VOC storage bucket
-- Recordings live in a private bucket. Access is via short-lived signed
-- URLs generated server-side (service role). No public policies needed;
-- signed URLs bypass object RLS. Uploads happen via the service-role
-- client in Server Actions / seed. Retained indefinitely (no delete policy).
-- =====================================================================

insert into storage.buckets (id, name, public)
values ('voc', 'voc', false)
on conflict (id) do nothing;
