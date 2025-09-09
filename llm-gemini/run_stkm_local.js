import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { generateWithTools, resolveOneToolCallAndContinue } from './client.js';
import { SYSTEM_INSTRUCTION } from './prompt.js';

const GAME_ID = process.env.GAME_ID || 'barcelona-atletico-2018-11-24';
const STKM_FILE = process.env.STKM_FILE || path.join(process.cwd(), 'sample_stkm.json');
const WINDOW_START = Number(process.env.WINDOW_START || 0);
const WINDOW_END   = Number(process.env.WINDOW_END   || 300);

// Guard: STKM file must exist
if (!fs.existsSync(STKM_FILE)) {
  console.error(`STKM file not found at: ${STKM_FILE}
- Either copy a 5-min compressed snapshot to ./llm-gemini/sample_stkm.json
- Or set STKM_FILE to its path, e.g.:
  STKM_FILE=./snapshots/<game-id>/compressed/0-300.json node llm-gemini/run_stkm_local.js`);
  process.exit(1);
}

const stkm = JSON.parse(fs.readFileSync(STKM_FILE, 'utf8'));

// Ask for JSON in the instruction text (since we’re not forcing a MIME type)
const userPayload = {
  instructions:
`Return JSON only: { "run_now": boolean, "reason": string, "batches": { "A":[...], "B":[...] } }.
Each question: { "market": "...", "prompt": "...", "options":[{label, market_key}], "settle": {"start": <sec>, "end": <sec>} }.
Use this compressed window (STKM). If you need more details, call get_facet.`,
  game: GAME_ID,
  window: { start: WINDOW_START, end: WINDOW_END },
  stkm
};

// 1) first call
let resp = await generateWithTools({
  systemInstruction: SYSTEM_INSTRUCTION,
  userPayload
});

// 2) resolve one tool call if present, then continue
resp = await resolveOneToolCallAndContinue(resp, {
  systemInstruction: SYSTEM_INSTRUCTION,
  userPayload
});

// Helper: extract text regardless of shape
function extractText(r) {
  const parts = r?.candidates?.[0]?.content?.parts || [];
  const txt = parts.filter(p => typeof p.text === 'string').map(p => p.text).join('');
  return txt || '';
}

// 3) print result
const outText = extractText(resp);
console.log(outText || '(empty text)');

try {
  const out = JSON.parse(outText);
  console.log('\nBatches summary:', {
    A: out?.batches?.A?.length || 0,
    B: out?.batches?.B?.length || 0
  });
} catch {
  // raw print above is fine if not valid JSON
}
