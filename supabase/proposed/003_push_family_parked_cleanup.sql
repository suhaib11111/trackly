-- =====================================================================
-- 003 — Phone notifications, family members, movement alarm, unpair,
--       automatic clean-up, error log + visit counter, misuse reports
-- Run once in Supabase → SQL Editor (project bag-tracker), after 002.
--
--  1. push_subscriptions: which phones get notifications (per account)
--  2. Every new alert calls the "send-alerts" Edge Function (pg_net) → phone notification
--  3. Family: share a bag permanently with family accounts (invite code), owner sees who has access
--  4. Movement alarm: "Park" a bag; if it moves 60 m+ you get an alert
--  5. Unpair: remove a tracker from your account (and its history), so it can be given to someone else
--  6. Clean-up every night: old locations (90 days), old alerts, expired links, old logs
--  7. Error log + daily visit counter (no personal data) + misuse reports
-- =====================================================================

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Who may see a tracker: its owner or a family member (used by the rules below).
-- security definer so the table rules don't loop into each other.
create table if not exists public.tracker_members (
  tracker_id uuid not null references public.trackers(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (tracker_id, user_id)
);
alter table public.tracker_members enable row level security;   -- read through functions only
revoke all on public.tracker_members from anon, authenticated;

create or replace function public.can_see_tracker(p_tracker uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.trackers t where t.id = p_tracker and t.owner_id = auth.uid())
      or exists (select 1 from public.tracker_members m where m.tracker_id = p_tracker and m.user_id = auth.uid());
$$;

-- family members can see the bag, its locations, zones and alerts
drop policy if exists "owners read their trackers" on public.trackers;
drop policy if exists "owners and family read trackers" on public.trackers;
create policy "owners and family read trackers" on public.trackers for select to authenticated using (public.can_see_tracker(id));
drop policy if exists "owners read their locations" on public.locations;
drop policy if exists "owners and family read locations" on public.locations;
create policy "owners and family read locations" on public.locations for select to authenticated using (public.can_see_tracker(tracker_id));
drop policy if exists "family read zones" on public.safe_zones;
create policy "family read zones" on public.safe_zones for select to authenticated using (public.can_see_tracker(tracker_id));
drop policy if exists "owners read their alerts" on public.alerts;
drop policy if exists "owners and family read alerts" on public.alerts;
create policy "owners and family read alerts" on public.alerts for select to authenticated using (public.can_see_tracker(tracker_id));

-- 1. Phone notifications ---------------------------------------------------
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  sub jsonb not null,
  lang text not null default 'en' check (lang in ('en', 'ckb', 'ar')),
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;

-- the notification keys (VAPID). The send-alerts function creates them on first use; only the server can read them.
create table if not exists public.app_keys (
  key text primary key,
  value text not null
);
alter table public.app_keys enable row level security;
revoke all on public.app_keys from anon, authenticated;

create or replace function public.save_push_subscription(p_sub jsonb, p_lang text default 'en')
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_logged_in'; end if;
  if jsonb_typeof(p_sub) <> 'object' or coalesce(p_sub->>'endpoint', '') !~ '^https://' then raise exception 'bad subscription'; end if;
  insert into public.push_subscriptions (endpoint, user_id, sub, lang)
  values (p_sub->>'endpoint', auth.uid(), p_sub, case when p_lang in ('en', 'ckb', 'ar') then p_lang else 'en' end)
  on conflict (endpoint) do update set user_id = excluded.user_id, sub = excluded.sub, lang = excluded.lang;
  -- keep at most 5 phones per account
  delete from public.push_subscriptions where user_id = auth.uid() and endpoint not in
    (select endpoint from public.push_subscriptions where user_id = auth.uid() order by created_at desc limit 5);
end;
$$;
create or replace function public.delete_push_subscription(p_endpoint text)
returns void language sql security definer set search_path = '' as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
$$;

-- 2. Every new alert → the send-alerts Edge Function sends the phone notifications
create or replace function public.alert_push() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform net.http_post(
    url := 'https://lcrvuijwpvhphbuwxtny.supabase.co/functions/v1/send-alerts',
    body := '{}'::jsonb,
    headers := '{"Content-Type": "application/json"}'::jsonb);
  return new;
exception when others then
  return new;   -- never block saving the alert
end;
$$;
drop trigger if exists alerts_push on public.alerts;
create trigger alerts_push after insert on public.alerts for each row execute function public.alert_push();

-- 4. Movement alarm ("Park") ---------------------------------------------------
alter table public.trackers add column if not exists parked_at timestamptz;
alter table public.trackers add column if not exists parked_lat double precision;
alter table public.trackers add column if not exists parked_lng double precision;
alter table public.trackers add column if not exists parked_alerted boolean not null default false;
alter table public.alerts drop constraint if exists alerts_kind_check;
alter table public.alerts add constraint alerts_kind_check check (kind in ('zone_left', 'zone_arrived', 'battery_low', 'battery_critical', 'moved'));

create or replace function public.set_parked(p_tracker uuid, p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_loc public.locations;
begin
  if not public.can_see_tracker(p_tracker) then raise exception 'not your tracker'; end if;
  if p_on then
    select * into v_loc from public.locations where tracker_id = p_tracker order by created_at desc limit 1;
    if not found then raise exception 'no location yet'; end if;
    update public.trackers set parked_at = now(), parked_lat = v_loc.lat, parked_lng = v_loc.lng, parked_alerted = false where id = p_tracker;
    return jsonb_build_object('parked_at', now(), 'lat', v_loc.lat, 'lng', v_loc.lng);
  end if;
  update public.trackers set parked_at = null, parked_lat = null, parked_lng = null, parked_alerted = false where id = p_tracker;
  return null;
end;
$$;

-- the location trigger from 002, plus the movement alarm
create or replace function public.location_alerts() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_prev public.locations;
  v_tr public.trackers;
  z public.safe_zones;
  was boolean;
  now_in boolean;
begin
  select * into v_tr from public.trackers where id = new.tracker_id;
  if v_tr.owner_id is null then return new; end if;

  if v_tr.parked_at is not null and not v_tr.parked_alerted
     and public.dist_m(new.lat, new.lng, v_tr.parked_lat, v_tr.parked_lng) > 60 then
    insert into public.alerts (tracker_id, owner_id, kind) values (new.tracker_id, v_tr.owner_id, 'moved');
    update public.trackers set parked_alerted = true where id = new.tracker_id;
  end if;

  select * into v_prev from public.locations
   where tracker_id = new.tracker_id and id <> new.id and created_at <= new.created_at
   order by created_at desc, id desc limit 1;
  if not found then return new; end if;

  for z in select * from public.safe_zones where tracker_id = new.tracker_id and enabled loop
    was := public.dist_m(v_prev.lat, v_prev.lng, z.lat, z.lng) <= z.radius_m;
    now_in := public.dist_m(new.lat, new.lng, z.lat, z.lng) <= z.radius_m;
    if was and not now_in and z.notify_on in ('leave', 'both') then
      insert into public.alerts (tracker_id, owner_id, kind, zone_name) values (new.tracker_id, v_tr.owner_id, 'zone_left', z.name);
    elsif not was and now_in and z.notify_on in ('arrive', 'both') then
      insert into public.alerts (tracker_id, owner_id, kind, zone_name) values (new.tracker_id, v_tr.owner_id, 'zone_arrived', z.name);
    end if;
  end loop;

  if v_prev.battery > 20 and new.battery <= 20 then
    insert into public.alerts (tracker_id, owner_id, kind, battery) values (new.tracker_id, v_tr.owner_id, 'battery_low', new.battery);
  end if;
  if v_prev.battery > 5 and new.battery <= 5 then
    insert into public.alerts (tracker_id, owner_id, kind, battery) values (new.tracker_id, v_tr.owner_id, 'battery_critical', new.battery);
  end if;
  return new;
end;
$$;

-- family can also use lost mode and the beep
create or replace function public.set_tracker_mode(p_tracker uuid, p_mode text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_mode not in ('normal', 'lost') then raise exception 'bad mode'; end if;
  if not public.can_see_tracker(p_tracker) then raise exception 'not your tracker'; end if;
  update public.trackers set mode = p_mode where id = p_tracker;
end;
$$;
create or replace function public.request_buzz(p_tracker uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.can_see_tracker(p_tracker) then raise exception 'not your tracker'; end if;
  update public.trackers set buzz_requested_at = now() where id = p_tracker;
end;
$$;

-- 3. Family invites ------------------------------------------------------------
create table if not exists public.member_invites (
  code text primary key,
  tracker_id uuid not null references public.trackers(id) on delete cascade,
  created_by uuid not null,
  expires_at timestamptz not null,
  used_by uuid
);
alter table public.member_invites enable row level security;
revoke all on public.member_invites from anon, authenticated;

create or replace function public.create_member_invite(p_tracker uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_code text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
begin
  if not exists (select 1 from public.trackers where id = p_tracker and owner_id = auth.uid()) then raise exception 'not your tracker'; end if;
  if (select count(*) from public.tracker_members where tracker_id = p_tracker) >= 10 then raise exception 'too many members'; end if;
  insert into public.member_invites (code, tracker_id, created_by, expires_at) values (v_code, p_tracker, auth.uid(), now() + interval '2 days');
  return v_code;
end;
$$;

create or replace function public.join_tracker(p_code text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_inv public.member_invites;
begin
  if auth.uid() is null then raise exception 'not_logged_in'; end if;
  if (select count(*) from public.claim_attempts where user_id = auth.uid() and at > now() - interval '15 minutes') >= 10 then raise exception 'too_many_attempts'; end if;
  select * into v_inv from public.member_invites where code = upper(trim(p_code)) and used_by is null and expires_at > now() for update;
  if not found then insert into public.claim_attempts (user_id) values (auth.uid()); return null; end if;
  if exists (select 1 from public.trackers where id = v_inv.tracker_id and owner_id = auth.uid()) then return v_inv.tracker_id; end if;
  insert into public.tracker_members (tracker_id, user_id) values (v_inv.tracker_id, auth.uid()) on conflict do nothing;
  update public.member_invites set used_by = auth.uid() where code = v_inv.code;
  return v_inv.tracker_id;
end;
$$;

-- who can see this bag (owner sees everyone; family sees the owner and each other)
create or replace function public.list_members(p_tracker uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when public.can_see_tracker(p_tracker) then coalesce((
    select jsonb_agg(jsonb_build_object('user_id', u.id, 'email', u.email, 'owner', u.id = t.owner_id, 'me', u.id = auth.uid()) order by u.id <> t.owner_id, u.email)
      from public.trackers t join auth.users u on u.id = t.owner_id or u.id in (select m.user_id from public.tracker_members m where m.tracker_id = t.id)
     where t.id = p_tracker), '[]'::jsonb) end;
$$;

-- the owner removes someone, or a family member leaves
create or replace function public.remove_member(p_tracker uuid, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not (p_user = auth.uid() or exists (select 1 from public.trackers where id = p_tracker and owner_id = auth.uid())) then raise exception 'not allowed'; end if;
  delete from public.tracker_members where tracker_id = p_tracker and user_id = p_user;
end;
$$;

-- 5. Unpair: the tracker is free again, with no history, zones, links or family left behind
create or replace function public.unpair_tracker(p_tracker uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.trackers where id = p_tracker and owner_id = auth.uid()) then raise exception 'not your tracker'; end if;
  delete from public.tracker_members where tracker_id = p_tracker;
  delete from public.member_invites where tracker_id = p_tracker;
  delete from public.share_links where tracker_id = p_tracker;
  delete from public.safe_zones where tracker_id = p_tracker;
  delete from public.alerts where tracker_id = p_tracker;
  delete from public.locations where tracker_id = p_tracker;
  update public.trackers set owner_id = null, name = null, color = null, mode = 'normal', buzz_requested_at = null,
         parked_at = null, parked_lat = null, parked_lng = null, parked_alerted = false
   where id = p_tracker;
end;
$$;

-- 7. Error log, visit counter, misuse reports -----------------------------------------
create table if not exists public.client_errors (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid,
  page text,
  message text
);
alter table public.client_errors enable row level security;
revoke all on public.client_errors from anon, authenticated;
create or replace function public.log_client_error(p_message text, p_page text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.client_errors where at > now() - interval '1 minute') >= 60 then return; end if;  -- flood guard
  insert into public.client_errors (user_id, page, message) values (auth.uid(), left(p_page, 100), left(p_message, 500));
end;
$$;

create table if not exists public.daily_visits (
  day date not null default current_date,
  page text not null check (page in ('app', 'share', 'landing')),
  visits integer not null default 0,
  primary key (day, page)
);
alter table public.daily_visits enable row level security;
revoke all on public.daily_visits from anon, authenticated;
create or replace function public.count_visit(p_page text)
returns void language sql security definer set search_path = '' as $$
  insert into public.daily_visits (page, visits) select p_page, 1 where p_page in ('app', 'share', 'landing')
  on conflict (day, page) do update set visits = public.daily_visits.visits + 1;
$$;

create table if not exists public.misuse_reports (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  about text check (length(about) <= 120),
  message text not null check (length(message) between 5 and 1000),
  contact text check (length(contact) <= 120)
);
alter table public.misuse_reports enable row level security;
revoke all on public.misuse_reports from anon, authenticated;
create or replace function public.submit_misuse_report(p_about text, p_message text, p_contact text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.misuse_reports where at > now() - interval '1 hour') >= 50 then raise exception 'busy'; end if;
  insert into public.misuse_reports (about, message, contact) values (left(nullif(trim(p_about), ''), 120), left(trim(p_message), 1000), left(nullif(trim(p_contact), ''), 120));
end;
$$;

-- 6. Clean-up every night at 03:00 (UTC) -------------------------------------------
create or replace function public.nightly_cleanup() returns void
language sql security definer set search_path = '' as $$
  delete from public.locations where created_at < now() - interval '90 days';
  delete from public.alerts where created_at < now() - interval '90 days';
  delete from public.claim_attempts where at < now() - interval '1 day';
  delete from public.share_links where expires_at < now() - interval '1 day';
  delete from public.member_invites where expires_at < now() - interval '1 day';
  delete from public.client_errors where at < now() - interval '30 days';
$$;
select cron.unschedule(jobid) from cron.job where jobname in ('trackly-nightly-cleanup', 'trackly-send-alerts');
select cron.schedule('trackly-nightly-cleanup', '0 3 * * *', 'select public.nightly_cleanup()');
-- backup: try sending notifications every 5 minutes too (in case a call was missed)
select cron.schedule('trackly-send-alerts', '*/5 * * * *',
  $c$select net.http_post(url := 'https://lcrvuijwpvhphbuwxtny.supabase.co/functions/v1/send-alerts', body := '{}'::jsonb, headers := '{"Content-Type": "application/json"}'::jsonb)$c$);

-- Who may call what ----------------------------------------------------------
revoke all on function public.can_see_tracker(uuid), public.save_push_subscription(jsonb, text), public.delete_push_subscription(text),
  public.alert_push(), public.set_parked(uuid, boolean), public.create_member_invite(uuid), public.join_tracker(text),
  public.list_members(uuid), public.remove_member(uuid, uuid), public.unpair_tracker(uuid), public.log_client_error(text, text),
  public.count_visit(text), public.submit_misuse_report(text, text, text), public.nightly_cleanup(),
  public.set_tracker_mode(uuid, text), public.request_buzz(uuid) from public, anon, authenticated;
grant execute on function public.can_see_tracker(uuid), public.save_push_subscription(jsonb, text), public.delete_push_subscription(text),
  public.set_parked(uuid, boolean), public.create_member_invite(uuid), public.join_tracker(text), public.list_members(uuid),
  public.remove_member(uuid, uuid), public.unpair_tracker(uuid), public.set_tracker_mode(uuid, text), public.request_buzz(uuid) to authenticated;
grant execute on function public.log_client_error(text, text), public.count_visit(text), public.submit_misuse_report(text, text, text) to anon, authenticated;
