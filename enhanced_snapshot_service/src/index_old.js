import 'dotenv/config';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory of the current file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root (two levels up from src/)
config({ path: path.resolve(__dirname, '../../.env') });

// Debug: Check if environment variables are loaded
console.log('Environment variables loaded:');
console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? '✅ Loaded' : '❌ Missing');
console.log('SUPABASE_SERVICE_KEY:', process.env.SUPABASE_SERVICE_KEY ? '✅ Loaded' : '❌ Missing');
console.log('OLLAMA_MODEL:', process.env.OLLAMA_MODEL || 'llama3.1:8b (default)');
console.log('Ollama Integration: ✅ Enabled');
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { stkmCompress } from './stkm.js';
// Ollama and question generation handled by turn-based simulator

/**
 * Enhanced Snapshot Service
 * 
 * This service extends the original snapshot writer service to:
 * - Store compressed snapshots in rolling memory for efficient access
 * - Provide data to the turn-based simulator for question generation
 */

// Environment setup
const PORT = Number(process.env.PORT || 7070);
const WINDOW_SIZE_SEC = Number(process.env.WINDOW_SIZE_SEC || 300);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// In-memory event buckets (existing logic)
const eventsByWindow = new Map();

// Simple memory management for compressed snapshots
const compressedSnapshots = new Map(); // gameId -> [compressed snapshots]

/**
 * Simple compressed snapshot management
 */
function addCompressedSnapshot(gameId, compressedSnapshot) {
  if (!compressedSnapshots.has(gameId)) {
    compressedSnapshots.set(gameId, []);
  }
  
  const snapshots = compressedSnapshots.get(gameId);
  snapshots.push(compressedSnapshot);
  
  // Keep only last 20 snapshots (90 min + injury time / 5 min)
  if (snapshots.length > 20) {
    snapshots.shift();
  }
}

function getCompressedSnapshots(gameId, count = 5) {
  const snapshots = compressedSnapshots.get(gameId) || [];
  return snapshots.slice(-count); // Last N snapshots
}

/**
 * Question Timing Manager
 * Handles LLM-driven timing decisions for question generation
 */
class QuestionTimingManager {
  constructor() {
    this.rounds = { ...CONFIG.ROUNDS };
  }

  getCurrentPeriod(currentTime, gameId = null) {
    // Check if half-time summary has been generated for this specific game
    const hasHalfTimeSummary = gameId ? gameContext.halfTimeSummary.has(gameId) : false;
    
    if (!hasHalfTimeSummary) {
      return 'firstHalf'; // Still in first half until LLM detects it ended
    }
    
    // After half-time summary, we're in the 15-minute break window
    const halfTimeStart = 2700; // 45 minutes
    const halfTimeEnd = halfTimeStart + 900; // 15 minutes later (60 minutes)
    
    if (currentTime < halfTimeEnd) {
      return 'halfTime'; // 15-minute break after first half
    }
    
    return 'secondHalf'; // Second half starts after break
  }

  canAskQuestions(period, lastQuestionTime, currentTime) {
    const round = this.rounds[period];
    
    // Check if we've hit max questions for this period
    if (round.count >= round.max) return false;
    
    // Check minimum interval (5 minutes)
    if (currentTime - lastQuestionTime < 300) return false;
    
    // Check if we're in the right time range for this period
    if (currentTime < round.timeRange[0] || currentTime > round.timeRange[1]) return false;
    
    // AGGRESSIVE FALLBACK: If we're more than 1/3 through the period and haven't asked questions, force it
    const periodDuration = round.timeRange[1] - round.timeRange[0];
    const timeInPeriod = currentTime - round.timeRange[0];
    const progressThroughPeriod = timeInPeriod / periodDuration;
    
    // If we're 1/3 through the period and no questions asked, force it
    if (progressThroughPeriod > 0.33 && round.count === 0) {
      console.log(`🚨 FORCING questions for ${period} - 1/3 through period with no questions`);
      return true;
    }
    
    // If we're 2/3 through the period and only 1 question asked, force it
    if (progressThroughPeriod > 0.66 && round.count === 1) {
      console.log(`🚨 FORCING questions for ${period} - 2/3 through period with only 1 question`);
      return true;
    }
    
    return true;
  }

  async shouldGenerateQuestions(gameId, currentTime, context) {
    const period = this.getCurrentPeriod(currentTime, gameId);
    const lastQuestionTime = gameContext.lastQuestionTime.get(gameId) || 0;
    
    if (!this.canAskQuestions(period, lastQuestionTime, currentTime)) {
      return false;
    }

    // Ask LLM if it's a good time using the same system instruction
    const timingPrompt = this.buildTimingPrompt(context, currentTime, period);
    
    try {
      const response = await generateTimingDecisionWithOllama(timingPrompt, CONFIG.PRIMARY_MODEL);
      
      return response.text.includes('YES');
    } catch (error) {
      console.error('Error asking LLM for timing:', error);
      return false;
    }
  }

