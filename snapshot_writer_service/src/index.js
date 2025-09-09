import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { stkmCompress } from './stkm.js';

/**
 * ENV
 */
const PORT = Number(process.env.PORT || 7070);
const WINDOW_SIZE_SEC = Number(process.env.WINDOW_SIZE_SEC || 300);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * In-memory event buckets:
 * eventsByWindow[gameId][windowKey] = [{...event}, ...]
 * where windowKey = `${startSec}-${endSec}`
 */
const eventsByWindow = new Map();

/**
 * Helpers
 */
function floorToWindow(tSec) {
  const start = Math.floor(tSec / WINDOW_SIZE_SEC) * WINDOW_SIZE_SEC;
  return { start, end: start + WINDOW_SIZE_SEC };
}

function getBucket(gameId, start, end) {
  if (!eventsByWindow.has(gameId)) eventsByWindow.set(gameId, new Map());
  const key = `${start}-${end}`;
  const byGame = eventsByWindow.get(gameId);
  if (!byGame.has(key)) byGame.set(key, []);
  return byGame.get(key);
}

async function upsertWindow(gameId, start_sec, end_sec) {
  const { data, error } = await supabase
    .from('windows')
    .upsert({ game_id: gameId, start_sec, end_sec }, { onConflict: 'game_id,start_sec,end_sec' })
    .select()
    .single();

  if (error) throw error;
  return data; // { id, game_id, start_sec, end_sec, ... }
}

async function insertSnapshot(window_id, raw_json, compressed_json, compressed_kind = 'STKM') {
    const { data, error } = await supabase
      .from('snapshots')
      .upsert(
        [{ window_id, raw_json, compressed_json, compressed_kind }],
        { onConflict: 'window_id' }
      )
      .select()
      .single();
    if (error) throw error;
    return data;
  }
  

/**
 * When a window “closes” we persist it.
 * We mark a window ready when the replay crosses its end boundary
 * (or if the stream sends an explicit flush).
 */
async function ensureGame(gameId, meta = {}) {
    const { home_team, away_team, kickoff, source } = meta;
    const { data, error } = await supabase
      .from('games')
      .upsert(
        {
          id: gameId,
          home_team: home_team ?? null,
          away_team: away_team ?? null,
          kickoff: kickoff ?? null,
          source: source ?? 'replay'
        },
        { onConflict: 'id' }
      )
      .select()
      .single();
  
    if (error) throw error;
    return data;
  }

async function flushWindow(gameId, start, end) {
  const byGame = eventsByWindow.get(gameId);
  if (!byGame) return;
  const key = `${start}-${end}`;
  const events = byGame.get(key);
  if (!events || events.length === 0) return; // nothing to write

  try {
    // 1) Save/find window
    await ensureGame(gameId); // or pass metadata if you have it

    const windowRow = await upsertWindow(gameId, start, end);

    // 2) Compress
    const compressed = stkmCompress(events, { gameId, start, end });

    // 3) Insert snapshot (raw + compressed)
    await insertSnapshot(windowRow.id, events, compressed, 'STKM');

    // 4) Clear memory for that window
    byGame.delete(key);
    if (byGame.size === 0) eventsByWindow.delete(gameId);

    console.log(`✔ Saved ${gameId} ${start}-${end} | raw ${events.length} events`);
  } catch (err) {
    console.error(`✖ Failed to save ${gameId} ${start}-${end}`, err);
  }
}

  

/**
 * Express app
 * POST /ingest
 *   { gameId, tSec, event: {...} }
 * - tSec: seconds from kickoff within this match (integer)
 * - event: any normalized event object
 *
 * POST /flush
 *   { gameId, start, end }  // optional - if omitted, flush all closed windows we can infer
 */
const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true, port: PORT, windowSizeSec: WINDOW_SIZE_SEC });
});

/**
 * Ingest one event from the replay server.
 * You can send one POST per event from your replay.
 */
app.post('/ingest', async (req, res) => {
  try {
    const { gameId, tSec, event } = req.body || {};
    if (!gameId || typeof tSec !== 'number' || !event) {
      return res.status(400).json({ error: 'Missing gameId, tSec, or event' });
    }

    const { start, end } = floorToWindow(tSec);
    const bucket = getBucket(gameId, start, end);
    bucket.push(event);

    // If you want “auto-flush” when we detect sequence crossing, you can also
    // pass the current tSec of the *next* event to decide when to flush previous windows.
    // For MVP: rely on /flush or a timer.

    return res.json({ ok: true, bucket: `${start}-${end}`, size: bucket.length });
  } catch (err) {
    console.error('ingest error', err);
    res.status(500).json({ error: 'ingest failed', details: String(err) });
  }
});

/**
 * Manual flush:
 *  - pass a specific window,
 *  - or pass { gameId } only to flush all windows currently held for that game
 */
app.post('/flush', async (req, res) => {
  try {
    const { gameId, start, end } = req.body || {};
    if (!gameId) return res.status(400).json({ error: 'Missing gameId' });

    const byGame = eventsByWindow.get(gameId);
    if (!byGame || byGame.size === 0) return res.json({ ok: true, flushed: 0 });

    const targets = [];
    if (typeof start === 'number' && typeof end === 'number') {
      targets.push({ start, end });
    } else {
      // flush all windows we’re currently holding
      for (const key of byGame.keys()) {
        const [s, e] = key.split('-').map(n => parseInt(n, 10));
        targets.push({ start: s, end: e });
      }
    }

    let flushed = 0;
    for (const w of targets) {
      await flushWindow(gameId, w.start, w.end);
      flushed++;
    }

    res.json({ ok: true, flushed });
  } catch (err) {
    console.error('flush error', err);
    res.status(500).json({ error: 'flush failed', details: String(err) });
  }
});


app.post('/ensure_game', async (req, res) => {
    try {
      const { gameId, meta } = req.body || {};
      if (!gameId) return res.status(400).json({ error: 'Missing gameId' });
      const row = await ensureGame(gameId, meta || {});
      res.json({ ok: true, game: row });
    } catch (err) {
      console.error('ensure_game error', err);
      res.status(500).json({ error: 'ensure_game failed', details: String(err) });
    }
  });
  

app.listen(PORT, () => {
  console.log(`snapshot-writer listening on :${PORT}`);
});
