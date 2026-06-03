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

// Flag to prevent multiple end turn actions
let myTurnEnded = false;

// Store player names
let playerNames = ['Player 1', 'Player 2'];

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
    playerNames[0] = document.getElementById('playerName').value;
    alert(`Game created! Share this code: ${data.gameId}`);
    document.getElementById('lobby').style.display = 'none';
    document.getElementById('game').style.display = 'block';
    document.getElementById('gameInfo').textContent = `Game Code: ${data.gameId} - Waiting for another player...`;
    buildBoard();
});

// Called when we successfully join a game
socket.on('gameJoined', (data) => {
    currentGameId = data.gameId;
    myPlayerIndex = 1;
    playerNames[1] = document.getElementById('playerName').value;
    document.getElementById('lobby').style.display = 'none';
    document.getElementById('game').style.display = 'block';
    document.getElementById('gameInfo').textContent = `Joined Game: ${data.gameId}`;
    buildBoard();
});

// When the other player joins, update their name on the scoreboard
socket.on('playerJoined', ({ players }) => {
    playerNames[0] = players[0].name;
    if (players[1]) playerNames[1] = players[1].name;
    updateScoreboard();

    // Both players are in - unlock controls
    setControlsLocked(false);
    setStatus('Game started! Place or move your monsters.');
    document.getElementById('gameInfo').textContent = `Game: ${currentGameId}`;
});

// Build the 10x10 grid
function buildBoard() {
    const board = document.getElementById('board');
    board.innerHTML = '';

    for (let row = 0; row < 10; row++) {
        for (let col = 0; col < 10; col++) {
            const cell = document.createElement('div');
            cell.classList.add('cell');
            cell.dataset.row = row;
            cell.dataset.col = col;

            if (row === 0) cell.classList.add('player1-edge');
            if (row === 9) cell.classList.add('player2-edge');

            cell.addEventListener('click', () => onCellClick(row, col));
            board.appendChild(cell);
        }
    }

    // Lock controls until the second player joins
    setControlsLocked(true);
}

    function setControlsLocked(locked) {
        // Lock or unlock all monster buttons and end turn
        // Keep back to lobby always enabled
        const buttons = document.querySelectorAll('#controls button:not([onclick="backToLobby()"])');
        buttons.forEach(btn => btn.disabled = locked);

        // Also prevent clicking the board
        document.getElementById('board').style.pointerEvents = locked ? 'none' : 'auto';

        if (locked) {
            setStatus('Waiting for opponent to join...');
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
    const myEdge = myPlayerIndex === 0 ? 0 : 9;

    if (row !== myEdge) {
        setStatus('You can only place monsters on your edge!');
        return;
    }

    if (boardState[row][col] !== null) {
        setStatus('That cell is already occupied!');
        return;
    }

    // Count how many monsters this player currently has on the board
    let monsterCount = 0;
    for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 10; c++) {
            const cell = boardState[r][c];
            if (cell && cell.player === myPlayerIndex) {
                monsterCount++;
            }
        }
    }

    // Maximum 10 monsters on the board at once
    if (monsterCount >= 10) {
        setStatus('You already have 10 monsters on the board!');
        return;
    }

    boardState[row][col] = { type: selectedMonster, player: myPlayerIndex };
    renderCell(row, col);

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

    checkAndLockIfNoMoves();
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

    // Define which row is off limits for this player
    // Player 0 cannot move to row 9 (opponent's edge)
    // Player 1 cannot move to row 0 (opponent's edge)
    const forbiddenRow = piece.player === 0 ? 9 : 0;

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

            // Cannot move to opponent's edge row
            if (newRow === forbiddenRow) break;

            const cellContent = boardState[newRow][newCol];

            if (cellContent) {
                if (cellContent.player === piece.player) {
                    continue; // Can move through own monsters
                } else {
                    validMoves.push({ row: newRow, col: newCol });
                    break;
                }
            }

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

    checkAndLockIfNoMoves();
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
    if (myTurnEnded) {
        setStatus('You already ended your turn, waiting for opponent...');
        return;
    }

    placedThisTurn = false;
    movedThisTurn = [];
    selectedCell = null;
    selectedMonster = null;
    clearHighlights();
    myTurnEnded = true;

    socket.emit('endTurn', { gameId: currentGameId, playerIndex: myPlayerIndex });
    setStatus('Turn ended - waiting for opponent...');
}

// Server tells us both players have ended their turn - new round begins
socket.on('newRound', ({ boardState: serverBoard, combatLog, losses, totalGamesPlayed }) => {
    // Reset turn ended flag for new round
    myTurnEnded = false;

    boardState = serverBoard;

    setControlsLocked(false);

    for (let row = 0; row < 10; row++) {
        for (let col = 0; col < 10; col++) {
            renderCell(row, col);
        }
    }

    if (losses) {
        updateScoreboard(losses);
    }

    if (totalGamesPlayed !== undefined) {
        updateStatsDisplay(totalGamesPlayed, null);
    }

    if (combatLog && combatLog.length > 0) {
        for (const fight of combatLog) {
            if (fight.removed === 'both') {
                setStatus(`⚔️ Both monsters at (${fight.row},${fight.col}) were destroyed!`);
            } else {
                setStatus(`⚔️ ${fight.survived} survived, ${fight.removed} was removed!`);
            }
        }
    } else {
        setStatus('New round! Place or move your monsters.');
    }

    checkAndLockIfNoMoves();

    placedThisTurn = false;
    movedThisTurn = [];
    selectedCell = null;
    selectedMonster = null;
    clearHighlights();
});

