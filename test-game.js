// End-to-end tests for the Skeeter game server.
// Boots the server on a test port, plays full games through both the
// web app REST API and the Vapi webhook, and checks every rule.
// Run: npm test

const { spawn } = require("child_process");

const PORT = 3971;
const BASE = `http://localhost:${PORT}`;
let failures = 0;

function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok - ${label}`);
  } else {
    failures++;
    console.error(`  FAIL - ${label}${detail ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function vapiTool(callId, name, args) {
  const res = await fetch(BASE + "/skeeter", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        type: "tool-calls",
        call: { id: callId },
        toolCallList: [{ id: "t", function: { name, arguments: args } }],
      },
    }),
  });
  const json = await res.json();
  return json.results[0].result;
}

async function testAppApi() {
  console.log("APP API: full game");

  // Create
  let r = await api("POST", "/api/games", { playerNames: ["Gary", "Dale"] });
  check("create game returns 201", r.status === 201, r);
  const id = r.body.state.id;
  check("phase starts at first_throw", r.body.state.phase === "first_throw");
  check("secret hidden during first throws", r.body.state.secret === null);

  // Bad inputs
  r = await api("POST", "/api/games", { playerNames: [] });
  check("empty playerNames rejected", r.status === 400);
  r = await api("POST", `/api/games/${id}/throw`, { segment: 5, ring: "double" });
  check("throw before first-throw resolution rejected", r.status === 409);

  // First throws: same number = guaranteed tie
  r = await api("POST", `/api/games/${id}/first-throw`, { player: "Gary", number: 10 });
  check("first throw recorded, awaiting Dale", r.body.event.type === "first_throw_recorded", r.body.event);
  r = await api("POST", `/api/games/${id}/first-throw`, { player: "Dale", number: 10 });
  check("equal throws produce a tie", r.body.event.type === "first_throw_tie", r.body.event);
  check("still in first_throw phase after tie", r.body.state.phase === "first_throw");

  // Re-throw with 1 vs 20: distances can never tie (secret is an integer)
  await api("POST", `/api/games/${id}/first-throw`, { player: "Gary", number: 1 });
  r = await api("POST", `/api/games/${id}/first-throw`, { player: "Dale", number: 20 });
  check("re-throws resolve first player", r.body.event.type === "first_throw_resolved", r.body.event);
  const secret = r.body.event.secret;
  const expectedFirst = Math.abs(1 - secret) <= Math.abs(20 - secret) ? "Gary" : "Dale";
  check("closest thrower goes first", r.body.event.first === expectedFirst, { secret, first: r.body.event.first });
  check("secret now public", r.body.state.secret === secret);
  check("currentPlayer set", r.body.state.currentPlayer === expectedFirst);

  // Helper: current player throws
  const throwDart = (segment, ring) => api("POST", `/api/games/${id}/throw`, { segment, ring });
  const state = async () => (await api("GET", `/api/games/${id}`)).body.state;

  // Double-in rules
  r = await throwDart(7, "single");
  check("single before double-in doesn't count", r.body.event.type === "no_count" && r.body.event.total === 0, r.body.event);
  check("no-count doesn't advance turn", r.body.state.currentPlayer === expectedFirst);
  r = await throwDart(3, "double");
  check("any double scores 0 and doubles in", r.body.event.type === "double_in" && r.body.event.total === 0, r.body.event);
  check("counting throw advances turn", r.body.state.currentPlayer !== expectedFirst);

  // Second player doubles in too
  r = await throwDart(18, "double");
  check("second player doubled in", r.body.event.type === "double_in", r.body.event);

  // Now back to first player: first scoring target must be the secret number
  let s = await state();
  const p1 = s.players.find((p) => p.name === expectedFirst);
  check("first scoring target is the secret number", p1.target.number === secret, p1.target);

  // Wrong number doesn't score and doesn't advance the turn
  const wrong = secret === 20 ? 19 : 20;
  r = await throwDart(wrong, "triple");
  check("wrong number scores nothing", r.body.event.type === "no_count" && r.body.event.total === 0, r.body.event);
  check("wrong number keeps the turn", r.body.state.currentPlayer === expectedFirst);
  r = await throwDart("green_bull", null);
  check("bull during numbers stage doesn't count", r.body.event.type === "no_count");
  r = await throwDart("miss", null);
  check("miss keeps the turn", r.body.state.currentPlayer === expectedFirst);

  // Hit the target with a triple: 3 points, turn advances
  r = await throwDart(secret, "triple");
  check("triple on target scores 3", r.body.event.points === 3 && r.body.event.total === 3, r.body.event);
  check("turn advanced after scoring", r.body.state.currentPlayer !== expectedFirst);

  // Other player passes so we can march player 1 through the whole board
  await api("POST", `/api/games/${id}/pass`, {});

  // March player 1 through remaining 19 numbers with singles
  let leaderChecks = 0;
  for (let i = 0; i < 19; i++) {
    s = await state();
    const me = s.players.find((p) => p.name === expectedFirst);
    r = await throwDart(me.target.number, "single");
    if (r.body.event.leaderCheck) leaderChecks++;
    if (r.body.state.currentPlayer !== expectedFirst && r.body.state.phase === "playing") {
      await api("POST", `/api/games/${id}/pass`, {});
    }
  }
  s = await state();
  const done = s.players.find((p) => p.name === expectedFirst);
  check("cleared all 20 numbers -> bull stage", done.stage === "bull", done);
  check("total = 3 + 19 singles = 22", done.total === 22, done.total);
  check("leader checks fired along the way", leaderChecks > 0);

  // Bull stage
  r = await throwDart(12, "triple");
  check("number hit during bull stage doesn't count", r.body.event.type === "no_count");
  r = await throwDart("red_bull", null);
  check("red bull scores 10 -> double-out stage", r.body.event.points === 10 && r.body.event.total === 32, r.body.event);
  await api("POST", `/api/games/${id}/pass`, {});

  // Double-out stage
  r = await throwDart(16, "single");
  check("single during double-out doesn't count", r.body.event.type === "no_count");
  r = await throwDart(16, "double");
  check("closing double scores 0 and wins", r.body.event.type === "win" && r.body.event.total === 32, r.body.event);
  check("game finished, winner recorded", r.body.state.phase === "finished" && r.body.state.winner === expectedFirst);
  check("standing record captured", r.body.state.standingRecord.points === 32, r.body.state.standingRecord);

  r = await throwDart(5, "double");
  check("throws after game over rejected", r.status === 409);

  // Standing record endpoint
  r = await api("GET", "/api/record");
  check("record endpoint agrees", r.body.standingRecord.points === 32, r.body);
}

