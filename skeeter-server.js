// Skeeter Game Server
// - POST /skeeter  : Vapi custom-tools webhook (voice version)
// - /api/*         : REST API for the web app (see app-api.js)
// - /              : static web app (public/)
// Game rules live in game-engine.js, shared by both frontends.

const express = require("express");
const engine = require("./game-engine");
const appApi = require("./app-api");

const app = express();
app.use(express.json({ limit: "2mb" }));

// CORS: lets the Vapi dashboard "Test Tool" panel call this server from the
// browser. Real Vapi tool calls are server-to-server and don't need this.
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- Vapi webhook endpoint ----------

app.post("/skeeter", (req, res) => {
  try {
    const message = req.body?.message;
    if (!message || message.type !== "tool-calls") {
      return res.status(200).json({ ok: true }); // ignore non-tool events
    }
    const callId = message.call?.id || "default";
    const toolCalls = message.toolCallList || [];
    const results = [];

    for (const tc of toolCalls) {
      const name = tc.function?.name || tc.name;
      let args = tc.function?.arguments ?? tc.arguments ?? {};
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      const game = engine.games.get(callId);
      let result;
      switch (name) {
        case "start_game":          result = engine.toolStartGame(game, args, callId); break;
        case "resolve_first_throw": result = engine.toolResolveFirstThrow(engine.games.get(callId), args); break;
        case "record_score":        result = engine.toolRecordScore(engine.games.get(callId), args); break;
        case "get_score":           result = engine.toolGetScore(engine.games.get(callId), args); break;
        case "get_leaderboard":     result = engine.toolGetLeaderboard(engine.games.get(callId)); break;
        default:                    result = `ERROR: Unknown tool ${name}.`;
      }
      // Vapi requires: results array, toolCallId matching, result as a STRING, HTTP 200.
      results.push({ toolCallId: tc.id, result: String(result) });
    }
    return res.status(200).json({ results });
  } catch (err) {
    console.error(err);
    return res.status(200).json({
      results: [{ toolCallId: req.body?.message?.toolCallList?.[0]?.id || "unknown", result: "ERROR: server hiccup, try again." }],
    });
  }
});

// ---------- Web app ----------

app.use("/api", appApi);
app.use(express.static("public"));

app.get("/health", (_req, res) => res.send("Skeeter's alive and ornery."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Skeeter server on ${PORT}`));
