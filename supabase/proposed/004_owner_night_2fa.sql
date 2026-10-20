-- =====================================================================
-- 004 — Owner page, tracker night battery saver, two-step login protection
-- Run after 003 (or use RUN_003_and_004.sql, which has both).
--
--  1. Owner page (admin.html): only accounts in app_admins can open it. You are added below.
--  2. Night battery saver: per bag, the tracker sends less at night (device_poll tells it when)
--  3. Two-step login: if you turned it on, your bag data can only be read after entering the code
-- =====================================================================

-- 1. Owner page ---------------------------------------------------------------
create table if not exists public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.app_admins enable row level security;
revoke all on public.app_admins from anon, authenticated;
insert into public.app_admins (user_id)
  select id from auth.users where email = 'barzanisuhaib781@gmail.com'
  on conflict do nothing;

create or replace function public.is_app_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins where user_id = auth.uid());
$$;

create or replace function public.admin_dashboard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_app_admin() then raise exception 'admins only'; end if;
  return jsonb_build_object(
    'counts', jsonb_build_object(
      'accounts', (select count(*) from auth.users),
      'trackers', (select count(*) from public.trackers),
      'paired', (select count(*) from public.trackers where owner_id is not null),
      'locations_today', (select count(*) from public.locations where created_at > now() - interval '1 day'),
      'alerts_week', (select count(*) from public.alerts where created_at > now() - interval '7 days'),
      'phones_with_notifications', (select count(distinct user_id) from public.push_subscriptions)),
    'preorders', coalesce((select jsonb_agg(p order by p.created_at desc) from (select id, name, phone, city, note, created_at from public.preorders order by created_at desc limit 200) p), '[]'::jsonb),
    'reports', coalesce((select jsonb_agg(r order by r.at desc) from (select id, about, message, contact, at from public.misuse_reports order by at desc limit 100) r), '[]'::jsonb),
    'visits', coalesce((select jsonb_agg(v order by v.day) from (select day, page, visits from public.daily_visits where day > current_date - 30) v), '[]'::jsonb),
    'errors', coalesce((select jsonb_agg(e order by e.at desc) from (select at, page, message from public.client_errors order by at desc limit 50) e), '[]'::jsonb),
    'trackers', coalesce((select jsonb_agg(t) from (
        select tr.device_code, tr.name, tr.mode, u.email owner,
               (select max(created_at) from public.locations l where l.tracker_id = tr.id) last_seen,
               (select battery from public.locations l where l.tracker_id = tr.id order by created_at desc limit 1) battery
          from public.trackers tr left join auth.users u on u.id = tr.owner_id order by tr.device_code) t), '[]'::jsonb));
end;
$$;

-- 2. Night battery saver ----------------------------------------------------------
alter table public.trackers add column if not exists night_saver boolean not null default false;
alter table public.trackers add column if not exists night_start time not null default '23:00';
alter table public.trackers add column if not exists night_end time not null default '07:00';

create or replace function public.set_night_saver(p_tracker uuid, p_on boolean, p_start time default '23:00', p_end time default '07:00')
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.trackers where id = p_tracker and owner_id = auth.uid()) then raise exception 'not your tracker'; end if;
  update public.trackers set night_saver = coalesce(p_on, false), night_start = coalesce(p_start, '23:00'), night_end = coalesce(p_end, '07:00') where id = p_tracker;
end;
$$;

-- the tracker asks after each report: { mode, buzz, night }. night = true → send only hourly check-ins and sleep.
-- (never at night while the bag is lost or parked)
create or replace function public.device_poll(p_code text, p_secret text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_tr public.trackers;
  v_now time := (now() at time zone 'Asia/Baghdad')::time;
  v_night boolean;
begin
  select * into v_tr from public.trackers where device_code = upper(trim(p_code)) and device_secret = p_secret for update;
  if not found then raise exception 'invalid device'; end if;
  if v_tr.buzz_requested_at is not null then update public.trackers set buzz_requested_at = null where id = v_tr.id; end if;
  v_night := v_tr.night_saver and v_tr.mode = 'normal' and v_tr.parked_at is null and
    (case when v_tr.night_start <= v_tr.night_end then v_now >= v_tr.night_start and v_now < v_tr.night_end
          else v_now >= v_tr.night_start or v_now < v_tr.night_end end);
  return jsonb_build_object('mode', v_tr.mode, 'buzz', coalesce(v_tr.buzz_requested_at > now() - interval '10 minutes', false), 'night', v_night);
end;
$$;

-- 3. Two-step login protection ---------------------------------------------------------
-- If an account has two-step login (authenticator app) turned on, its bag data only opens after the code.
create or replace function public.mfa_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt()->>'aal'), 'aal1') = 'aal2'
      or not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified');
$$;
drop policy if exists "two-step login" on public.trackers;
create policy "two-step login" on public.trackers as restrictive for select to authenticated using (public.mfa_ok());
drop policy if exists "two-step login" on public.locations;
create policy "two-step login" on public.locations as restrictive for select to authenticated using (public.mfa_ok());
drop policy if exists "two-step login" on public.safe_zones;
create policy "two-step login" on public.safe_zones as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
drop policy if exists "two-step login" on public.alerts;
create policy "two-step login" on public.alerts as restrictive for select to authenticated using (public.mfa_ok());

revoke all on function public.is_app_admin(), public.admin_dashboard(), public.set_night_saver(uuid, boolean, time, time), public.mfa_ok() from public, anon, authenticated;
grant execute on function public.is_app_admin(), public.admin_dashboard(), public.set_night_saver(uuid, boolean, time, time), public.mfa_ok() to authenticated;
grant execute on function public.device_poll(text, text) to anon;
