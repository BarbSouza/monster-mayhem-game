# Monster Mayhem

A real-time multiplayer browser game built with Node.js, Express, and Socket.io.

## Setup

```bash
npm install
node server.js
```

Open `http://localhost:3000` in two browser tabs 
Open `http://x.x.x.x:3000` in a different machine on the same network with the ip address (x.x.x.x)

## How to play

1. Enter your name and click **Create Game** — share the 6-character code with your opponent
2. Opponent enters the code and clicks **Join Game**
3. Each turn: place one new monster on your edge row, then move any of your existing monsters
4. Click **End Turn** when done — the round resolves once both players have ended their turn
5. First player to have 10 monsters removed loses

**Monster combat (rock-paper-scissors):**
- 🧛 Vampire beats 🐺 Werewolf
- 🐺 Werewolf beats 👻 Ghost
- 👻 Ghost beats 🧛 Vampire
- Same type → both removed

## Project structure

```
server.js       — Express + Socket.io server; game logic, turn barrier, combat resolution
client/
  index.html    — Single-page UI (lobby + game view)
  style.css     — Dark horror theme (Creepster font, amber accents)
  game.js       — Client-side game state, board rendering, move validation
```

## Concurrency notes

Turns are **simultaneous** — both players move independently and neither sees the other's moves until both click End Turn.

The server implements a **barrier pattern** in the `endTurn` handler: player indices are pushed into `game.turnEnded[]` as each player submits. The round only resolves when `game.turnEnded.length === game.players.length`. This prevents either player's moves from being processed before the other is ready.

Combat is resolved server-side on the **authoritative board state** after the barrier fires. The resolved board is then broadcast to both clients via `newRound`, keeping both views consistent.

Multiple simultaneous games are supported — each game is a fully isolated object in the `games` map, keyed by game ID.