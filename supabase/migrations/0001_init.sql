-- =====================================================================
-- Gifting Fulfilment & VOC Platform — Admin Panel (Phase 1)
-- Migration 0001: enums, tables, indexes
-- Production-shaped schema per TECH_SPEC §6 (incl. IVR language add-on).
-- =====================================================================

-- ===== Enums =====
create type user_role as enum ('admin','telecaller');

create type recipient_status as enum (
  'imported',
  'order_confirm_pending',
  'address_confirmed',
  'address_corrected',
  'order_unreachable',
  'dispatched',
  'delivered',
  'delivery_confirm_pending',
  'confirmed',
  'issue_raised',
  'delivery_unreachable',
  'closed'
);

create type call_type    as enum ('order_confirmation','delivery_confirmation');
create type caller_type  as enum ('ivr','agent');
create type call_outcome as enum (
  'confirmed','corrected','no_answer','wrong_number',
  'issue_raised','transferred_to_agent','not_reachable'
);
create type language_source as enum
  ('recipient_selected','defaulted','region_inferred','agent_set');

-- ===== Users =====
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  role        user_role not null default 'telecaller',
  created_at  timestamptz not null default now()
);

-- ===== Languages (lookup) =====
create table languages (
  code         text primary key,      -- 'hi','en','bn','mr','ta','te','kn'
  display_name text not null,
  is_active    boolean not null default true
);

-- ===== Import batches =====
-- (declared before recipients because recipients references it)
create table import_batches (
  id              uuid primary key default gen_random_uuid(),
  campaign_id     uuid,
  file_name       text,
  row_count       int,
  valid_count     int,
  error_count     int,
  duplicate_count int,
  uploaded_by     uuid references profiles(id),
  created_at      timestamptz not null default now()
);

-- ===== Campaigns =====
create table campaigns (
  id                 uuid primary key default gen_random_uuid(),
  calling_from       text not null,     -- Company/Brand ("Calling From")
  order_reference    text,
  start_date         date,
  end_date           date,
  -- language add-on config (per PRD §5.2, §8)
  default_language   text not null references languages(code) default 'hi',
  retry_limit        int  not null default 2,
  skip_menu_if_known boolean not null default false,
  language_config    jsonb not null default
      '[{"dtmf":"1","lang":"hi"},{"dtmf":"2","lang":"en"}]',
  created_by         uuid references profiles(id),
  created_at         timestamptz not null default now()
);

alter table import_batches
  add constraint import_batches_campaign_fk
  foreign key (campaign_id) references campaigns(id) on delete cascade;

-- ===== Recipients =====
create table recipients (
  id                    uuid primary key default gen_random_uuid(),
  campaign_id           uuid not null references campaigns(id) on delete cascade,
  -- mjunction import columns (Appendix C of brief)
  calling_from          text,
  telecaller_name       text,
  contact_no            text,
  contact_no_e164       text,           -- normalised (libphonenumber-js)
  customer_name         text,
  address               text,
  product_name          text,
  product_delivery_date date,           -- delivery file only
  -- pipeline
  status                recipient_status not null default 'imported',
  -- language add-on (per PRD §8)
  preferred_language    text references languages(code),
  language_source       language_source,
  -- import hygiene flags
  missing_address       boolean not null default false,
  missing_product       boolean not null default false,
  dedupe_key            text,           -- campaign_id + contact_no_e164
  import_batch_id       uuid references import_batches(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index recipients_campaign_status_idx on recipients (campaign_id, status);
create unique index recipients_campaign_phone_uidx on recipients (campaign_id, contact_no_e164)
  where contact_no_e164 is not null;

-- ===== Call attempts (mock now, real later — same shape) =====
create table call_attempts (
  id                 uuid primary key default gen_random_uuid(),
  recipient_id       uuid not null references recipients(id) on delete cascade,
  campaign_id        uuid not null references campaigns(id) on delete cascade,
  call_type          call_type not null,
  attempt_number     int not null default 1,
  provider           text not null default 'mock',   -- 'mock' | 'exotel' | ...
  caller_type        caller_type not null default 'ivr',
  agent_id           uuid references profiles(id),    -- when caller_type='agent'
  -- language add-on
  language           text references languages(code),
  language_defaulted boolean not null default false,
  dtmf_response      text,             -- '1','2','9', null
  outcome            call_outcome,
  agent_note         text,
  started_at         timestamptz,
  ended_at           timestamptz,
  created_at         timestamptz not null default now()
);
create index call_attempts_recipient_type_idx on call_attempts (recipient_id, call_type);

-- ===== Dispatch (structured for Phase-2 courier API) =====
create table dispatches (
  id             uuid primary key default gen_random_uuid(),
  recipient_id   uuid not null unique references recipients(id) on delete cascade,
  courier_name   text,
  awb_number     text,
  dispatch_date  date,
  delivered_date date,
  created_by     uuid references profiles(id),
  created_at     timestamptz not null default now()
);

-- ===== VOC vault =====
create table voc_recordings (
  id               uuid primary key default gen_random_uuid(),
  sealed_voc_id    text unique not null,            -- human-facing id for client report
  recipient_id     uuid not null references recipients(id),
  campaign_id      uuid not null references campaigns(id),
  call_attempt_id  uuid not null references call_attempts(id),
  call_type        call_type not null,
  product_name     text,
  caller_type      caller_type not null,
  language         text references languages(code),
  dtmf_outcome     text,
  storage_path     text not null,      -- private Storage object key (mock file now)
  duration_seconds int,
  created_at       timestamptz not null default now()
  -- retained indefinitely; no delete policy
);
create index voc_recordings_campaign_idx on voc_recordings (campaign_id);

-- ===== Timeline / audit (who/what/when) =====
create table recipient_events (
  id           uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references recipients(id) on delete cascade,
  event_type   text not null,        -- 'imported','call_attempt','status_change','dispatch','edit','voc_sealed'
  actor_type   text not null,        -- 'system','ivr','agent','admin'
  actor_id     uuid references profiles(id),
  payload      jsonb not null default '{}',
  created_at   timestamptz not null default now()
);
create index recipient_events_recipient_time_idx on recipient_events (recipient_id, created_at);
