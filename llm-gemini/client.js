// llm-gemini/client.js
import 'dotenv/config';
import { GoogleGenAI, Type } from '@google/genai';

// Configuration constants
const CONFIG = {
  DEFAULT_MODEL: 'gemini-2.5-flash',
  FALLBACK_MODEL: 'gemini-2.5-flash',
  TEMPERATURE: 1.0,
  MAX_TOOL_CALLS: 3, // Allow more tool calls for better question generation
  FACET_URL: process.env.FACET_URL || 'http://localhost:8080/get_facet',
  REQUEST_TIMEOUT: 30000, // 30 seconds
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000, // 2 seconds
  RATE_LIMIT_DELAY: 15000 // 15 seconds between requests (more conservative for 503 errors)
};

// Global rate limiting across all API calls
let lastRequestTime = 0;
let requestQueue = [];
let isProcessingQueue = false;

// Initialize AI client with validation
if (!process.env.GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY environment variable is required');
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ---- Tool declaration (matches AI Studio "function calling") ----
const tools = [
  {
    functionDeclarations: [
      {
        name: 'get_facet',
        description:
          'Fetches an extra compressed facet for a time window to enrich question generation.',
        parameters: {
          type: Type.OBJECT,
          required: ['gameId', 'start', 'end', 'facet'],
          properties: {
            gameId: {
              type: Type.STRING,
              description: 'Game id used when creating snapshots',
            },
            start: {
              type: Type.NUMBER,
              description: 'Window start time in seconds (e.g., 2700)',
            },
            end: {
              type: Type.NUMBER,
              description: 'Window end time in seconds (e.g., 3000)',
            },
            facet: {
              type: Type.STRING,
              description:
                'Which facet to fetch: PTF (Player Threat Focus), PAD (Pressure & Discipline), SPT (Set-Piece Threat), FTT (Field Tilt & Territory), PCS (Possession Chains Summary), KH (Keeper Heat), MMH (Minimal Market Hooks), NCMS (Narrative Capsule + Stats).',
              enum: ['PTF', 'PAD', 'SPT', 'FTT', 'PCS', 'KH', 'MMH', 'NCMS'],
            },
          },
        },
      },
    ],
  },
];

// ---- Logging utilities ----
function log(level, message, ...args) {
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  const currentLevel = levels[CONFIG.LOG_LEVEL] || 2;
  if (levels[level] <= currentLevel) {
    console[level](message, ...args);
  }
}

// ---- Global rate limiting and request queue ----
async function processRequestQueue() {
  if (isProcessingQueue || requestQueue.length === 0) return;
  
  isProcessingQueue = true;
  
  while (requestQueue.length > 0) {
    const { resolve, reject, fn } = requestQueue.shift();
    
    try {
      const now = Date.now();
      const timeSinceLastRequest = now - lastRequestTime;
      
      if (timeSinceLastRequest < CONFIG.RATE_LIMIT_DELAY) {
        const delay = CONFIG.RATE_LIMIT_DELAY - timeSinceLastRequest;
        log('debug', `Global rate limiting: waiting ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      lastRequestTime = Date.now();
      const result = await fn();
      resolve(result);
    } catch (error) {
      reject(error);
    }
  }
  
  isProcessingQueue = false;
}

async function queueRequest(fn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ resolve, reject, fn });
    processRequestQueue();
  });
}

async function retryWithBackoff(fn, maxRetries = CONFIG.MAX_RETRIES) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isRateLimit = error.message?.includes('503') || 
                         error.message?.includes('overloaded') ||
                         error.message?.includes('Service Unavailable') ||
                         error.message?.includes('UNAVAILABLE');
      
      if (isRateLimit && attempt < maxRetries) {
        const delay = CONFIG.RETRY_DELAY * Math.pow(2, attempt - 1); // Exponential backoff
        log('warn', `Rate limit hit, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      // If it's the last attempt and still a rate limit, wait longer
      if (isRateLimit && attempt === maxRetries) {
        log('warn', `Final attempt failed with rate limit, waiting 30 seconds before throwing`);
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
      
      throw error;
    }
  }
}

// ---- Input validation ----
function validateUserPayload(userPayload) {
  if (!userPayload || typeof userPayload !== 'object') {
    throw new Error('userPayload must be an object');
  }
  
  if (!userPayload.instructions || typeof userPayload.instructions !== 'string') {
    throw new Error('userPayload.instructions must be a non-empty string');
  }
  
  if (!userPayload.game || typeof userPayload.game !== 'string') {
    throw new Error('userPayload.game must be a non-empty string');
  }
  
  if (!userPayload.window || typeof userPayload.window !== 'object') {
    throw new Error('userPayload.window must be an object');
  }
  
  if (typeof userPayload.window.start !== 'number' || typeof userPayload.window.end !== 'number') {
    throw new Error('userPayload.window.start and end must be numbers');
  }
  
  if (!userPayload.stkm) {
    throw new Error('userPayload.stkm is required');
  }
}

// ---- Helpers ----
export async function* streamGen(request) {
  try {
    const stream = await ai.models.generateContentStream(request);
    for await (const chunk of stream) yield chunk;
  } catch (error) {
    log('error', 'Streaming generation failed:', error.message);
    throw error;
  }
}

export function firstFunctionCallFromAny(respOrChunk) {
  if (!respOrChunk) return null;
  
  try {
    if (respOrChunk.functionCalls?.[0]) return respOrChunk.functionCalls[0];
    const parts = respOrChunk.candidates?.[0]?.content?.parts || [];
    const p = parts.find((x) => x.functionCall);
    return p?.functionCall || null;
  } catch (error) {
    log('error', 'Error extracting function call:', error.message);
    return null;
  }
}

function extractTextFlexible(r) {
  if (!r) return '';
  
  try {
    // Try common shapes from @google/genai responses
    if (typeof r?.response?.text === 'function') return r.response.text();
    if (typeof r?.text === 'function') return r.text();
    
    const parts = r?.candidates?.[0]?.content?.parts || [];
    const out = parts
      .map((p) => {
        if (typeof p?.text === 'string') return p.text;
        if (p?.functionCall) return ''; // Skip function calls in text extraction
        return '';
      })
      .filter(Boolean)
      .join('\n');
    return out || '';
  } catch (error) {
    log('error', 'Error extracting text from response:', error.message);
    return '';
  }
}

/**
 * Generate content with Gemini using tools (function calling)
 * @param {Object} params - Parameters object
 * @param {string} params.systemInstruction - System instruction for the model
 * @param {Object} params.userPayload - User payload with instructions, game, window, and stkm data
 * @param {string} [params.model] - Model to use (defaults to CONFIG.DEFAULT_MODEL)
 * @returns {Promise<{text: string, error: Error|null}>} Response object with text and error
 */
export async function generateSimple({ systemInstruction, userPayload, model = null }) {
  const selectedModel = model || CONFIG.DEFAULT_MODEL;
  
  if (!validateUserPayload(userPayload)) {
    throw new Error('Invalid user payload');
  }

  const request = {
    model: selectedModel,
    config: {
      systemInstruction: [{ text: systemInstruction }],
      generationConfig: { temperature: CONFIG.TEMPERATURE },
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: userPayload.instructions }]
      }
    ],
  };

  try {
    log('debug', 'Queuing simple API call to Gemini with global rate limiting');
    
    const result = await queueRequest(async () => {
      return await retryWithBackoff(async () => {
        const resp = await ai.models.generateContent(request);
        const text = extractTextFlexible(resp);
        return { text, error: null };
      });
    });
    
    return result;
  } catch (error) {
    log('error', 'Simple generation failed:', error.message);
    return { text: '', error: error.message };
  }
}

export async function generateWithTools({ systemInstruction, userPayload, model = null }) {
  // Input validation
  if (!systemInstruction || typeof systemInstruction !== 'string') {
    throw new Error('systemInstruction must be a non-empty string');
  }
  
  validateUserPayload(userPayload);
  
  const selectedModel = model || process.env.GEMINI_MODEL || CONFIG.DEFAULT_MODEL;
  log('debug', `Generating with model: ${selectedModel}`);
  
  // Build user contents as multiple parts (instruction + metadata + STKM JSON)
  const contents = [
    {
      role: 'user',
      parts: [
        { text: userPayload.instructions },
        {
          text: `GAME_ID: ${userPayload.game} | WINDOW: ${userPayload.window.start}-${userPayload.window.end}s`,
        },
        { text: `STKM JSON:\n${JSON.stringify(userPayload.stkm, null, 2)}` },
      ],
    },
  ];

  const request = {
    model: selectedModel,
    config: {
      tools,
      toolConfig: { functionCallingConfig: 'AUTO' },
      systemInstruction: [{ text: systemInstruction }],
      generationConfig: { temperature: CONFIG.TEMPERATURE },
    },
    contents,
  };

  try {
    log('debug', 'Queuing API call to Gemini with global rate limiting');
    
    const result = await queueRequest(async () => {
      return await retryWithBackoff(async () => {
        // Try direct API call first
        try {
          const resp = await ai.models.generateContent(request);
          const text = extractTextFlexible(resp);
          const firstCall = firstFunctionCallFromAny(resp);
          
          // If there are function calls, resolve them to get the final response
          if (firstCall) {
            log('info', 'Function calls detected, resolving...');
            const resolved = await resolveAllToolCalls({ resp, text, firstCall, request }, { systemInstruction, userPayload, model: selectedModel });
            return { text: resolved.text, error: null };
          }
          
          return { text, error: null };
        } catch (directError) {
          log('warn', 'Direct API call failed, trying streaming fallback:', directError.message);
          
          // Fallback to streaming
          const chunks = [];
          let firstCall = null;
          
          for await (const ch of streamGen(request)) {
            chunks.push(ch);
            if (!firstCall) firstCall = firstFunctionCallFromAny(ch);
          }
          
          const resp = chunks[chunks.length - 1];
          const text = extractTextFlexible(resp);
          
          // If there are function calls, resolve them to get the final response
          if (firstCall) {
            log('info', 'Function calls detected in stream, resolving...');
            const resolved = await resolveAllToolCalls({ resp, text, firstCall, request }, { systemInstruction, userPayload, model: selectedModel });
            return { text: resolved.text, error: null };
          }
          
          return { text, error: null };
        }
      });
    });
    
    return result;
  } catch (error) {
    log('error', 'All retry attempts failed:', error.message);
    return { text: '', error: error };
  }
}

/**
 * Resolve all tool calls in a chain, handling function calling recursively
 * @param {Object} initialResponse - Initial response containing function calls
 * @param {Object} params - Parameters object
 * @param {string} params.systemInstruction - System instruction for the model
 * @param {Object} params.userPayload - User payload with instructions, game, window, and stkm data
 * @param {string} [params.model] - Model to use (defaults to CONFIG.DEFAULT_MODEL)
 * @returns {Promise<{resp: Object, text: string, firstCall: Object|null}>} Final response object
 */
export async function resolveAllToolCalls(initialResponse, { systemInstruction, userPayload, model = null }) {
  let currentResponse = initialResponse;
  let toolCallCount = 0;
  const usedFacets = new Set(); // Track which facets have been used
  const selectedModel = model || process.env.GEMINI_MODEL || CONFIG.DEFAULT_MODEL;
  
  // Build initial conversation history
  let conversationHistory = [
    {
      role: 'user',
      parts: [
        { text: userPayload.instructions },
        {
          text: `GAME_ID: ${userPayload.game} | WINDOW: ${userPayload.window.start}-${userPayload.window.end}s`,
        },
        { text: `STKM JSON:\n${JSON.stringify(userPayload.stkm, null, 2)}` },
      ],
    }
  ];
  
  while (currentResponse.firstCall && toolCallCount < CONFIG.MAX_TOOL_CALLS) {
    const call = currentResponse.firstCall;
    
    // Validate function call
    if (call.name !== 'get_facet') {
      log('warn', `Unknown function call: ${call.name}, stopping resolution`);
      break;
    }
    
    // Check if we've already used this facet
    if (usedFacets.has(call.args.facet)) {
      log('warn', `Facet ${call.args.facet} already used, stopping resolution`);
      break;
    }
    
    toolCallCount++;
    usedFacets.add(call.args.facet);
    log('info', `Resolving tool call ${toolCallCount}: ${call.args.facet}`);
    
    try {
      // Make facet request with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
      
      const r = await fetch(CONFIG.FACET_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(call.args),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!r.ok) {
        throw new Error(`facet error ${r.status}: ${r.statusText}`);
      }
      
      const facetData = await r.json();
      log('debug', `Received ${call.args.facet} facet data:`, JSON.stringify(facetData, null, 2));

      // Add model response with function call
      conversationHistory.push({
        role: 'model',
        parts: [
          { text: currentResponse.text || '' },
          {
            functionCall: {
              name: call.name,
              args: call.args,
            },
          },
        ],
      });
      
      // Add tool response
      conversationHistory.push({
        role: 'tool',
        parts: [
          {
            functionResponse: {
              name: 'get_facet',
              response: facetData,
            },
          },
        ],
      });

      // Continue conversation with tool response
      const followup = await ai.models.generateContent({
        model: selectedModel,
        config: {
          tools,
          toolConfig: { functionCallingConfig: 'AUTO' },
          systemInstruction: [{ text: systemInstruction }],
          generationConfig: { temperature: CONFIG.TEMPERATURE },
        },
        contents: conversationHistory,
      });

      const text = extractTextFlexible(followup);
      const nextCall = firstFunctionCallFromAny(followup);
      
      log('debug', `Tool resolution response: text="${text.substring(0, 100)}...", nextCall=${nextCall ? nextCall.name : 'none'}`);
      
      currentResponse = { resp: followup, text, firstCall: nextCall };
      
      if (nextCall) {
        log('info', `Next tool call detected: ${nextCall.args.facet}`);
      } else {
        log('info', 'Tool resolution complete - final response ready');
        break; // Exit loop when no more tool calls
      }
      
    } catch (error) {
      log('error', `Tool call ${toolCallCount} failed:`, error.message);
      log('info', 'Tool call failed, generating final response with available data');
      
      // Generate final response without tool data
      try {
        const finalResponse = await ai.models.generateContent({
          model: selectedModel,
          config: {
            systemInstruction: [{ text: systemInstruction }],
            generationConfig: { temperature: CONFIG.TEMPERATURE },
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: userPayload.instructions }]
            }
          ],
        });
        
        const finalText = extractTextFlexible(finalResponse);
        log('debug', `Fallback response: "${finalText.substring(0, 100)}..."`);
        
        currentResponse = { resp: finalResponse, text: finalText, firstCall: null };
        break;
      } catch (fallbackError) {
        log('error', 'Fallback generation also failed:', fallbackError.message);
        break;
      }
    }
  }
  
  if (toolCallCount >= CONFIG.MAX_TOOL_CALLS) {
    log('warn', `Maximum tool calls (${CONFIG.MAX_TOOL_CALLS}) reached, generating final response with available data`);
    
    // Generate final response with the facet data we've collected
    try {
      const finalResponse = await ai.models.generateContent({
        model: selectedModel,
        config: {
          systemInstruction: [{ text: systemInstruction }],
          generationConfig: { temperature: CONFIG.TEMPERATURE },
        },
        contents: conversationHistory,
      });
      
      const finalText = extractTextFlexible(finalResponse);
      log('debug', `Final response with facets: "${finalText.substring(0, 100)}..."`);
      
      currentResponse = { resp: finalResponse, text: finalText, firstCall: null };
    } catch (finalError) {
      log('error', 'Final response generation failed:', finalError.message);
    }
  }

  return currentResponse;
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use resolveAllToolCalls instead
 * @param {Object} prevResponse - Previous response object
 * @param {Object} params - Parameters object
 * @returns {Promise<Object>} Resolved response object
 */
export async function resolveOneToolCallAndContinue(prevResponse, { systemInstruction, userPayload, model = null }) {
  log('warn', 'resolveOneToolCallAndContinue is deprecated, use resolveAllToolCalls instead');
  const resolved = await resolveAllToolCalls(prevResponse, { systemInstruction, userPayload, model });
  return resolved;
}
