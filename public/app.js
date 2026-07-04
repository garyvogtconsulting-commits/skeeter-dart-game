/* Race to the Top with Skeeter - web app frontend (Phase 2)
   Talks to the REST API in app-api.js. The server judges every throw. */

const $ = (sel) => document.querySelector(sel);

// ---------- API ----------

const api = {
  async call(method, path, body) {
    const res = await fetch("/api" + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  },
  createGame: (playerNames) => api.call("POST", "/games", { playerNames }),
  firstThrow: (id, player, number) => api.call("POST", `/games/${id}/first-throw`, { player, number }),
  throw: (id, segment, ring) => api.call("POST", `/games/${id}/throw`, { segment, ring }),
  pass: (id) => api.call("POST", `/games/${id}/pass`, {}),
};

// ---------- Dartboard rendering ----------
// Standard board: 20 at top, clockwise.
const SEGMENTS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
const CX = 250, CY = 250;
const R = { doubleOuter: 200, doubleInner: 186, tripleOuter: 122, tripleInner: 108, bullOuter: 30, bullInner: 13, numbers: 222 };

function polar(r, deg) {
  const rad = (deg - 90) * Math.PI / 180;
  return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)];
}

function sectorPath(rIn, rOut, a0, a1) {
  const [x0, y0] = polar(rOut, a0), [x1, y1] = polar(rOut, a1);
  const [x2, y2] = polar(rIn, a1), [x3, y3] = polar(rIn, a0);
  return `M ${x0} ${y0} A ${rOut} ${rOut} 0 0 1 ${x1} ${y1} L ${x2} ${y2} A ${rIn} ${rIn} 0 0 0 ${x3} ${y3} Z`;
}

function buildBoard() {
  const svg = $("#board");
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };

  // backing circle (the "surround")
  svg.appendChild(el("circle", { cx: CX, cy: CY, r: 246, fill: "#141414" }));

  const DARK = "#2e2e2e", CREAM = "#e8dcc0", RED = "#c23b2e", GREEN = "#2e7d4f";

  SEGMENTS.forEach((num, i) => {
    const a0 = i * 18 - 9, a1 = i * 18 + 9;
    const dark = i % 2 === 0; // 20 is dark
    const single = dark ? DARK : CREAM;
    const ring = dark ? RED : GREEN;

    const parts = [
      { rIn: R.tripleOuter, rOut: R.doubleInner, ring: "single", fill: single },   // outer single
      { rIn: R.bullOuter,  rOut: R.tripleInner, ring: "single", fill: single },    // inner single
      { rIn: R.doubleInner, rOut: R.doubleOuter, ring: "double", fill: ring },
      { rIn: R.tripleInner, rOut: R.tripleOuter, ring: "triple", fill: ring },
    ];
    for (const part of parts) {
      const p = el("path", {
        d: sectorPath(part.rIn, part.rOut, a0, a1),
        fill: part.fill,
        stroke: "#888", "stroke-width": 0.7,
        "data-seg": num, "data-ring": part.ring,
      });
      svg.appendChild(p);
    }

    // number label
    const [nx, ny] = polar(R.numbers, i * 18);
    const t = el("text", {
      x: nx, y: ny, fill: "#e8dcc0", "font-size": 22,
      "text-anchor": "middle", "dominant-baseline": "central",
      "font-family": "Georgia, serif", "data-num-label": num,
    });
    t.textContent = num;
    svg.appendChild(t);
  });

  // bulls
  svg.appendChild(el("circle", { cx: CX, cy: CY, r: R.bullOuter, fill: "#2e7d4f", stroke: "#888", "stroke-width": 0.7, "data-seg": "green_bull", "data-ring": "" }));
  svg.appendChild(el("circle", { cx: CX, cy: CY, r: R.bullInner, fill: "#c23b2e", stroke: "#888", "stroke-width": 0.7, "data-seg": "red_bull", "data-ring": "" }));

  svg.addEventListener("click", (e) => {
    const t = e.target.closest("[data-seg]");
    if (!t) return;
    onBoardClick(t.dataset.seg, t.dataset.ring || null);
  });
}

// ---------- App state ----------

let gameId = null;
let state = null;
let busy = false;

const setupEl = $("#setup"), gameEl = $("#game");

// ----- setup screen -----

function addNameInput(value = "") {
  const input = document.createElement("input");
  input.placeholder = `Player ${$("#name-list").children.length + 1}`;
  input.value = value;
  input.maxLength = 20;
  $("#name-list").appendChild(input);
  return input;
}

$("#add-player").addEventListener("click", () => addNameInput().focus());

$("#start-game").addEventListener("click", async () => {
  const names = [...$("#name-list").querySelectorAll("input")]
    .map((i) => i.value.trim()).filter(Boolean);
  if (names.length < 1) return say("Gimme at least one name, partner.");
  try {
    const { state: s } = await api.createGame(names);
    gameId = s.id;
    state = s;
    setupEl.classList.add("hidden");
    gameEl.classList.remove("hidden");
    $("#win-overlay").classList.add("hidden");
    say(`Alright: ${names.join(", ")}. I picked my secret number and I ain't tellin'. ${firstThrowPrompt()}`);
    render();
  } catch (err) {
    say(`Clipboard trouble: ${err.message}`);
  }
});

