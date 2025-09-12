// sb-replay-server.js
// Usage: node sb-replay-server.js ./events.json --port=4000 --speed=6
// SSE stream of StatsBomb open-data events, normalized for easy consumption.

import fs from 'fs';
import http from 'http';
import url from 'url';

const args = process.argv.slice(2);
const fileArg = args.find(a => a.startsWith('--file='));
const EVENTS_PATH = fileArg ? fileArg.split('=')[1] : args[0];
if (!EVENTS_PATH) {
  console.error('Provide path to a StatsBomb events.json, e.g. node sb-replay-server.js --file=./events.json');
  process.exit(1);
}
const PORT = Number((args.find(a => a.startsWith('--port=')) || '').split('=')[1] || 4000);
const SPEED = Number((args.find(a => a.startsWith('--speed=')) || '').split('=')[1] || 6); // 1=real-time, 6=6x faster

// ---- Helpers
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// Compute absolute seconds for an event.
// StatsBomb events have minute (0..), second (0..59), and period (1=1H, 2=2H, etc.)
// Many SB datasets keep minute running (46, 47...), but we guard w/ period offsets.
function eventSeconds(e) {
  const minute = Number(e.minute || 0);
  const second = Number(e.second || 0);
  const period = Number(e.period || 1);
  const offsets = { 1: 0, 2: 45 * 60, 3: 90 * 60, 4: 105 * 60 }; // basic ET offsets
  const base = minute * 60 + second;
  // If minutes are absolute already (e.g., 52 in 2H), don’t double-add offset:
  if (period > 1 && minute >= 45) return base;
  return base + (offsets[period] || 0);
}

// Normalize a StatsBomb event into a compact, betting-friendly shape
function normalizeEvent(e) {
  const t = e.type?.name || '';
  const team = e.team?.name || null;
  const player = e.player?.name || null;
  const absSec = eventSeconds(e);

  // Shots
  if (t === 'Shot') {
    const s = e.shot || {};
    const outcome = s.outcome?.name || null;
    const isGoal = outcome === 'Goal';
    const onTarget = ['Saved', 'Saved To Post', 'Goal'].includes(outcome) || s.saved === true || s.on_target === true;
    return {
      ts: absSec,
      type: isGoal ? 'GOAL' : 'SHOT',
      team, player,
      data: {
        xg: s.statsbomb_xg ?? null,
        outcome,
        on_target: !!onTarget,
        body_part: s.body_part?.name || null,                 // e.g., Head, Right Foot
        header: (s.body_part?.name || '').toLowerCase().includes('head'),
        technique: s.technique?.name || null,                 // e.g., Volley
        set_piece: s.type?.name || 'Open Play',               // From Corner, From Free Kick, Penalty, Open Play
        first_time: !!s.first_time,
        location: e.location || null,
        end_location: s.end_location || null,
        assisted_by: s.assisted_by || null
      }
    };
  }

  // Goalkeeper (saves, claims, punches)
  if (t === 'Goal Keeper') {
    const gk = e.goalkeeper || {};
    return {
      ts: absSec,
      type: (gk.type?.name || '').toUpperCase().replace(/\s+/g, '_'), // e.g., SHOT_SAVED, CLAIM, PUNCHED
      team, player,
      data: { outcome: gk.outcome?.name || null, location: e.location || null }
    };
  }

  // Fouls & Cards
  if (t === 'Foul Committed') {
    return { ts: absSec, type: 'FOUL', team, player, data: { card: e.foul_committed?.card?.name || null } };
  }
  if (t === 'Bad Behaviour') {
    return { ts: absSec, type: 'CARD', team, player, data: { card: e.bad_behaviour?.card?.name || 'Yellow Card' } };
  }

  // Set pieces & restarts (corner, free-kick, throw-in, goal-kick)
  if (t === 'Corner Awarded' || t === 'Corner') {
    return { ts: absSec, type: 'CORNER', team, player };
  }
  if (t === 'Free Kick Won') {
    return { ts: absSec, type: 'FREE_KICK_WON', team, player };
  }
  if (t === 'Throw-in') {
    return { ts: absSec, type: 'THROW_IN', team, player };
  }
  if (t === 'Goal Kick') {
    return { ts: absSec, type: 'GOAL_KICK', team, player };
  }
  if (t === 'Offside') {
    return { ts: absSec, type: 'OFFSIDE', team, player };
  }

  // Substitutions
  if (t === 'Substitution') {
    return {
      ts: absSec,
      type: 'SUB',
      team,
      player, // player off
      data: { replacement: e.substitution?.replacement?.name || null }
    };
  }

  // Passes (only emit “key/assist/into box” to keep it signal-rich)
  if (t === 'Pass') {
    const p = e.pass || {};
    const keyish = p.shot_assist || p.goal_assist || (p.end_location && isIntoBox(p.end_location));
    if (keyish) {
      return {
        ts: absSec,
        type: p.goal_assist ? 'ASSIST' : (p.shot_assist ? 'KEY_PASS' : 'PASS_INTO_BOX'),
        team, player,
        data: {
          length: p.length ?? null,
          end_location: p.end_location || null,
          height: p.height?.name || null,
          cross: !!p.cross,
          switch: !!p.switch,
          through_ball: !!p.through_ball
        }
      };
    }
  }

  // VAR
  if (t === 'VAR') {
    return { ts: absSec, type: 'VAR', team, player, data: { decision: e.var?.decision?.name || e.detail || null } };
  }

  // Default: ignore low-signal events to keep stream clean
  return null;
}

