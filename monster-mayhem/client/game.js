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

// Track which cell is currently selected for moving
let selectedCell = null;

// Track which monsters have already been moved this turn
let movedThisTurn = [];

// Monster emojis for display
const MONSTERS = {
    vampire: '🧛',
    werewolf: '🐺',
    ghost: '👻'
};

// Called when game is created - store our info and build the board
socket.on('gameCreated', (data) => {
    currentGameId = data.gameId;
    myPlayerIndex = 0;
    alert(`Game created! Share this code: ${data.gameId}`);
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
    // If a monster type is selected, try to place it
    if (selectedMonster) {
        placeMonster(row, col);
        return;
    }

    // If a monster is already selected for moving
    if (selectedCell) {
        // Clicking the same cell deselects it
        if (selectedCell.row === row && selectedCell.col === col) {
            clearHighlights();
            selectedCell = null;
            setStatus('Deselected');
            return;
        }

        // Try to move to the clicked cell
        tryMove(selectedCell.row, selectedCell.col, row, col);
        return;
    }

    // No monster selected yet - try to select one
    const piece = boardState[row][col];

    // Must be your own monster
    if (!piece || piece.player !== myPlayerIndex) {
        setStatus('No monster there, or not yours!');
        return;
    }

    // Cannot move a monster placed this turn
    if (placedThisTurn && piece.placedThisTurn) {
        setStatus('Cannot move a monster placed this turn!');
        return;
    }

    // Cannot move a monster already moved this turn
    if (movedThisTurn.some(m => m.row === row && m.col === col)) {
        setStatus('Already moved that monster this turn!');
        return;
    }

    // Select it and highlight valid moves
    selectedCell = { row, col };
    highlightValidMoves(row, col);
    setStatus(`Selected ${piece.type} at (${row},${col}) - click a highlighted cell to move`);
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

function getValidMoves(fromRow, fromCol) {
    const validMoves = [];
    const piece = boardState[fromRow][fromCol];

    const directions = [
        { dr: 0, dc: 1, diagonal: false },
        { dr: 0, dc: -1, diagonal: false },
        { dr: 1, dc: 0, diagonal: false },
        { dr: -1, dc: 0, diagonal: false },
        { dr: 1, dc: 1, diagonal: true },
        { dr: 1, dc: -1, diagonal: true },
        { dr: -1, dc: 1, diagonal: true },
        { dr: -1, dc: -1, diagonal: true },
    ];

    for (const dir of directions) {
        const maxSteps = dir.diagonal ? 2 : 10;

        for (let step = 1; step <= maxSteps; step++) {
            const newRow = fromRow + dir.dr * step;
            const newCol = fromCol + dir.dc * step;

            // Stop if out of bounds
            if (newRow < 0 || newRow > 9 || newCol < 0 || newCol > 9) break;

            const cellContent = boardState[newRow][newCol];

            if (cellContent) {
                if (cellContent.player === piece.player) {
                    // Own monster blocks - cannot pass through or land here
                    break;
                } else {
                    // Enemy monster - can land on it (combat) but cannot pass through
                    validMoves.push({ row: newRow, col: newCol });
                    break;
                }
            }

            // Empty cell - valid move
            validMoves.push({ row: newRow, col: newCol });
        }
    }

    return validMoves;
}

function highlightValidMoves(row, col) {
    // Clear any existing highlights first
    clearHighlights();

    // Highlight the selected monster's cell
    const selectedEl = document.querySelector(`.cell[data-row="${row}"][data-col="${col}"]`);
    if (selectedEl) selectedEl.classList.add('selected');

    // Highlight all valid destination cells
    const moves = getValidMoves(row, col);
    for (const move of moves) {
        const cell = document.querySelector(`.cell[data-row="${move.row}"][data-col="${move.col}"]`);
        if (cell) cell.classList.add('valid-move');
    }
}

function clearHighlights() {
    // Remove all highlight classes from the board
    document.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
    document.querySelectorAll('.valid-move').forEach(el => el.classList.remove('valid-move'));
}

function tryMove(fromRow, fromCol, toRow, toCol) {
    // Check the destination is actually a valid move
    const validMoves = getValidMoves(fromRow, fromCol);
    const isValid = validMoves.some(m => m.row === toRow && m.col === toCol);

    if (!isValid) {
        setStatus('Invalid move!');
        clearHighlights();
        selectedCell = null;
        return;
    }

    // Move the monster in local board state
    const piece = boardState[fromRow][fromCol];
    boardState[fromRow][fromCol] = null;
    boardState[toRow][toCol] = piece;

    // Re-render both cells
    renderCell(fromRow, fromCol);
    renderCell(toRow, toCol);

    // Track this monster as moved this turn
    movedThisTurn.push({ row: toRow, col: toCol });

    // Tell the server about the move
    socket.emit('moveMonster', {
        gameId: currentGameId,
        fromRow, fromCol,
        toRow, toCol,
        playerIndex: myPlayerIndex
    });

    clearHighlights();
    selectedCell = null;
    setStatus(`Moved ${piece.type} to (${toRow}, ${toCol})`);
}

// When the other player moves a monster, update our board
socket.on('monsterMoved', ({ fromRow, fromCol, toRow, toCol }) => {
    const piece = boardState[fromRow][fromCol];
    boardState[fromRow][fromCol] = null;
    boardState[toRow][toCol] = piece;
    renderCell(fromRow, fromCol);
    renderCell(toRow, toCol);
    setStatus('Opponent moved a monster!');
});

function endTurn() {
    // Reset this player's turn state
    placedThisTurn = false;
    movedThisTurn = [];
    selectedCell = null;
    selectedMonster = null;
    clearHighlights();

    // Tell the server this player has ended their turn
    socket.emit('endTurn', { gameId: currentGameId, playerIndex: myPlayerIndex });

    setStatus('Turn ended - waiting for opponent...');
}

// Server tells us both players have ended their turn - new round begins
socket.on('newRound', ({ boardState: serverBoard }) => {
    // Replace local board with the server's authoritative state
    boardState = serverBoard;
    
    // Re-render every cell
    for (let row = 0; row < 10; row++) {
        for (let col = 0; col < 10; col++) {
            renderCell(row, col);
        }
    }

    placedThisTurn = false;
    movedThisTurn = [];
    selectedCell = null;
    selectedMonster = null;
    clearHighlights();
    setStatus('New round! Place or move your monsters.');
});