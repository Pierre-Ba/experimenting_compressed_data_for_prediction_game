import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { generateQuestionsWithOllamaAndFacets, generateHalfTimeSummaryWithOllama } from './ollama_client.js';
import { SYSTEM_INSTRUCTION } from '../../llm-gemini/prompt.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from project root
config({ path: path.resolve(__dirname, '../../.env') });

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Configuration
const CONFIG = {
  PRIMARY_MODEL: process.env.OLLAMA_MODEL || 'llama2:13b',
  QUESTIONS_PER_ROUND: 7, // Generate 7 questions, user picks 2
  MAX_SNAPSHOTS: 20,
  ROUNDS: {
    firstHalf: { start: 0, end: 2700, questions: 2 },
    halfTime: { start: 2700, end: 3600, questions: 2 },
    secondHalf: { start: 3600, end: 5400, questions: 2 }
  }
};

// Helper functions from game_simulator.js
const formatStats = (first, last, stat) => {
  if (!first?.payload?.state || !last?.payload?.state) return 'No data available';
  return `${first.payload.state[stat]?.home || 0} → ${last.payload.state[stat]?.home || 0}, ${first.payload.state[stat]?.away || 0} → ${last.payload.state[stat]?.away || 0}`;
};

const createQuestionTemplate = (count) => Array.from({ length: count }, (_, i) => 
  `Question ${i + 1}: [Your question here]\nA) [Choice 1]\nB) [Choice 2]\nC) [Choice 3]`
).join('\n\n');

// QuestionGenerator class methods
class QuestionGenerator {
  static createInstructions() {
    return `
Generate exactly ${CONFIG.QUESTIONS_PER_ROUND} betting questions.

FORMAT REQUIRED:
${createQuestionTemplate(CONFIG.QUESTIONS_PER_ROUND)}

IMPORTANT: Be VARIED and UNPREDICTABLE in your questions. Don't repeat the same question types. 
Use the tools at your disposal naturally - if you need more data to create interesting questions, request it.
Avoid boring, repetitive questions about the same markets.

EXPLORE the data deeply - look for patterns, player behaviors, tactical nuances, and interesting details that others might miss.
Create questions that reward football knowledge and attention to detail, not just basic stats.
    `;
  }

  static createTrendAnalysis(snapshots) {
    if (snapshots.length < 2) return '';
    
    const [first, last] = [snapshots[0], snapshots[snapshots.length - 1]];
    const players = this.extractKeyPlayers(snapshots);
    
    return `
GAME PROGRESSION IN THIS PERIOD:
- Time: ${first.window?.start || 0}s to ${last.window?.end || 0}s
- Shots: ${formatStats(first, last, 'shots')}
- Box Entries: ${formatStats(first, last, 'box_entries')}
- Cards: ${formatStats(first, last, 'cards')}
- Goals: ${formatStats(first, last, 'score')}
- Key Players: ${players}

The data contains rich details about player actions, tactical patterns, and game dynamics - explore it thoroughly.
    `;
  }

  static extractKeyPlayers(snapshots) {
    const players = new Set();
    snapshots.forEach(snapshot => {
      snapshot.key_moments?.forEach(moment => {
        if (moment.player) players.add(moment.player);
      });
    });
    return Array.from(players).slice(0, 8).join(', ') || 'No player data available';
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
          questions.push({ 
            question: questionText, 
            options: choices 
          });
        }
        
        i = j;
      } else {
        i++;
      }
    }
    
    return questions;
  }
}

class TurnBasedSimulator {
  constructor(gameId) {
    this.currentGameId = gameId;
    this.isRunning = false;
    this.score = 0;
    this.totalQuestions = 0;
    this.halfTimeSummary = null;
    this.activePredictions = []; // Store predictions to check against stream
  }

