// snapshotter.js
// Create 5-minute raw + compressed (STKM) snapshots from a StatsBomb events JSON.
// Usage:
//   node snapshotter.js --events=./barcelona_alaves_18_08_18.json --gameId=barca-alaves-2018-08-18 --window=300
//
// Output folders:
//   ./snapshots/<gameId>/raw/<start>-<end>.json
//   ./snapshots/<gameId>/compressed/stkm/<start>-<end>.json

const fs = require('fs');
const path = require('path');

function arg(name, defVal=null) {
  const found = process.argv.find(a => a.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : defVal;
}

const EVENTS_PATH = arg('events');
const GAME_ID = arg('gameId', 'game');
const WINDOW = Number(arg('window', '300'));

if (!EVENTS_PATH) {
  console.error('Usage: node snapshotter.js --events=./events.json --gameId=my-game --window=300');
  process.exit(1);
}

const rawText = require('fs').readFileSync(EVENTS_PATH, 'utf8');
let raw = JSON.parse(rawText);
const events = Array.isArray(raw) ? raw : (raw.events || []);

// Helpers
function secondsFor(e) {
  const period = Number(e.period || 1);
  const minute = Number(e.minute || 0);
  const second = Number(e.second || 0);
  // StatsBomb minutes are absolute within period; we'll compute absolute seconds with period offsets.
  const offsets = { 1: 0, 2: 45*60, 3: 90*60, 4: 105*60 };
  return (offsets[period] || 0) + (minute * 60 + second);
}

function intoBox(endLoc) {
  // Simple SB pitch (120x80 approx). Box near x>=102 and y between 18 and 62.
  if (!Array.isArray(endLoc)) return false;
  const [x, y] = endLoc;
  return x >= 102 && y >= 18 && y <= 62;
}

function normalize(e) {
  const tname = e.type?.name || '';
  const team = e.team?.name || null;
  const player = e.player?.name || null;
  const ts = secondsFor({ minute: e.minute, second: e.second, period: e.period });

  if (tname === 'Shot') {
    const s = e.shot || {};
    const outcome = s.outcome?.name || null;
    const goal = outcome === 'Goal';
    const onTarget = ['Saved', 'Saved To Post', 'Goal'].includes(outcome);
    return {
      ts, type: goal ? 'GOAL' : 'SHOT', team, player,
      data: { on_target: onTarget, sp: s.type?.name || 'Open Play', end_location: s.end_location || null }
    };
  }
  if (tname === 'Foul Committed') {
    return { ts, type: 'FOUL', team, player, data: { card: e.foul_committed?.card?.name || null } };
  }
  if (tname === 'Bad Behaviour') {
    return { ts, type: 'CARD', team, player, data: { card: e.bad_behaviour?.card?.name || 'Yellow Card' } };
  }
  if (tname === 'Corner Awarded' || tname === 'Corner') {
    return { ts, type: 'CORNER', team, player };
  }
  if (tname === 'Free Kick Won') {
    // could be used for SPT facet later
    return { ts, type: 'FREE_KICK_WON', team, player };
  }
  if (tname === 'Substitution') {
    return { ts, type: 'SUB', team, player, data: { replacement: e.substitution?.replacement?.name || null } };
  }
  if (tname === 'Goal Keeper') {
    const gkType = e.goalkeeper?.type?.name || '';
    return { ts, type: gkType.toUpperCase().replace(/\s+/g, '_'), team, player };
  }
  if (tname === 'Pass') {
    const p = e.pass || {};
    const keyish = p.shot_assist || p.goal_assist || (p.end_location && intoBox(p.end_location));
    if (keyish) {
      return {
        ts,
        type: p.goal_assist ? 'ASSIST' : (p.shot_assist ? 'KEY_PASS' : 'PASS_INTO_BOX'),
        team, player
      };
    }
  }
  return null;
}

const norm = events.map(normalize).filter(Boolean).sort((a,b)=>a.ts-b.ts);
const maxTs = norm.length ? norm[norm.length-1].ts : 0;

// Prepare output dirs
const outRoot = path.join(process.cwd(), 'snapshots', GAME_ID);
const rawDir = path.join(outRoot, 'raw');
const stkmDir = path.join(outRoot, 'compressed', 'stkm');
fs.mkdirSync(rawDir, { recursive: true });
fs.mkdirSync(stkmDir, { recursive: true });

// Windowing
const windows = [];
for (let start=0; start<=maxTs; start+=WINDOW) {
  const end = start + WINDOW;
  const slice = norm.filter(ev => ev.ts >= start && ev.ts < end);
  windows.push({ start, end, events: slice });
}

// Simple team identifiers (fallbacks if names absent)
function detectTeams(all) {
  const names = [...new Set(all.map(e => e.team).filter(Boolean))];
  if (names.length >= 2) return [names[0], names[1]];
  return ['Home', 'Away'];
}
const [homeTeam, awayTeam] = detectTeams(norm);

// Build running score tracking
let runningScore = { [homeTeam]: 0, [awayTeam]: 0 };

function computeSTKM(win, prevStkm) {
  // counts
  const count = (type, team=null) => win.events.filter(e=>e.type===type && (!team || e.team===team)).length;
  const shotOnTarget = (team) =>
    win.events.filter(e => e.team===team && (e.type==='GOAL' || (e.type==='SHOT' && e.data?.on_target))).length;
  const boxEntries = (team) => win.events.filter(e => e.type==='PASS_INTO_BOX' && e.team===team).length;
  const cards = (team) => win.events.filter(e => e.type==='CARD' && e.team===team).length;
  const fouls = (team) => win.events.filter(e => e.type==='FOUL' && e.team===team).length;
  const corners = (team) => win.events.filter(e => e.type==='CORNER' && e.team===team).length;

  // Update running score for any goals inside this window
  const goalsHome = count('GOAL', homeTeam);
  const goalsAway = count('GOAL', awayTeam);
  runningScore[homeTeam] += goalsHome;
  runningScore[awayTeam] += goalsAway;

  const state = {
    shots: {
      home: count('SHOT', homeTeam) + goalsHome,
      away: count('SHOT', awayTeam) + goalsAway
    },
    shots_on_target: {
      home: shotOnTarget(homeTeam),
      away: shotOnTarget(awayTeam)
    },
    box_entries: {
      home: boxEntries(homeTeam),
      away: boxEntries(awayTeam)
    },
    corners: {
      home: corners(homeTeam),
      away: corners(awayTeam)
    },
    fouls: {
      home: fouls(homeTeam),
      away: fouls(awayTeam)
    },
    cards: {
      home: cards(homeTeam),
      away: cards(awayTeam)
    }
  };

  // key moments: last 4 impactful events
  const impactful = win.events.filter(e => ['GOAL','SHOT','CORNER','CARD','FOUL','PASS_INTO_BOX','KEY_PASS','ASSIST'].includes(e.type));
  const key_moments = impactful.slice(-4).map(e => {
    const out = { ts: e.ts, type: e.type, team: e.team || null };
    if (e.player) out.player = e.player;
    if (e.data?.on_target) out.on_target = true;
    if (e.data?.card) out.card = e.data.card;
    return out;
  });

  const stkm = {
    window: {
      start: win.start,
      end: win.end,
      minute_range: `${Math.floor(win.start/60)}-${Math.floor(win.end/60)}`,
      period: win.end <= 45*60 ? 1 : (win.end <= 90*60 ? 2 : 3)
    },
    score: { home: runningScore[homeTeam], away: runningScore[awayTeam], home_name: homeTeam, away_name: awayTeam },
    state,
    key_moments
  };

  if (prevStkm) {
    stkm.trends_vs_prev = {
      shot_delta: {
        home: state.shots.home - (prevStkm.state?.shots?.home || 0),
        away: state.shots.away - (prevStkm.state?.shots?.away || 0)
      },
      card_delta: {
        home: state.cards.home - (prevStkm.state?.cards?.home || 0),
        away: state.cards.away - (prevStkm.state?.cards?.away || 0)
      },
      corner_delta: {
        home: state.corners.home - (prevStkm.state?.corners?.home || 0),
        away: state.corners.away - (prevStkm.state?.corners?.away || 0)
      }
    };
  }

  return stkm;
}

// Write snapshots
let prevStkm = null;
for (const w of windows) {
  if (!w.events.length) continue;

  // write raw
  const rawPath = path.join(rawDir, `${w.start}-${w.end}.json`);
  fs.writeFileSync(rawPath, JSON.stringify(w.events, null, 2));

  // write STKM
  const stkm = computeSTKM(w, prevStkm);
  const stkmPath = path.join(stkmDir, `${w.start}-${w.end}.json`);
  fs.writeFileSync(stkmPath, JSON.stringify(stkm, null, 2));

  prevStkm = stkm;
}

console.log(`Wrote snapshots to ${outRoot}`);
