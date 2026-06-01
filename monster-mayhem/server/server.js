const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

const games = {};

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
            turnEnded: []
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

        // Update server board state
        game.boardState[row][col] = { type, player: playerIndex };

        // Broadcast to the OTHER player
        socket.to(gameId).emit('monsterPlaced', { row, col, type, playerIndex });

        console.log(`Player ${playerIndex} placed ${type} at (${row}, ${col})`);
    });

    socket.on('moveMonster', ({ gameId, fromRow, fromCol, toRow, toCol, playerIndex }) => {
        const game = games[gameId];
        if (!game) return;

        // Update server board state
        const piece = game.boardState[fromRow][fromCol];
        game.boardState[fromRow][fromCol] = null;
        game.boardState[toRow][toCol] = piece;

        // Broadcast to the other player
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

        // When all players have ended their turn, sync board and start new round
        if (game.turnEnded.length === game.players.length) {
            game.turnEnded = [];
            // Send the authoritative board state to ALL players
            io.to(gameId).emit('newRound', { boardState: game.boardState });
            console.log(`New round started in game ${gameId}`);
        }
    });


});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});