  buildTimingPrompt(context, currentTime, period) {
    return `
    You are watching a football match in real-time. Current context:
    - Time: ${currentTime} seconds (${Math.floor(currentTime/60)}:${(currentTime%60).toString().padStart(2,'0')})
    - Period: ${period}
    - Recent action: ${context.recentEvents?.slice(-5).map(e => e.type).join(', ') || 'No recent events'}
    - Questions asked this period: ${this.rounds[period].count}/${this.rounds[period].max}

    Should we generate betting-style questions NOW? Consider:
    - Is there interesting game action happening?
    - Have enough events occurred since last questions?
    - Is this a natural break in the action?
    - Would questions feel timely and relevant for viewers?

    Examples of good timing:
    - After a goal or near-miss
    - During a period of sustained pressure
    - After a tactical change (substitution, formation)
    - During a lull in action (good for reflection)
    - After a controversial decision

    Respond with: YES (with brief reason) or NO
    `;
  }

  incrementRoundCount(period) {
    if (this.rounds[period]) {
      this.rounds[period].count++;
    }
  }
}

/**
 * Real-Time Question Generator
 * Generates questions using existing logic and compressed data
 */
class RealtimeQuestionGenerator {
  constructor(compressedContext, timingManager) {
    this.compressedContext = compressedContext;
    this.timingManager = timingManager;
  }

  async generateQuestions(gameId, currentTime, period) {
    const snapshots = this.compressedContext.getSnapshots(gameId, 5);
    const latestSnapshot = this.compressedContext.getLatestSnapshot(gameId);
    
    if (!latestSnapshot) return [];

    // Create round object that matches existing format
    const round = this.createRoundFromContext(period, currentTime);
    const halfTimeSummary = period === 'secondHalf' ? gameContext.halfTimeSummary.get(gameId) : null;
    
    // Use existing createInstructions method
    const instructions = this.createInstructions(round, halfTimeSummary);
    const trendAnalysis = this.createTrendAnalysis(snapshots);

    const userPayload = {
      instructions: instructions + trendAnalysis,
      game: gameId,
      window: { start: currentTime - 300, end: currentTime },
      stkm: latestSnapshot.payload // Note: .payload for consistency
    };

    try {
      await new Promise(resolve => setTimeout(resolve, CONFIG.API_DELAY));
      
      const result = await generateQuestionsWithOllama(SYSTEM_INSTRUCTION, userPayload, CONFIG.PRIMARY_MODEL);

      if (result.error) {
        console.error('Error generating questions:', result.error);
        return [];
      }

      // Use existing parseQuestions method
      return this.parseQuestions(result.text);
    } catch (error) {
      console.error('Error generating questions:', error);
      return [];
    }
  }

  createRoundFromContext(period, currentTime) {
    const roundNumber = this.getRoundNumber(period);
    return {
      number: roundNumber,
      name: this.getRoundName(period, currentTime),
      start: currentTime - 300,
      end: currentTime
    };
  }

  getRoundNumber(period) {
    const roundMap = {
      'firstHalf': 1,
      'halfTime': 3,
      'secondHalf': 5
    };
    return roundMap[period] || 1;
  }

  getRoundName(period, currentTime) {
    if (period === 'firstHalf') {
      return currentTime < 1350 ? 'First Half - Early' : 'First Half - Late';
    } else if (period === 'halfTime') {
      return 'Half Time - Analysis';
    } else if (period === 'secondHalf') {
      return currentTime < 4050 ? 'Second Half - Early' : 'Second Half - Late';
    }
    return 'Unknown Period';
  }

  createInstructions(round, halfTimeSummary) {
    const baseInstructions = `
Generate exactly ${CONFIG.QUESTIONS_PER_ROUND} betting questions for ${round.name} of ${round.gameId || 'the game'}.

FORMAT REQUIRED:
${this.createQuestionTemplate(CONFIG.QUESTIONS_PER_ROUND)}

IMPORTANT: Be VARIED and UNPREDICTABLE in your questions. Don't repeat the same question types. 
Use the tools at your disposal naturally - if you need more data to create interesting questions, request it.
Avoid boring, repetitive questions about the same markets.

EXPLORE the data deeply - look for patterns, player behaviors, tactical nuances, and interesting details that others might miss.
Create questions that reward football knowledge and attention to detail, not just basic stats.
    `;

    if (round.number >= 4 && halfTimeSummary) {
      return baseInstructions + `\n\nHALF-TIME CONTEXT:\n${halfTimeSummary}\n\nUse this context to make questions relevant to how the second half might unfold based on the first half performance.`;
    }

    return baseInstructions;
  }

