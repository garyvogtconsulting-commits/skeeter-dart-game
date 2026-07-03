// Skeeter Game Engine - Vapi Custom Tools Webhook Server
// Deploy to Railway. Vapi POSTs tool calls here; this holds all game state.

const express = require("express");
const app = express();
app.use(express.json({ limit: "2mb" }));

// ---------- In-memory game state, keyed by Vapi call ID ----------
// Note: state resets if the server restarts. Fine for game night.
// Swap for Supabase later if you want persistent standing records.
const games = new Map();
let STANDING_RECORD = { name: null, points: 0 }; // survives across games until restart

function newGame(playerNames) {
  const secret = Math.floor(Math.random() * 20) + 1;
  const players = {};
  for (const raw of playerNames) {
    const name = normalize(raw);
    players[name] = {
      display: raw.trim(),
      sequence: buildSequence(secret),
      pos: 0,               // index into sequence
      doubledIn: false,
      onBull: false,
      onDoubleOut: false,
      finished: false,
      total: 0,
    };
  }
  return {
    secret,
    players,
    order: playerNames.map(normalize),
    turnCount: 0,
    firstThrowResolved: false,
    winner: null,
  };
}

function buildSequence(secret) {
  const nums = [];
  for (let i = 1; i <= 20; i++) if (i !== secret) nums.push(i);
  // Fisher-Yates shuffle
  for (let i = nums.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [nums[i], nums[j]] = [nums[j], nums[i]];
  }
  return [secret, ...nums]; // secret number is always first
}

function normalize(s) {
  return String(s || "").trim().toLowerCase();
}

function findPlayer(game, name) {
  const key = normalize(name);
  if (game.players[key]) return game.players[key];
  // fuzzy: startsWith match for voice transcription slop ("darlene" vs "darlene s")
  const hit = Object.keys(game.players).find(
    (k) => k.startsWith(key) || key.startsWith(k)
  );
  return hit ? game.players[hit] : null;
}

function currentTarget(p) {
  if (p.finished) return "DONE";
  if (p.onDoubleOut) return "any DOUBLE on the board (double out)";
  if (p.onBull) return "the BULL";
  return `the ${p.sequence[p.pos]}`;
}

function leaderLine(game) {
  const rows = Object.values(game.players)
    .map((p) => ({ name: p.display, total: p.total }))
    .sort((a, b) => b.total - a.total);
  if (rows.length < 2) return `${rows[0].name} has ${rows[0].total} points.`;
  const [a, b] = rows;
  if (a.total === b.total) return `We got a tie at the top: ${a.name} and ${b.name} both at ${a.total}.`;
  return `${a.name} leads with ${a.total}. ${b.name} is chasing at ${b.total}.`;
}

// ---------- Tool implementations (each returns a plain string) ----------

function toolStartGame(game, args, callId) {
  const names = args.playerNames || [];
  if (!names.length) return "ERROR: No player names given. Ask for player names first.";
  games.set(callId, newGame(names));
  return `Game created with players: ${names.join(", ")}. Secret number is locked in (hidden). Tell each player to throw one dart at the board and report the number they hit, then call resolve_first_throw with everyone's numbers.`;
}

function toolResolveFirstThrow(game, args) {
  if (!game) return "ERROR: No game started. Call start_game first.";
  const throws = args.throws || [];
  if (!throws.length) return "ERROR: No throws provided.";
  let best = null;
  for (const t of throws) {
    const dist = Math.abs(Number(t.number) - game.secret);
    if (!best || dist < best.dist) best = { player: t.player, dist };
  }
  game.firstThrowResolved = true;
  return `The secret number was ${game.secret}! Closest was ${best.player}, so ${best.player} throws first. EVERY player's first target is the ${game.secret}, and they must DOUBLE IN: only a double on the ${game.secret} counts to get on the board.`;
}

