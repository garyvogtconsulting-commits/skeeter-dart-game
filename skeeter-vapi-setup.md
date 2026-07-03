# Skeeter on Vapi: Tool Setup Instructions

## Why tools instead of variables

Vapi's {{variables}} (variableValues / assistantOverrides) are set once at call start and are static during the call. They can't hold live scores. Custom Tools are the right mechanism: Skeeter's LLM calls a tool, Vapi POSTs to your server, your server holds the game state and returns a string Skeeter reads back. This makes scorekeeping bulletproof instead of relying on the LLM's memory.

Architecture: Vapi Assistant (Skeeter) → Custom Tools → your Railway server (skeeter-server.js) → in-memory game state keyed by call ID.

---

## STEP 1: Deploy the server to Railway

1. Create a new folder, drop in `skeeter-server.js` and `package.json`.
2. Push to a GitHub repo (or use `railway up` from the CLI).
3. Railway → New Project → Deploy from GitHub repo. It auto-detects Node and runs `npm start`.
4. In Railway, go to Settings → Networking → Generate Domain. Copy your public URL, e.g. `https://skeeter-production.up.railway.app`
5. Test it: open `https://YOUR-URL/health` in a browser. You should see "Skeeter's alive and ornery."

Your webhook endpoint for all tools is: `https://YOUR-URL/skeeter`

---

## STEP 2: Create the 5 tools in the Vapi Dashboard

Dashboard → Tools → Create Tool → choose **Custom Tool** (function type). Create each of the 5 below. For EVERY tool:

- **Server URL:** `https://YOUR-URL/skeeter`
- **Async:** OFF (blocking). Skeeter must wait for the result before speaking the score.
- **Messages (optional but recommended):** Request Start message: leave blank or use something short like "Lemme check my clipboard..." so there's no dead air.

### Tool 1: start_game
- Name: `start_game`
- Description: `Start a new game of Race to the Top. Call this once all player names are collected. The server picks a hidden secret number and builds each player's random 20-number sequence.`
- Parameters (JSON schema):
```json
{
  "type": "object",
  "properties": {
    "playerNames": {
      "type": "array",
      "items": { "type": "string" },
      "description": "List of player names in registration order"
    }
  },
  "required": ["playerNames"]
}
```

### Tool 2: resolve_first_throw
- Name: `resolve_first_throw`
- Description: `After every player throws one dart and reports the number they hit, call this with all throws. The server reveals the secret number and declares who throws first.`
- Parameters:
```json
{
  "type": "object",
  "properties": {
    "throws": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "player": { "type": "string", "description": "Player name" },
          "number": { "type": "integer", "description": "Board number they hit, 1-20" }
        },
        "required": ["player", "number"]
      },
      "description": "One entry per player with the number they hit"
    }
  },
  "required": ["throws"]
}
```

### Tool 3: record_score
- Name: `record_score`
- Description: `Record a player's throw result. ALWAYS call this when a player reports a score or a miss. The server handles double-in, points, sequence advancement, the bull, the final double-out, win detection, and leader checks. Player point calls map as: '1 point' = single, '2 points' = double, '3 points' = triple. On the bull stage use green_bull or red_bull. On the double-out stage, a hit of double ends the game.`
- Parameters:
```json
{
  "type": "object",
  "properties": {
    "player": { "type": "string", "description": "Player name" },
    "hit": {
      "type": "string",
      "enum": ["single", "double", "triple", "miss", "green_bull", "red_bull"],
      "description": "single = 1 point, double = 2 points, triple = 3 points, miss = no score, green_bull = outer bull (5 points), red_bull = inner bull (10 points). Landing either bull moves the player to the double-out stage, where 'double' (any double on the board) scores 2 and wins the game."
    }
  },
  "required": ["player", "hit"]
}
```

### Tool 4: get_score
- Name: `get_score`
- Description: `Look up one player's current point total and current target. Call whenever anyone asks how many points they have.`
- Parameters:
```json
{
  "type": "object",
  "properties": {
    "player": { "type": "string", "description": "Player name" }
  },
  "required": ["player"]
}
```

### Tool 5: get_leaderboard
- Name: `get_leaderboard`
- Description: `Get all players' totals plus the standing record. Call when asked who is winning or for a full scoreboard.`
- Parameters:
```json
{ "type": "object", "properties": {} }
```

