-- Create tables for football quiz simulator
-- This migration creates the necessary tables for the enhanced snapshot service

-- Create games table
create table if not exists games (
  id text primary key,
  home_team text,
  away_team text,
  kickoff timestamp with time zone,
  source text default 'replay',
  created_at timestamp with time zone default now()
);

-- Create windows table
create table if not exists windows (
  id uuid primary key default gen_random_uuid(),
  game_id text references games(id) on delete cascade,
  start_sec int not null,
  end_sec int not null,
  created_at timestamp with time zone default now(),
  unique (game_id, start_sec, end_sec)
);

-- Create snapshots table
create table if not exists snapshots (
  id uuid primary key default gen_random_uuid(),
  window_id uuid references windows(id) on delete cascade,
  compressed_kind text not null check (compressed_kind in ('raw', 'STKM', 'PTF', 'PAD', 'SPT', 'FTT', 'PCS', 'KH', 'MMH', 'NCMS')),
  raw_json jsonb,
  compressed_json jsonb,
  created_at timestamp with time zone default now(),
  unique (window_id, compressed_kind)
);

-- Create indexes for better performance
create index if not exists idx_windows_game_id on windows(game_id);
create index if not exists idx_windows_time on windows(start_sec, end_sec);
create index if not exists idx_snapshots_window_id on snapshots(window_id);
create index if not exists idx_snapshots_kind on snapshots(compressed_kind);

-- Grant permissions to service_role
grant all on table "public"."games" to "service_role";
grant all on table "public"."windows" to "service_role";
grant all on table "public"."snapshots" to "service_role";

-- Grant SELECT permissions to anon and authenticated for client access
grant select on table "public"."games" to "anon";
grant select on table "public"."games" to "authenticated";

grant select on table "public"."windows" to "anon";
grant select on table "public"."windows" to "authenticated";

grant select on table "public"."snapshots" to "anon";
grant select on table "public"."snapshots" to "authenticated";

-- Grant USAGE on sequences (needed for auto-incrementing IDs)
grant usage on all sequences in schema public to "service_role";
grant usage on all sequences in schema public to "anon";
grant usage on all sequences in schema public to "authenticated";
