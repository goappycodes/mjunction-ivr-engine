-- =====================================================================
-- Full request/response payload log for every IVR edge function call —
-- both inbound (Exotel/mjunction hitting one of our functions) and outbound
-- (this project calling Exotel's Calls/connect or Call Details API).
--
-- `ivr_logs`/`ivr_call_events` already trace the *call flow* (per-step
-- status, digit pressed) but deliberately don't carry the raw request
-- payload. This table is the complement: every request this project sends
-- or receives, with its full body, for diagnosing a misbehaving Exotel
-- integration without needing to reproduce the call by hand.
--
-- Written from `_shared/logging.ts` (`logEvent`, called by every function
-- already) and from the two outbound Exotel call sites
-- (`ivr-engine/exotel.ts`, `_shared/exotel.ts`). Service-role only, same as
-- every other IVR-internal table — mjunction has no reason to read this.
-- =====================================================================

create table if not exists ivr_request_log (
  id          uuid primary key default gen_random_uuid(),
  fn          text not null,               -- emitting function, e.g. "ivr-engine"
  direction   text not null check (direction in ('inbound', 'outbound')),
  event       text,                        -- short machine-filterable code, e.g. "call_initiated"
  level       text,                        -- "success" | "warning" | "error"
  method      text,
  url         text,
  status      int,                         -- HTTP status of the request/response
  call_sid    text,
  order_id    text,
  message     text,
  payload     jsonb,                       -- full request/response body
  error       text,
  duration_ms int,
  created_at  timestamptz not null default now()
);

create index if not exists ivr_request_log_call_sid_idx
  on ivr_request_log (call_sid);
create index if not exists ivr_request_log_created_at_idx
  on ivr_request_log (created_at desc);

notify pgrst, 'reload schema';
