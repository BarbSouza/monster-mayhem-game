const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

// =====================================================================
// SHARED STATE
// All active games are stored here. Key = gameId, value = game object.
// Multiple games can run simultaneously - each is fully isolated.
// =====================================================================
const games = {};

// Global stats persist for the lifetime of the server process.
// playerStats is keyed by player name (not socket id) so stats
// survive disconnects and reconnects.
const stats = {
    totalGamesPlayed: 0,
    playerStats: {}   // { [playerName]: { wins, losses, name } }
};

// Count of currently connected sockets (for lobby display)
let onlineUsers = 0;

// =====================================================================
// COMBAT RESOLUTION
// Rock-paper-scissors logic: vampire > werewolf > ghost > vampire.
// Returns 'type1' if the first monster wins, 'type2' if the second wins,
// or null if both are removed (same type clash).
// =====================================================================
function resolveCombat(type1, type2) {
    if (type1 === type2) return null;

    if (type1 === 'vampire' && type2 === 'werewolf') return 'type1';
    if (type1 === 'werewolf' && type2 === 'vampire') return 'type2';

    if (type1 === 'werewolf' && type2 === 'ghost') return 'type1';
    if (type1 === 'ghost' && type2 === 'werewolf') return 'type2';

    if (type1 === 'ghost' && type2 === 'vampire') return 'type1';
    if (type1 === 'vampire' && type2 === 'ghost') return 'type2';

    return null;
}

// =====================================================================
// BOARD SCAN: RESOLVE ALL COMBAT
// Called once per round after both players have ended their turn.
// Scans every cell; any cell with a .challenger field means two monsters
// landed on the same square and need to be resolved.
// Returns a combatLog array so clients can display what happened.
// =====================================================================
function resolveAllCombat(boardState) {
    const combatLog = [];

    for (let row = 0; row < 10; row++) {
        for (let col = 0; col < 10; col++) {
            const cell = boardState[row][col];

            if (cell && cell.challenger) {
                const winner = resolveCombat(cell.type, cell.challenger.type);

                if (winner === 'type1') {
                    // Original occupant wins - remove the challenger
                    combatLog.push({
                        row, col,
                        removed: cell.challenger.type,
                        survived: cell.type,
                        survivorPlayer: cell.player,
                        player: cell.challenger.player,
                        challengerPlayer: cell.challenger.player
                    });
                    delete cell.challenger;
                } else if (winner === 'type2') {
                    // Challenger wins - replace the original with the challenger
                    combatLog.push({
                        row, col,
                        removed: cell.type,
                        survived: cell.challenger.type,
                        survivorPlayer: cell.challenger.player,
                        player: cell.player,
                        challengerPlayer: cell.challenger.player
                    });
                    boardState[row][col] = cell.challenger;
                } else {
                    // Same type - both removed
                    combatLog.push({
                        row, col,
                        removed: 'both',
                        survived: null,
                        player: cell.player,
                        challengerPlayer: cell.challenger.player
                    });
                    boardState[row][col] = null;
                }
            }
        }
    }

    return combatLog;
}

// Serve the client files from the /client folder
app.use(express.static(path.join(__dirname, '../client')));

