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
    currentGameId = data.gameId;
    myPlayerIndex = 0;
    alert(`Game created! Share this code: ${data.gameId}`); // keep the alert here
    document.getElementById('lobby').style.display = 'none';
    document.getElementById('game').style.display = 'block';
    document.getElementById('gameInfo').textContent = `Game Code: ${data.gameId} - Waiting for another player...`;
    buildBoard();
});

socket.on('error', (msg) => alert(msg));

// Game state variables
// Store our player info for this session
let myPlayerIndex = null;
let currentGameId = null;

// Track which monster type the player has selected to place
let selectedMonster = null;

// Track which monster has been placed this turn (can only place one per turn)
let placedThisTurn = false;

// Track the full board state - 10x10 grid of cells
// Each cell is either null or { type: 'vampire'/'werewolf'/'ghost', player: 0/1 }
let boardState = Array.from({ length: 10 }, () => Array(10).fill(null));

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

function onCellClick(row, col) {
    // If a monster is selected, try to place it
    if (selectedMonster) {
        placeMonster(row, col);
        return;
    }
}

function selectMonster(type) {
    // Cant place if already placed one this turn
    if (placedThisTurn && type !== null) {
        setStatus('You already placed a monster this turn!');
        return;
    }
    selectedMonster = type;

    if (type) {
        setStatus(`Selected ${type} - click your edge to place it`);
    } else {
        setStatus('Selection cancelled');
    }
}

function placeMonster(row, col) {
    // Player 1 can only place on row 0, player 2 on row 9
    const myEdge = myPlayerIndex === 0 ? 0 : 9;

    if (row !== myEdge) {
        setStatus('You can only place monsters on your edge!');
        return;
    }

    if (boardState[row][col] !== null) {
        setStatus('That cell is already occupied!');
        return;
    }

    // Place the monster locally
    boardState[row][col] = { type: selectedMonster, player: myPlayerIndex };
    renderCell(row, col);

    // Tell the server
    socket.emit('placeMonster', {
        gameId: currentGameId,
        row,
        col,
        type: selectedMonster,
        playerIndex: myPlayerIndex
    });

    placedThisTurn = true;
    selectedMonster = null;
    setStatus(`Placed ${boardState[row][col].type}! You can now move other monsters.`);
}

// Update a single cell on the board visually
function renderCell(row, col) {
    // Find the cell div using its data attributes
    const cell = document.querySelector(
        `.cell[data-row="${row}"][data-col="${col}"]`
    );
    if (!cell) return;

    const content = boardState[row][col];
    if (content) {
        // Show monster emoji with a colour indicator for which player owns it
        cell.textContent = MONSTERS[content.type];
        cell.style.backgroundColor = content.player === 0 
            ? 'rgba(255,0,0,0.3)' 
            : 'rgba(0,0,255,0.3)';
    } else {
        // Empty cell - restore edge colour or clear it
        cell.textContent = '';
        cell.style.backgroundColor = '';
        if (row === 0) cell.classList.add('player1-edge');
        if (row === 9) cell.classList.add('player2-edge');
    }
}

// Helper to update status text
function setStatus(msg) {
    document.getElementById('statusText').textContent = msg;
}

// When the other player places a monster, update our board
socket.on('monsterPlaced', ({ row, col, type, playerIndex }) => {
    boardState[row][col] = { type, player: playerIndex };
    renderCell(row, col);
    setStatus(`Opponent placed a ${type}!`);
});