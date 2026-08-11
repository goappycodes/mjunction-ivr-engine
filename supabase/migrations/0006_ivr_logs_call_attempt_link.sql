-- =====================================================================
-- Migration 0006: link ivr_logs to the call_attempts row it belongs to
--
-- The IVR flow now writes real progress onto mjunction's own
-- `recipients` / `call_attempts` / `recipient_events` tables (a recipient's
-- `unique_id` IS the order id carried through Exotel) instead of the old
-- standalone `orders` table. Every step after the one that places the call
-- needs to recover which call_attempts row this call_sid belongs to so it
-- can finalize it later — this column is that link.
--
-- Deliberately NOT a foreign key. `call_attempts` is owned by mjunction's own
-- migrations, not this repo's — on the shared project both are already
-- applied and this is a safe reference, but a fresh `supabase db reset` run
-- from *this* repo alone only replays this repo's migrations, so a hard FK
-- here would make that reset fail outright the moment `recipients` doesn't
-- exist yet. The application code is what enforces the relationship; see
-- README for the resulting local-dev dependency on mjunction's schema.
-- =====================================================================

alter table ivr_logs add column if not exists call_attempt_id uuid;

notify pgrst, 'reload schema';