function toolRecordScore(game, args) {
  if (!game) return "ERROR: No game started. Call start_game first.";
  if (game.winner) return `Game's over. ${game.winner} already won. Call start_game to play again.`;
  const p = findPlayer(game, args.player);
  if (!p) return `ERROR: No player named ${args.player} in this game.`;
  if (p.finished) return `${p.display} already finished. They're done, partner.`;

  const hit = normalize(args.hit); // single | double | triple | miss | green_bull | red_bull
  game.turnCount++;
  let msg = "";

  if (p.onDoubleOut) {
    // Final stage: player must hit ANY double on the board to end the game.
    if (hit === "double") {
      p.total += 2;
      p.onDoubleOut = false;
      p.finished = true;
      game.winner = p.display;
      const recordNote = recordCheck(p);
      msg = `DOUBLE OUT! 2 points for ${p.display}, final total: ${p.total}. ${p.display} WINS! ${recordNote} Sing the victory song!`;
    } else if (hit === "miss") {
      msg = `Miss. ${p.display} still needs ANY double on the board to go out. Total holds at ${p.total}.`;
    } else {
      msg = `Don't count, hoss. ${p.display} needs a DOUBLE to end it. Anything else is just noise. Total: ${p.total}. Target: any double on the board.`;
    }
  } else if (p.onBull) {
    // Bull stage: land EITHER bull to record points, then move to double-out.
    if (hit === "red_bull" || hit === "red" || hit === "bullseye") {
      p.total += 10;
      p.onBull = false;
      p.onDoubleOut = true;
      msg = `RED BULL! 10 points for ${p.display}, new total: ${p.total}. Bull's done. Now DOUBLE OUT: hit any double on the board to win.`;
    } else if (hit === "green_bull" || hit === "green") {
      p.total += 5;
      p.onBull = false;
      p.onDoubleOut = true;
      msg = `Green bull, 5 points for ${p.display}, new total: ${p.total}. Bull's done. Now DOUBLE OUT: hit any double on the board to win.`;
    } else if (hit === "miss") {
      msg = `Miss. ${p.display} stays on the BULL. Total holds at ${p.total}. Green's 5, red's 10.`;
    } else {
      msg = `${p.display} is on the BULL. Only green_bull, red_bull, or miss count here. No points. Total: ${p.total}.`;
    }
  } else if (!p.doubledIn) {
    // Must double in on the secret number (their first target).
    if (hit === "double") {
      p.doubledIn = true;
      p.total += 2;
      p.pos++;
      msg = `DOUBLE IN! ${p.display} is on the board. 2 points, total: ${p.total}. Next target: ${currentTarget(p)}.`;
    } else if (hit === "miss") {
      msg = `Miss. ${p.display} still needs a DOUBLE on the ${p.sequence[p.pos]} to get in. Total: 0.`;
    } else {
      msg = `Nice throw but it don't count: ${p.display} must DOUBLE IN first. Still hunting a double on the ${p.sequence[p.pos]}. Total: 0.`;
    }
  } else {
    // Normal play through the 20 numbers.
    const pts = { single: 1, double: 2, triple: 3, miss: 0 };
    if (!(hit in pts)) {
      msg = `ERROR: hit must be single, double, triple, miss, green_bull, or red_bull. Got: ${args.hit}.`;
    } else if (hit === "miss") {
      msg = `Goose egg. ${p.display} stays on ${currentTarget(p)}. Total: ${p.total}.`;
    } else {
      p.total += pts[hit];
      p.pos++;
      if (p.pos >= 20) {
        p.onBull = true;
        msg = `${pts[hit]} point${pts[hit] > 1 ? "s" : ""} for ${p.display}, total: ${p.total}. That clears all 20 numbers! Next target: the BULL. Green is 5, red is 10. Land either one, then it's double out to win.`;
      } else {
        msg = `${pts[hit]} point${pts[hit] > 1 ? "s" : ""} for ${p.display}, new total: ${p.total}. Next target: ${currentTarget(p)}.`;
      }
    }
  }

  if (!game.winner && game.turnCount % 3 === 0) {
    msg += ` LEADER CHECK, announce it: ${leaderLine(game)}`;
  }
  return msg;
}

function recordCheck(p) {
  if (p.total > STANDING_RECORD.points) {
    STANDING_RECORD = { name: p.display, points: p.total };
    return `NEW STANDING RECORD: ${p.display} with ${p.total} points (record counts because they won).`;
  }
  return `Standing record stays with ${STANDING_RECORD.name || "nobody yet"} at ${STANDING_RECORD.points}.`;
}

function toolGetScore(game, args) {
  if (!game) return "ERROR: No game started.";
  const p = findPlayer(game, args.player);
  if (!p) return `ERROR: No player named ${args.player}.`;
  return `${p.display} has ${p.total} points. Current target: ${currentTarget(p)}.${p.doubledIn ? "" : " (Still needs to double in.)"}`;
}

function toolGetLeaderboard(game) {
  if (!game) return "ERROR: No game started.";
  const rows = Object.values(game.players)
    .sort((a, b) => b.total - a.total)
    .map((p) => `${p.display}: ${p.total}${p.finished ? " (FINISHED)" : ""}`)
    .join("; ");
  return `Scoreboard: ${rows}. Standing record: ${STANDING_RECORD.name || "none"} at ${STANDING_RECORD.points}.`;
}

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
      const game = games.get(callId);
      let result;
      switch (name) {
        case "start_game":          result = toolStartGame(game, args, callId); break;
        case "resolve_first_throw": result = toolResolveFirstThrow(games.get(callId), args); break;
        case "record_score":        result = toolRecordScore(games.get(callId), args); break;
        case "get_score":           result = toolGetScore(games.get(callId), args); break;
        case "get_leaderboard":     result = toolGetLeaderboard(games.get(callId)); break;
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

app.get("/health", (_req, res) => res.send("Skeeter's alive and ornery."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Skeeter server on ${PORT}`));
