// client.js (for @google/genai) — robust to response shapes
import 'dotenv/config';
import { GoogleGenAI, Type } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const tools = [
  {
    functionDeclarations: [
      {
        name: 'get_facet',
        description: 'Fetch a compressed facet for a time window to enrich question generation.',
        parameters: {
          type: Type.OBJECT,
          required: ['gameId', 'start', 'end', 'facet'],
          properties: {
            gameId: { type: Type.STRING, description: 'Game id used for snapshots' },
            start:  { type: Type.NUMBER, description: 'Start time in seconds' },
            end:    { type: Type.NUMBER, description: 'End time in seconds' },
            facet:  {
              type: Type.STRING,
              enum: ['STKM','PTF','PAD','SPT','FTT','PCS','KH','MMH','NCMS'],
              description: 'Which extra facet to fetch'
            }
          }
        }
      }
    ]
  }
];

// Helper: find the first function call regardless of shape
export function getFirstFunctionCall(resp) {
  if (!resp) return null;
  if (resp.functionCalls?.[0]) return resp.functionCalls[0];
  const parts = resp.candidates?.[0]?.content?.parts || [];
  const p = parts.find(x => x.functionCall);
  return p?.functionCall || null;
}

export async function generateWithTools({ systemInstruction, userPayload }) {
  return ai.models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-pro',
    config: {
      thinkingConfig: { thinkingBudget: -1 },
      tools,
      systemInstruction: [{ text: systemInstruction }]
    },
    contents: [
      { role: 'user', parts: [{ text: JSON.stringify(userPayload) }] }
    ]
  });
}

export async function resolveOneToolCallAndContinue(prevResponse, { systemInstruction, userPayload }) {
  const call = getFirstFunctionCall(prevResponse);
  if (!call || call.name !== 'get_facet') return prevResponse;

  const facetUrl = process.env.FACET_URL || 'http://localhost:8080/get_facet';
  const r = await fetch(facetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(call.args)
  });
  if (!r.ok) throw new Error(`facet error ${r.status}`);
  const facetData = await r.json();

  // Continue by providing the tool response back to the model
  return ai.models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-pro',
    config: {
      thinkingConfig: { thinkingBudget: -1 },
      tools,
      systemInstruction: [{ text: systemInstruction }]
    },
    contents: [
      { role: 'user', parts: [{ text: JSON.stringify(userPayload) }] },
      { role: 'tool', parts: [{ functionResponse: { name: 'get_facet', response: facetData } }] }
    ]
  });
}
