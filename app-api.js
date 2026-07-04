// REST API for the Skeeter Darts web app.
// The client reports WHERE each dart landed; the engine judges it.

const express = require("express");
const engine = require("./game-engine");

const router = express.Router();

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (err) {
      if (err instanceof engine.ApiError) {
        return res.status(err.status).json({ error: err.message });
      }
      console.error(err);
      return res.status(500).json({ error: "server hiccup, try again" });
    }
  };
}

// Create a game: { playerNames: ["Gary", "Dale"] }
router.post("/games", handle((req, res) => {
  const id = engine.createGame(req.body?.playerNames);
  const game = engine.getGame(id);
  res.status(201).json({ state: engine.publicState(id, game) });
}));

// Current state of a game
router.get("/games/:id", handle((req, res) => {
  const game = engine.getGame(req.params.id);
  res.json({ state: engine.publicState(req.params.id, game) });
}));

// One opening dart: { player: "Gary", number: 12 }
router.post("/games/:id/first-throw", handle((req, res) => {
  const game = engine.getGame(req.params.id);
  const event = engine.submitFirstThrow(game, req.body?.player, req.body?.number);
  res.json({ event, state: engine.publicState(req.params.id, game) });
}));

// A throw by the current player: { segment: 14, ring: "triple" }
// segment: 1-20 | "green_bull" | "red_bull" | "miss" (ring ignored for non-numbers)
router.post("/games/:id/throw", handle((req, res) => {
  const game = engine.getGame(req.params.id);
  const event = engine.throwDart(game, req.body?.segment, req.body?.ring);
  res.json({ event, state: engine.publicState(req.params.id, game) });
}));

// Current player gives up the darts without a counting hit
router.post("/games/:id/pass", handle((req, res) => {
  const game = engine.getGame(req.params.id);
  const event = engine.passTurn(game);
  res.json({ event, state: engine.publicState(req.params.id, game) });
}));

// Standing record (across games, until server restart)
router.get("/record", handle((_req, res) => {
  res.json({ standingRecord: engine.standingRecord() });
}));

module.exports = router;
