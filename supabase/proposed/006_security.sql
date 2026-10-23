-- Trackly 006 — security fixes (from the security check on 2026-10-23)
-- Safe to run more than once. Function names and inputs stay the same, so the app and the tracker need no change.
--
-- BEFORE YOU RUN IT: write down each tracker's secret (it's on the QR card / in the ESP32 code).
-- After this, the database keeps only a fingerprint (hash) of each secret, not the secret itself.
--   select device_code, device_secret from public.trackers;   -- run this first and save the result somewhere private
--
-- 1. Device secrets are stored as a SHA-256 fingerprint.
--    Before: family members (and live updates of the trackers row) could see the real secret. With it, someone you
--    once invited could send fake locations for your bag, or claim it first if you ever unpair it.
-- 2. Two-step login now also protects the actions (share link, invite, lost mode, beep, park, unpair, …),
--    not only reading. Before, someone with only your password could create a live-share link and watch your bag.
-- 3. report_location checks its input (real coordinates, battery 0–100) and ignores floods (more than one point a second).

-- ---------------------------------------------------------------- 1. secrets → fingerprints
create or replace function public.secret_hash(p text) returns text
  language sql immutable set search_path = '' as $$
  select encode(pg_catalog.sha256(convert_to(coalesce(trim(p), ''), 'UTF8')), 'hex')
$$;
revoke execute on function public.secret_hash(text) from public, anon, authenticated;

-- hash every secret that isn't a fingerprint yet (64 hex characters)
update public.trackers set device_secret = public.secret_hash(device_secret) where device_secret !~ '^[0-9a-f]{64}$';

-- the tracker reports its location (plain secret in, compared as a fingerprint)
create or replace function public.report_location(p_code text, p_secret text, p_lat double precision, p_lng double precision, p_battery integer default null)
  returns text language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_mode text;
begin
  select id, mode into v_id, v_mode from public.trackers
   where device_code = upper(trim(p_code)) and device_secret = public.secret_hash(p_secret);
  if v_id is null then raise exception 'invalid device'; end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 or (p_lat = 0 and p_lng = 0) then
    raise exception 'bad location';
  end if;
  -- lost mode sends every 5 s; anything faster than 1 a second is a fault or a flood: keep the first, skip the rest
  if exists (select 1 from public.locations where tracker_id = v_id and created_at > now() - interval '1 second') then return v_mode; end if;
  insert into public.locations (tracker_id, lat, lng, battery)
  values (v_id, p_lat, p_lng, case when p_battery between 0 and 100 then p_battery end);
  return v_mode;
end;
$$;

create or replace function public.device_poll(p_code text, p_secret text) returns jsonb
  language plpgsql security definer set search_path = '' as $$
declare
  v_tr public.trackers;
  v_now time := (now() at time zone 'Asia/Baghdad')::time;
  v_night boolean;
begin
  select * into v_tr from public.trackers where device_code = upper(trim(p_code)) and device_secret = public.secret_hash(p_secret) for update;
  if not found then raise exception 'invalid device'; end if;
  if v_tr.buzz_requested_at is not null then update public.trackers set buzz_requested_at = null where id = v_tr.id; end if;
  v_night := v_tr.night_saver and v_tr.mode = 'normal' and v_tr.parked_at is null and
    (case when v_tr.night_start <= v_tr.night_end then v_now >= v_tr.night_start and v_now < v_tr.night_end
          else v_now >= v_tr.night_start or v_now < v_tr.night_end end);
  return jsonb_build_object('mode', v_tr.mode, 'buzz', coalesce(v_tr.buzz_requested_at > now() - interval '10 minutes', false), 'night', v_night);
end;
$$;

create or replace function public.claim_tracker(p_code text, p_secret text, p_name text default null) returns uuid
  language plpgsql security definer set search_path = '' as $$
declare
  v_tr public.trackers;
begin
  if auth.uid() is null then raise exception 'not_logged_in'; end if;
  if (select count(*) from public.claim_attempts where user_id = auth.uid() and at > now() - interval '15 minutes') >= 10 then
    raise exception 'too_many_attempts';
  end if;
  select * into v_tr from public.trackers where device_code = upper(trim(p_code)) for update;
  if not found or v_tr.device_secret is distinct from public.secret_hash(p_secret) then
    insert into public.claim_attempts (user_id) values (auth.uid());
    return null;
  end if;
  if v_tr.owner_id is not null and v_tr.owner_id <> auth.uid() then raise exception 'already_paired'; end if;
  update public.trackers
     set owner_id = auth.uid(), name = coalesce(nullif(left(trim(p_name), 40), ''), name, 'My bag')
   where id = v_tr.id;
  delete from public.claim_attempts where user_id = auth.uid();
  return v_tr.id;