  async getRecentSnapshots(currentTime) {
    try {
      const response = await fetch(`http://localhost:7070/compressed_snapshots/${this.currentGameId}?count=5`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      return data.snapshots || [];
    } catch (error) {
      console.error('Error fetching snapshots from enhanced service:', error);
      return [];
    }
  }

  async generateHalfTimeSummary() {
    console.log('\n⏸️  Generating Half-Time Summary...');
    
    try {
      // Get raw events for first half from database
      const { data: rawEvents, error } = await supabase
        .from('snapshots')
        .select(`
          raw_json,
          windows!inner(
            game_id,
            start_sec,
            end_sec
          )
        `)
        .eq('windows.game_id', this.currentGameId)
        .eq('compressed_kind', 'raw')
        .lte('windows.end_sec', 2700)
        .order('created_at', { ascending: true });

      if (error) throw error;

      const events = rawEvents?.map(s => s.raw_json) || [];
      
      const summaryResult = await generateHalfTimeSummaryWithOllama(
        'Generate a comprehensive half-time summary of the first half of the game. Focus on key moments, tactical patterns, player performances, and overall game flow.',
        this.currentGameId,
        events,
        CONFIG.PRIMARY_MODEL
      );
      
      this.halfTimeSummary = summaryResult.error ? 'Half-time summary generation failed.' : summaryResult.text;
      
      console.log('✅ Half-time summary generated');
      console.log(`📝 Summary: ${this.halfTimeSummary.substring(0, 200)}...`);
      
    } catch (error) {
      console.error('❌ Error generating half-time summary:', error);
      this.halfTimeSummary = 'Half-time summary generation failed.';
    }
  }

  async generateQuestions(snapshots, period, currentTime) {
    const latestSnapshot = snapshots[snapshots.length - 1];
    
    const trendAnalysis = QuestionGenerator.createTrendAnalysis(snapshots);
    
    let instructions = `Generate exactly ${CONFIG.QUESTIONS_PER_ROUND} betting questions for ${period} of ${this.currentGameId}.`;
    
    if (period === 'secondHalf' && this.halfTimeSummary) {
      instructions += `\n\nHALF-TIME SUMMARY:\n${this.halfTimeSummary}\n\nUse this context to create more informed questions for the second half.`;
    }
    
    instructions += `\n\n${trendAnalysis}`;

    const userPayload = {
      instructions,
      game: this.currentGameId,
      window: { start: currentTime - 300, end: currentTime },
      stkm: latestSnapshot
    };

    try {
      console.log(`🤖 Generating questions for ${period}...`);
      const response = await generateQuestionsWithOllamaAndFacets(SYSTEM_INSTRUCTION, userPayload, CONFIG.PRIMARY_MODEL);
      
      if (response.error) {
        console.error('❌ Ollama error:', response.error);
        return [];
      }
      
      const questions = QuestionGenerator.parseQuestions(response.text);
      return questions;
    } catch (error) {
      console.error('❌ Error generating questions:', error);
      return [];
    }
  }

  getCurrentPeriod(currentTime) {
    if (currentTime <= CONFIG.ROUNDS.firstHalf.end) return 'firstHalf';
    if (currentTime <= CONFIG.ROUNDS.halfTime.end) return 'halfTime';
    return 'secondHalf';
  }

  shouldGenerateQuestions(period, currentTime) {
    const questionTimes = {
      firstHalf: [900, 1800], // 15 min, 30 min
      halfTime: [2700, 3150], // 45 min, 52.5 min  
      secondHalf: [4050, 4950] // 67.5 min, 82.5 min
    };
    
    const times = questionTimes[period] || [];
    const isGoodTime = times.some(time => Math.abs(currentTime - time) < 150); // Within 2.5 minutes
    
    return isGoodTime;
  }

  async processTimeWindow(lastTime, currentTime) {
    const period = this.getCurrentPeriod(currentTime);
    
    // Check if we need to generate half-time summary
    if (period === 'halfTime' && !this.halfTimeSummary && currentTime >= 2700) {
      await this.generateHalfTimeSummary();
    }
    
    // Check if any predictions should be resolved
    await this.checkPredictions(currentTime);
    
    // Check if we should generate questions
    if (this.shouldGenerateQuestions(period, currentTime)) {
      const snapshots = await this.getRecentSnapshots(currentTime);
      if (snapshots.length > 0) {
        await this.askQuestions(snapshots, period, currentTime);
      }
    }
  }

  async askQuestions(snapshots, period, currentTime) {
    const questions = await this.generateQuestions(snapshots, period, currentTime);
    
    if (questions.length === 0) {
      console.log('❌ No questions generated');
      return;
    }

    console.log(`\n🎯 ${period.toUpperCase()} QUESTIONS (${Math.floor(currentTime/60)}:${(currentTime%60).toString().padStart(2,'0')})`);
    console.log('='.repeat(60));
    
    // Let user pick 2 questions
    const selectedQuestions = await this.selectQuestions(questions);
    
    if (selectedQuestions.length > 0) {
      await this.answerQuestions(selectedQuestions, period);
    }
  }

  async selectQuestions(questions) {
    console.log('\n📋 Available Questions:');
    questions.forEach((q, i) => {
      console.log(`${i + 1}. ${q.question}`);
      console.log(`   Options: ${q.options.join(' | ')}`);
      console.log('');
    });

    // Use a more robust readline implementation
    const readline = await import('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });

    return new Promise((resolve) => {
      const askForSelection = () => {
        rl.question(`\n🎯 Select 2 questions (e.g., "1,3"): `, (answer) => {
          const indices = answer.split(',').map(s => parseInt(s.trim()) - 1).filter(i => i >= 0 && i < questions.length);
          
          if (indices.length === 0) {
            console.log('❌ Invalid selection. Please try again.');
            askForSelection();
            return;
          }
          
          const selected = indices.slice(0, 2).map(i => questions[i]);
          
          console.log(`\n✅ Selected ${selected.length} questions:`);
          selected.forEach((q, i) => {
            console.log(`${i + 1}. ${q.question}`);
          });
          
          rl.close();
          resolve(selected);
        });
      };
      
      askForSelection();
    });
  }

  async answerQuestions(questions, period) {
    const readline = await import('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });

    for (let i = 0; i < questions.length; i++) {
      const question = questions[i];
      console.log(`\n❓ Question ${i + 1}: ${question.question}`);
      console.log(`Options: ${question.options.join(' | ')}`);
      
      const answer = await new Promise((resolve) => {
        const askForAnswer = () => {
          rl.question('\n🎯 Your answer (A, B, or C): ', (answer) => {
            const validAnswers = ['A', 'B', 'C', 'a', 'b', 'c'];
            if (validAnswers.includes(answer.trim())) {
              console.log(`✅ Answer recorded: ${answer.toUpperCase()}`);
              resolve(answer.toUpperCase());
            } else {
              console.log(`❌ Invalid answer: ${answer}. Please use A, B, or C.`);
              askForAnswer();
            }
          });
        };
        askForAnswer();
      });
      
      // Store prediction for later validation against stream
      const prediction = {
        question: question.question,
        selectedOption: answer,
        selectedText: question.options[answer.charCodeAt(0) - 65], // Convert A/B/C to option text
        timestamp: Date.now(),
        gameTime: this.getCurrentGameTime(),
        timeframe: this.extractTimeframe(question.question),
        resolved: false,
        correct: null
      };
      
      this.activePredictions.push(prediction);
      this.totalQuestions++;
      
      console.log(`📝 Prediction recorded: ${prediction.selectedText}`);
      console.log(`⏰ Will be checked at: ${prediction.gameTime + (prediction.timeframe || 900)} seconds`);
    }
    
    rl.close();
    const resolvedCount = this.activePredictions.filter(p => p.resolved).length;
    console.log(`\n📊 Score: ${this.score}/${resolvedCount} (${this.totalQuestions} total predictions)`);
    console.log('\n🎉 Round completed! Waiting for next questions...\n');
  }

  getCurrentGameTime() {
    // Get current game time from the last processed snapshot
    return this.lastProcessedTime || 0;
  }

  extractTimeframe(questionText) {
    // Extract timeframe from question text (e.g., "next 15 minutes" = 900 seconds)
    const timeMatch = questionText.match(/(\d+)\s*(minute|min|second|sec)/i);
    if (timeMatch) {
      const value = parseInt(timeMatch[1]);
      const unit = timeMatch[2].toLowerCase();
      if (unit.startsWith('min')) {
        return value * 60;
      } else if (unit.startsWith('sec')) {
        return value;
      }
    }
    return 900; // Default 15 minutes
  }

  async checkPredictions(currentGameTime) {
    // Check if any predictions should be resolved
    for (const prediction of this.activePredictions) {
      if (!prediction.resolved && currentGameTime >= prediction.gameTime + prediction.timeframe) {
        await this.resolvePrediction(prediction, currentGameTime);
      }
    }
  }

  async resolvePrediction(prediction, currentGameTime) {
    // Get game events that happened during the prediction timeframe
    const events = await this.getGameEvents(prediction.gameTime, currentGameTime);
    
    // Check if prediction was correct based on actual events
    const isCorrect = this.evaluatePrediction(prediction, events);
    
    prediction.resolved = true;
    prediction.correct = isCorrect;
    
    if (isCorrect) {
      this.score++;
      console.log(`\n✅ PREDICTION CORRECT: ${prediction.selectedText}`);
    } else {
      console.log(`\n❌ PREDICTION INCORRECT: ${prediction.selectedText}`);
    }
    
    console.log(`📊 Current Score: ${this.score}/${this.totalQuestions}`);
  }

  async getGameEvents(startTime, endTime) {
    // Get raw events from the database for the timeframe
    try {
      const { data: events, error } = await supabase
        .from('snapshots')
        .select(`
          raw_json,
          windows!inner(
            start_sec,
            end_sec
          )
        `)
        .eq('windows.game_id', this.currentGameId)
        .eq('compressed_kind', 'raw')
        .gte('windows.start_sec', startTime)
        .lte('windows.end_sec', endTime)
        .order('windows.start_sec', { ascending: true });

      if (error) throw error;
      return events?.map(s => s.raw_json) || [];
    } catch (error) {
      console.error('Error fetching game events:', error);
      return [];
    }
  }

  evaluatePrediction(prediction, events) {
    // Evaluate if prediction was correct based on actual events
    const question = prediction.question.toLowerCase();
    const selectedText = prediction.selectedText.toLowerCase();
    
    // Simple evaluation logic - can be enhanced
    if (question.includes('yellow card')) {
      const hasYellowCard = events.some(event => 
        event.type === 'card' && event.card_type === 'yellow'
      );
      return (selectedText.includes('yes') && hasYellowCard) || 
             (selectedText.includes('no') && !hasYellowCard);
    }
    
    if (question.includes('goal')) {
      const hasGoal = events.some(event => event.type === 'goal');
      return (selectedText.includes('yes') && hasGoal) || 
             (selectedText.includes('no') && !hasGoal);
    }
    
    // Add more evaluation logic for different question types
    return false; // Default to incorrect if we can't evaluate
  }

  async showFinalResults() {
    console.log('\n🏆 FINAL RESULTS');
    console.log('='.repeat(30));
    console.log(`Score: ${this.score}/${this.totalQuestions}`);
    console.log(`Accuracy: ${this.totalQuestions > 0 ? Math.round((this.score/this.totalQuestions) * 100) : 0}%`);
  }

  async startRealTimeProcessing() {
    let lastProcessedTime = 0;
    const checkInterval = 2000; // Check for new data every 2 seconds
    
    console.log('⏳ Waiting for game data from stream...');
    
    while (this.isRunning) {
      try {
        // Check if we have new data available
        const snapshots = await this.getRecentSnapshots(999999); // Get all available data
        
        if (snapshots.length > 0) {
          // Find the latest time we have data for
          const latestSnapshot = snapshots[snapshots.length - 1];
          const currentTime = latestSnapshot.window?.end || 0;
          
          // Only process if we have new data
          if (currentTime > lastProcessedTime) {
            console.log(`📊 New data available: ${Math.floor(currentTime/60)}:${(currentTime%60).toString().padStart(2,'0')}`);
            await this.processTimeWindow(lastProcessedTime, currentTime);
            lastProcessedTime = currentTime;
          }
        }
        
        // Check if game is over (90 minutes + some buffer)
        if (lastProcessedTime > 5400) {
          console.log(`\n🏁 Game completed! Final score: ${this.score}/${this.totalQuestions}`);
          await this.showFinalResults();
          break;
        }
        
        // Wait before checking again
        await new Promise(resolve => setTimeout(resolve, checkInterval));
        
      } catch (error) {
        console.error(`❌ Error checking for new data:`, error);
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait longer on error
      }
    }
  }

  async start() {
    console.log(`🎮 Starting Turn-Based Simulator with Facets for ${this.currentGameId}`);
    console.log('='.repeat(60));
    
    this.isRunning = true;
    await this.startRealTimeProcessing();
  }
}

// Export the class for testing
export { TurnBasedSimulator };

// Main execution (only run if this file is executed directly)
if (import.meta.url === `file://${process.argv[1]}`) {
  const gameId = process.argv[2] || 'barcelona-alaves-2018-08-18';
  const simulator = new TurnBasedSimulator(gameId);

  simulator.start().catch(error => {
    console.error('❌ Simulator error:', error);
    process.exit(1);
  });
}