---

## STEP 3: Attach tools to the Skeeter assistant

1. Dashboard → Assistants → your Skeeter assistant → Tools tab (or Functions section in the model config).
2. Add all 5 tools: start_game, resolve_first_throw, record_score, get_score, get_leaderboard.
3. Model tip: use a strong tool-calling model (GPT-4o or Claude) rather than a mini model. Skeeter has personality AND has to call tools correctly.
4. If you see truncated tool responses in call logs ("token truncation warnings"), raise the tool/model max tokens. The default tool response token limit is low (100) and Skeeter's result strings can run longer.

---

## STEP 4: Add this block to Skeeter's system prompt

Paste this at the END of the Skeeter system prompt (from the original prompt doc), replacing the old "State Tracking Template" section entirely. The server owns the state now.

```
## TOOL USAGE (CRITICAL - the server is the official scoreboard, not your memory)

You NEVER track scores, sequences, targets, or totals yourself. The game server does. Your job is to call tools, then read the results back in your voice.

1. GAME START: Collect all player names, then call start_game with the names. Then tell everyone to throw one dart each and report their number.
2. FIRST THROW: Once every player reports a number, call resolve_first_throw with all of them. Announce the secret number, who throws first, and the double-in rule, in your own words.
3. EVERY SCORE REPORT: When a player says anything like "Skeeter, put me down for 3", "I got 2 points", "I hit a double", "missed", "green bull", or "red bull", IMMEDIATELY call record_score. Map their words: 1 point = single, 2 points = double, 3 points = triple, nothing/whiff = miss.
4. READ BACK THE RESULT: The tool returns the points scored, the new total, and the player's NEXT TARGET. Always announce all three, in character. Never invent a target number. Only say the target the tool gives you.
5. LEADER CHECK: If the tool result contains "LEADER CHECK", announce who's leading right then, with some trash talk.
6. SCORE QUESTIONS: If anyone asks their points, call get_score and announce it. If they ask who's winning, call get_leaderboard.
7. WIN: If the tool result says a player WINS, celebrate huge and sing the victory song. Mention the standing record status the tool reports.
8. NEVER guess or estimate a score. If a tool errors, tell the players the clipboard's acting up and ask them to repeat.
9. Do not read tool results word-for-word like a robot. Say the same facts in Skeeter's voice. The NUMBERS must match the tool exactly.
```

---

## STEP 5: Test sequence

1. Call the assistant. Say: "Skeeter, new game. Players are Gary and Dale."
   - Expect: start_game fires, Skeeter asks for first throws.
2. "Gary hit 12, Dale hit 6."
   - Expect: resolve_first_throw fires, secret number revealed, first player named, double-in reminder.
3. "Skeeter, put me down for 2 points" (as the first player).
   - Expect: record_score with hit=double, double-in confirmed, 2 points, next target announced.
4. "Skeeter, how many points do I have?"
   - Expect: get_score fires, correct total.
5. Report scores until a leader check fires (every 3rd score report).
6. Check Railway logs (`railway logs` or the dashboard) to watch the requests land.

---

## Notes & gotchas

- **Response format is strict.** The server already handles it: HTTP 200, `{"results":[{"toolCallId":"...","result":"..."}]}`, result as a plain string, toolCallId matching the request. If you ever move this to Make.com instead, map `{{1.message.toolCallList[0].id}}` into toolCallId in the Webhook Response module.
- **State lives in memory keyed by Vapi call ID.** One phone call = one game session. If the call drops, the game state is gone. The standing record persists across games but not across server restarts. Want it permanent? Swap the STANDING_RECORD variable for a Supabase table (you already have Supabase on the caproute stack, it's a 10-line change).
- **End-game flow (confirmed rule):** clear all 20 numbers → target the bull. Landing EITHER bull records the points (green 5, red 10) and completes the bull stage. Then the player must hit ANY double on the board to go out. The winning double scores 2 points toward the final total. Only the game winner's score can take the standing record. If you'd rather the closing double score 0 points, delete the `p.total += 2;` line in the onDoubleOut block of toolRecordScore.
- **Voice slop:** the server does fuzzy name matching so "Darlene" vs "Darlene S." transcription differences still resolve.
