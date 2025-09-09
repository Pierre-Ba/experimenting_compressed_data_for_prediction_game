Snapshot Writer Service

This service listens to a football game replay stream and automatically produces 5-minute snapshots in two formats:

Raw JSON → all events exactly as they come in

Compressed JSON (STKM + facets) → reduced form with only essential signals

Both versions are stored in a Supabase database, where snapshots are grouped by game and time window.

Prerequisites

Node.js v18+ (ESM compatible)

A Supabase project (with API keys)

Replay server running (e.g. sb-replay-server.js)

Environment Variables

Create a .env file (or export variables in your shell):

SUPABASE_URL=<your-supabase-project-url>
SUPABASE_SERVICE_KEY=<your-service-role-key>


The service role key is required because the service writes to the database.

Database Setup

Run this SQL inside Supabase once:

create table games (
  id text primary key,
  metadata jsonb
);

create table windows (
  id uuid primary key default gen_random_uuid(),
  game_id text references games(id),
  start_sec int,
  end_sec int,
  unique (game_id, start_sec, end_sec)
);

create table snapshots (
  id uuid primary key default gen_random_uuid(),
  window_id uuid references windows(id),
  kind text check (kind in ('raw', 'compressed')),
  payload jsonb,
  unique (window_id, kind)
);


This creates the tables where snapshots will be stored.

How to Run

Start the snapshot service

cd snapshot_writer_service
node index.js


By default it listens on port 7070.

Start the replay server (from another terminal)

node sb-replay-server.js --file path/to/game.json --speed 5


--file = raw game JSON

--speed = replay speed multiplier (e.g. 5× faster than real time)

Start the bridge (connects replay to snapshot service)

REPLAY_URL=http://localhost:4000/stream \
SNAPSHOT_URL=http://localhost:7070 \
GAME_ID=barcelona-atletico-2018-11-24 \
WINDOW_SIZE_SEC=300 \
node bridge_sse_to_snapshot.js


REPLAY_URL = where replay server streams

SNAPSHOT_URL = where snapshot service listens

GAME_ID = any string identifier for the game

WINDOW_SIZE_SEC = snapshot length in seconds (300 = 5 min)

Workflow

Replay server streams game events.

Bridge groups events into 5-minute windows and sends to snapshot service.

Snapshot service writes both raw and compressed snapshots into Supabase under the same window ID.

You can query Supabase later to retrieve snapshots for analysis or LLM experiments.