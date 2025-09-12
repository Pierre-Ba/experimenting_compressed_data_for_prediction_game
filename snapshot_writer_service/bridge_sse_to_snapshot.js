// bridge_sse_to_snapshot.js
// Connects to sb-replay-server SSE and forwards events to the snapshot service,
// auto-flushing 5-min windows as time progresses.



import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Normalize all shapes: CJS default, named, or wrapped
const esPkg = require('eventsource');
const EventSource = esPkg?.EventSource || esPkg?.default || esPkg;



const REPLAY_URL = process.env.REPLAY_URL || 'http://localhost:4000/stream'; // sb-replay-server.js default
const SNAPSHOT_URL = process.env.SNAPSHOT_URL || 'http://localhost:7070';    // snapshot service (index.js)
const WINDOW = Number(process.env.WINDOW_SIZE_SEC || 300);                    // 5 minutes


// Simple helper to POST JSON (Node 18+ has fetch).
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${url} failed ${res.status}: ${text}`);
  }
  return res.json().catch(() => ({}));
}

// Set your game id for the run (use your own naming convention).
const GAME_ID = process.env.GAME_ID || 'barcelona-atletico-2018-11-24';

// Track which 5-min window we're currently in and the last fully flushed end.
let currentWindowStart = 0;
let currentWindowEnd = WINDOW;    // [0,300), [300,600), ...
let lastFlushedEnd = -1;

// Create all 18 windows upfront (0-300, 300-600, ..., 5100-5400)
const TOTAL_GAME_SECONDS = 90 * 60; // 90 minutes
const ALL_WINDOWS = [];
for (let start = 0; start < TOTAL_GAME_SECONDS; start += WINDOW) {
  ALL_WINDOWS.push({ start, end: start + WINDOW });
}

// ---- one-time metadata sender on hello ----
let sentMeta = false;
async function sendGameMetaOnce(hello) {
  if (sentMeta) return;
  sentMeta = true;

  // If the replay server provides a stable id, you can derive GAME_ID from it:
  // if (hello?.game_id) GAME_ID = hello.game_id;

  const meta = {
    home_team: hello?.home || hello?.home_team || null,
    away_team: hello?.away || hello?.away_team || null,
    kickoff:   hello?.kickoff || hello?.kickoff_iso || null,
    source:    'replay'
  };

  try {
    await postJSON(`${SNAPSHOT_URL}/ensure_game`, { gameId: GAME_ID, meta });
    console.log('✓ ensured game metadata', { gameId: GAME_ID, meta });
  } catch (err) {
    console.warn('ensure_game failed (continuing anyway):', err.message);
  }
}

// Called for every incoming event from SSE
async function handleTick(data) {
  // `data` is a JSON string like: { i, ts, event: { ts, type, team, player, ... } }
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    return; // ignore malformed
  }
  const { ts, event } = payload;
  if (typeof ts !== 'number' || !event) return;

  // 1) Forward to snapshot service /ingest
  try {
    await postJSON(`${SNAPSHOT_URL}/ingest`, {
      gameId: GAME_ID,
      tSec: ts,
      event
    });
  } catch (err) {
    console.error('ingest error:', err.message);
  }

  // 2) If we’ve crossed the current window boundary, flush the previous window once
  while (ts >= currentWindowEnd) {
    const start = currentWindowStart;
    const end = currentWindowEnd;

    if (end !== lastFlushedEnd) {
      try {
        await postJSON(`${SNAPSHOT_URL}/flush`, { gameId: GAME_ID, start, end });
        lastFlushedEnd = end;
        console.log(`flushed ${start}-${end}`);
      } catch (err) {
        console.error('flush error:', err.message);
      }
    }

    // advance to next window
    currentWindowStart += WINDOW;
    currentWindowEnd += WINDOW;
  }
}

async function run() {
  console.log(`Bridge starting:
  - REPLAY_URL   = ${REPLAY_URL}
  - SNAPSHOT_URL = ${SNAPSHOT_URL}
  - GAME_ID      = ${GAME_ID}
  - WINDOW       = ${WINDOW}s`);

  const es = new EventSource(REPLAY_URL);

  es.addEventListener('hello', async(e) => {
   // hello may be JSON or plain text
   try {
    const hello = JSON.parse(e.data);
    await sendGameMetaOnce(hello);
    console.log('replay hello:', hello);
  } catch {
    await sendGameMetaOnce({});
    console.log('replay hello (non-JSON):', e.data);
  }
  });

  es.addEventListener('tick', async (e) => {
    try {
      await handleTick(e.data);
    } catch (err) {
      console.error('tick handling failed:', err);
    }
  });

  es.addEventListener('done', async () => {
    console.log('replay done: flushing all windows…');
    // Flush ALL 18 windows to ensure complete coverage
    try {
      for (const window of ALL_WINDOWS) {
        await postJSON(`${SNAPSHOT_URL}/flush`, {
          gameId: GAME_ID,
          start: window.start,
          end: window.end
        });
        console.log(`flushed ${window.start}-${window.end}`);
      }
    } catch (err) {
      console.error('final flush error:', err.message);
    }
    es.close();
  });

  es.onerror = (err) => {
    console.error('SSE error:', err?.message || err);
  };
}

run().catch(err => console.error('bridge failed:', err));