// =====================================================================
// SOCKET.IO CONNECTION HANDLER
// Each connected browser tab gets its own socket. All game logic is
// driven by socket events emitted from the client.
// =====================================================================
io.on('connection', (socket) => {
    onlineUsers++;
    console.log('A user connected:', socket.id);

    // Send the new user the current lobby state immediately on connect
    socket.emit('lobbyUpdate', {
        onlineUsers,
        openGames: getOpenGames()
    });

    // Tell everyone else the online count changed
    socket.broadcast.emit('lobbyUpdate', {
        onlineUsers,
        openGames: getOpenGames()
    });

    // =====================================================================
    // DISCONNECT HANDLER
    // If a player drops mid-game, award the win to their opponent and
    // clean up the game entry. If they were still in the lobby (waiting),
    // just remove the open game listing.
    // =====================================================================
    socket.on('disconnect', () => {
        onlineUsers--;
        console.log('User disconnected:', socket.id);

        for (const gameId in games) {
            const game = games[gameId];
            const playerIndex = game.players.findIndex(p => p.id === socket.id);
            if (playerIndex === -1) continue;

            if (game.status !== 'active') {
                if (game.status === 'waiting') {
                    delete games[gameId];
                    io.emit('lobbyUpdate', { onlineUsers, openGames: getOpenGames() });
                }
                continue;
            }

            // Award win to the surviving player
            const winnerIndex = playerIndex === 0 ? 1 : 0;
            stats.totalGamesPlayed += 1;

            for (let i = 0; i < game.players.length; i++) {
                const playerName = game.players[i].name;
                if (!stats.playerStats[playerName]) {
                    stats.playerStats[playerName] = { wins: 0, losses: 0, name: playerName };
                }
                if (i === winnerIndex) {
                    stats.playerStats[playerName].wins += 1;
                } else {
                    stats.playerStats[playerName].losses += 1;
                }
            }

            io.to(gameId).emit('opponentDisconnected', {
                winnerIndex,
                totalGamesPlayed: stats.totalGamesPlayed,
                playerStats: {
                    0: stats.playerStats[game.players[0].name],
                    1: stats.playerStats[game.players[1].name]
                }
            });

            game.status = 'finished';
            console.log(`Player ${playerIndex} disconnected from game ${gameId} - Player ${winnerIndex} wins!`);
        }

        io.emit('lobbyUpdate', { onlineUsers, openGames: getOpenGames() });
    });

    // Returns only games still waiting for a second player
    function getOpenGames() {
        return Object.entries(games)
            .filter(([id, game]) => game.status === 'waiting')
            .map(([id, game]) => ({
                gameId: id,
                host: game.players[0].name
            }));
    }

    // =====================================================================
    // CREATE GAME
    // Generates a collision-resistant 6-character alphanumeric game ID,
    // initialises the game object, and joins the creator to a Socket.io
    // room named after the gameId so future broadcasts are scoped.
    // =====================================================================
    socket.on('createGame', ({ playerName }) => {
        const gameId = Math.random().toString(36).substr(2, 6).toUpperCase();
        games[gameId] = {
            players: [{ id: socket.id, name: playerName }],
            status: 'waiting',
            boardState: Array.from({ length: 10 }, () => Array(10).fill(null)),
            turnEnded: [],   // Tracks which players have submitted their turn this round
            losses: [0, 0]   // Monster removal count per player; game ends at 10
        };

        if (!stats.playerStats[playerName]) {
            stats.playerStats[playerName] = { wins: 0, losses: 0, name: playerName };
        }

        socket.emit('statsUpdate', {
            totalGamesPlayed: stats.totalGamesPlayed,
            myStats: stats.playerStats[playerName],
            opponentStats: null
        });

        socket.join(gameId);
        socket.emit('gameCreated', { gameId });

        console.log(`Game ${gameId} created by ${playerName}`);

        io.emit('lobbyUpdate', { onlineUsers, openGames: getOpenGames() });
    });

    // =====================================================================
    // JOIN GAME
    // Second player joins by game code. Once both players are in, the game
    // status changes to 'active' and both clients are notified to unlock
    // their controls and start playing.
    // =====================================================================
    socket.on('joinGame', ({ playerName, gameId }) => {
        const game = games[gameId];
        if (!game) return socket.emit('error', 'Game not found!');
        if (game.status !== 'waiting') return socket.emit('error', 'Game already started!');

        game.players.push({ id: socket.id, name: playerName });
        socket.join(gameId);
        game.status = 'active';

        for (const player of game.players) {
            if (!stats.playerStats[player.name]) {
                stats.playerStats[player.name] = { wins: 0, losses: 0, name: player.name };
            }
        }

        io.to(gameId).emit('statsUpdate', {
            totalGamesPlayed: stats.totalGamesPlayed,
            myStats: stats.playerStats[game.players[0].name],
            opponentStats: stats.playerStats[game.players[1].name]
        });

        socket.emit('gameJoined', { gameId });
        io.to(gameId).emit('playerJoined', { players: game.players });

        console.log(`${playerName} joined game ${gameId}`);

        io.emit('lobbyUpdate', { onlineUsers, openGames: getOpenGames() });
    });

    // =====================================================================
    // PLACE MONSTER
    // The client validates placement locally before emitting this event,
    // but the server still applies it to the authoritative board state.
    // If an enemy monster is already on the target square, the new piece
    // is stored as a .challenger - combat resolves at end of round.
    // =====================================================================
    socket.on('placeMonster', ({ gameId, row, col, type, playerIndex }) => {
        const game = games[gameId];
        if (!game) return;

        const targetCell = game.boardState[row][col];
        const piece = { type, player: playerIndex };

        if (targetCell && targetCell.player !== playerIndex) {
            // Conflict - store as challenger; resolved when round ends
            game.boardState[row][col] = { ...targetCell, challenger: piece };
        } else {
            game.boardState[row][col] = piece;
        }

        console.log(`Player ${playerIndex} placed ${type} at (${row}, ${col})`);
    });

    // =====================================================================
    // MOVE MONSTER
    // Updates the server's authoritative board state. The piece may be the
    // main occupant of a cell or a challenger stored within it - the server
    // checks both cases. Landing on an enemy square stores the moving piece
    // as a challenger; combat resolves at end of round.
    // =====================================================================
    socket.on('moveMonster', ({ gameId, fromRow, fromCol, toRow, toCol, playerIndex }) => {
        const game = games[gameId];
        if (!game) return;

        let piece = null;
        const fromCell = game.boardState[fromRow][fromCol];

        if (fromCell && fromCell.player === playerIndex) {
            // Main occupant belongs to this player
            piece = { type: fromCell.type, player: fromCell.player };
            if (fromCell.challenger) {
                // Leave the challenger behind in the source cell
                game.boardState[fromRow][fromCol] = fromCell.challenger;
            } else {
                game.boardState[fromRow][fromCol] = null;
            }
        } else if (fromCell && fromCell.challenger && fromCell.challenger.player === playerIndex) {
            // This player's piece is the challenger in the source cell
            piece = fromCell.challenger;
            delete game.boardState[fromRow][fromCol].challenger;
        } else {
            return; // Piece not found - ignore stale event
        }

        const targetCell = game.boardState[toRow][toCol];

        if (!targetCell) {
            game.boardState[toRow][toCol] = piece;
        } else if (targetCell.player !== piece.player) {
            if (!targetCell.challenger) {
                // First conflict on this square - store as challenger
                game.boardState[toRow][toCol] = { ...targetCell, challenger: piece };
            } else {
                // Edge case: challenger slot already taken - overwrite
                game.boardState[toRow][toCol] = piece;
            }
        } else {
            game.boardState[toRow][toCol] = piece;
        }

        console.log(`Player ${playerIndex} moved from (${fromRow},${fromCol}) to (${toRow},${toCol})`);
    });

    // =====================================================================
    // END TURN (BARRIER / LATCH PATTERN)
    // This is the core concurrency mechanism. Each player's turn runs
    // independently and simultaneously. The server collects 'endTurn'
    // events in the game.turnEnded array.
    //
    // The barrier fires only when ALL players have submitted - i.e.
    // game.turnEnded.length === game.players.length. Until that condition
    // is met, the round does not advance and neither player can see the
    // other's moves. This guarantees simultaneous turn resolution.
    //
    // Once the barrier fires:
    //   1. Combat is resolved on the authoritative server board state
    //   2. Losses are counted
    //   3. Elimination is checked
    //   4. The resolved board is broadcast to all clients (newRound / gameOver)
    //   5. turnEnded is reset for the next round
    // =====================================================================
    socket.on('endTurn', ({ gameId, playerIndex }) => {
        const game = games[gameId];
        if (!game) return;

        if (!game.turnEnded) game.turnEnded = [];

        // Guard against duplicate endTurn events from the same player
        if (!game.turnEnded.includes(playerIndex)) {
            game.turnEnded.push(playerIndex);
        }

        console.log(`Player ${playerIndex} ended their turn in game ${gameId}`);

        // Barrier check - only proceed when all players are ready
        if (game.turnEnded.length === game.players.length) {
            game.turnEnded = []; // Reset for next round

            // Resolve all monster conflicts on the board
            const combatLog = resolveAllCombat(game.boardState);

            // Tally losses from this round's combat
            for (const fight of combatLog) {
                if (fight.removed === 'both') {
                    game.losses[fight.player] += 1;
                    game.losses[fight.challengerPlayer] += 1;
                } else {
                    const losingPlayer = fight.player === fight.survivorPlayer
                        ? (fight.player === 0 ? 1 : 0)
                        : fight.player;
                    game.losses[losingPlayer] += 1;
                }
            }

            console.log(`Losses - Player 0: ${game.losses[0]}, Player 1: ${game.losses[1]}`);

            // Check for elimination (10 monsters removed = out)
            const eliminated = [];
            for (let i = 0; i < game.players.length; i++) {
                if (game.losses[i] >= 10) {
                    eliminated.push(i);
                    console.log(`Player ${i} has been eliminated!`);
                }
            }

            const activePlayers = game.players.filter((_, i) => !eliminated.includes(i));

            // Tie: all players eliminated in the same round
            if (activePlayers.length === 0) {
                stats.totalGamesPlayed += 1;
                console.log(`Game ${gameId} ended in a tie!`);
                io.to(gameId).emit('gameOver', {
                    winner: null,
                    losses: game.losses,
                    totalGamesPlayed: stats.totalGamesPlayed,
                    playerStats: {
                        0: stats.playerStats[game.players[0].name],
                        1: stats.playerStats[game.players[1].name]
                    }
                });
                game.status = 'finished';
                return;
            }

            // One player remaining - they win
            if (activePlayers.length === 1) {
                const winnerIndex = game.players.indexOf(activePlayers[0]);
                stats.totalGamesPlayed += 1;

                for (let i = 0; i < game.players.length; i++) {
                    const playerName = game.players[i].name;
                    if (!stats.playerStats[playerName]) {
                        stats.playerStats[playerName] = { wins: 0, losses: 0, name: playerName };
                    }
                    if (i === winnerIndex) {
                        stats.playerStats[playerName].wins += 1;
                    } else {
                        stats.playerStats[playerName].losses += 1;
                    }
                }

                console.log(`Total games played: ${stats.totalGamesPlayed}`);
                io.to(gameId).emit('gameOver', {
                    winner: winnerIndex,
                    losses: game.losses,
                    totalGamesPlayed: stats.totalGamesPlayed,
                    playerStats: {
                        0: stats.playerStats[game.players[0].name],
                        1: stats.playerStats[game.players[1].name]
                    }
                });
                game.status = 'finished';
                console.log(`Player ${winnerIndex} wins game ${gameId}!`);
                return;
            }

            // Game continues - broadcast the resolved board to both clients
            io.to(gameId).emit('newRound', {
                boardState: game.boardState,
                combatLog,
                losses: game.losses,
                totalGamesPlayed: stats.totalGamesPlayed
            });

            console.log(`New round started in game ${gameId}`);
        }
    });

    // =====================================================================
    // GIVE UP
    // Immediate forfeit - awards the win to the opponent and ends the game.
    // =====================================================================
    socket.on('giveUp', ({ gameId, playerIndex }) => {
        const game = games[gameId];
        if (!game) return;

        const winnerIndex = playerIndex === 0 ? 1 : 0;
        stats.totalGamesPlayed += 1;

        for (let i = 0; i < game.players.length; i++) {
            const playerName = game.players[i].name;
            if (!stats.playerStats[playerName]) {
                stats.playerStats[playerName] = { wins: 0, losses: 0, name: playerName };
            }
            if (i === winnerIndex) {
                stats.playerStats[playerName].wins += 1;
            } else {
                stats.playerStats[playerName].losses += 1;
            }
        }

        io.to(gameId).emit('gameOver', {
            winner: winnerIndex,
            losses: game.losses,
            totalGamesPlayed: stats.totalGamesPlayed,
            playerStats: {
                0: stats.playerStats[game.players[0].name],
                1: stats.playerStats[game.players[1].name]
            }
        });

        game.status = 'finished';
        console.log(`Player ${playerIndex} gave up in game ${gameId}!`);
    });

    // =====================================================================
    // LEAVE GAME (voluntary - e.g. Back to Lobby button)
    // If the game was waiting, cancel it. If active, award the win to the
    // opponent (same outcome as a disconnect but triggered intentionally).
    // =====================================================================
    socket.on('leaveGame', ({ gameId, playerIndex }) => {
        const game = games[gameId];
        if (!game) return;

        if (game.status === 'waiting') {
            delete games[gameId];
            console.log(`Game ${gameId} cancelled - host left`);
            io.emit('lobbyUpdate', { onlineUsers, openGames: getOpenGames() });
            return;
        }

        if (game.status === 'active') {
            const winnerIndex = playerIndex === 0 ? 1 : 0;
            stats.totalGamesPlayed += 1;

            for (let i = 0; i < game.players.length; i++) {
                const playerName = game.players[i].name;
                if (!stats.playerStats[playerName]) {
                    stats.playerStats[playerName] = { wins: 0, losses: 0, name: playerName };
                }
                if (i === winnerIndex) {
                    stats.playerStats[playerName].wins += 1;
                } else {
                    stats.playerStats[playerName].losses += 1;
                }
            }

            io.to(gameId).emit('opponentDisconnected', {
                winnerIndex,
                totalGamesPlayed: stats.totalGamesPlayed,
                playerStats: {
                    0: stats.playerStats[game.players[0].name],
                    1: stats.playerStats[game.players[1].name]
                }
            });

            game.status = 'finished';
            console.log(`Player ${playerIndex} left game ${gameId} - Player ${winnerIndex} wins!`);
        }

        io.emit('lobbyUpdate', { onlineUsers, openGames: getOpenGames() });
    });

});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});