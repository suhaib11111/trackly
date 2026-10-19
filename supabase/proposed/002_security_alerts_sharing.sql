-- =====================================================================
-- 002 — Security + server alerts + sharing + beep + pre-orders
-- PROPOSED: review, then run it in Supabase → SQL Editor (project bag-tracker), or let Claude run it.
-- Safe to run once on the current database (tables trackers / locations / safe_zones already exist).
--
--  1. New columns: zone type (icon), bag colour, "beep requested"
--  2. Security: pairing allows max 10 wrong codes per 15 minutes per account,
--     and the browser can no longer write to tables directly (only through functions)
--  3. Alerts made by the SERVER on every new location (bag left / arrived at a safe zone, low battery),
--     so they are saved even when the app is closed (push to the phone comes in the next step)
--  4. Family share links that end by themselves
--  5. Beep: the app asks, the tracker picks it up with device_poll()
--  6. Pre-orders from the website (anyone can send one, nobody can read them except you)
-- =====================================================================

-- 1. New columns ---------------------------------------------------------
alter table public.safe_zones add column if not exists kind text not null default 'other'
  check (kind in ('home', 'work', 'school', 'gym', 'family', 'other'));
alter table public.trackers add column if not exists color text check (color ~ '^#[0-9A-Fa-f]{6}$');
alter table public.trackers add column if not exists buzz_requested_at timestamptz;

-- 2. Security ------------------------------------------------------------
-- Tables are only changed through the functions below (or safe_zones with its own rules).
revoke insert, update, delete, truncate, references, trigger on public.trackers, public.locations from anon, authenticated;
revoke all on public.safe_zones from anon;
revoke truncate, references, trigger on public.safe_zones from authenticated;

create table if not exists public.claim_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  at timestamptz not null default now()
);
create index if not exists claim_attempts_user_idx on public.claim_attempts (user_id, at);
alter table public.claim_attempts enable row level security;   -- no policies: only the server can read it
revoke all on public.claim_attempts from anon, authenticated;

-- Pairing. A wrong code returns NULL (instead of an error) so the failed try is saved and counted.
create or replace function public.claim_tracker(p_code text, p_secret text, p_name text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_tr public.trackers;
begin
  if auth.uid() is null then raise exception 'not_logged_in'; end if;
  if (select count(*) from public.claim_attempts where user_id = auth.uid() and at > now() - interval '15 minutes') >= 10 then
    raise exception 'too_many_attempts';
  end if;
  select * into v_tr from public.trackers where device_code = upper(trim(p_code)) for update;
  if not found or v_tr.device_secret is distinct from trim(p_secret) then
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

-- Rename a bag / pick its colour
create or replace function public.set_tracker_info(p_tracker uuid, p_name text, p_color text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_color is not null and p_color !~ '^#[0-9A-Fa-f]{6}$' then raise exception 'bad colour'; end if;
  update public.trackers
     set name = coalesce(nullif(left(trim(p_name), 40), ''), name), color = coalesce(p_color, color)
   where id = p_tracker and owner_id = auth.uid();
  if not found then raise exception 'not your tracker'; end if;
end;
$$;

-- 3. Server alerts -------------------------------------------------------
create table if not exists public.alerts (
  id bigint generated always as identity primary key,
  tracker_id uuid not null references public.trackers(id) on delete cascade,
  owner_id uuid not null,
  kind text not null check (kind in ('zone_left', 'zone_arrived', 'battery_low', 'battery_critical')),
  zone_name text,
  battery integer,
  created_at timestamptz not null default now(),
  pushed_at timestamptz            -- when the phone notification was sent (next step)
);
create index if not exists alerts_owner_idx on public.alerts (owner_id, created_at desc);
alter table public.alerts enable row level security;
revoke all on public.alerts from anon, authenticated;
grant select on public.alerts to authenticated;
drop policy if exists "owners read their alerts" on public.alerts;
create policy "owners read their alerts" on public.alerts for select to authenticated using (owner_id = (select auth.uid()));

-- distance in metres between two points (good enough for zones up to 1 km)
create or replace function public.dist_m(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision language sql immutable set search_path = '' as $$
  select 6371000 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)));
$$;

-- runs for every new location: compare with the previous one
create or replace function public.location_alerts() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_prev public.locations;
  v_owner uuid;
  z public.safe_zones;
  was boolean;
  now_in boolean;
begin
  select owner_id into v_owner from public.trackers where id = new.tracker_id;
  if v_owner is null then return new; end if;
  select * into v_prev from public.locations
   where tracker_id = new.tracker_id and id <> new.id and created_at <= new.created_at
   order by created_at desc, id desc limit 1;
  if not found then return new; end if;

  for z in select * from public.safe_zones where tracker_id = new.tracker_id and enabled loop
    was := public.dist_m(v_prev.lat, v_prev.lng, z.lat, z.lng) <= z.radius_m;
    now_in := public.dist_m(new.lat, new.lng, z.lat, z.lng) <= z.radius_m;
    if was and not now_in and z.notify_on in ('leave', 'both') then
      insert into public.alerts (tracker_id, owner_id, kind, zone_name) values (new.tracker_id, v_owner, 'zone_left', z.name);
    elsif not was and now_in and z.notify_on in ('arrive', 'both') then
      insert into public.alerts (tracker_id, owner_id, kind, zone_name) values (new.tracker_id, v_owner, 'zone_arrived', z.name);
    end if;
  end loop;

  if v_prev.battery > 20 and new.battery <= 20 then
    insert into public.alerts (tracker_id, owner_id, kind, battery) values (new.tracker_id, v_owner, 'battery_low', new.battery);
  end if;
  if v_prev.battery > 5 and new.battery <= 5 then
    insert into public.alerts (tracker_id, owner_id, kind, battery) values (new.tracker_id, v_owner, 'battery_critical', new.battery);
  end if;
  return new;
