// game_simulator_refactored.js
// Clean, maintainable football quiz simulator

import 'dotenv/config';
import { getCompressedSnapshots } from './supabase_reader.js';
import { generateWithTools, resolveOneToolCallAndContinue } from './llm-gemini/client.js';
import { SYSTEM_INSTRUCTION } from './llm-gemini/prompt.js';
import readline from 'readline';

// Configuration
const CONFIG = {
  GAME_ID: process.env.GAME_ID || 'barcelona-atletico-2018-11-24',
  TEAMS: { HOME: 'Barcelona', AWAY: 'Atlético Madrid' },
  HALF_TIME: 2700,
  GAME_END: 5400,
  QUESTIONS_PER_ROUND: 7,
  QUESTIONS_TO_ANSWER: 2,
  API_DELAY: 3000,
  ROUND_DELAY: 2000,
  // Model configuration
  PRIMARY_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  FALLBACK_MODELS: ['gemini-2.5-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  MAX_RETRIES: 3,
  RETRY_DELAYS: [5000, 10000, 15000], // Progressive delays
  MODEL_CHECK_INTERVAL: 30000 // Check model status every 30 seconds
};

const ROUNDS = [
  { number: 1, name: 'First Half - Early', start: 0, end: 1350 },
  { number: 2, name: 'First Half - Late', start: 1350, end: CONFIG.HALF_TIME },
  { number: 3, name: 'Half Time - Analysis', start: CONFIG.HALF_TIME, end: CONFIG.HALF_TIME },
  { number: 4, name: 'Half Time - Predictions', start: CONFIG.HALF_TIME, end: CONFIG.HALF_TIME },
  { number: 5, name: 'Second Half - Early', start: CONFIG.HALF_TIME, end: 4050 },
  { number: 6, name: 'Second Half - Late', start: 4050, end: CONFIG.GAME_END }
];

// Utility functions
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const askQuestion = (question) => new Promise((resolve) => {
  rl.question(question, resolve);
});

const formatStats = (first, last, stat) => {
  if (!first?.payload?.state || !last?.payload?.state) return 'No data available';
  return `${CONFIG.TEAMS.HOME} ${first.payload.state[stat]?.home || 0} → ${last.payload.state[stat]?.home || 0}, ${CONFIG.TEAMS.AWAY} ${first.payload.state[stat]?.away || 0} → ${last.payload.state[stat]?.away || 0}`;
};

const createQuestionTemplate = (count) => Array.from({ length: count }, (_, i) => 
  `Question ${i + 1}: [Your question here]\nA) [Choice 1]\nB) [Choice 2]\nC) [Choice 3]`
).join('\n\n');

// Model management utilities
class ModelManager {
  constructor() {
    this.currentModel = CONFIG.PRIMARY_MODEL;
    this.modelStatus = new Map(); // Track model availability
    this.lastCheck = 0;
  }

  async checkModelStatus(model) {
    const now = Date.now();
    if (now - this.lastCheck < CONFIG.MODEL_CHECK_INTERVAL) {
      return this.modelStatus.get(model) || true; // Assume available if not recently checked
    }

    try {
      // More realistic health check - test with actual question generation payload
      const testPayload = {
        instructions: 'Generate 2 questions about this match data. Respond with just "OK" if you understand.',
        game: CONFIG.GAME_ID,
        window: { start: 0, end: 300 },
        stkm: { 
          score: { home: 0, away: 0 },
          possession: { home: 60, away: 40 },
          shots: { home: 2, away: 1 }
        }
      };

      const startTime = Date.now();
      const result = await generateWithTools({
        systemInstruction: 'You are a football analyst. Generate questions about match data.',
        userPayload: testPayload,
        model: model
      });
      
      const responseTime = Date.now() - startTime;
      // Check if we got a valid response (not empty, not just function calls)
      const hasValidText = result.text && result.text.length > 10 && !result.text.includes('[Function call:');
      const isHealthy = hasValidText && responseTime < 15000; // Longer timeout for realistic test
      
      this.modelStatus.set(model, isHealthy);
      this.lastCheck = now;
      
      console.log(`🔍 Model ${model} status: ${isHealthy ? '✅ Available' : '❌ Unavailable'} (${responseTime}ms)`);
      if (!isHealthy && result.text) {
        console.log(`   📄 Response preview: "${result.text.substring(0, 100)}..."`);
      }
      return isHealthy;
    } catch (error) {
      console.log(`🔍 Model ${model} status: ❌ Error - ${error.message}`);
      this.modelStatus.set(model, false);
      this.lastCheck = now;
      return false;
    }
  }

  async getAvailableModel() {
    // Check current model first
    if (await this.checkModelStatus(this.currentModel)) {
      return this.currentModel;
    }

    // Try fallback models
    for (const fallbackModel of CONFIG.FALLBACK_MODELS) {
      if (fallbackModel !== this.currentModel && await this.checkModelStatus(fallbackModel)) {
        console.log(`🔄 Switching from ${this.currentModel} to ${fallbackModel}`);
        this.currentModel = fallbackModel;
        return fallbackModel;
      }
    }

    // If all models are down, return primary model anyway (let the retry logic handle it)
    console.log(`⚠️  All models appear unavailable, using primary model: ${this.currentModel}`);
    return this.currentModel;
  }

  getModelInfo() {
    return {
      current: this.currentModel,
      status: Object.fromEntries(this.modelStatus),
      lastCheck: new Date(this.lastCheck).toISOString()
    };
  }
}

// Question generation utilities
class QuestionGenerator {
  static createInstructions(round, halfTimeSummary = null) {
    const baseInstructions = `
Generate exactly ${CONFIG.QUESTIONS_PER_ROUND} betting questions for ${round.name} of ${CONFIG.GAME_ID}.

FORMAT REQUIRED:
${createQuestionTemplate(CONFIG.QUESTIONS_PER_ROUND)}

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

  static createTrendAnalysis(snapshots) {
    if (snapshots.length < 2) return '';
    
    const [first, last] = [snapshots[0], snapshots[snapshots.length - 1]];
    const players = this.extractKeyPlayers(snapshots);
    
    return `
GAME PROGRESSION IN THIS PERIOD:
- Time: ${first.minute_range} to ${last.minute_range}
- Shots: ${formatStats(first, last, 'shots')}
- Box Entries: ${formatStats(first, last, 'box_entries')}
- Cards: ${formatStats(first, last, 'cards')}
- Goals: ${formatStats(first, last, 'score')}
- Key Players: ${players}

NOTE: You have access to additional data through the get_facet tool if you need it for more interesting questions.
The data contains rich details about player actions, tactical patterns, and game dynamics - explore it thoroughly.
    `;
  }

  static extractKeyPlayers(snapshots) {
    const players = new Set();
    snapshots.forEach(snapshot => {
      snapshot.payload.key_moments?.forEach(moment => {
        if (moment.player) players.add(moment.player);
      });
    });
    return Array.from(players).slice(0, 8).join(', ') || 'No player data available';
  }

  static async generateQuestions(snapshots, round, halfTimeSummary = null, modelManager = null) {
    if (snapshots.length === 0) return [];

    const instructions = this.createInstructions(round, halfTimeSummary);
    const trendAnalysis = this.createTrendAnalysis(snapshots);
    const latestSnapshot = snapshots[snapshots.length - 1];

    const userPayload = {
      instructions: instructions + trendAnalysis,
      game: CONFIG.GAME_ID,
      window: { start: round.start, end: round.end },
      stkm: latestSnapshot.payload
    };

    // Try with progressive retry strategy
    for (let attempt = 0; attempt < CONFIG.MAX_RETRIES; attempt++) {
      try {
        // Get available model
        const model = modelManager ? await modelManager.getAvailableModel() : CONFIG.PRIMARY_MODEL;
        console.log(`   🤖 Using model: ${model} (attempt ${attempt + 1}/${CONFIG.MAX_RETRIES})`);
        
        await new Promise(resolve => setTimeout(resolve, CONFIG.API_DELAY));
        
        const firstTurn = await generateWithTools({
          systemInstruction: SYSTEM_INSTRUCTION,
          userPayload,
          model: model
        });

        const finalTurn = await resolveOneToolCallAndContinue(firstTurn, {
          systemInstruction: SYSTEM_INSTRUCTION,
          userPayload,
          model: model
        });

        // Debug: Check final response
        console.log(`   🔍 DEBUG: Final response length: ${finalTurn.text?.length || 0} characters`);
        if (finalTurn.text) {
          console.log(`   🔍 DEBUG: Final text preview: "${finalTurn.text.substring(0, 100)}..."`);
        }

        const questions = this.parseQuestions(finalTurn.text);
        
        // Debug: Show what the LLM actually returned if no questions were parsed
        if (questions.length === 0) {
          console.log(`   ❌ LLM generated no questions`);
          console.log(`   📄 Response length: ${finalTurn.text?.length || 0} characters`);
          if (finalTurn.text) {
            console.log(`   📄 Response preview: "${finalTurn.text.substring(0, 200)}..."`);
          }
          if (finalTurn.error) {
            console.log(`   ❌ Error: ${finalTurn.error.message}`);
          }
          // Check if model status was misleading
          if (modelManager) {
            const modelStatus = modelManager.modelStatus.get(model);
            if (modelStatus) {
              console.log(`   ⚠️  Model ${model} was marked as available but generation failed - status check may be unreliable`);
            }
          }
        } else {
          console.log(`   ✅ Successfully generated ${questions.length} questions with ${model}`);
          return questions;
        }

        // If we got here, questions were empty but no error - try next attempt
        if (attempt < CONFIG.MAX_RETRIES - 1) {
          const delay = CONFIG.RETRY_DELAYS[attempt] || 10000;
          console.log(`   ⏳ No questions generated, retrying in ${delay/1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }

      } catch (error) {
        console.error(`   ❌ Attempt ${attempt + 1} failed: ${error.message}`);
        
        // Check if it's a model-specific error
        if (error.message.includes('429') || error.message.includes('503') || error.message.includes('UNAVAILABLE')) {
          if (modelManager) {
            console.log(`   🔄 Model appears overloaded, will try different model on next attempt`);
          }
        }
        
        // If this is the last attempt, give up
        if (attempt === CONFIG.MAX_RETRIES - 1) {
          console.error(`❌ All ${CONFIG.MAX_RETRIES} attempts failed`);
          return [];
        }
        
        // Wait before next attempt
        const delay = CONFIG.RETRY_DELAYS[attempt] || 10000;
        console.log(`   ⏳ Waiting ${delay/1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    return [];
  }

  static parseQuestions(text) {
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

  static createFallbackQuestions(round) {
    return [
      { text: `In this ${round.name.toLowerCase()} period, which team will have more possession?`, choices: [CONFIG.TEAMS.HOME, CONFIG.TEAMS.AWAY, 'Equal possession'] },
      { text: `Will there be a goal scored in the next 15 minutes?`, choices: [`Yes, ${CONFIG.TEAMS.HOME} scores`, `Yes, ${CONFIG.TEAMS.AWAY} scores`, 'No goal'] },
      { text: `Will we see a yellow card in this period?`, choices: [`Yes, to ${CONFIG.TEAMS.HOME} player`, `Yes, to ${CONFIG.TEAMS.AWAY} player`, 'No cards'] },
      { text: `Which team will have more shots on target?`, choices: [CONFIG.TEAMS.HOME, CONFIG.TEAMS.AWAY, 'Equal shots on target'] },
      { text: `Will there be a corner kick in this period?`, choices: [`Yes, ${CONFIG.TEAMS.HOME} corner`, `Yes, ${CONFIG.TEAMS.AWAY} corner`, 'No corners'] },
      { text: `Which team will commit more fouls?`, choices: [CONFIG.TEAMS.HOME, CONFIG.TEAMS.AWAY, 'Equal fouls'] },
      { text: `Will there be a substitution in this period?`, choices: [`Yes, ${CONFIG.TEAMS.HOME} substitution`, `Yes, ${CONFIG.TEAMS.AWAY} substitution`, 'No substitutions'] }
    ];
  }
}

// Answer resolution utilities
class AnswerResolver {
  static async determineCorrectAnswer(pendingQuestion, gameTime = null) {
    const question = pendingQuestion.question.toLowerCase();
    const time = gameTime || pendingQuestion.gameTime;
    
    try {
      const snapshots = await getCompressedSnapshots(CONFIG.GAME_ID, 0, time);
      if (snapshots.length === 0) return null;
      
      const stkm = snapshots[snapshots.length - 1].payload;
      return this.analyzeQuestion(question, stkm);
    } catch (error) {
      console.error(`❌ Error determining answer: ${error.message}`);
      return null;
    }
  }

  static analyzeQuestion(question, stkm) {
    const analyzers = [
      { pattern: ['goal', 'score'], fn: () => this.analyzeGoals(stkm) },
      { pattern: ['yellow card', 'card'], fn: () => this.analyzeCards(stkm) },
      { pattern: ['possession'], fn: () => this.analyzePossession(stkm) },
      { pattern: ['shot', 'target'], fn: () => this.analyzeShotsOnTarget(stkm) }
    ];

    for (const analyzer of analyzers) {
      if (analyzer.pattern.some(p => question.includes(p))) {
        return analyzer.fn();
      }
    }
    return null;
  }

  static analyzeGoals(stkm) {
    const [home, away] = [stkm?.score?.home || 0, stkm?.score?.away || 0];
    if (home > 0 && away === 0) return 'A';
    if (away > 0 && home === 0) return 'B';
    if (home === 0 && away === 0) return 'C';
    if (home > away) return 'A';
    if (away > home) return 'B';
    return null;
  }

  static analyzeCards(stkm) {
    const [home, away] = [stkm?.state?.cards?.home || 0, stkm?.state?.cards?.away || 0];
    if (home > 0 && away === 0) return 'A';
    if (away > 0 && home === 0) return 'B';
    if (home === 0 && away === 0) return 'C';
    return null;
  }

  static analyzePossession(stkm) {
    const [home, away] = [stkm?.state?.possession?.home || 0, stkm?.state?.possession?.away || 0];
    if (home > away) return 'A';
    if (away > home) return 'B';
    return 'C';
  }

  static analyzeShotsOnTarget(stkm) {
    const [home, away] = [stkm?.state?.shots?.home_on_target || 0, stkm?.state?.shots?.away_on_target || 0];
    if (home > away) return 'A';
    if (away > home) return 'B';
    return 'C';
  }
}

// Main game simulator class
class GameSimulator {
  constructor() {
    this.score = 0;
    this.totalQuestions = 0;
    this.halfTimeSummary = null;
    this.pendingQuestions = [];
    this.modelManager = new ModelManager();
  }

  async loadSnapshotsForRound(round) {
    if (round.start === round.end) return [];
    const snapshots = await getCompressedSnapshots(CONFIG.GAME_ID, round.start, round.end);
    console.log(`📊 Found ${snapshots.length} snapshots for ${round.name}`);
    return snapshots;
  }

  async playRound(round) {
    console.log(`\n🎯 ROUND ${round.number}: ${round.name}`);
    console.log('='.repeat(50));

    if (round.number === 3) {
      await this.generateHalfTimeSummary();
      return;
    }

    if (round.number === 4) {
      await this.generateHalfTimePredictions();
      return;
    }

    const snapshots = await this.loadSnapshotsForRound(round);
    let questions = await QuestionGenerator.generateQuestions(snapshots, round, this.halfTimeSummary, this.modelManager);

    if (questions.length === 0) {
      console.log('   ⚠️  No questions generated, creating fallback questions...');
      questions = QuestionGenerator.createFallbackQuestions(round);
    }

    if (questions.length === 0) {
      console.log('❌ No questions available, skipping round');
      return;
    }

    await this.handleUserInteraction(questions, round);
  }

  async handleUserInteraction(questions, round) {
    console.log(`\n📝 Generated ${questions.length} Questions:`);
    questions.forEach((q, i) => {
      console.log(`\n${i + 1}. ${q.text}`);
      q.choices.forEach((choice, j) => {
        console.log(`   ${String.fromCharCode(65 + j)}) ${choice}`);
      });
    });

    const questionChoices = await askQuestion(`\nPick 2 questions to answer (enter numbers 1-${questions.length}, separated by comma): `);
    const selectedIndices = questionChoices.split(',').map(s => parseInt(s.trim()) - 1);

    if (selectedIndices.length !== CONFIG.QUESTIONS_TO_ANSWER || selectedIndices.some(i => i < 0 || i >= questions.length)) {
      console.log('Invalid choice, please select exactly 2 valid question numbers');
      return;
    }

    for (let i = 0; i < CONFIG.QUESTIONS_TO_ANSWER; i++) {
      const questionIndex = selectedIndices[i];
      const selectedQuestion = questions[questionIndex];
      
      console.log(`\n🎯 Question ${i + 1}/2: ${selectedQuestion.text}`);
      selectedQuestion.choices.forEach((choice, j) => {
        console.log(`${String.fromCharCode(65 + j)}) ${choice}`);
      });

      const answer = await askQuestion(`\nYour answer (A, B, or C): `);
      
      this.pendingQuestions.push({
        question: selectedQuestion.text,
        yourAnswer: answer.toUpperCase(),
        round: round.number,
        roundName: round.name,
        gameTime: round.end,
        resolved: false
      });
      
      console.log(`✅ Answer ${i + 1} recorded!`);
      this.totalQuestions++;
    }
  }

  async generateHalfTimeSummary() {
    console.log('\n⏸️  HALF TIME SUMMARY');
    console.log('='.repeat(30));
    
    await this.resolvePendingQuestions(CONFIG.HALF_TIME);
    
    try {
      const snapshots = await getCompressedSnapshots(CONFIG.GAME_ID, 0, CONFIG.HALF_TIME);
      if (snapshots.length === 0) {
        this.halfTimeSummary = "First half: No data available";
        return;
      }

      const trendAnalysis = QuestionGenerator.createTrendAnalysis(snapshots);
      const userPayload = {
        instructions: `Generate a comprehensive half-time summary for ${CONFIG.GAME_ID} based on the first half data.\n\nInclude: current score, key statistics, trends, player performances, tactical observations, momentum shifts, and what to watch for in the second half.\n\nMake it detailed enough to inform second half questions but concise for context efficiency.` + trendAnalysis,
        game: CONFIG.GAME_ID,
        window: { start: 0, end: CONFIG.HALF_TIME },
        stkm: snapshots[snapshots.length - 1].payload
      };
      
      const result = await generateWithTools({
        systemInstruction: SYSTEM_INSTRUCTION,
        userPayload
      });
      
      this.halfTimeSummary = result.text;
      console.log(`✅ Half-time summary generated: ${this.halfTimeSummary.substring(0, 100)}...`);
    } catch (error) {
      console.error(`❌ Error generating half-time summary: ${error.message}`);
      this.halfTimeSummary = "First half: Summary generation failed";
    }
  }

  async generateHalfTimePredictions() {
    console.log('\n🔮 HALF TIME PREDICTIONS');
    console.log('='.repeat(30));
    
    try {
      const snapshots = await getCompressedSnapshots(CONFIG.GAME_ID, 0, CONFIG.HALF_TIME);
      if (snapshots.length === 0) {
        console.log('⚠️  No first half data available for predictions');
        return;
      }

      const userPayload = {
        instructions: `Generate 3-5 betting-style prediction questions for the second half of ${CONFIG.GAME_ID} based on the first half performance.\n\nCreate informed predictions about: tactical adjustments, player substitutions, momentum shifts, score predictions, goal timing, set piece opportunities.\n\nEach question should have 3 mutually exclusive choices and be based on observable first half patterns.` + (this.halfTimeSummary ? `\n\nHALF-TIME CONTEXT:\n${this.halfTimeSummary}` : ''),
        game: CONFIG.GAME_ID,
        window: { start: CONFIG.HALF_TIME, end: CONFIG.GAME_END },
        stkm: snapshots[snapshots.length - 1].payload
      };
      
      const result = await generateWithTools({
        systemInstruction: SYSTEM_INSTRUCTION,
        userPayload
      });
      
      const predictions = QuestionGenerator.parseQuestions(result.text);
      console.log(`✅ Generated ${predictions.length} half-time predictions`);
      
      if (predictions.length > 0) {
        console.log('\n🔮 HALF-TIME PREDICTIONS:');
        predictions.forEach((q, i) => {
          console.log(`\n${i + 1}. ${q.text}`);
          q.choices.forEach((choice, j) => {
            console.log(`   ${String.fromCharCode(65 + j)}) ${choice}`);
          });
        });
      }
    } catch (error) {
      console.error(`❌ Error generating half-time predictions: ${error.message}`);
    }
  }

  async resolvePendingQuestions(currentGameTime) {
    for (const pending of this.pendingQuestions) {
      if (pending.resolved || currentGameTime < pending.gameTime) continue;
      
      console.log(`\n🔍 Resolving question from ${pending.roundName}:`);
      console.log(`   Q: ${pending.question}`);
      console.log(`   Your answer: ${pending.yourAnswer}`);
      
      const actualAnswer = await AnswerResolver.determineCorrectAnswer(pending, currentGameTime);
      
      if (actualAnswer) {
        const isCorrect = pending.yourAnswer === actualAnswer;
        if (isCorrect) {
          this.score++;
          console.log(`✅ Correct! +1 point (Answer was ${actualAnswer})`);
        } else {
          console.log(`❌ Incorrect. The answer was ${actualAnswer}`);
        }
        pending.resolved = true;
        console.log(`   Current score: ${this.score}/${this.totalQuestions}`);
      } else {
        console.log(`⏳ Cannot resolve this question yet - need more data`);
      }
    }
  }

  async showFinalResults() {
    console.log('\n🏆 FINAL RESULTS');
    console.log('='.repeat(30));
    
    console.log('🔍 Resolving all questions with final game data...');
    await this.resolveAllQuestions();
    
    console.log(`\n📊 Final Score: ${this.score}/${this.totalQuestions}`);
    if (this.totalQuestions > 0) {
      console.log(`📈 Percentage: ${Math.round((this.score / this.totalQuestions) * 100)}%`);
    } else {
      console.log(`📈 Percentage: No questions answered`);
    }
  }

  async resolveAllQuestions() {
    try {
      const finalSnapshots = await getCompressedSnapshots(CONFIG.GAME_ID, 0, CONFIG.GAME_END);
      if (finalSnapshots.length === 0) {
        console.log('❌ No final game data available for resolution');
        return;
      }
      
      const finalSnapshot = finalSnapshots[finalSnapshots.length - 1];
      console.log(`📊 Using final game data from ${finalSnapshot.minute_range}`);
      
      for (const pending of this.pendingQuestions) {
        if (pending.resolved) continue;
        
        console.log(`\n🔍 Resolving: ${pending.question}`);
        console.log(`   Your answer: ${pending.yourAnswer}`);
        
        const actualAnswer = await AnswerResolver.determineCorrectAnswer(pending, CONFIG.GAME_END);
        
        if (actualAnswer) {
          const isCorrect = pending.yourAnswer === actualAnswer;
          if (isCorrect) {
            this.score++;
            console.log(`   ✅ Correct! +1 point (Answer was ${actualAnswer})`);
          } else {
            console.log(`   ❌ Incorrect. The answer was ${actualAnswer}`);
          }
          pending.resolved = true;
        } else {
          console.log(`   ⏳ Cannot determine answer from available data`);
        }
      }
    } catch (error) {
      console.error(`❌ Error resolving questions: ${error.message}`);
    }
  }

  async showModelStatus() {
    console.log('\n🤖 MODEL STATUS');
    console.log('='.repeat(30));
    const modelInfo = this.modelManager.getModelInfo();
    console.log(`Current Model: ${modelInfo.current}`);
    console.log(`Last Check: ${modelInfo.lastCheck}`);
    console.log('Model Status:');
    for (const [model, status] of Object.entries(modelInfo.status)) {
      console.log(`  ${model}: ${status ? '✅ Available' : '❌ Unavailable'}`);
    }
  }

  async play() {
    console.log(`🎮 Starting Football Quiz Simulator`);
    console.log(`Game: ${CONFIG.GAME_ID}`);
    console.log(`Rounds: ${ROUNDS.length}`);
    
    // Show initial model status
    await this.showModelStatus();

    for (const round of ROUNDS) {
      await this.playRound(round);
      
      if (round.number < ROUNDS.length) {
        console.log('\n⏳ Waiting 2 seconds before next round...');
        await new Promise(resolve => setTimeout(resolve, CONFIG.ROUND_DELAY));
      }
    }

    await this.showFinalResults();
    rl.close();
  }
}

// Start the game
const simulator = new GameSimulator();
simulator.play().catch(console.error);
