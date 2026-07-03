# Skeeter Dart Game — Vapi Webhook Server

Game-state backend for **"Race to the Top with Skeeter"**, a voice-hosted darts
game. A [Vapi](https://vapi.ai) voice assistant (Skeeter, an ornery Texas
cowboy) calls 5 custom tools; this Express server holds the official scoreboard
in memory, keyed by Vapi call ID.

## Endpoints

- `POST /skeeter` — Vapi custom-tools webhook (start_game, resolve_first_throw,
  record_score, get_score, get_leaderboard)
- `GET /health` — returns "Skeeter's alive and ornery."

## Run

```
npm install
npm start
```

Listens on `PORT` (default 3000).

## Deploy

Deployed on Railway — auto-deploys from `main`. See
[skeeter-vapi-setup.md](skeeter-vapi-setup.md) for the full Vapi tool setup and
[skeeter-voice-ai-prompt.md](skeeter-voice-ai-prompt.md) for Skeeter's system
prompt.
