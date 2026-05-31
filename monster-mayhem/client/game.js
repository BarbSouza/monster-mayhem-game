const socket = io();

function createGame() {
    const name = document.getElementById('playerName').value;
    if (!name) return alert('Enter your name first!');
    socket.emit('createGame', { playerName: name });
}

function joinGame() {
    const name = document.getElementById('playerName').value;
    const code = document.getElementById('gameCode').value;
    if (!name || !code) return alert('Enter your name and game code!');
    socket.emit('joinGame', { playerName: name, gameId: code });
}

socket.on('gameCreated', (data) => {
    alert(`Game created! Share this code: ${data.gameId}`);
    document.getElementById('lobby').style.display = 'none';
    document.getElementById('game').style.display = 'block';
});

socket.on('gameJoined', (data) => {
    document.getElementById('lobby').style.display = 'none';
    document.getElementById('game').style.display = 'block';
});

socket.on('error', (msg) => alert(msg));

// Store our player info for this session
let myPlayerIndex = null;
let currentGameId = null;

// Monster emojis for display
const MONSTERS = {
    vampire: '🧛',
    werewolf: '🐺',
    ghost: '👻'
};

// Called when game is created - store our info and build the board
socket.on('gameCreated', (data) => {
    currentGameId = data.gameId;
    myPlayerIndex = 0; // Creator is always player 0
    document.getElementById('lobby').style.display = 'none';
    document.getElementById('game').style.display = 'block';
    document.getElementById('gameInfo').textContent = `Game Code: ${data.gameId} - Waiting for another player...`;
    buildBoard();
});

// Called when we successfully join a game
socket.on('gameJoined', (data) => {
    currentGameId = data.gameId;
    myPlayerIndex = 1; // Joiner is always player 1
    document.getElementById('lobby').style.display = 'none';
    document.getElementById('game').style.display = 'block';
    document.getElementById('gameInfo').textContent = `Joined Game: ${data.gameId}`;
    buildBoard();
});

// Build the 10x10 grid
function buildBoard() {
    const board = document.getElementById('board');
    board.innerHTML = ''; // Clear any existing board

    for (let row = 0; row < 10; row++) {
        for (let col = 0; col < 10; col++) {
            const cell = document.createElement('div');
            cell.classList.add('cell');
            cell.dataset.row = row;
            cell.dataset.col = col;

            // Player 1 owns the top row (row 0)
            // Player 2 owns the bottom row (row 9)
            if (row === 0) cell.classList.add('player1-edge');
            if (row === 9) cell.classList.add('player2-edge');

            // Click handler for placing/moving monsters
            cell.addEventListener('click', () => onCellClick(row, col));

            board.appendChild(cell);
        }
    }
}

// Placeholder for cell click - we'll build this out in the next step
function onCellClick(row, col) {
    console.log(`Clicked cell: row ${row}, col ${col}`);
}