end;
$$;
drop trigger if exists locations_alerts on public.locations;
create trigger locations_alerts after insert on public.locations for each row execute function public.location_alerts();

-- 4. Family share links ----------------------------------------------------
create table if not exists public.share_links (
  token text primary key,
  tracker_id uuid not null references public.trackers(id) on delete cascade,
  owner_id uuid not null default auth.uid(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.share_links enable row level security;
revoke all on public.share_links from anon, authenticated;
grant select, delete on public.share_links to authenticated;
drop policy if exists "owners see their links" on public.share_links;
create policy "owners see their links" on public.share_links for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists "owners delete their links" on public.share_links;
create policy "owners delete their links" on public.share_links for delete to authenticated using (owner_id = (select auth.uid()));

create or replace function public.create_share_link(p_tracker uuid, p_hours integer default 4)
returns text
language plpgsql security definer set search_path = '' as $$
declare v_token text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  if not exists (select 1 from public.trackers where id = p_tracker and owner_id = auth.uid()) then raise exception 'not your tracker'; end if;
  if p_hours is null or p_hours < 1 or p_hours > 72 then raise exception 'bad hours'; end if;
  delete from public.share_links where owner_id = auth.uid() and expires_at < now();   -- tidy up old ones
  insert into public.share_links (token, tracker_id, owner_id, expires_at)
  values (v_token, p_tracker, auth.uid(), now() + make_interval(hours => p_hours));
  return v_token;
end;
$$;

-- What a family member sees (no account): name, mode, last point, last 30 minutes. Nothing else.
create or replace function public.get_shared_location(p_token text)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'name', t.name, 'mode', t.mode, 'expires_at', s.expires_at,
    'last', (select jsonb_build_object('lat', l.lat, 'lng', l.lng, 'battery', l.battery, 'created_at', l.created_at)
               from public.locations l where l.tracker_id = t.id order by l.created_at desc limit 1),
    'trail', coalesce((select jsonb_agg(jsonb_build_array(x.lat, x.lng) order by x.created_at)
               from public.locations x where x.tracker_id = t.id and x.created_at > now() - interval '30 minutes'), '[]'::jsonb))
  from public.share_links s join public.trackers t on t.id = s.tracker_id
  where s.token = p_token and s.expires_at > now();
$$;

-- 5. Beep ------------------------------------------------------------------
create or replace function public.request_buzz(p_tracker uuid)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.trackers set buzz_requested_at = now() where id = p_tracker and owner_id = auth.uid();
  if not found then raise exception 'not your tracker'; end if;
end;
$$;

-- The tracker calls this after each report: { mode, buzz }. A beep request is used once, and only if it's fresh.
create or replace function public.device_poll(p_code text, p_secret text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tr public.trackers;
begin
  select * into v_tr from public.trackers where device_code = upper(trim(p_code)) and device_secret = p_secret for update;
  if not found then raise exception 'invalid device'; end if;
  if v_tr.buzz_requested_at is not null then update public.trackers set buzz_requested_at = null where id = v_tr.id; end if;
  return jsonb_build_object('mode', v_tr.mode, 'buzz', coalesce(v_tr.buzz_requested_at > now() - interval '10 minutes', false));
end;
$$;

-- 6. Pre-orders from the website -----------------------------------------
create table if not exists public.preorders (
  id bigint generated always as identity primary key,
  name text not null check (length(name) between 1 and 60),
  phone text not null check (phone ~ '^[+0-9 ]{7,20}$'),
  city text check (length(city) <= 40),
  note text check (length(note) <= 300),
  created_at timestamptz not null default now()
);
alter table public.preorders enable row level security;   -- no policies: only you (dashboard) can read them
revoke all on public.preorders from anon, authenticated;

create or replace function public.submit_preorder(p_name text, p_phone text, p_city text default null, p_note text default null)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  -- simple flood guard for the whole site, and no duplicate phone numbers per day
  if (select count(*) from public.preorders where created_at > now() - interval '1 hour') >= 200 then raise exception 'busy'; end if;
  if exists (select 1 from public.preorders where phone = trim(p_phone) and created_at > now() - interval '1 day') then
    return 0;
  end if;
  insert into public.preorders (name, phone, city, note)
  values (left(trim(p_name), 60), trim(p_phone), left(nullif(trim(p_city), ''), 40), left(nullif(trim(p_note), ''), 300))
  returning id into v_id;
  return v_id;
end;
$$;

-- Who may call what ----------------------------------------------------------
revoke all on function public.claim_tracker(text, text, text), public.set_tracker_info(uuid, text, text),
  public.create_share_link(uuid, integer), public.get_shared_location(text), public.request_buzz(uuid),
  public.device_poll(text, text), public.submit_preorder(text, text, text, text), public.location_alerts(),
  public.dist_m(double precision, double precision, double precision, double precision) from public, anon, authenticated;
grant execute on function public.claim_tracker(text, text, text), public.set_tracker_info(uuid, text, text),
  public.create_share_link(uuid, integer), public.request_buzz(uuid) to authenticated;
grant execute on function public.get_shared_location(text), public.submit_preorder(text, text, text, text) to anon, authenticated;
grant execute on function public.device_poll(text, text) to anon;   -- the tracker uses the public key, like report_location

-- Live updates for alerts in the app
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'alerts') then
    alter publication supabase_realtime add table public.alerts;
  end if;
end $$;