function isIntoBox(endLoc) {
  // crude: SB coords ~120x80; box approx x>=102, y in [18,62]
  if (!Array.isArray(endLoc) || endLoc.length < 2) return false;
  const [x, y] = endLoc;
  return x >= 102 && y >= 18 && y <= 62;
}

// ---- Load and prep events
const raw = JSON.parse(fs.readFileSync(EVENTS_PATH, 'utf8'));
const all = Array.isArray(raw) ? raw : (raw.events || []);
const normalized = all
  .map(e => normalizeEvent(e))
  .filter(Boolean)
  .sort((a, b) => a.ts - b.ts);

// Meta (best-effort from first records)
function extractMeta() {
  const first = all.find(Boolean) || {};
  const match = {
    competition: first.competition?.name || null,
    season: first.season?.name || null,
    home: first.team?.name || null, // StatsBomb events carry team per event; true home/away require lineups/lineup files
    away: null
  };
  return { total_events: normalized.length, match };
}
const META = extractMeta();

// ---- SSE server
const clients = new Set();

const server = http.createServer(async (req, res) => {
  const { pathname, query } = url.parse(req.url, true);

  // CORS (simple)
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, events: normalized.length }));
    return;
  }

  if (pathname === '/meta') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(META));
    return;
  }

  if (pathname === '/stream') {
    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ speed: SPEED, events: normalized.length })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));

    // If this is the first client, kick off a replay loop (simple single-run)
    if (clients.size === 1 && !replaying) {
      replay().catch(err => console.error('replay error:', err));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

let replaying = false;
async function replay() {
  if (replaying) return;
  replaying = true;

  let prev = 0;
  for (let i = 0; i < normalized.length; i++) {
    const ev = normalized[i];
    const gap = clamp(((ev.ts - prev) / SPEED) * 1000, 30, 5000); // min 30ms, max 5s for sanity
    await sleep(gap);
    prev = ev.ts;

    const payload = JSON.stringify({ i, ts: ev.ts, event: ev });
    for (const c of clients) {
      c.write(`event: tick\ndata: ${payload}\n\n`);
    }
  }

  // End stream
  for (const c of clients) c.write(`event: done\ndata: {}\n\n`);
  replaying = false;
}

server.listen(PORT, () => {
  console.log(`SB replay server listening on http://localhost:${PORT}`);
  console.log(`Stream: GET /stream   Meta: GET /meta   Health: GET /health`);
});