// ----- board clicks -----

async function onBoardClick(seg, ring) {
  if (!state || busy) return;
  const isNumber = /^\d+$/.test(seg);

  try {
    busy = true;
    if (state.phase === "first_throw") {
      if (!isNumber) { say("Just the numbers for the openin' throw, hoss."); return; }
      const player = state.firstThrow.awaiting[0];
      const { event, state: s } = await api.firstThrow(gameId, player, Number(seg));
      state = s;
      handleEvent(event);
    } else if (state.phase === "playing") {
      const segment = isNumber ? Number(seg) : seg;
      const { event, state: s } = await api.throw(gameId, segment, ring);
      state = s;
      handleEvent(event);
    }
    render();
  } catch (err) {
    say(`Hold your horses: ${err.message}`);
  } finally {
    busy = false;
  }
}

$("#miss-btn").addEventListener("click", () => onBoardClick("miss", null));

$("#pass-btn").addEventListener("click", async () => {
  if (!state || state.phase !== "playing" || busy) return;
  try {
    busy = true;
    const { event, state: s } = await api.pass(gameId);
    state = s;
    handleEvent(event);
    render();
  } catch (err) {
    say(`Hold on: ${err.message}`);
  } finally {
    busy = false;
  }
});

const resetToSetup = () => {
  gameEl.classList.add("hidden");
  $("#win-overlay").classList.add("hidden");
  setupEl.classList.remove("hidden");
};
$("#new-game").addEventListener("click", resetToSetup);
$("#win-again").addEventListener("click", resetToSetup);

// ---------- events & speech ----------

function handleEvent(event) {
  let text = event.text;
  if (event.leaderCheck) text += ` 📣 ${event.leaderCheck}`;
  if (state.phase === "first_throw" && event.type !== "first_throw_tie") {
    text += ` ${firstThrowPrompt()}`;
  }
  say(text);

  if (event.type === "win") {
    $("#win-title").textContent = `🏆 ${event.player} WINS!`;
    $("#win-text").textContent = `Final total: ${event.total} points. ${event.recordNote || ""} That's how it's done, folks! HEEEE-hee-hee-HAW!`;
    $("#win-overlay").classList.remove("hidden");
  }
}

function firstThrowPrompt() {
  if (!state || state.phase !== "first_throw") return "";
  const next = state.firstThrow.awaiting[0];
  return next ? `${next}: throw one dart and tap the number you hit.` : "";
}

let talkTimer = null;
function say(text) {
  $("#bubble-text").textContent = text;
  const sk = $("#skeeter");
  sk.classList.add("talking");
  clearTimeout(talkTimer);
  talkTimer = setTimeout(() => sk.classList.remove("talking"), 1400);
}

// ---------- rendering ----------

function stageLabel(p) {
  switch (p.stage) {
    case "double_in": return "needs DOUBLE IN";
    case "numbers": return `target: ${p.target.number}`;
    case "bull": return "target: BULL 🎯";
    case "double_out": return "DOUBLE OUT to win!";
    case "finished": return "FINISHED 🏆";
    default: return "";
  }
}

function render() {
  if (!state) return;

  // scoreboard
  const rows = state.players.map((p) => `
    <div class="sb-row ${p.isTurn ? "turn" : ""} ${p.stage === "finished" ? "done" : ""}">
      <span class="nm">${escapeHtml(p.name)}</span>
      <span class="pts">${p.total}</span>
      <span class="tgt">${stageLabel(p)}</span>
    </div>`).join("");
  $("#sb-rows").innerHTML = rows;

  const rec = state.standingRecord;
  $("#record-line").textContent = rec.name ? `Record: ${rec.name} · ${rec.points}` : "Record: none yet";

  // status line
  if (state.phase === "first_throw") {
    $("#status-line").textContent = `Openin' throws — waiting on: ${state.firstThrow.awaiting.join(", ")}`;
  } else if (state.phase === "playing") {
    $("#status-line").textContent = `Secret number: ${state.secret} · ${state.currentPlayer} is throwin'`;
  } else {
    $("#status-line").textContent = `Game over — ${state.winner} took it.`;
  }

  // buttons
  $("#miss-btn").disabled = state.phase !== "playing";
  $("#pass-btn").disabled = state.phase !== "playing";
  $("#new-game").classList.toggle("hidden", state.phase !== "finished");

  // board highlight + lock
  $("#board").classList.toggle("locked", state.phase === "finished");
  updateHighlight();
}

function updateHighlight() {
  document.querySelectorAll("#board .hot").forEach((e) => e.classList.remove("hot"));
  if (!state || state.phase !== "playing") return;
  const p = state.players.find((x) => x.isTurn);
  if (!p) return;

  const mark = (sel) => document.querySelectorAll(sel).forEach((e) => e.classList.add("hot"));
  if (p.stage === "double_in" || p.stage === "double_out") {
    mark('#board [data-ring="double"]');
  } else if (p.stage === "numbers") {
    mark(`#board [data-seg="${p.target.number}"]`);
  } else if (p.stage === "bull") {
    mark('#board [data-seg="green_bull"], #board [data-seg="red_bull"]');
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- boot ----------

buildBoard();
addNameInput();
addNameInput();