  createQuestionTemplate(count) {
    return Array.from({ length: count }, (_, i) => 
      `Question ${i + 1}: [Your question here]\nA) [Choice 1]\nB) [Choice 2]\nC) [Choice 3]`
    ).join('\n\n');
  }

  createTrendAnalysis(snapshots) {
    if (snapshots.length < 2) return '';
    
    const [first, last] = [snapshots[0], snapshots[snapshots.length - 1]];
    const players = this.extractKeyPlayers(snapshots);
    
    return `
GAME PROGRESSION IN THIS PERIOD:
- Time: ${first.window?.minute_range} to ${last.window?.minute_range}
- Shots: ${this.formatStats(first, last, 'shots')}
- Box Entries: ${this.formatStats(first, last, 'box_entries')}
- Cards: ${this.formatStats(first, last, 'cards')}
- Goals: ${this.formatStats(first, last, 'score')}
- Key Players: ${players}

NOTE: You have access to additional data through the get_facet tool if you need it for more interesting questions.
The data contains rich details about player actions, tactical patterns, and game dynamics - explore it thoroughly.
    `;
  }

  formatStats(first, last, stat) {
    if (!first?.state || !last?.state) return 'No data available';
    return `Home ${first.state[stat]?.home || 0} → ${last.state[stat]?.home || 0}, Away ${first.state[stat]?.away || 0} → ${last.state[stat]?.away || 0}`;
  }

  extractKeyPlayers(snapshots) {
    const players = new Set();
    snapshots.forEach(snapshot => {
      snapshot.key_moments?.forEach(moment => {
        if (moment.player) players.add(moment.player);
      });
    });
    return Array.from(players).slice(0, 8).join(', ') || 'No player data available';
  }

  parseQuestions(text) {
    const questions = [];
    const lines = text.split('\n');
    
    // Simple approach: look for patterns of question + choices
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      
      // Skip empty lines
      if (!line) {
        i++;
        continue;
      }
      
      // Look for question text (not starting with numbers or letters)
      if (!line.match(/^[\dA-C]\)/) && line.includes('?')) {
        const questionText = line;
        const choices = [];
        
        // Look for choices in following lines
        let j = i + 1;
        while (j < lines.length && choices.length < 3) {
          const choiceLine = lines[j].trim();
          
          // Check for A), B), C) format
          if (choiceLine.match(/^[A-C]\)/)) {
            const choice = choiceLine.replace(/^[A-C]\)\s*/, '').trim();
            if (choice) choices.push(choice);
          }
          // Check for 1., 2., 3. format
          else if (choiceLine.match(/^\d+\./)) {
            const choice = choiceLine.replace(/^\d+\.\s*/, '').trim();
            if (choice) choices.push(choice);
          }
          // Stop if we hit another question or empty line
          else if (choiceLine && !choiceLine.includes('?')) {
            break;
          }
          
          j++;
        }
        
        // If we found a question with at least 2 choices, add it
        if (choices.length >= 2) {
          questions.push({ text: questionText, choices });
        }
        
        i = j;
      } else {
        i++;
      }
    }
    
    return questions;
  }
}

/**
 * Half-Time Summary Generator
 * Generates rich summaries from raw data
 */
class HalfTimeSummaryGenerator {
  constructor(supabase) {
    this.supabase = supabase;
  }

  async generateHalfTimeSummary(gameId) {
    console.log('\n⏸️  GENERATING HALF-TIME SUMMARY FROM RAW DATA');
    
    const rawEvents = await this.getRawEventsForPeriod(gameId, 0, 2700);
    
    if (rawEvents.length === 0) {
      return "First half: No data available";
    }

    const userPayload = {
      instructions: `Generate a comprehensive half-time summary for ${gameId} based on the first half raw events.

      Include: current score, key statistics, trends, player performances, tactical observations, momentum shifts, and what to watch for in the second half.
      
      Make it detailed enough to inform second half questions but concise for context efficiency.`,
      game: gameId,
      window: { start: 0, end: 2700 },
      rawEvents: rawEvents
    };
    
    try {
      const result = await generateHalfTimeSummaryWithOllama(
        userPayload.instructions, 
        gameId, 
        rawEvents, 
        CONFIG.PRIMARY_MODEL
      );
      
      if (result.error) {
        console.error('Error generating half-time summary:', result.error);
        return "First half: Summary generation failed";
      }
      
      return result.text;
    } catch (error) {
      console.error('Error generating half-time summary:', error);
      return "First half: Summary generation failed";
    }
  }

