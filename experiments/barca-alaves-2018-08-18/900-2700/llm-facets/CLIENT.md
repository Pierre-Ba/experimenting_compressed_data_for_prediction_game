# Using the get_facet tool with your LLM

## 1) Start the server
```bash
npm i express body-parser
node facet_server.js
# listens on :8080
```

## 2) Register the tool in your LLM (Gemini-like function calling)
Use this tool schema (JSON):
```json
{
  "name": "get_facet",
  "description": "Fetches an extra compressed facet for a 5-minute window to enrich question generation.",
  "parameters": {
    "type": "object",
    "properties": {
      "gameId": { "type": "string", "description": "The game identifier used when creating snapshots" },
      "start": { "type": "number", "description": "Window start time in seconds (e.g. 2700)" },
      "end": { "type": "number", "description": "Window end time in seconds (e.g. 3000)" },
      "facet": {
        "type": "string",
        "enum": ["PTF","PAD","SPT","FTT","PCS","KH","MMH","NCMS"],
        "description": "Which facet to fetch: PTF (Player Threat Focus), PAD (Pressure & Discipline), SPT (Set-Piece Threat), FTT (Field Tilt & Territory), PCS (Possession Chains Summary), KH (Keeper Heat), MMH (Minimal Market Hooks), NCMS (Narrative Capsule + Stats)."
      }
    },
    "required": ["gameId","start","end","facet"]
  }
}
```

## 3) Sample tool call (the model would emit this)
```json
{
  "tool": "get_facet",
  "arguments": {
    "gameId": "barca-alaves-2018-08-18",
    "start": 2700,
    "end": 3000,
    "facet": "PTF"
  }
}
```

## 4) Sample server response
```json
{
  "window": {"start":2700,"end":3000},
  "facet":"PTF",
  "data": {
    "top_attackers":[
      {"player":"Home Messi","team":"Home","shots":2,"sot":1,"box_touches":3,"key_passes":1},
      {"player":"Home Suarez","team":"Home","shots":1,"sot":1,"box_touches":2,"key_passes":0}
    ]
  }
}
```

## 5) Policy you can paste into your system prompt
- You receive `STKM` for each 5-minute window.
- If `STKM` is sufficient, do **not** call tools.
- Otherwise you may call `get_facet` **at most once per window** to fetch one of: PTF, PAD, SPT, FTT, PCS, KH, MMH, or NCMS.
- Choose the facet that most improves question quality for the **next 15 minutes** (e.g., PTF for hot attackers, PAD for fouls/cards tension, SPT for corners/FKs pressure).
- Stay under the token budget. Don’t repeat markets from `q_history`.
- Output 2–4 multiple-choice questions (3 options each), each clearly mapping to a betting market.
