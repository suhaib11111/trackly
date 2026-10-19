-- =====================================================================
-- PROPOSED — not run yet. Review first, then paste into Supabase → SQL Editor → Run.
-- Project: bag-tracker (lcrvuijwpvhphbuwxtny)
--
-- What it adds (exactly what js/app.js calls when fakeBackend is false):
--   1. claim_tracker(p_code, p_secret, p_name)  → pair a tracker to the logged-in user
--   2. set_tracker_mode(p_tracker, p_mode)      → lost mode on / off
--   3. safe_zones table + Row Level Security     → each user sees only their own zones
--   4. Realtime on locations + trackers          → the map updates live
--
-- Assumes trackers.id and locations.tracker_id are uuid. If yours are bigint, change the
-- "uuid" types below (check: Table Editor → trackers → id column type).
-- =====================================================================

-- 1. Pair a tracker -----------------------------------------------------
-- "security definer" = runs with the function owner's rights, so it can read device_secret,
-- which normal users can never select. It only ever pairs to the caller (auth.uid()).
create or replace function public.claim_tracker(p_code text, p_secret text, p_name text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_tr public.trackers;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;

  select * into v_tr from public.trackers
   where device_code = upper(trim(p_code))
   for update;                                   -- lock the row so two people can't claim it at once

  -- same error for "no such code" and "wrong secret", so codes can't be guessed one by one
  if not found or v_tr.device_secret is distinct from trim(p_secret) then
    raise exception 'invalid_code';
  end if;
  if v_tr.owner_id is not null and v_tr.owner_id <> auth.uid() then
    raise exception 'already_paired';
  end if;

  update public.trackers
     set owner_id = auth.uid(),
         name = coalesce(nullif(left(trim(p_name), 40), ''), name, 'My bag')
   where id = v_tr.id;
  return v_tr.id;
end;
$$;

-- 2. Lost mode on / off ----------------------------------------------
create or replace function public.set_tracker_mode(p_tracker uuid, p_mode text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_mode not in ('normal', 'lost') then raise exception 'bad mode'; end if;
  update public.trackers set mode = p_mode where id = p_tracker and owner_id = auth.uid();
  if not found then raise exception 'not your tracker'; end if;
end;
$$;

revoke all on function public.claim_tracker(text, text, text), public.set_tracker_mode(uuid, text) from public, anon;
grant execute on function public.claim_tracker(text, text, text), public.set_tracker_mode(uuid, text) to authenticated;

-- 3. Safe zones ---------------------------------------------------------
create table if not exists public.safe_zones (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  tracker_id uuid not null references public.trackers(id) on delete cascade,
  name text not null check (length(name) between 1 and 40),
  kind text not null default 'other' check (kind in ('home', 'work', 'school', 'gym', 'family', 'other')),  -- icon in the app
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  radius_m integer not null check (radius_m between 50 and 1000),
  notify_on text not null default 'leave' check (notify_on in ('leave', 'arrive', 'both')),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists safe_zones_tracker_idx on public.safe_zones (tracker_id);

alter table public.safe_zones enable row level security;

create policy "own zones: read" on public.safe_zones for select to authenticated
  using (owner_id = (select auth.uid()));
-- insert only for a tracker you own
create policy "own zones: add" on public.safe_zones for insert to authenticated
  with check (owner_id = (select auth.uid())
    and exists (select 1 from public.trackers t where t.id = tracker_id and t.owner_id = (select auth.uid())));
create policy "own zones: change" on public.safe_zones for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "own zones: delete" on public.safe_zones for delete to authenticated
  using (owner_id = (select auth.uid()));

-- 4. Live updates on the map --------------------------------------------
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'locations') then
    alter publication supabase_realtime add table public.locations;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'trackers') then
    alter publication supabase_realtime add table public.trackers;
  end if;
end $$;
