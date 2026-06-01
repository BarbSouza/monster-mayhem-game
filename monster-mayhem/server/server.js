const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

const games = {};

// Combat resolution rules
// Returns which monster survives, or null if both are removed
function resolveCombat(type1, type2) {
    // Same type - both removed
    if (type1 === type2) return null;

    // Vampire beats werewolf
    if (type1 === 'vampire' && type2 === 'werewolf') return 'type1';
    if (type1 === 'werewolf' && type2 === 'vampire') return 'type2';

    // Werewolf beats ghost
    if (type1 === 'werewolf' && type2 === 'ghost') return 'type1';
    if (type1 === 'ghost' && type2 === 'werewolf') return 'type2';

    // Ghost beats vampire
    if (type1 === 'ghost' && type2 === 'vampire') return 'type1';
    if (type1 === 'vampire' && type2 === 'ghost') return 'type2';

    return null;
}

// Check the whole board for combat and resolve it
// Returns a list of cells that were affected so clients can animate/log them
function resolveAllCombat(boardState) {
    const combatLog = [];

    for (let row = 0; row < 10; row++) {
        for (let col = 0; col < 10; col++) {
            const cell = boardState[row][col];

            if (cell && cell.challenger) {
                const winner = resolveCombat(cell.type, cell.challenger.type);

                if (winner === 'type1') {
                    // Original wins
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
                    // Challenger wins
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
                    // Both removed
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

app.use(express.static(path.join(__dirname, '../client')));

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });

    socket.on('createGame', ({ playerName }) => {
        const gameId = Math.random().toString(36).substr(2, 6).toUpperCase();
        games[gameId] = {
            players: [{ id: socket.id, name: playerName }],
            status: 'waiting',
            // Server holds the authoritative board state
            boardState: Array.from({ length: 10 }, () => Array(10).fill(null)),
            turnEnded: [],
            // Track how many monsters each player has lost
            losses: [0, 0]
        };
        socket.join(gameId);
        socket.emit('gameCreated', { gameId });
        console.log(`Game ${gameId} created by ${playerName}`);
    });

    socket.on('joinGame', ({ playerName, gameId }) => {
        const game = games[gameId];
        if (!game) return socket.emit('error', 'Game not found!');
        if (game.status !== 'waiting') return socket.emit('error', 'Game already started!');
        
        game.players.push({ id: socket.id, name: playerName });
        socket.join(gameId);
        socket.emit('gameJoined', { gameId });
        io.to(gameId).emit('playerJoined', { players: game.players });
        console.log(`${playerName} joined game ${gameId}`);
    });

    socket.on('placeMonster', ({ gameId, row, col, type, playerIndex }) => {
        const game = games[gameId];
        if (!game) return;

        const targetCell = game.boardState[row][col];
        const piece = { type, player: playerIndex };

        if (targetCell && targetCell.player !== playerIndex) {
            // Enemy already on this square - store as challenger
            game.boardState[row][col] = {
                ...targetCell,
                challenger: piece
            };
        } else {
            game.boardState[row][col] = piece;
        }

        // Broadcast to the OTHER player
        socket.to(gameId).emit('monsterPlaced', { row, col, type, playerIndex });

        console.log(`Player ${playerIndex} placed ${type} at (${row}, ${col})`);
    });

    socket.on('moveMonster', ({ gameId, fromRow, fromCol, toRow, toCol, playerIndex }) => {
        const game = games[gameId];
        if (!game) return;

        const piece = game.boardState[fromRow][fromCol];
        const targetCell = game.boardState[toRow][toCol];

        game.boardState[fromRow][fromCol] = null;

        if (!targetCell) {
            // Empty square - just move there
            game.boardState[toRow][toCol] = piece;
        } else if (targetCell.player !== piece.player) {
            // Enemy on this square - store as challenger
            // But only if there isn't already a challenger stored
            if (!targetCell.challenger) {
                game.boardState[toRow][toCol] = {
                    ...targetCell,
                    challenger: piece
                };
            } else {
                // There's already a challenger - just overwrite for now
                game.boardState[toRow][toCol] = piece;
            }
        } else {
            // Own monster already there - shouldn't happen but handle safely
            game.boardState[toRow][toCol] = piece;
        }

        socket.to(gameId).emit('monsterMoved', { fromRow, fromCol, toRow, toCol });
        console.log(`Player ${playerIndex} moved from (${fromRow},${fromCol}) to (${toRow},${toCol})`);
    });

    socket.on('endTurn', ({ gameId, playerIndex }) => {
        const game = games[gameId];
        if (!game) return;

        if (!game.turnEnded) game.turnEnded = [];

        if (!game.turnEnded.includes(playerIndex)) {
            game.turnEnded.push(playerIndex);
        }

        console.log(`Player ${playerIndex} ended their turn in game ${gameId}`);

        if (game.turnEnded.length === game.players.length) {
            game.turnEnded = [];

            // Resolve combat
            const combatLog = resolveAllCombat(game.boardState);

            // Count losses from combat log
            for (const fight of combatLog) {
                if (fight.removed === 'both') {
                    // Both players lose a monster
                    game.losses[fight.player] += 1;
                    // The challenger's player also loses one
                    game.losses[fight.challengerPlayer] += 1;
                } else {
                    // The loser's player loses a monster
                    const losingPlayer = fight.player === fight.survivorPlayer 
                        ? (fight.player === 0 ? 1 : 0)
                        : fight.player;
                    game.losses[losingPlayer] += 1;
                }
            }

            console.log(`Losses - Player 0: ${game.losses[0]}, Player 1: ${game.losses[1]}`);

            // Check for elimination
            const eliminated = [];
            for (let i = 0; i < game.players.length; i++) {
                if (game.losses[i] >= 10) {
                    eliminated.push(i);
                    console.log(`Player ${i} has been eliminated!`);
                }
            }

            // Check for a winner - if only one player is not eliminated
            const activePlayers = game.players.filter((_, i) => !eliminated.includes(i));

            if (activePlayers.length === 1) {
                // We have a winner!
                const winnerIndex = game.players.indexOf(activePlayers[0]);
                io.to(gameId).emit('gameOver', { 
                    winner: winnerIndex,
                    losses: game.losses
                });
                game.status = 'finished';
                console.log(`Player ${winnerIndex} wins game ${gameId}!`);
                return;
            }

            // Send new round with losses and combat log
            io.to(gameId).emit('newRound', { 
                boardState: game.boardState,
                combatLog,
                losses: game.losses
            });

            console.log(`New round started in game ${gameId}`);
        }
    });

});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});