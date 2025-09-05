// make_experiment.js
// Bundle a 30-min (configurable) experiment block into 3 arms:
//  - raw.json        (concatenated raw windows)
//  - compressed.json (concatenated STKM windows)
//  - summary.txt     (deterministic text summaries from STKM)
//
// Usage:
//   node make_experiment.js --gameId=barca-alaves-2018-08-18 --from=2700 --duration=1800
//
// Outputs under: ./experiments/<gameId>/<from>-<end>/{raw.json, compressed.json, summary.txt}

const fs = require('fs');
const path = require('path');

function arg(name, defVal=null) {
  const found = process.argv.find(a => a.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : defVal;
}

const GAME_ID = arg('gameId', 'game');
const FROM = Number(arg('from', '900'));       // default 45:00
const DURATION = Number(arg('duration', '1800')); // default 30 minutes
const TO = FROM + DURATION;

const root = path.join(process.cwd(), 'snapshots', GAME_ID);
const rawDir = path.join(root, 'raw');
const stkmDir = path.join(root, 'compressed', 'stkm');

if (!fs.existsSync(rawDir) || !fs.existsSync(stkmDir)) {
  console.error('Snapshots not found. Run snapshotter.js first.');
  process.exit(1);
}

// collect windows overlapping [FROM, TO)
function listFiles(dir) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
}
function parseRange(filename) {
  const [start,end] = filename.replace('.json','').split('-').map(Number);
  return { start, end };
}

const rawFiles = listFiles(rawDir).map(f => ({ f, ...parseRange(f) }))
  .filter(r => r.start >= FROM && r.end <= TO)
  .sort((a,b)=>a.start-b.start);

const stkmFiles = listFiles(stkmDir).map(f => ({ f, ...parseRange(f) }))
  .filter(r => r.start >= FROM && r.end <= TO)
  .sort((a,b)=>a.start-b.start);

// load
const rawSlices = rawFiles.flatMap(r => JSON.parse(fs.readFileSync(path.join(rawDir, r.f), 'utf8')));
const stkmSlices = stkmFiles.map(r => JSON.parse(fs.readFileSync(path.join(stkmDir, r.f), 'utf8')));

// deterministic text summaries
function toTextSummary(stkm) {
  const m = stkm.window.minute_range;
  const s = stkm.state;
  const parts = [];
  parts.push(`Minutes ${m}.`);
  parts.push(`Shots Home ${s.shots.home}, Away ${s.shots.away}. On target Home ${s.shots_on_target.home}, Away ${s.shots_on_target.away}.`);
  if (s.corners.home + s.corners.away > 0) parts.push(`Corners Home ${s.corners.home}, Away ${s.corners.away}.`);
  if (s.cards.home + s.cards.away > 0) parts.push(`Cards Home ${s.cards.home}, Away ${s.cards.away}.`);
  if (s.box_entries.home + s.box_entries.away > 0) parts.push(`Box entries Home ${s.box_entries.home}, Away ${s.box_entries.away}.`);
  const km = (stkm.key_moments || []).slice(-1)[0];
  if (km) {
    const team = km.team || 'Unknown';
    const t = km.type;
    parts.push(`Recent moment: ${team} ${t}.`);
  }
  return parts.join(' ');
}

const summaryText = stkmSlices.map(toTextSummary).join('\n');

// write experiment bundle
const expDir = path.join(process.cwd(), 'experiments', GAME_ID, `${FROM}-${TO}`);
fs.mkdirSync(expDir, { recursive: true });
fs.writeFileSync(path.join(expDir, 'raw.json'), JSON.stringify(rawSlices, null, 2));
fs.writeFileSync(path.join(expDir, 'compressed.json'), JSON.stringify(stkmSlices, null, 2));
fs.writeFileSync(path.join(expDir, 'summary.txt'), summaryText);

console.log(`Wrote experiment bundle to ${expDir}`);