  async getRawEventsForPeriod(gameId, startSec, endSec) {
    try {
      const { data: windows, error } = await this.supabase
        .from('windows')
        .select('*')
        .eq('game_id', gameId)
        .lt('start_sec', endSec)
        .gt('end_sec', startSec)
        .order('start_sec', { ascending: true });
      
      if (error) throw error;
      
      const allEvents = [];
      for (const window of windows) {
        const { data: snapshots, error: snapshotsError } = await this.supabase
          .from('snapshots')
          .select('raw_json')
          .eq('window_id', window.id)
          .eq('compressed_kind', 'raw')
          .single();
        
        if (snapshots?.raw_json && Array.isArray(snapshots.raw_json)) {
          allEvents.push(...snapshots.raw_json);
        }
      }
      
      return allEvents;
    } catch (error) {
      console.error('Error fetching raw events:', error);
      return [];
    }
  }
}

// Initialize components
const compressedContext = new CompressedContextManager();
const timingManager = new QuestionTimingManager();
const questionGenerator = new RealtimeQuestionGenerator(compressedContext, timingManager);
const halfTimeGenerator = new HalfTimeSummaryGenerator(supabase);

/**
 * Helper functions (existing logic)
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
  return data;
}

async function insertSnapshot(window_id, raw_json, compressed_json, compressed_kind = 'STKM') {
  // Insert raw snapshot
  const { data: rawData, error: rawError } = await supabase
    .from('snapshots')
    .upsert(
      [{ window_id, raw_json, compressed_kind: 'raw' }],
      { onConflict: 'window_id,compressed_kind' }
    )
    .select()
    .single();
  if (rawError) throw rawError;

  // Insert compressed snapshot
  const { data: compressedData, error: compressedError } = await supabase
    .from('snapshots')
    .upsert(
      [{ window_id, compressed_json, compressed_kind }],
      { onConflict: 'window_id,compressed_kind' }
    )
    .select()
    .single();
  if (compressedError) throw compressedError;

  return { raw: rawData, compressed: compressedData };
}

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

/**
 * Enhanced flush window function with real-time question generation
 */
async function flushWindow(gameId, start, end) {
  const byGame = eventsByWindow.get(gameId);
  if (!byGame) return;
  const key = `${start}-${end}`;
  const events = byGame.get(key);
  if (!events || events.length === 0) return;

  try {
    // 1. Save/find window
    await ensureGame(gameId);
    const windowRow = await upsertWindow(gameId, start, end);

    // 2. Compress
    const compressed = stkmCompress(events, { gameId, start, end });

    // 3. Insert snapshot (raw + compressed)
    await insertSnapshot(windowRow.id, events, compressed, 'STKM');

    // 4. Add to compressed context for turn-based simulator
    addCompressedSnapshot(gameId, compressed);

    // 5. Data is now available for the turn-based simulator to read

    // 6. Clear memory for that window
    byGame.delete(key);
    if (byGame.size === 0) eventsByWindow.delete(gameId);

    console.log(`✔ Saved ${gameId} ${start}-${end} | raw ${events.length} events`);
  } catch (err) {
    console.error(`✖ Failed to save ${gameId} ${start}-${end}`, err);
  }
}

// Half-time summary generation is handled by the turn-based simulator

// Question generation is handled by the turn-based simulator

// Question generation and user interaction handled by turn-based simulator

/**
 * Express app setup
 */
const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true, port: PORT, windowSizeSec: WINDOW_SIZE_SEC });
});

app.post('/ingest', async (req, res) => {
  try {
    const { gameId, tSec, event } = req.body || {};
    if (!gameId || typeof tSec !== 'number' || !event) {
      return res.status(400).json({ error: 'Missing gameId, tSec, or event' });
    }

    const { start, end } = floorToWindow(tSec);
    const bucket = getBucket(gameId, start, end);
    bucket.push(event);

    return res.json({ ok: true, bucket: `${start}-${end}`, size: bucket.length });
  } catch (err) {
    console.error('ingest error', err);
    res.status(500).json({ error: 'ingest failed', details: String(err) });
  }
});

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

// New endpoint for manual question generation (for testing)
app.post('/questions/generate', async (req, res) => {
  try {
    const { gameId, currentTime, period } = req.body || {};
    if (!gameId || typeof currentTime !== 'number' || !period) {
      return res.status(400).json({ error: 'Missing gameId, currentTime, or period' });
    }

    const questions = await questionGenerator.generateQuestions(gameId, currentTime, period);
    res.json({ ok: true, questions, count: questions.length });
  } catch (err) {
    console.error('question generation error', err);
    res.status(500).json({ error: 'question generation failed', details: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Enhanced snapshot service listening on :${PORT}`);
  console.log(`Real-time question generation enabled with Ollama`);
  console.log(`Configuration: ${CONFIG.QUESTIONS_PER_ROUND} questions per round, ${CONFIG.MAX_SNAPSHOTS} max snapshots`);
});