end;
$$;

-- ---------------------------------------------------------------- 2. two-step login for actions too
-- owner or family, and (if two-step login is on) the code was entered
create or replace function public.can_see_tracker(p_tracker uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select public.mfa_ok() and (
         exists (select 1 from public.trackers t where t.id = p_tracker and t.owner_id = auth.uid())
      or exists (select 1 from public.tracker_members m where m.tracker_id = p_tracker and m.user_id = auth.uid()));
$$;
-- (set_tracker_mode, request_buzz, set_parked and list_members use can_see_tracker, so they're covered by the line above)

create or replace function public.create_share_link(p_tracker uuid, p_hours integer default 4) returns text
  language plpgsql security definer set search_path = '' as $$
declare v_token text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  if not public.mfa_ok() then raise exception 'two_step_required'; end if;
  if not exists (select 1 from public.trackers where id = p_tracker and owner_id = auth.uid()) then raise exception 'not your tracker'; end if;
  if p_hours is null or p_hours < 1 or p_hours > 72 then raise exception 'bad hours'; end if;
  delete from public.share_links where owner_id = auth.uid() and expires_at < now();   -- tidy up old ones
  insert into public.share_links (token, tracker_id, owner_id, expires_at)
  values (v_token, p_tracker, auth.uid(), now() + make_interval(hours => p_hours));
  return v_token;
end;
$$;

create or replace function public.create_member_invite(p_tracker uuid) returns text
  language plpgsql security definer set search_path = '' as $$
declare v_code text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
begin
  if not public.mfa_ok() then raise exception 'two_step_required'; end if;
  if not exists (select 1 from public.trackers where id = p_tracker and owner_id = auth.uid()) then raise exception 'not your tracker'; end if;
  if (select count(*) from public.tracker_members where tracker_id = p_tracker) >= 10 then raise exception 'too many members'; end if;
  insert into public.member_invites (code, tracker_id, created_by, expires_at) values (v_code, p_tracker, auth.uid(), now() + interval '2 days');
  return v_code;
end;
$$;

create or replace function public.remove_member(p_tracker uuid, p_user uuid) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  if not public.mfa_ok() then raise exception 'two_step_required'; end if;
  if not (p_user = auth.uid() or exists (select 1 from public.trackers where id = p_tracker and owner_id = auth.uid())) then raise exception 'not allowed'; end if;
  delete from public.tracker_members where tracker_id = p_tracker and user_id = p_user;
end;
$$;

create or replace function public.set_night_saver(p_tracker uuid, p_on boolean, p_start time default '23:00', p_end time default '07:00') returns void
  language plpgsql security definer set search_path = '' as $$
begin
  if not public.mfa_ok() then raise exception 'two_step_required'; end if;
  if not exists (select 1 from public.trackers where id = p_tracker and owner_id = auth.uid()) then raise exception 'not your tracker'; end if;
  update public.trackers set night_saver = coalesce(p_on, false), night_start = coalesce(p_start, '23:00'), night_end = coalesce(p_end, '07:00') where id = p_tracker;
end;
$$;

create or replace function public.set_tracker_info(p_tracker uuid, p_name text, p_color text default null) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  if not public.mfa_ok() then raise exception 'two_step_required'; end if;
  if p_color is not null and p_color !~ '^#[0-9A-Fa-f]{6}$' then raise exception 'bad colour'; end if;
  update public.trackers
     set name = coalesce(nullif(left(trim(p_name), 40), ''), name), color = coalesce(p_color, color)
   where id = p_tracker and owner_id = auth.uid();
  if not found then raise exception 'not your tracker'; end if;
end;
$$;

create or replace function public.unpair_tracker(p_tracker uuid) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  if not public.mfa_ok() then raise exception 'two_step_required'; end if;
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

-- ---------------------------------------------------------------- 3. tidy grants: signed-out visitors never read these tables directly
revoke select on public.trackers from anon;
revoke select on public.locations from anon;

-- ADDING A NEW TRACKER from now on (SQL editor): store the fingerprint, keep the real secret for the QR card and the ESP32
--   insert into public.trackers (device_code, device_secret) values ('SB-0002', public.secret_hash('the-24-character-secret'));