async function testVapiWebhook() {
  console.log("VAPI WEBHOOK: regression");
  const callId = "test-call-1";

  let out = await vapiTool(callId, "start_game", { playerNames: ["Ann", "Bob"] });
  check("start_game", out.includes("Game created with players: Ann, Bob"), out);

  out = await vapiTool(callId, "resolve_first_throw", { throws: [{ player: "Ann", number: 10 }, { player: "Bob", number: 3 }] });
  check("resolve_first_throw reveals secret", /The secret number was \d+!/.test(out), out);

  out = await vapiTool(callId, "record_score", { player: "Ann", hit: "single" });
  check("single before double-in doesn't count", out.includes("must DOUBLE IN first"), out);

  out = await vapiTool(callId, "record_score", { player: "Ann", hit: "double" });
  check("double-in scores 0", out.includes("DOUBLE IN") && out.includes("total: 0"), out);

  out = await vapiTool(callId, "record_score", { player: "Ann", hit: "triple" });
  check("triple scores 3 with leader check on 3rd record", out.includes("3 points") && out.includes("LEADER CHECK"), out);

  out = await vapiTool(callId, "get_score", { player: "Ann" });
  check("get_score", out.includes("Ann has 3 points"), out);

  out = await vapiTool(callId, "get_leaderboard", {});
  check("get_leaderboard", out.includes("Ann: 3") && out.includes("Bob: 0"), out);

  const health = await fetch(BASE + "/health").then((r) => r.text());
  check("health endpoint", health.includes("alive and ornery"), health);

  const home = await fetch(BASE + "/").then((r) => r.text());
  check("static app served at /", home.includes("Race to the Top"), null);
}

async function main() {
  const server = spawn("node", ["skeeter-server.js"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  try {
    // wait for the server to come up
    for (let i = 0; i < 40; i++) {
      try { await fetch(BASE + "/health"); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    await testAppApi();
    await testVapiWebhook();
  } finally {
    server.kill();
  }
  if (failures) {
    console.error(`\n${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("\nAll tests passed.");
}

main();
