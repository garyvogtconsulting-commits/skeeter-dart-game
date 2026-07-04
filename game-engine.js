// Skeeter Game Engine - shared rules for "Race to the Top with Skeeter".
// Used by BOTH the Vapi voice webhook (tool* functions, hit-type based) and
// the web app REST API (throw-by-board-position based). One games Map holds
// both kinds of sessions: Vapi games are keyed by call ID, app games by g_ ids.

const crypto = require("crypto");

const games = new Map();
let STANDING_RECORD = { name: null, points: 0 }; // survives across games until restart

// ---------- Core state ----------

function newGame(playerNames) {
  const secret = Math.floor(Math.random() * 20) + 1;
  const players = {};
  for (const raw of playerNames) {
    const name = normalize(raw);
    players[name] = {
      display: String(raw).trim(),
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
    // Web-app session fields (ignored by the Vapi flow)
    phase: "first_throw",        // first_throw | playing | finished
    firstThrows: {},             // normalized name -> number thrown
    firstThrowPool: playerNames.map(normalize), // who's still competing for first
    currentIdx: 0,               // index into order: whose turn
    lastEvent: null,
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

function stageOf(p) {
  if (p.finished) return "finished";
  if (p.onDoubleOut) return "double_out";
  if (p.onBull) return "bull";
  if (!p.doubledIn) return "double_in";
  return "numbers";
}

function currentTarget(p) {
  if (p.finished) return "DONE";
  if (p.onDoubleOut) return "any DOUBLE on the board (double out)";
  if (p.onBull) return "the BULL";
  if (!p.doubledIn) return "any DOUBLE on the board (to double in)";
  return `the ${p.sequence[p.pos]}`;
}

function targetInfo(p) {
  const kind = stageOf(p);
  return {
    kind, // double_in | numbers | bull | double_out | finished
    number: kind === "numbers" ? p.sequence[p.pos] : null,
    label: currentTarget(p),
  };
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

function recordCheck(p) {
  if (p.total > STANDING_RECORD.points) {
    STANDING_RECORD = { name: p.display, points: p.total };
    return `NEW STANDING RECORD: ${p.display} with ${p.total} points (record counts because they won).`;
  }
  return `Standing record stays with ${STANDING_RECORD.name || "nobody yet"} at ${STANDING_RECORD.points}.`;
}

function standingRecord() {
  return { ...STANDING_RECORD };
}

// ---------- Vapi tool implementations (each returns a plain string) ----------

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
  game.phase = "playing";
  const idx = game.order.findIndex((k) => game.players[k] === findPlayer(game, best.player));
  if (idx >= 0) game.currentIdx = idx;
  return `The secret number was ${game.secret}! Closest was ${best.player}, so ${best.player} throws first. Every player must DOUBLE IN first: hit ANY double anywhere on the board to get started (the double-in scores no points). After doubling in, their first scoring target is the ${game.secret}.`;
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
      p.onDoubleOut = false;
      p.finished = true;
      game.winner = p.display;
      const recordNote = recordCheck(p);
      msg = `DOUBLE OUT! The closing double scores nothing, but it don't need to. Final total: ${p.total}. ${p.display} WINS! ${recordNote} Sing the victory song!`;
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
    // Must double in first: ANY double on the board, scores 0 points.
    // Only after that can they start scoring, beginning with the secret number.
    if (hit === "double") {
      p.doubledIn = true;
      msg = `DOUBLE IN! ${p.display} is on the board. The double-in scores nothing, total: ${p.total}. First scoring target: ${currentTarget(p)}.`;
    } else if (hit === "miss") {
      msg = `Miss. ${p.display} still needs ANY double on the board to get in. Total: ${p.total}.`;
    } else {
      msg = `Nice throw but it don't count: ${p.display} must DOUBLE IN first. Any double on the board gets you started. Total: ${p.total}.`;
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

// ---------- Web app API (throw-by-board-position) ----------
// The app reports WHERE the dart landed (segment + ring); the server judges
// whether it counts. segment: 1-20 | "green_bull" | "red_bull" | "miss".
// ring: "single" | "double" | "triple" (only meaningful for numbered segments).

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createGame(playerNames) {
  if (!Array.isArray(playerNames) || playerNames.length < 1) {
    throw new ApiError(400, "playerNames must be a non-empty array");
  }
  const cleaned = playerNames.map((n) => String(n).trim()).filter(Boolean);
  if (!cleaned.length) throw new ApiError(400, "playerNames must contain at least one name");
  const keys = new Set(cleaned.map(normalize));
  if (keys.size !== cleaned.length) throw new ApiError(400, "player names must be unique");
  const id = "g_" + crypto.randomBytes(4).toString("hex");
  games.set(id, newGame(cleaned));
  return id;
}

function getGame(id) {
  const game = games.get(id);
  if (!game) throw new ApiError(404, "no game with that id");
  return game;
}

function publicState(id, game) {
  const currentKey = game.order[game.currentIdx];
  return {
    id,
    phase: game.phase,
    secret: game.phase === "first_throw" ? null : game.secret,
    currentPlayer:
      game.phase === "playing" ? game.players[currentKey].display : null,
    turnCount: game.turnCount,
    winner: game.winner,
    players: game.order.map((k) => {
      const p = game.players[k];
      return {
        name: p.display,
        total: p.total,
        stage: stageOf(p),
        doubledIn: p.doubledIn,
        target: targetInfo(p),
        isTurn: game.phase === "playing" && k === currentKey && !p.finished,
      };
    }),
    standingRecord: standingRecord(),
    firstThrow:
      game.phase === "first_throw"
        ? {
            thrown: Object.fromEntries(
              Object.entries(game.firstThrows).map(([k, v]) => [
                game.players[k].display,
                v,
              ])
            ),
            awaiting: game.firstThrowPool
              .filter((k) => !(k in game.firstThrows))
              .map((k) => game.players[k].display),
          }
        : null,
    lastEvent: game.lastEvent,
  };
}

function submitFirstThrow(game, playerName, number) {
  if (game.phase !== "first_throw") throw new ApiError(409, "first throws are already resolved");
  const n = Number(number);
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new ApiError(400, "number must be 1-20");
  const p = findPlayer(game, playerName);
  if (!p) throw new ApiError(404, `no player named ${playerName}`);
  const key = game.order.find((k) => game.players[k] === p);
  if (!game.firstThrowPool.includes(key)) {
    throw new ApiError(409, `${p.display} is not throwing for first right now`);
  }
  game.firstThrows[key] = n;

  const awaiting = game.firstThrowPool.filter((k) => !(k in game.firstThrows));
  if (awaiting.length > 0) {
    const event = {
      type: "first_throw_recorded",
      player: p.display,
      text: `${p.display} threw a ${n}. Waiting on: ${awaiting
        .map((k) => game.players[k].display)
        .join(", ")}.`,
    };
    game.lastEvent = event;
    return event;
  }

  // Everyone in the pool has thrown: find who's closest to the secret.
  let bestDist = Infinity;
  for (const k of game.firstThrowPool) {
    bestDist = Math.min(bestDist, Math.abs(game.firstThrows[k] - game.secret));
  }
  const winners = game.firstThrowPool.filter(
    (k) => Math.abs(game.firstThrows[k] - game.secret) === bestDist
  );

  if (winners.length > 1) {
    // Tie: only the tied players throw again.
    game.firstThrowPool = winners;
    game.firstThrows = {};
    const names = winners.map((k) => game.players[k].display);
    const event = {
      type: "first_throw_tie",
      players: names,
      text: `Tie! ${names.join(" and ")} are dead even. Y'all throw again.`,
    };
    game.lastEvent = event;
    return event;
  }

  game.phase = "playing";
  game.firstThrowResolved = true;
  game.currentIdx = game.order.indexOf(winners[0]);
  const first = game.players[winners[0]].display;
  const event = {
    type: "first_throw_resolved",
    secret: game.secret,
    first,
    text: `The secret number was ${game.secret}! ${first} was closest and throws first. Everybody's gotta DOUBLE IN: any double on the board, scores nothing, just gets you started. After that, first scoring target is the ${game.secret}.`,
  };
  game.lastEvent = event;
  return event;
}

const RING_POINTS = { single: 1, double: 2, triple: 3 };

function throwDart(game, segment, ring) {
  if (game.phase === "first_throw") throw new ApiError(409, "resolve first throws before playing");
  if (game.winner) throw new ApiError(409, `game is over — ${game.winner} won`);

  const key = game.order[game.currentIdx];
  const p = game.players[key];

  const seg = typeof segment === "string" ? normalize(segment) : Number(segment);
  const isNumber = Number.isInteger(seg) && seg >= 1 && seg <= 20;
  const isMiss = seg === "miss";
  const isGreen = seg === "green_bull";
  const isRed = seg === "red_bull";
  if (!isNumber && !isMiss && !isGreen && !isRed) {
    throw new ApiError(400, "segment must be 1-20, green_bull, red_bull, or miss");
  }
  if (isNumber && !(normalize(ring) in RING_POINTS)) {
    throw new ApiError(400, "ring must be single, double, or triple for a numbered segment");
  }
  const r = isNumber ? normalize(ring) : null;

  let event;
  const st = stageOf(p);

  if (st === "double_in") {
    if (isNumber && r === "double") {
      p.doubledIn = true;
      event = ev("double_in", p, 0, `DOUBLE IN! ${p.display} is on the board. Scores nothing, but you're alive. First scoring target: ${currentTarget(p)}.`);
      advanceTurn(game, event);
    } else if (isMiss) {
      event = ev("miss", p, 0, `Off the board. ${p.display} still needs ANY double to get in.`);
    } else {
      event = ev("no_count", p, 0, `Don't count. ${p.display} must DOUBLE IN first — any double on the board.`);
    }
  } else if (st === "numbers") {
    const target = p.sequence[p.pos];
    if (isMiss) {
      event = ev("miss", p, 0, `Goose egg. ${p.display} stays on the ${target}.`);
    } else if (isGreen || isRed) {
      event = ev("no_count", p, 0, `Nice bull, wrong time. ${p.display} needs the ${target}. No score.`);
    } else if (seg !== target) {
      event = ev("no_count", p, 0, `That's the ${seg}, hoss — you need the ${target}. No score.`);
    } else {
      const pts = RING_POINTS[r];
      p.total += pts;
      p.pos++;
      if (p.pos >= 20) {
        p.onBull = true;
        event = ev("to_bull", p, pts, `${pts} point${pts > 1 ? "s" : ""} for ${p.display}, total ${p.total} — and that clears all 20 numbers! Next up: the BULL. Green's 5, red's 10.`);
      } else {
        event = ev("score", p, pts, `${pts} point${pts > 1 ? "s" : ""} for ${p.display}, total ${p.total}. Next target: ${currentTarget(p)}.`);
      }
      advanceTurn(game, event);
    }
  } else if (st === "bull") {
    if (isGreen || isRed) {
      const pts = isRed ? 10 : 5;
      p.total += pts;
      p.onBull = false;
      p.onDoubleOut = true;
      event = ev(isRed ? "red_bull" : "green_bull", p, pts, `${isRed ? "RED BULL! 10" : "Green bull, 5"} points for ${p.display}, total ${p.total}. Now DOUBLE OUT: any double on the board wins it.`);
      advanceTurn(game, event);
    } else if (isMiss) {
      event = ev("miss", p, 0, `Miss. ${p.display} stays on the BULL. Green's 5, red's 10.`);
    } else {
      event = ev("no_count", p, 0, `${p.display}'s huntin' the BULL — that don't count. No score.`);
    }
  } else if (st === "double_out") {
    if (isNumber && r === "double") {
      p.onDoubleOut = false;
      p.finished = true;
      game.winner = p.display;
      game.phase = "finished";
      const recordNote = recordCheck(p);
      event = ev("win", p, 0, `DOUBLE OUT! Scores nothing, don't need to. Final total: ${p.total}. ${p.display} WINS! ${recordNote}`);
      event.recordNote = recordNote;
    } else if (isMiss) {
      event = ev("miss", p, 0, `Miss. ${p.display} needs ANY double to go out. Total holds at ${p.total}.`);
    } else {
      event = ev("no_count", p, 0, `Don't count. ${p.display} needs a DOUBLE to end it. Total: ${p.total}.`);
    }
  } else {
    throw new ApiError(409, `${p.display} already finished`);
  }

  game.lastEvent = event;
  return event;
}

function passTurn(game) {
  if (game.phase !== "playing") throw new ApiError(409, "no turn to pass");
  const p = game.players[game.order[game.currentIdx]];
  const event = ev("pass", p, 0, `${p.display} hands over the darts.`);
  advanceTurn(game, event);
  game.lastEvent = event;
  return event;
}

function ev(type, p, points, text) {
  return {
    type,
    player: p.display,
    points,
    total: p.total,
    target: currentTarget(p),
    text,
  };
}

// A completed turn = the current player's throw counted (or they passed).
// House rule: you keep throwing until you hit your target, so misses and
// no-counts do NOT advance the turn.
function advanceTurn(game, event) {
  game.turnCount++;
  if (!game.winner && game.turnCount % 3 === 0) {
    event.leaderCheck = leaderLine(game);
  }
  if (game.winner) return;
  const n = game.order.length;
  for (let i = 1; i <= n; i++) {
    const idx = (game.currentIdx + i) % n;
    if (!game.players[game.order[idx]].finished) {
      game.currentIdx = idx;
      return;
    }
  }
}

module.exports = {
  games,
  newGame,
  normalize,
  findPlayer,
  currentTarget,
  leaderLine,
  standingRecord,
  ApiError,
  // Vapi tools
  toolStartGame,
  toolResolveFirstThrow,
  toolRecordScore,
  toolGetScore,
  toolGetLeaderboard,
  // Web app API
  createGame,
  getGame,
  publicState,
  submitFirstThrow,
  throwDart,
  passTurn,
};
