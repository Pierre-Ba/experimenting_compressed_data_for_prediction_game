// llm-gemini/run_stkm_local.js
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { generateWithTools, resolveOneToolCallAndContinue } from './client.js';
import { SYSTEM_INSTRUCTION } from './prompt.js';

// ---- Env / defaults ----
const GAME_ID = process.env.GAME_ID || 'barcelona-atletico-2018-11-24';
const WINDOW_START = Number(process.env.WINDOW_START || 0);
const WINDOW_END = Number(process.env.WINDOW_END || 300);
const STKM_FILE =
  process.env.STKM_FILE ||
  // <= If you keep sample_stkm.json in llm-gemini/, run this file from repo root:
  path.join(process.cwd(), 'sample_stkm.json');

// ---- Load STKM snapshot ----
const stkm = JSON.parse(fs.readFileSync(STKM_FILE, 'utf8'));

(async () => {
  try {
    // Build the payload (include your Studio-like nudge here)
    const userPayload = {
      instructions: `
You are given a compressed 5-minute football snapshot ("stkm") for ${GAME_ID} covering ${WINDOW_START}–${WINDOW_END}s.
If this is enough, generate 2–4 multiple-choice betting questions (3 choices each), tied to betting markets.
If you need more detail, call function get_facet with one of: PTF, PAD, SPT, FTT, PCS, KH, MMH, NCMS.
Use only the provided data (snapshot or facet). Do not use any other sources.
`,
      game: GAME_ID,
      window: { start: WINDOW_START, end: WINDOW_END },
      stkm
    };

    // 1) First turn
    const firstTurn = await generateWithTools({
      systemInstruction: SYSTEM_INSTRUCTION,
      userPayload
    });

    if (firstTurn.firstCall) {
      console.log('🔧 TOOL CALL (first turn):', JSON.stringify(firstTurn.firstCall, null, 2));
      console.log('📡 Fetching facet data...');
    } else {
      console.log('✅ NO TOOL CALL on first turn - generating questions directly.');
    }

    // 2) Resolve exactly one tool call (if any), then print final text
    const finalTurn = await resolveOneToolCallAndContinue(firstTurn, {
      systemInstruction: SYSTEM_INSTRUCTION,
      userPayload
    });

    const finalText = finalTurn.text || '(empty text)';
    console.log('\n🎯 GENERATED QUESTIONS:');
    console.log('=' .repeat(50));
    console.log(finalText);
    console.log('=' .repeat(50));

    // Optional: if still empty, dump a compact view for debugging
    if (!finalTurn.text) {
      console.log('DEBUG raw resp (compact):',
        JSON.stringify({
          hasCandidates: !!finalTurn?.resp?.candidates,
          hasResponseTextFn: typeof finalTurn?.resp?.response?.text === 'function',
          firstCallPresent: !!firstTurn.firstCall
        })
      );
    }
  } catch (err) {
    console.error('run_stkm_local failed:', err);
    process.exitCode = 1;
  }
})();
