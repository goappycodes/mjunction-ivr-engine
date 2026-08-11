-- =====================================================================
-- Drop the legacy standalone `orders` table.
--
-- Superseded by commit ad0b039 ("treat recipients as orders"): every lookup
-- now goes through mjunction's own `recipients` table (see
-- _shared/orders.ts's RECIPIENT_COLUMNS/lookupOrderById), keyed by
-- `recipients.unique_id`. Nothing under supabase/functions/** references
-- `orders` anymore — confirmed via grep across the whole project. `ivr_logs`
-- (created by the same 0004 migration) stays; it's still the live
-- CallSid-keyed technical trace table.
-- =====================================================================

drop table if exists orders;

notify pgrst, 'reload schema';
