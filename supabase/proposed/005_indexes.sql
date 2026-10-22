-- Trackly 005: indexes for foreign keys (Supabase "Performance" advisor).
-- Safe to run more than once. Only speeds up lookups and deletes; changes no data.
create index if not exists alerts_tracker_id_idx on public.alerts (tracker_id);
create index if not exists member_invites_tracker_id_idx on public.member_invites (tracker_id);
create index if not exists push_subscriptions_user_id_idx on public.push_subscriptions (user_id);
create index if not exists safe_zones_tracker_id_idx on public.safe_zones (tracker_id);
create index if not exists share_links_tracker_id_idx on public.share_links (tracker_id);
create index if not exists tracker_members_user_id_idx on public.tracker_members (user_id);
create index if not exists trackers_owner_id_idx on public.trackers (owner_id);
