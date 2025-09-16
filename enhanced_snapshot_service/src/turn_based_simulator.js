import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { generateWithTools, generateSimple } from '../../llm-gemini/client.js';
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
  PRIMARY_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-pro',
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
    
    // Handle function call responses - extract only the final text
    if (text.includes('[Function call:') || text.includes('Function call:')) {
      // Try to extract the final response after function calls
      const finalResponseMatch = text.match(/Tool resolution complete.*?(.*?)$/s);
      if (finalResponseMatch) {
        text = finalResponseMatch[1];
      } else {
        // If we can't extract clean text, return empty
        console.log('⚠️  Response contains function calls but no clean text found');
        return [];
      }
    }
    
    const lines = text.split('\n');
    
    // Clean up the text first - remove any introductory text
    let startIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // Look for the start of actual questions (usually after intro text)
      if (line.match(/^\d+\./) || line.includes('Will') || line.includes('Which') || line.includes('?')) {
        startIndex = i;
        break;
      }
    }
    
    const relevantLines = lines.slice(startIndex);
    
    // Parse questions with better pattern matching
    let i = 0;
    while (i < relevantLines.length) {
      const line = relevantLines[i].trim();
      
      // Skip empty lines
      if (!line) {
        i++;
        continue;
      }
      
      // Look for question patterns
      let questionText = '';
      let choices = [];
      
      // Check if this line starts a question (numbered or question-like)
      const isQuestionStart = line.match(/^\d+\./) || 
          (line.includes('?') && line.length > 20) ||
          (line.includes('Will') && line.length > 20) ||
          (line.includes('Which') && line.length > 20);
      
      if (isQuestionStart) {
        // Clean up question text - remove any leading numbers and dots
        questionText = line.replace(/^\d+\.\s*/, '').trim();
        // Also remove any "1. " pattern that might be embedded
        questionText = questionText.replace(/^\d+\.\s*/, '').trim();
        
        // Look for choices in following lines
        let j = i + 1;
        while (j < relevantLines.length && choices.length < 3) {
          const choiceLine = relevantLines[j].trim();
          
          // Skip empty lines
          if (!choiceLine) {
            j++;
            continue;
          }
          
          // Check for A), B), C) format
          if (choiceLine.match(/^[A-C]\)/)) {
            const choice = choiceLine.replace(/^[A-C]\)\s*/, '').trim();
            if (choice) choices.push(choice);
          }
          // Check for A., B., C. format
          else if (choiceLine.match(/^[A-C]\./)) {
            const choice = choiceLine.replace(/^[A-C]\.\s*/, '').trim();
            if (choice) choices.push(choice);
          }
        // Check for numbered format (1., 2., 3.) - but not if it's a new question
        else if (choiceLine.match(/^\d+\./) && !choiceLine.includes('?') && !choiceLine.includes('Will') && !choiceLine.includes('Which')) {
          const choice = choiceLine.replace(/^\d+\.\s*/, '').trim();
          if (choice) choices.push(choice);
        }
          // Check for bullet points or dashes
          else if (choiceLine.match(/^[-•*]/)) {
            const choice = choiceLine.replace(/^[-•*]\s*/, '').trim();
            if (choice) choices.push(choice);
          }
          // Check for "Options:" followed by choices
          else if (choiceLine.startsWith('Options:')) {
            const optionsText = choiceLine.replace(/^Options:\s*/, '');
            // Split by | and clean up
            const optionParts = optionsText.split('|').map(opt => opt.trim()).filter(opt => opt.length > 0);
            choices.push(...optionParts);
          }
          // Stop if we hit another question
          else if (choiceLine.match(/^\d+\./) || 
                   (choiceLine.includes('?') && choiceLine.length > 20) ||
                   (choiceLine.includes('Will') && choiceLine.length > 20)) {
            break;
          }
          
          j++;
        }
        
        // Look for RESOLVES_AT timeframe and CHECK_FACET in the question text or following lines
        let timeframe = 900; // Default 15 minutes
        let checkFacet = 'goals'; // Default facet
        const timeframeMatch = questionText.match(/RESOLVES_AT:\s*(\d+)/i);
        const facetMatch = questionText.match(/CHECK_FACET:\s*([a-zA-Z_]+)/i);
        
        if (timeframeMatch) {
          timeframe = parseInt(timeframeMatch[1]);
        }
        if (facetMatch) {
          checkFacet = facetMatch[1].toLowerCase();
        }
        
        if (timeframeMatch) {
          questionText = questionText.replace(/RESOLVES_AT:\s*\d+/i, '').trim();
        }
        if (facetMatch) {
          questionText = questionText.replace(/CHECK_FACET:\s*[a-zA-Z_]+/i, '').trim();
        } else {
          // Check in the following lines for RESOLVES_AT
          for (let k = i + 1; k < Math.min(i + 5, relevantLines.length); k++) {
            const timeframeLine = relevantLines[k].trim();
            const match = timeframeLine.match(/RESOLVES_AT:\s*(\d+)/i);
            if (match) {
              timeframe = parseInt(match[1]);
              break;
            }
          }
        }
        
        // If we found a question with at least 2 choices, add it
        if (choices.length >= 2) {
          questions.push({ 
            question: questionText, 
            options: choices.slice(0, 3), // Take up to 3 choices
            timeframe: timeframe,
            checkFacet: checkFacet
          });
        }
        
        i = j;
      } else {
        i++;
      }
    }
    
    // If we still didn't find questions, try a more aggressive approach
    if (questions.length === 0) {
      // Look for any text that might be a question followed by choices
      const textBlocks = text.split(/\n\s*\n/); // Split by double newlines
      
      for (const block of textBlocks) {
        const blockLines = block.trim().split('\n');
        if (blockLines.length >= 3) { // At least question + 2 choices
          const firstLine = blockLines[0].trim();
          const remainingLines = blockLines.slice(1);
          
          // Check if first line looks like a question
          if (firstLine.length > 10 && (firstLine.includes('?') || firstLine.includes('Which') || firstLine.includes('Will'))) {
            const choices = remainingLines
              .map(line => line.trim())
              .filter(line => line.length > 0)
              .map(line => {
                // Remove common prefixes
                return line.replace(/^[A-C]\)\s*/, '')
                          .replace(/^\d+\.\s*/, '')
                          .replace(/^[-•*]\s*/, '')
                          .trim();
              })
              .filter(choice => choice.length > 0);
            
            if (choices.length >= 2) {
              // Look for RESOLVES_AT timeframe
              let timeframe = 900; // Default 15 minutes
              const timeframeMatch = firstLine.match(/RESOLVES_AT:\s*(\d+)/i);
              if (timeframeMatch) {
                timeframe = parseInt(timeframeMatch[1]);
                firstLine = firstLine.replace(/RESOLVES_AT:\s*\d+/i, '').trim();
              }
              
              questions.push({
                question: firstLine,
                options: choices.slice(0, 3), // Take up to 3 choices
                timeframe: timeframe,
                checkFacet: 'goals' // Default facet for fallback questions
              });
            }
          }
        }
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
    this.generatedQuestions = new Set(); // Track when questions have been generated
    this.askedQuestions = []; // Track all questions asked for LLM context
    this.roundNumber = 0; // Track current round number
    this.cachedFacetData = new Map(); // Cache facet data to avoid additional API calls
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
      
        const summaryResult = await generateWithTools({
          systemInstruction: 'Generate a comprehensive half-time summary of the first half of the game. Focus on key moments, tactical patterns, player performances, and overall game flow.',
          userPayload: {
            instructions: 'Generate a comprehensive half-time summary of the first half of the game. Focus on key moments, tactical patterns, player performances, and overall game flow.',
            game: this.currentGameId,
            window: { start: 0, end: 2700 },
            stkm: { events: events }
          },
          model: CONFIG.PRIMARY_MODEL
        });
      
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
    
    // Calculate round information
    this.roundNumber++;
    const totalRounds = 6; // 2 first half + 2 half-time + 2 second half
    const remainingRounds = totalRounds - this.roundNumber + 1;
    
    // Build context about previous questions
    let previousQuestionsContext = '';
    if (this.askedQuestions.length > 0) {
      previousQuestionsContext = '\n\nPREVIOUS QUESTIONS ASKED (avoid repetition):\n';
      this.askedQuestions.forEach((q, i) => {
        previousQuestionsContext += `${i + 1}. ${q.question}\n`;
      });
      previousQuestionsContext += '\nIMPORTANT: Do NOT repeat these questions. Create fresh, different questions.';
    }
    
    // Build context about current predictions
    let predictionsContext = '';
    if (this.activePredictions.length > 0) {
      predictionsContext = '\n\nCURRENT ACTIVE PREDICTIONS:\n';
      this.activePredictions.forEach((pred, i) => {
        predictionsContext += `${i + 1}. ${pred.question} → ${pred.selectedText} (resolves at ${Math.floor(pred.gameTime/60)}:${(pred.gameTime%60).toString().padStart(2,'0')})\n`;
      });
    }
    
    // Build game timing context
    const gameTimeMinutes = Math.floor(currentTime / 60);
    const gameTimeSeconds = currentTime % 60;
    const timeRemaining = 90 - gameTimeMinutes;
    
      let instructions = `CRITICAL: You MUST generate exactly ${CONFIG.QUESTIONS_PER_ROUND} betting questions. No more, no less.

FORMAT REQUIRED:
${createQuestionTemplate(CONFIG.QUESTIONS_PER_ROUND)}

ROUND CONTEXT:
- Current Round: ${this.roundNumber}/${totalRounds}
- Rounds Remaining: ${remainingRounds}
- Game Time: ${gameTimeMinutes}:${gameTimeSeconds.toString().padStart(2,'0')}
- Time Remaining: ~${timeRemaining} minutes
- Period: ${period}

TIMING AWARENESS:
- This is round ${this.roundNumber} of ${totalRounds} total rounds
- ${remainingRounds} rounds remaining in the game
- You have flexibility to generate questions within time ranges, not at exact moments
- Make questions relevant to the current game time and remaining time
- Consider the urgency: later rounds should focus on end-game scenarios
- Account for injury time and actual game flow timing${previousQuestionsContext}${predictionsContext}

IMPORTANT: For each question, provide:
1. The exact game time (in seconds) when the prediction should be resolved
2. Which facet to check for evaluation
Format: "RESOLVES_AT: [time_in_seconds] CHECK_FACET: [facet_name]" after each question.
Examples:
- "Will Barcelona score in the first half? RESOLVES_AT: 2700 CHECK_FACET: goals"
- "Will there be a goal before the 30th minute? RESOLVES_AT: 1800 CHECK_FACET: goals"
- "Will Barcelona win the match? RESOLVES_AT: 5400 CHECK_FACET: goals"

TEAMS: This match is Barcelona vs Alavés. Use these exact team names in your questions.`;
    
    if (period === 'secondHalf' && this.halfTimeSummary) {
      instructions += `\n\nHALF-TIME SUMMARY:\n${this.halfTimeSummary}\n\nUse this context to create more informed questions for the second half.`;
    }
    
    instructions += `\n\n${trendAnalysis}`;

    const userPayload = {
      instructions,
      game: this.currentGameId,
      teams: { home: 'Barcelona', away: 'Alavés' },
      window: { start: currentTime - 300, end: currentTime },
      stkm: latestSnapshot
    };

    try {
      console.log(`🤖 Generating questions for ${period}...`);
      
      // Try with tools first
      let response = await generateWithTools({
        systemInstruction: SYSTEM_INSTRUCTION,
        userPayload: userPayload,
        model: CONFIG.PRIMARY_MODEL
      });
      
      // Cache facet data from tool calls for later evaluation
      this.cacheFacetDataFromResponse(response, currentTime);
      
      if (response.error) {
        console.error('❌ Gemini error with tools:', response.error);
        console.log('🔄 Trying simple generation without tools...');
        
        // Try simple generation without tools
        response = await generateSimple({
          systemInstruction: SYSTEM_INSTRUCTION,
          userPayload: userPayload,
          model: CONFIG.PRIMARY_MODEL
        });
        
        if (response.error) {
          console.error('❌ Simple generation also failed:', response.error);
          return [];
        }
      }
      
      console.log(`🔍 Raw Gemini response: "${response.text.substring(0, 200)}..."`);
      const questions = QuestionGenerator.parseQuestions(response.text);
      console.log(`📊 Parsed ${questions.length} questions from response`);
      
      // If no questions were parsed, return empty array
      if (questions.length === 0) {
        console.log('🔄 No questions parsed from response');
        return [];
      }
      
      // If we have some questions but not enough, return what we have
      if (questions.length < CONFIG.QUESTIONS_PER_ROUND) {
        console.log(`⚠️  Only ${questions.length} questions parsed (expected ${CONFIG.QUESTIONS_PER_ROUND})`);
      }
      
      return questions.slice(0, CONFIG.QUESTIONS_PER_ROUND); // Ensure we don't exceed the limit
    } catch (error) {
      console.error('❌ Error generating questions:', error);
      return [];
    }
  }

  cacheFacetDataFromResponse(response, currentTime) {
    // Extract facet data from the LLM response for caching
    // This is a simplified approach - in practice, we'd need to access the tool call results
    // For now, we'll cache based on the current time and common facets
    const commonFacets = ['goals', 'cards', 'shots_on_target', 'possession'];
    
    commonFacets.forEach(facet => {
      const facetKey = `${this.currentGameId}_${facet}_${currentTime}`;
      // In a real implementation, we'd store the actual facet data here
      // For now, we'll store a placeholder that indicates data was available
      this.cachedFacetData.set(facetKey, [{ type: 'placeholder', facet: facet }]);
    });
    
    console.log(`📦 Cached facet data for ${commonFacets.length} facets at ${currentTime}s`);
  }

  getCurrentPeriod(currentTime) {
    if (currentTime <= CONFIG.ROUNDS.firstHalf.end) return 'firstHalf';
    if (currentTime <= CONFIG.ROUNDS.halfTime.end) return 'halfTime';
    return 'secondHalf';
  }

  shouldGenerateQuestions(period, currentTime) {
    // Use precise timing to avoid rate limiting issues
    const questionTimes = {
      firstHalf: [900, 1800],    // 15 min, 30 min
      halfTime: [2700, 3150],    // 45 min, 52.5 min  
      secondHalf: [4050, 4950]   // 67.5 min, 82.5 min
    };
    
    const times = questionTimes[period] || [];
    
    // Check if we're past any target time and haven't generated questions for it yet
    for (const targetTime of times) {
      const timeKey = `${period}-${targetTime}`;
      
      // If we haven't generated questions for this target time yet
      if (!this.generatedQuestions.has(timeKey)) {
        // And we're past the target time (with some tolerance)
        if (currentTime >= targetTime - 300) { // 5 minutes before target
          return true;
        }
      }
    }
    
    return false;
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

    // Mark this time window as having generated questions
    const questionTimes = {
      firstHalf: [900, 1800],
      halfTime: [2700, 3150], 
      secondHalf: [4050, 4950]
    };
    
    const times = questionTimes[period] || [];
    
    // Find which target time we're closest to and mark it as used
    for (const targetTime of times) {
      const timeKey = `${period}-${targetTime}`;
      
      // If we haven't generated questions for this target time yet
      if (!this.generatedQuestions.has(timeKey)) {
        // And we're past the target time (with some tolerance)
        if (currentTime >= targetTime - 300) { // 5 minutes before target
          this.generatedQuestions.add(timeKey);
          break; // Only mark one time window per call
        }
      }
    }

    console.log(`\n🎯 ${period.toUpperCase()} QUESTIONS - ROUND ${this.roundNumber}/6 (${Math.floor(currentTime/60)}:${(currentTime%60).toString().padStart(2,'0')})`);
    console.log('='.repeat(60));
    
    // Let user pick 2 questions
    const selectedQuestions = await this.selectQuestions(questions);
    
    if (selectedQuestions.length > 0) {
      // Track the questions that were asked for future LLM context
      selectedQuestions.forEach(q => {
        this.askedQuestions.push({
          question: q.question,
          round: this.roundNumber,
          period: period,
          gameTime: currentTime
        });
      });
      
      await this.answerQuestions(selectedQuestions, period);
    }
  }

  async selectQuestions(questions) {
    console.log('\n📋 Available Questions:');
    questions.forEach((q, i) => {
      console.log(`\n${i + 1}. ${q.question}`);
      console.log('   A) ' + q.options[0]);
      console.log('   B) ' + q.options[1]);
      console.log('   C) ' + q.options[2]);
    });

    // Use a more robust readline implementation with timeout
    const readline = await import('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });

    return new Promise((resolve) => {
      let resolved = false;
      
      // Auto-select questions after 30 seconds if no input
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          console.log('\n⏰ Timeout reached, auto-selecting first 2 questions...');
          const selected = questions.slice(0, 2);
          console.log(`\n✅ Auto-selected ${selected.length} questions:`);
          selected.forEach((q, i) => {
            console.log(`${i + 1}. ${q.question}`);
          });
          rl.close();
          resolve(selected);
        }
      }, 30000);

      const askForSelection = () => {
        rl.question(`\n🎯 Select 2 questions (e.g., "1,3") or wait 30s for auto-selection: `, (answer) => {
          if (resolved) return;
          
          const indices = answer.split(',').map(s => parseInt(s.trim()) - 1).filter(i => i >= 0 && i < questions.length);
          
          if (indices.length === 0) {
            console.log('❌ Invalid selection. Please try again.');
            askForSelection();
            return;
          }
          
          resolved = true;
          clearTimeout(timeout);
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
      console.log('   A) ' + question.options[0]);
      console.log('   B) ' + question.options[1]);
      console.log('   C) ' + question.options[2]);
      
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
        timeframe: question.timeframe || 900, // Use LLM-provided timeframe or default
        checkFacet: question.checkFacet || 'goals', // Use LLM-specified facet or default
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
    // LLM will provide timeframe directly, no need for complex parsing
    // This is a fallback for backward compatibility
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
        .order('created_at', { ascending: true });

      if (error) throw error;
      return events?.map(s => s.raw_json) || [];
    } catch (error) {
      console.error('Error fetching game events:', error);
      return [];
    }
  }

  evaluatePrediction(prediction, events) {
    // Use cached facet data for evaluation instead of parsing question text
    const selectedText = prediction.selectedText.toLowerCase();
    const checkFacet = prediction.checkFacet || 'goals';
    
    // Get cached facet data for this prediction's timeframe
    const facetKey = `${this.currentGameId}_${checkFacet}_${prediction.timeframe}`;
    const facetData = this.cachedFacetData.get(facetKey);
    
    if (!facetData) {
      console.log(`⚠️  No cached facet data found for ${checkFacet} at ${prediction.timeframe}s`);
      return false; // Default to incorrect if no data available
    }
    
    // Simple evaluation based on facet data
    // This can be enhanced to use LLM for more complex evaluation
    if (checkFacet === 'goals') {
      const hasGoal = facetData.some(event => event.type === 'goal');
      return (selectedText.includes('yes') && hasGoal) || 
             (selectedText.includes('no') && !hasGoal) ||
             (selectedText.includes('draw') && !hasGoal);
    }
    
    if (checkFacet === 'cards') {
      const hasCard = facetData.some(event => event.type === 'card');
      return (selectedText.includes('yes') && hasCard) || 
             (selectedText.includes('no') && !hasCard);
    }
    
    // Default evaluation - can be enhanced with more facet types
    console.log(`⚠️  No evaluation logic for facet: ${checkFacet}`);
    return false;
  }

  async showFinalResults() {
    console.log('\n🏆 FINAL RESULTS');
    console.log('='.repeat(50));
    
    const resolvedPredictions = this.activePredictions.filter(p => p.resolved);
    const correctPredictions = resolvedPredictions.filter(p => p.correct);
    
    console.log(`📊 Final Score: ${correctPredictions.length}/${resolvedPredictions.length} (${this.totalQuestions} total predictions)`);
    console.log(`🎯 Accuracy: ${resolvedPredictions.length > 0 ? Math.round((correctPredictions.length/resolvedPredictions.length) * 100) : 0}%`);
    
    if (resolvedPredictions.length > 0) {
      console.log('\n📋 Prediction Summary:');
      resolvedPredictions.forEach((pred, i) => {
        const status = pred.correct ? '✅' : '❌';
        console.log(`${i + 1}. ${status} ${pred.question}`);
        console.log(`   Your answer: ${pred.selectedText}`);
      });
    }
    
    if (this.activePredictions.length > resolvedPredictions.length) {
      const unresolved = this.activePredictions.length - resolvedPredictions.length;
      console.log(`\n⏳ ${unresolved} predictions still pending resolution`);
    }
    
    console.log('\n🎉 Game completed! Thanks for playing!');
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

// Export the classes for testing
export { TurnBasedSimulator, QuestionGenerator };

// Main execution (only run if this file is executed directly)
if (import.meta.url === `file://${process.argv[1]}`) {
  const gameId = process.argv[2] || 'barcelona-alaves-18-08-18';
  const simulator = new TurnBasedSimulator(gameId);

  simulator.start().catch(error => {
    console.error('❌ Simulator error:', error);
    process.exit(1);
  });
}