socket.on('gameOver', ({ winner, losses, totalGamesPlayed, playerStats }) => {
    updateScoreboard(losses);

    // Update stats with final numbers
    const myStats = playerStats[myPlayerIndex];
    updateStatsDisplay(totalGamesPlayed, myStats);

    if (winner === null) {
        setStatus(`🤝 It's a tie! Both players lost 10 monsters.`);
    } else if (winner === myPlayerIndex) {
        setStatus(`🏆 You win! Total games played: ${totalGamesPlayed}`);
    } else {
        setStatus(`💀 You lose! Total games played: ${totalGamesPlayed}`);
    }

    document.querySelectorAll('#controls button').forEach(btn => btn.disabled = true);
});

function updateStatsDisplay(totalGamesPlayed, myStats) {
    // Update in game stats bar
    if (document.getElementById('total-games')) {
        document.getElementById('total-games').textContent = totalGamesPlayed;
    }
    // Update lobby stats too
    if (document.getElementById('lobby-total-games')) {
        document.getElementById('lobby-total-games').textContent = totalGamesPlayed;
    }
    if (myStats) {
        document.getElementById('my-wins').textContent = myStats.wins;
        document.getElementById('my-losses').textContent = myStats.losses;
    }
}

// Receives stats when joining or creating a game
socket.on('statsUpdate', ({ totalGamesPlayed, myStats }) => {
    updateStatsDisplay(totalGamesPlayed, myStats);
});

socket.on('lobbyUpdate', ({ onlineUsers, openGames }) => {
    // Update online user count
    const onlineEl = document.getElementById('online-users');
    if (onlineEl) onlineEl.textContent = onlineUsers;

    // Update open games list
    const listEl = document.getElementById('open-games-list');
    if (!listEl) return;

    if (openGames.length === 0) {
        listEl.innerHTML = '<li>No open games yet...</li>';
        return;
    }

    // Build a list item for each open game with a quick join button
    listEl.innerHTML = openGames.map(game => `
        <li>
            🎮 ${game.host}'s game 
            <strong>${game.gameId}</strong>
            <button onclick="quickJoin('${game.gameId}')">Join</button>
        </li>
    `).join('');
});

function quickJoin(gameId) {
    const name = document.getElementById('playerName').value;
    if (!name) return alert('Enter your name first!');
    socket.emit('joinGame', { playerName: name, gameId });
}

function backToLobby() {
    // Reset all game state
    currentGameId = null;
    myPlayerIndex = null;
    selectedMonster = null;
    selectedCell = null;
    placedThisTurn = false;
    myTurnEnded = false;
    movedThisTurn = [];
    boardState = Array.from({ length: 10 }, () => Array(10).fill(null));

    // Re-enable all buttons in case game ended
    document.querySelectorAll('#controls button').forEach(btn => btn.disabled = false);

    // Switch views
    document.getElementById('game').style.display = 'none';
    document.getElementById('lobby').style.display = 'block';
}

function updateScoreboard(losses) {
    const l0 = losses ? losses[0] : 0;
    const l1 = losses ? losses[1] : 0;
    document.getElementById('losses-0').textContent = l0;
    document.getElementById('losses-1').textContent = l1;

    // Update labels with actual names
    const p0label = document.querySelector('#scoreboard p:first-child');
    const p1label = document.querySelector('#scoreboard p:last-child');
    if (p0label) p0label.innerHTML = `🔴 ${playerNames[0]} losses: <span id="losses-0">${l0}</span>/10`;
    if (p1label) p1label.innerHTML = `🔵 ${playerNames[1]} losses: <span id="losses-1">${l1}</span>/10`;
}

function hasAnyValidMoves() {
    // Check every cell on the board
    for (let row = 0; row < 10; row++) {
        for (let col = 0; col < 10; col++) {
            const piece = boardState[row][col];

            // Only check our own monsters
            if (!piece || piece.player !== myPlayerIndex) continue;

            // Skip monsters already moved this turn
            if (movedThisTurn.some(m => m.row === row && m.col === col)) continue;

            // Skip monster placed this turn
            if (placedThisTurn && piece.placedThisTurn) continue;

            // If this monster has at least one valid move, we're not stuck
            if (getValidMoves(row, col).length > 0) return true;
        }
    }
    return false;
}

function checkAndLockIfNoMoves() {
    if (!hasAnyValidMoves()) {
        // Disable monster selection and board clicks
        document.querySelectorAll('#controls button:not([onclick="endTurn()"])' +
            ':not([onclick="backToLobby()"])').forEach(btn => btn.disabled = true);
        document.getElementById('board').style.pointerEvents = 'none';
        setStatus('No moves left - press End Turn!');
    }
}