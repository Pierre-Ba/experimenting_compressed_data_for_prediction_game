// llm-gemini/client.js
import 'dotenv/config';
import { GoogleGenAI, Type } from '@google/genai';

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

// ---- Helpers ----
export async function* streamGen(request) {
  const stream = await ai.models.generateContentStream(request);
  for await (const chunk of stream) yield chunk;
}

export function firstFunctionCallFromAny(respOrChunk) {
  if (!respOrChunk) return null;
  if (respOrChunk.functionCalls?.[0]) return respOrChunk.functionCalls[0];
  const parts = respOrChunk.candidates?.[0]?.content?.parts || [];
  const p = parts.find((x) => x.functionCall);
  return p?.functionCall || null;
}

function extractTextFlexible(r) {
  // Try common shapes from @google/genai responses
  if (typeof r?.response?.text === 'function') return r.response.text();
  if (typeof r?.text === 'function') return r.text();
  const parts = r?.candidates?.[0]?.content?.parts || [];
  const out = parts
    .map((p) => {
      if (typeof p?.text === 'string') return p.text;
      if (p?.functionCall) return `[Function call: ${p.functionCall.name}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
  return out || '';
}

// ---- First turn: mirrors AI Studio (prompt text + "file" text) ----
export async function generateWithTools({ systemInstruction, userPayload, model = null }) {
  // Build user contents as multiple parts (instruction + metadata + STKM JSON).
  const contents = [
    {
      role: 'user',
      parts: [
        { text: userPayload.instructions || '' }, // your natural-language prompt
        {
          text: `GAME_ID: ${userPayload.game} | WINDOW: ${userPayload.window.start}-${userPayload.window.end}s`,
        },
        { text: `STKM JSON:\n${JSON.stringify(userPayload.stkm)}` }, // like attaching a file
      ],
    },
  ];

  const request = {
    model: model || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    config: {
      tools,
      toolConfig: { functionCallingConfig: 'AUTO' },
      systemInstruction: [{ text: systemInstruction }],
      generationConfig: { temperature: 1.0 }, // matches your AI Studio temperature
    },
    contents,
  };

  try {
    // Use generateContent instead of generateContentStream for better reliability
    const resp = await ai.models.generateContent(request);
    const text = extractTextFlexible(resp);
    const firstCall = firstFunctionCallFromAny(resp);
    return { resp, text, firstCall, request };
  } catch (error) {
    console.error('Direct API call failed, trying streaming fallback:', error.message);
    // Fallback to streaming if direct call fails
    try {
      const chunks = [];
      let firstCall = null;
      for await (const ch of streamGen(request)) {
        chunks.push(ch);
        if (!firstCall) firstCall = firstFunctionCallFromAny(ch);
      }
      const resp = chunks[chunks.length - 1];
      const text = extractTextFlexible(resp);
      return { resp, text, firstCall, request };
    } catch (streamError) {
      console.error('Streaming fallback also failed:', streamError.message);
      return { resp: null, text: '', firstCall: null, request, error: streamError };
    }
  }
}

// ---- Recursive tool resolution - handles complete function call chains ----
export async function resolveAllToolCalls(initialResponse, { systemInstruction, userPayload, model = null }) {
  let currentResponse = initialResponse;
  let toolCallCount = 0;
  const maxToolCalls = 5; // Prevent infinite loops
  
  while (currentResponse.firstCall && toolCallCount < maxToolCalls) {
    const call = currentResponse.firstCall;
    if (call.name !== 'get_facet') {
      console.log(`⚠️  Unknown function call: ${call.name}, stopping resolution`);
      break;
    }
    
    toolCallCount++;
    console.log(`🔧 Resolving tool call ${toolCallCount}: ${call.args.facet}`);
    
    try {
      const facetUrl = process.env.FACET_URL || 'http://localhost:8080/get_facet';
      const r = await fetch(facetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(call.args),
      });
      
      if (!r.ok) {
        throw new Error(`facet error ${r.status}: ${r.statusText}`);
      }
      
      const facetData = await r.json();
      console.log(`📊 Received ${call.args.facet} facet data:`, JSON.stringify(facetData, null, 2));

      // Build conversation history for continuation
      const conversationHistory = [
        {
          role: 'user',
          parts: [
            { text: userPayload.instructions || '' },
            {
              text: `GAME_ID: ${userPayload.game} | WINDOW: ${userPayload.window.start}-${userPayload.window.end}s`,
            },
            { text: `STKM JSON:\n${JSON.stringify(userPayload.stkm)}` },
          ],
        }
      ];

      // Add all previous model responses and tool calls
      if (currentResponse.resp) {
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
      }

      // Continue conversation with tool response
      const followup = await ai.models.generateContent({
        model: model || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        config: {
          tools,
          toolConfig: { functionCallingConfig: 'AUTO' },
          systemInstruction: [{ text: systemInstruction }],
          generationConfig: { temperature: 1.0 },
        },
        contents: conversationHistory,
      });

      const text = extractTextFlexible(followup);
      const nextCall = firstFunctionCallFromAny(followup);
      
      console.log(`🔍 Tool resolution response: text="${text}", nextCall=${nextCall ? nextCall.name : 'none'}`);
      
      currentResponse = { resp: followup, text, firstCall: nextCall };
      
      if (nextCall) {
        console.log(`🔧 Next tool call detected: ${nextCall.args.facet}`);
      } else {
        console.log(`✅ Tool resolution complete - final response ready`);
      }
      
             } catch (error) {
               console.error(`❌ Tool call ${toolCallCount} failed:`, error.message);
               console.log(`🔄 Tool call failed, generating final response with available data`);
               
               // Generate final response without tool data
               try {
                 const finalResponse = await ai.models.generateContent({
                   model: model || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
                   config: {
                     systemInstruction: [{ text: systemInstruction }],
                     generationConfig: { temperature: 1.0 },
                   },
                   contents: [
                     {
                       role: 'user',
                       parts: [{ text: userPayload.instructions || '' }]
                     }
                   ],
                 });
                 
                 const finalText = extractTextFlexible(finalResponse);
                 console.log(`🔍 Fallback response: "${finalText.substring(0, 100)}..."`);
                 
                 currentResponse = { resp: finalResponse, text: finalText, firstCall: null };
                 break;
               } catch (fallbackError) {
                 console.error(`❌ Fallback generation also failed:`, fallbackError.message);
                 break;
               }
             }
  }
  
  if (toolCallCount >= maxToolCalls) {
    console.log(`⚠️  Maximum tool calls (${maxToolCalls}) reached, stopping resolution`);
  }

  return currentResponse;
}

// ---- Legacy function for backward compatibility ----
export async function resolveOneToolCallAndContinue(prevResponse, { systemInstruction, userPayload, model = null }) {
  const resolved = await resolveAllToolCalls(prevResponse, { systemInstruction, userPayload, model });
  return resolved;
}
