const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

const games = {};

// Global stats - shared across all games
const stats = {
    totalGamesPlayed: 0,
    // Player stats stored by socket id
    playerStats: {}
};

// Track connected users
let onlineUsers = 0;

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
    onlineUsers++;
    console.log('A user connected:', socket.id);
    
    // Send current lobby state to the newly connected user
    socket.emit('lobbyUpdate', {
        onlineUsers,
        openGames: getOpenGames()
    });

    // Tell everyone else the online count changed
    socket.broadcast.emit('lobbyUpdate', {
        onlineUsers,
        openGames: getOpenGames()
    });

    socket.on('disconnect', () => {
        onlineUsers--;
        console.log('User disconnected:', socket.id);

        // Check if this player was in an active game
        for (const gameId in games) {
            const game = games[gameId];

            // Find which player index this socket was
            const playerIndex = game.players.findIndex(p => p.id === socket.id);
            if (playerIndex === -1) continue;

            // Only handle active games - ignore waiting or finished
            if (game.status !== 'active') {
                // If they were waiting for opponent, just remove the game
                if (game.status === 'waiting') {
                    delete games[gameId];
                    io.emit('lobbyUpdate', {
                        onlineUsers,
                        openGames: getOpenGames()
                    });
                }
                continue;
            }

            // The other player wins by default
            const winnerIndex = playerIndex === 0 ? 1 : 0;

            // Update stats
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

            // Notify the remaining player
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

        // Update lobby for everyone
        io.emit('lobbyUpdate', {
            onlineUsers,
            openGames: getOpenGames()
        });
    });

    // Returns list of games that are waiting for a second player
    function getOpenGames() {
        return Object.entries(games)
            .filter(([id, game]) => game.status === 'waiting')
            .map(([id, game]) => ({
                gameId: id,
                host: game.players[0].name
            }));
    }

    socket.on('createGame', ({ playerName }) => {
        const gameId = Math.random().toString(36).substr(2, 6).toUpperCase();
        games[gameId] = {
            players: [{ id: socket.id, name: playerName }],
            status: 'waiting',
            boardState: Array.from({ length: 10 }, () => Array(10).fill(null)),
            turnEnded: [],
            losses: [0, 0]
        };

    // Initialise stats by player name instead of socket id
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

        // Send current stats to creator
        socket.emit('statsUpdate', {
            totalGamesPlayed: stats.totalGamesPlayed,
            myStats: stats.playerStats[socket.id],
            opponentStats: null
        });

        console.log(`Game ${gameId} created by ${playerName}`);

        // Tell everyone about the new open game
        io.emit('lobbyUpdate', {
            onlineUsers,
            openGames: getOpenGames()
        });
    });

    socket.on('joinGame', ({ playerName, gameId }) => {
        const game = games[gameId];
        if (!game) return socket.emit('error', 'Game not found!');
        if (game.status !== 'waiting') return socket.emit('error', 'Game already started!');
        
        game.players.push({ id: socket.id, name: playerName });
        socket.join(gameId);
        game.status = 'active';

        // Initialise stats for both players by name
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

        // Send current stats to both players
        io.to(gameId).emit('statsUpdate', {
            totalGamesPlayed: stats.totalGamesPlayed,
            myStats: stats.playerStats[game.players[0].id],
            opponentStats: stats.playerStats[game.players[1].id]
        });

        console.log(`${playerName} joined game ${gameId}`);

        // Tell everyone this game is no longer open
        io.emit('lobbyUpdate', {
            onlineUsers,
            openGames: getOpenGames()
        });
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

        console.log(`Player ${playerIndex} placed ${type} at (${row}, ${col})`);
    });

    socket.on('moveMonster', ({ gameId, fromRow, fromCol, toRow, toCol, playerIndex }) => {
        const game = games[gameId];
        if (!game) return;

        // Get the piece that is moving
        // It might be stored as the main piece or as the challenger
        let piece = null;

        const fromCell = game.boardState[fromRow][fromCol];

        if (fromCell && fromCell.player === playerIndex) {
            // The main piece belongs to this player - take it
            piece = { type: fromCell.type, player: fromCell.player };

            if (fromCell.challenger) {
                // There was a challenger waiting here - leave the challenger behind
                game.boardState[fromRow][fromCol] = fromCell.challenger;
            } else {
                game.boardState[fromRow][fromCol] = null;
            }
        } else if (fromCell && fromCell.challenger && fromCell.challenger.player === playerIndex) {
            // The challenger belongs to this player - extract it
            piece = fromCell.challenger;
            // Remove the challenger, leave the original
            delete game.boardState[fromRow][fromCol].challenger;
        } else {
            // Piece not found - ignore
            return;
        }

        const targetCell = game.boardState[toRow][toCol];

        if (!targetCell) {
            game.boardState[toRow][toCol] = piece;
        } else if (targetCell.player !== piece.player) {
            if (!targetCell.challenger) {
                game.boardState[toRow][toCol] = {
                    ...targetCell,
                    challenger: piece
                };
            } else {
                game.boardState[toRow][toCol] = piece;
            }
        } else {
            game.boardState[toRow][toCol] = piece;
        }

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

            // All players eliminated at the same time - it's a tie!
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

            if (activePlayers.length === 1) {
                const winnerIndex = game.players.indexOf(activePlayers[0]);
                
                stats.totalGamesPlayed += 1;

                for (let i = 0; i < game.players.length; i++) {
                    const playerName = game.players[i].name;

                    if (!stats.playerStats[playerName]) {
                        stats.playerStats[playerName] = { 
                            wins: 0, 
                            losses: 0, 
                            name: playerName
                        };
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

            // Also send updated stats with every new round
            io.to(gameId).emit('newRound', { 
                boardState: game.boardState,
                combatLog,
                losses: game.losses,
                totalGamesPlayed: stats.totalGamesPlayed
            });

            console.log(`New round started in game ${gameId}`);
        }
    });

    socket.on('giveUp', ({ gameId, playerIndex }) => {
    const game = games[gameId];
    if (!game) return;

    // The player who gave up loses, the other player wins
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

});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});