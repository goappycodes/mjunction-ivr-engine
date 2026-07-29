-- =====================================================================
-- Migration 0002: reference data, auth wiring, Row Level Security
-- =====================================================================

-- ===== Reference data: languages =====
insert into languages (code, display_name, is_active) values
  ('hi','Hindi',   true),
  ('en','English', true),
  ('bn','Bengali', true),
  ('mr','Marathi', true),
  ('ta','Tamil',   true),
  ('te','Telugu',  true),
  ('kn','Kannada', true)
on conflict (code) do nothing;

-- =====================================================================
-- Auth wiring
-- =====================================================================

-- Auto-create a profile row for every new auth user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'telecaller')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Security-definer helpers used by RLS (read role without recursing on
-- profiles RLS). Source of truth for authorization is profiles.role.
create or replace function public.current_app_role()
returns user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- Optional: Supabase custom-access-token hook so profiles.role is mirrored
-- into the JWT (app_metadata.app_role) when enabled in Auth > Hooks.
-- RLS below does NOT depend on it (uses is_admin()), so it is safe whether
-- or not the hook is enabled in the dashboard.
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  claims   jsonb;
  app_role text;
begin
  select role::text into app_role from public.profiles where id = (event->>'user_id')::uuid;
  claims := event->'claims';
  if app_role is not null then
    claims := jsonb_set(claims, '{app_role}', to_jsonb(app_role));
  end if;
  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook to supabase_auth_admin;
grant select on table public.profiles to supabase_auth_admin;

-- =====================================================================
-- Row Level Security
-- =====================================================================
alter table profiles         enable row level security;
alter table languages        enable row level security;
alter table campaigns        enable row level security;
alter table recipients       enable row level security;
alter table import_batches   enable row level security;
alter table call_attempts    enable row level security;
alter table dispatches       enable row level security;
alter table voc_recordings   enable row level security;
alter table recipient_events enable row level security;

-- ---- profiles ----
create policy profiles_select on profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
create policy profiles_update_own on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_admin_all on profiles for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---- languages ----
create policy languages_read on languages for select to authenticated using (true);
create policy languages_admin_write on languages for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---- campaigns ----
create policy campaigns_read on campaigns for select to authenticated using (true);
create policy campaigns_admin_write on campaigns for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---- import_batches ----
create policy import_batches_read on import_batches for select to authenticated using (true);
create policy import_batches_admin_write on import_batches for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---- recipients ----
create policy recipients_read on recipients for select to authenticated using (true);
create policy recipients_admin_write on recipients for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
-- telecaller may update recipients (corrected address / agent-driven status
-- transitions); insert/delete remain admin-only.
create policy recipients_telecaller_update on recipients for update to authenticated
  using (public.current_app_role() = 'telecaller')
  with check (public.current_app_role() = 'telecaller');

-- ---- call_attempts ----
create policy call_attempts_read on call_attempts for select to authenticated using (true);
create policy call_attempts_admin_write on call_attempts for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
-- telecaller may log agent call attempts only.
create policy call_attempts_telecaller_insert on call_attempts for insert to authenticated
  with check (public.current_app_role() = 'telecaller' and caller_type = 'agent');

-- ---- dispatches ----
create policy dispatches_read on dispatches for select to authenticated using (true);
create policy dispatches_admin_write on dispatches for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---- voc_recordings ----
create policy voc_read on voc_recordings for select to authenticated using (true);
create policy voc_admin_write on voc_recordings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---- recipient_events ----
create policy events_read on recipient_events for select to authenticated using (true);
create policy events_admin_write on recipient_events for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
-- telecaller may append audit events (agent actions).
create policy events_telecaller_insert on recipient_events for insert to authenticated
  with check (public.current_app_role() = 'telecaller');
