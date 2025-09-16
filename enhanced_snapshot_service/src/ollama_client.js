/**
 * Ollama Client for Enhanced Snapshot Service
 * Replaces Gemini API calls with local Ollama model
 */

const OLLAMA_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama2:13b';

/**
 * Generate text using Ollama
 */
export async function generateWithOllama(prompt, model = DEFAULT_MODEL) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180000); // 3 minute timeout for 70b model
    
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model,
        prompt: prompt,
        stream: false,
            options: {
              temperature: 0.7,
              top_p: 0.9,
              num_predict: 2000,
              num_ctx: 4096
            }
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return {
      text: data.response || '',
      error: null
    };
  } catch (error) {
    console.error('Ollama generation error:', error);
    return {
      text: '',
      error: error
    };
  }
}

/**
 * Generate questions with Ollama (replaces generateWithTools)
 */
export async function generateQuestionsWithOllama(systemInstruction, userPayload, model = DEFAULT_MODEL) {
  try {
    // Combine system instruction and user payload into a single prompt
    const fullPrompt = `${systemInstruction}

User Request:
${userPayload.instructions}

Game Context:
- Game: ${userPayload.game}
- Window: ${userPayload.window.start}-${userPayload.window.end} seconds
- Current Data: ${JSON.stringify(userPayload.stkm, null, 2)}

Please generate exactly 7 betting-style multiple choice questions based on this data. Each question should have 3 choices (A, B, C).

Format your response as:
Question 1: [Your question here]
A) [Choice 1]
B) [Choice 2]
C) [Choice 3]

Question 2: [Your question here]
A) [Choice 1]
B) [Choice 2]
C) [Choice 3]

[Continue for all 7 questions]`;

    const result = await generateWithOllama(fullPrompt, model);
    
    return {
      text: result.text,
      error: result.error
    };
  } catch (error) {
    console.error('Error generating questions with Ollama:', error);
    return {
      text: '',
      error: error
    };
  }
}

/**
 * Generate timing decision with Ollama
 */
export async function generateTimingDecisionWithOllama(prompt, model = DEFAULT_MODEL) {
  try {
    const fullPrompt = `${prompt}

Please respond with either "YES" (if it's a good time for questions) or "NO" (if it's not a good time).`;

    const result = await generateWithOllama(fullPrompt, model);
    
    return {
      text: result.text,
      error: result.error
    };
  } catch (error) {
    console.error('Error generating timing decision with Ollama:', error);
    return {
      text: 'NO',
      error: error
    };
  }
}

/**
 * Generate half-time summary with Ollama
 */
export async function generateHalfTimeSummaryWithOllama(instructions, gameId, rawEvents, model = DEFAULT_MODEL) {
  try {
    const fullPrompt = `${instructions}

Game: ${gameId}
Raw Events: ${JSON.stringify(rawEvents.slice(0, 50), null, 2)} ${rawEvents.length > 50 ? '... (truncated)' : ''}

Please generate a comprehensive half-time summary based on this data.`;

    const result = await generateWithOllama(fullPrompt, model);
    
    return {
      text: result.text,
      error: result.error
    };
  } catch (error) {
    console.error('Error generating half-time summary with Ollama:', error);
    return {
      text: 'First half: Summary generation failed',
      error: error
    };
  }
}

/**
 * Generate questions with Ollama and facet support
 */
export async function generateQuestionsWithOllamaAndFacets(systemInstruction, userPayload, model = DEFAULT_MODEL) {
  try {
    // First, try to get additional facet data if the LLM requests it
    let facetData = '';
    
    // Check if we should request facet data based on the game context
    const shouldRequestFacets = userPayload.stkm && (
      userPayload.stkm.key_moments?.length > 0 ||
      userPayload.stkm.state?.shots?.home > 0 ||
      userPayload.stkm.state?.shots?.away > 0
    );
    
    if (shouldRequestFacets) {
      try {
        // Request FTT (Field Tilt & Territory) facet for better context
        const facetResponse = await fetch('http://localhost:8080/get_facet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            gameId: userPayload.game,
            start: userPayload.window.start,
            end: userPayload.window.end,
            facet: 'FTT'
          })
        });
        
        if (facetResponse.ok) {
          const facetResult = await facetResponse.json();
          facetData = `\n\nAdditional Context (Field Tilt & Territory):\n${JSON.stringify(facetResult.data, null, 2)}`;
          console.log('📊 Retrieved FTT facet data for enhanced questions');
        }
      } catch (facetError) {
        console.log('⚠️  Could not retrieve facet data, proceeding without it');
      }
    }

    // Combine system instruction and user payload into a single prompt
    const fullPrompt = `SYSTEM INSTRUCTIONS:
${systemInstruction}

USER REQUEST:
${userPayload.instructions}

GAME CONTEXT:
- Game: ${userPayload.game}
- Window: ${userPayload.window.start}-${userPayload.window.end} seconds
- Current Data: ${JSON.stringify(userPayload.stkm, null, 2)}${facetData}

CRITICAL REQUIREMENTS:
1. Generate exactly ${userPayload.instructions.includes('2') ? '2' : '7'} betting-style multiple choice questions
2. Each question must be about FUTURE events (not past events)
3. Each question must be tied to betting markets
4. Each question must have 3 choices (A, B, C) - NEVER use "Unknown"
5. All choices must be realistic betting options with calculable odds
6. Questions should reward attentive viewers who are watching the game live

FORMAT YOUR RESPONSE EXACTLY AS:
Question 1: [Your betting question about future events]
A) [Realistic betting choice 1]
B) [Realistic betting choice 2]
C) [Realistic betting choice 3]

Question 2: [Your betting question about future events]
A) [Realistic betting choice 1]
B) [Realistic betting choice 2]
C) [Realistic betting choice 3]

[Continue for all questions]`;

    const result = await generateWithOllama(fullPrompt, model);
    
    return {
      text: result.text,
      error: result.error
    };
  } catch (error) {
    console.error('Error generating questions with Ollama and facets:', error);
    return {
      text: '',
      error: error
    };
  }
}
