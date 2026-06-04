const socket = io();

// =====================================================================
// GAME STATE (client-side)
// These variables track the local game state for this player's session.
// The server holds the authoritative state; the client mirrors it after
// each round.
// =====================================================================

let myPlayerIndex = null;      // 0 or 1 - assigned when we create/join
let currentGameId = null;      // The 6-character game code for this session

let selectedMonster = null;    // Monster type chosen from the sidebar buttons
let placedThisTurn = false;    // True once a monster has been placed this turn (one per turn)

// 10x10 grid - each cell is null or { type, player }
let boardState = Array.from({ length: 10 }, () => Array(10).fill(null));

let selectedCell = null;       // { row, col } of the monster currently selected for moving
let movedThisTurn = [];        // Tracks destination coords of monsters moved this turn
let myTurnEnded = false;       // Prevents double-submitting endTurn

let playerNames = ['Player 1', 'Player 2'];
let roundNumber = 0;

// Emoji lookup for rendering monsters on the board
const MONSTERS = {
    vampire: '🧛',
    werewolf: '🐺',
    ghost: '👻'
};

// =====================================================================
// LOBBY ACTIONS
// =====================================================================

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

// =====================================================================
// GAME SETUP EVENTS
// =====================================================================

// Received by the player who created the game
socket.on('gameCreated', (data) => {
    currentGameId = data.gameId;
    myPlayerIndex = 0;
    playerNames[0] = document.getElementById('playerName').value;
    document.getElementById('lobby').style.display = 'none';
    document.getElementById('game').style.display = 'block';
    document.getElementById('gameInfo').textContent = `Game Code: ${data.gameId} - Waiting for another player...`;
    buildBoard();
    showGameCode(data.gameId);
});

// Received by the player who joined an existing game
socket.on('gameJoined', (data) => {
    currentGameId = data.gameId;
    myPlayerIndex = 1;
    playerNames[1] = document.getElementById('playerName').value;
    document.getElementById('lobby').style.display = 'none';
    document.getElementById('game').style.display = 'block';
    document.getElementById('gameInfo').textContent = `Joined Game: ${data.gameId}`;
    buildBoard();
});

// Received by both players once the second player joins - game can begin
socket.on('playerJoined', ({ players }) => {
    playerNames[0] = players[0].name;
    if (players[1]) playerNames[1] = players[1].name;
    updateScoreboard();
    setControlsLocked(false);
    setStatus('Game started! Place or move your monsters.');
    document.getElementById('gameInfo').textContent = `Game: ${currentGameId}`;
});

// =====================================================================
// BOARD RENDERING
// =====================================================================

// Builds the 10x10 grid from scratch, with coordinate labels.
// Also resets round-specific state (combat log, round counter).
function buildBoard() {
    roundNumber = 0;

    const list = document.getElementById('combat-log-list');
    list.innerHTML = '<li class="placeholder">No combat yet...</li>';

    const board = document.getElementById('board');
    board.innerHTML = '';

    // Top-left corner spacer
    const corner = document.createElement('div');
    corner.classList.add('coord-label');
    board.appendChild(corner);

    // Column number labels (0-9)
    for (let col = 0; col < 10; col++) {
        const label = document.createElement('div');
        label.classList.add('coord-label');
        label.textContent = col;
        board.appendChild(label);
    }

    // Rows: row number label + 10 cells
    for (let row = 0; row < 10; row++) {
        const rowLabel = document.createElement('div');
        rowLabel.classList.add('coord-label');
        rowLabel.textContent = row;
        board.appendChild(rowLabel);

        for (let col = 0; col < 10; col++) {
            const cell = document.createElement('div');
            cell.classList.add('cell');
            cell.dataset.row = row;
            cell.dataset.col = col;

            // Colour-code the home edge rows
            if (row === 0) cell.classList.add('player1-edge');
            if (row === 9) cell.classList.add('player2-edge');

            cell.addEventListener('click', () => onCellClick(row, col));
            board.appendChild(cell);
        }
    }

    // Board is locked until the second player joins
    setControlsLocked(true);
}

// Disables/enables all game controls and board interaction.
// Used while waiting for an opponent and while waiting for the
// opponent to end their turn.
function setControlsLocked(locked) {
    const buttons = document.querySelectorAll('#controls button:not([onclick="backToLobby()"])');
    buttons.forEach(btn => btn.disabled = locked);
    document.getElementById('board').style.pointerEvents = locked ? 'none' : 'auto';
    if (locked) setStatus('Waiting for opponent to join...');
}

// Updates a single cell's visual appearance from boardState
function renderCell(row, col) {
    const cell = document.querySelector(`.cell[data-row="${row}"][data-col="${col}"]`);
    if (!cell) return;

    const content = boardState[row][col];
    if (content) {
        cell.textContent = MONSTERS[content.type];
        // Red tint for player 0, blue tint for player 1
        cell.style.backgroundColor = content.player === 0
            ? 'rgba(255,0,0,0.3)'
            : 'rgba(0,0,255,0.3)';
    } else {
        cell.textContent = '';
        cell.style.backgroundColor = '';
        // Restore edge row colour if applicable
        if (row === 0) cell.classList.add('player1-edge');
        if (row === 9) cell.classList.add('player2-edge');
    }
}

function setStatus(msg) {
    document.getElementById('statusText').textContent = msg;
}

// =====================================================================
// CELL CLICK HANDLER
// Handles three interaction modes depending on current state:
//   1. Monster type selected -> attempt to place it
//   2. Monster already selected for moving -> attempt to move it
//   3. Nothing selected -> attempt to select a monster to move
// =====================================================================
function onCellClick(row, col) {
    if (selectedMonster) {
        placeMonster(row, col);
        return;
    }

    if (selectedCell) {
        if (selectedCell.row === row && selectedCell.col === col) {
            // Clicking the same cell again deselects it
            clearHighlights();
            selectedCell = null;
            setStatus('Deselected');
            return;
        }
        tryMove(selectedCell.row, selectedCell.col, row, col);
        return;
    }

    // Try to select a monster at this cell
    const piece = boardState[row][col];

    if (!piece || piece.player !== myPlayerIndex) {
        setStatus('No monster there, or not yours!');
        return;
    }

    if (placedThisTurn && piece.placedThisTurn) {
        setStatus('Cannot move a monster placed this turn!');
        return;
    }

    if (movedThisTurn.some(m => m.row === row && m.col === col)) {
        setStatus('Already moved that monster this turn!');
        return;
    }

    selectedCell = { row, col };
    highlightValidMoves(row, col);
    setStatus(`Selected ${piece.type} at (${row},${col}) - click a highlighted cell to move`);
}

// =====================================================================
// MONSTER PLACEMENT
// Only allowed on the player's own edge row (row 0 for player 0,
// row 9 for player 1). One placement per turn. Maximum 10 monsters
// on the board at once.
// =====================================================================
function selectMonster(type) {
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

    // Count existing monsters to enforce the 10-monster cap
    let monsterCount = 0;
    for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 10; c++) {
            const cell = boardState[r][c];
            if (cell && cell.player === myPlayerIndex) monsterCount++;
        }
    }

    if (monsterCount >= 10) {
        setStatus('You already have 10 monsters on the board!');
        return;
    }

    // Update local board state and re-render the cell immediately
    boardState[row][col] = { type: selectedMonster, player: myPlayerIndex };
    renderCell(row, col);

    // Notify the server so its authoritative board state stays in sync
    socket.emit('placeMonster', {
        gameId: currentGameId,
        row, col,
        type: selectedMonster,
        playerIndex: myPlayerIndex
    });

    placedThisTurn = true;
    selectedMonster = null;
    setStatus(`Placed ${boardState[row][col].type}! You can now move other monsters.`);

    checkAndLockIfNoMoves();
}

// =====================================================================
// MOVEMENT VALIDATION
// Computes all squares a given monster can legally reach this turn.
// Rules:
//   - Horizontal/vertical: unlimited range
//   - Diagonal: max 2 squares
//   - Can pass through own monsters but not land on them
//   - Cannot enter the opponent's starting edge row
//   - Stops (and can land) when reaching an enemy monster
// =====================================================================
function getValidMoves(fromRow, fromCol) {
    const validMoves = [];
    const piece = boardState[fromRow][fromCol];
    const forbiddenRow = piece.player === 0 ? 9 : 0;

    const directions = [
        { dr: 0,  dc: 1,  diagonal: false },
        { dr: 0,  dc: -1, diagonal: false },
        { dr: 1,  dc: 0,  diagonal: false },
        { dr: -1, dc: 0,  diagonal: false },
        { dr: 1,  dc: 1,  diagonal: true  },
        { dr: 1,  dc: -1, diagonal: true  },
        { dr: -1, dc: 1,  diagonal: true  },
        { dr: -1, dc: -1, diagonal: true  },
    ];

    for (const dir of directions) {
        const maxSteps = dir.diagonal ? 2 : 10;

        for (let step = 1; step <= maxSteps; step++) {
            const newRow = fromRow + dir.dr * step;
            const newCol = fromCol + dir.dc * step;

            if (newRow < 0 || newRow > 9 || newCol < 0 || newCol > 9) break;
            if (newRow === forbiddenRow) break;

            const cellContent = boardState[newRow][newCol];

            if (cellContent) {
                if (cellContent.player === piece.player) {
                    continue; // Pass through own monsters
                } else {
                    validMoves.push({ row: newRow, col: newCol }); // Can land on enemy
                    break; // Cannot pass through enemy
                }
            }

            validMoves.push({ row: newRow, col: newCol });
        }
    }

    return validMoves;
}

function highlightValidMoves(row, col) {
    clearHighlights();
    const selectedEl = document.querySelector(`.cell[data-row="${row}"][data-col="${col}"]`);
    if (selectedEl) selectedEl.classList.add('selected');

    const moves = getValidMoves(row, col);
    for (const move of moves) {
        const cell = document.querySelector(`.cell[data-row="${move.row}"][data-col="${move.col}"]`);
        if (cell) cell.classList.add('valid-move');
    }
}

function clearHighlights() {
    document.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
    document.querySelectorAll('.valid-move').forEach(el => el.classList.remove('valid-move'));
}

// Validates and executes a move from one cell to another.
// Updates local state optimistically, then syncs to server.
function tryMove(fromRow, fromCol, toRow, toCol) {
    const validMoves = getValidMoves(fromRow, fromCol);
    const isValid = validMoves.some(m => m.row === toRow && m.col === toCol);

    if (!isValid) {
        setStatus('Invalid move!');
        clearHighlights();
        selectedCell = null;
        return;
    }

    const piece = boardState[fromRow][fromCol];
    boardState[fromRow][fromCol] = null;
    boardState[toRow][toCol] = piece;

    renderCell(fromRow, fromCol);
    renderCell(toRow, toCol);

    movedThisTurn.push({ row: toRow, col: toCol });

    socket.emit('moveMonster', {
        gameId: currentGameId,
        fromRow, fromCol, toRow, toCol,
        playerIndex: myPlayerIndex
    });

    clearHighlights();
    selectedCell = null;
    setStatus(`Moved ${piece.type} to (${toRow}, ${toCol})`);

    checkAndLockIfNoMoves();
}

// =====================================================================
// END TURN
// Locks the player's controls and tells the server the turn is done.
// The server will not advance the round until both players have called
// this (barrier pattern). The board unlocks again when 'newRound' or
// 'gameOver' is received.
// =====================================================================
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

    setControlsLocked(true);

    socket.emit('endTurn', { gameId: currentGameId, playerIndex: myPlayerIndex });
    setStatus('Turn ended - waiting for opponent...');
}

// =====================================================================
// ROUND RESOLUTION EVENTS
// =====================================================================

// Received when both players have ended their turn and combat is resolved.
// The server sends the authoritative post-combat board state.
socket.on('newRound', ({ boardState: serverBoard, combatLog, losses, totalGamesPlayed }) => {
    myTurnEnded = false;
    roundNumber++;

    setControlsLocked(false);

    // Replace local board with the server's resolved board
    boardState = serverBoard;
    for (let row = 0; row < 10; row++) {
        for (let col = 0; col < 10; col++) {
            renderCell(row, col);
        }
    }

    if (losses) updateScoreboard(losses);
    if (totalGamesPlayed !== undefined) updateStatsDisplay(totalGamesPlayed, null);

    if (combatLog && combatLog.length > 0) {
        updateCombatLog(combatLog, roundNumber);
        setStatus(`⚔️ Round ${roundNumber} combat resolved!`);
    } else {
        setStatus(`Round ${roundNumber + 1} started! Place or move your monsters.`);
    }

    // Reset per-turn tracking for the new round
    placedThisTurn = false;
    movedThisTurn = [];
    selectedCell = null;
    selectedMonster = null;
    clearHighlights();
    checkAndLockIfNoMoves();
});

// Received when a player reaches 10 losses or forfeits
socket.on('gameOver', ({ winner, losses, totalGamesPlayed, playerStats }) => {
    updateScoreboard(losses);

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
    document.getElementById('post-game').style.display = 'block';
});

// =====================================================================
// STATS DISPLAY
// =====================================================================

function updateStatsDisplay(totalGamesPlayed, myStats) {
    if (document.getElementById('total-games')) {
        document.getElementById('total-games').textContent = totalGamesPlayed;
    }
    if (document.getElementById('lobby-total-games')) {
        document.getElementById('lobby-total-games').textContent = totalGamesPlayed;
    }
    if (myStats) {
        document.getElementById('my-wins').textContent = myStats.wins;
        document.getElementById('my-losses').textContent = myStats.losses;
    }
}

// Received when joining/creating a game to show current stats immediately
socket.on('statsUpdate', ({ totalGamesPlayed, myStats }) => {
    updateStatsDisplay(totalGamesPlayed, myStats);
});

// Received whenever the lobby state changes (player count, open games list)
socket.on('lobbyUpdate', ({ onlineUsers, openGames }) => {
    const onlineEl = document.getElementById('online-users');
    if (onlineEl) onlineEl.textContent = onlineUsers;

    const listEl = document.getElementById('open-games-list');
    if (!listEl) return;

    if (openGames.length === 0) {
        listEl.innerHTML = '<li>No open games yet...</li>';
        return;
    }

    listEl.innerHTML = openGames.map(game => `
        <li>
            🎮 ${game.host}'s game 
            <strong>${game.gameId}</strong>
            <button onclick="quickJoin('${game.gameId}')">Join</button>
        </li>
    `).join('');
});

// Join a game directly from the open games list in the lobby
function quickJoin(gameId) {
    const name = document.getElementById('playerName').value;
    if (!name) return alert('Enter your name first!');
    socket.emit('joinGame', { playerName: name, gameId });
}

// =====================================================================
// SCOREBOARD
// =====================================================================

function updateScoreboard(losses) {
    const l0 = losses ? losses[0] : 0;
    const l1 = losses ? losses[1] : 0;
    document.getElementById('losses-0').textContent = l0;
    document.getElementById('losses-1').textContent = l1;

    const p0label = document.querySelector('#scoreboard p:first-child');
    const p1label = document.querySelector('#scoreboard p:last-child');
    if (p0label) p0label.innerHTML = `🔴 ${playerNames[0]} losses: <span id="losses-0">${l0}</span>/10`;
    if (p1label) p1label.innerHTML = `🔵 ${playerNames[1]} losses: <span id="losses-1">${l1}</span>/10`;
}

// =====================================================================
// MOVE AVAILABILITY CHECK
// After each placement or move, check whether the player has any moves
// left. If not (and they have already placed), auto-lock controls and
// prompt them to end their turn.
// =====================================================================

function hasAnyValidMoves() {
    for (let row = 0; row < 10; row++) {
        for (let col = 0; col < 10; col++) {
            const piece = boardState[row][col];
            if (!piece || piece.player !== myPlayerIndex) continue;
            if (movedThisTurn.some(m => m.row === row && m.col === col)) continue;
            if (placedThisTurn && piece.placedThisTurn) continue;
            if (getValidMoves(row, col).length > 0) return true;
        }
    }
    return false;
}

function checkAndLockIfNoMoves() {
    if (!placedThisTurn) return; // Still need to place before locking

    if (!hasAnyValidMoves()) {
        document.querySelectorAll(
            '#controls button:not([onclick="endTurn()"]):not([onclick="backToLobby()"])'
        ).forEach(btn => btn.disabled = true);
        document.getElementById('board').style.pointerEvents = 'none';
        setStatus('No moves left - press End Turn!');
    }
}

// =====================================================================
// GIVE UP / NAVIGATION
// =====================================================================

function giveUp() {
    if (!confirm('Are you sure you want to give up?')) return;
    socket.emit('giveUp', { gameId: currentGameId, playerIndex: myPlayerIndex });
}

function backToLobby() {
    if (currentGameId) {
        socket.emit('leaveGame', { gameId: currentGameId, playerIndex: myPlayerIndex });
    }
    resetGameState();
    document.getElementById('game').style.display = 'none';
    document.getElementById('lobby').style.display = 'block';
}

function playAgain() {
    const savedName = playerNames[myPlayerIndex];
    resetGameState();
    document.getElementById('post-game').style.display = 'none';
    document.querySelectorAll('#controls button').forEach(btn => btn.disabled = false);
    document.getElementById('game').style.display = 'none';
    document.getElementById('lobby').style.display = 'block';
    document.getElementById('playerName').value = savedName;
}

// Centralised reset so backToLobby and playAgain stay DRY
function resetGameState() {
    currentGameId = null;
    myPlayerIndex = null;
    selectedMonster = null;
    selectedCell = null;
    placedThisTurn = false;
    myTurnEnded = false;
    movedThisTurn = [];
    boardState = Array.from({ length: 10 }, () => Array(10).fill(null));
    document.getElementById('post-game').style.display = 'none';
    document.querySelectorAll('#controls button').forEach(btn => btn.disabled = false);
}

// =====================================================================
// OPPONENT DISCONNECT
// =====================================================================

socket.on('opponentDisconnected', ({ winnerIndex, totalGamesPlayed, playerStats }) => {
    const myStats = playerStats[myPlayerIndex];
    updateStatsDisplay(totalGamesPlayed, myStats);

    if (winnerIndex === myPlayerIndex) {
        setStatus('🏆 Your opponent disconnected — you win!');
    } else {
        setStatus('💀 You disconnected from the game.');
    }

    document.querySelectorAll('#controls button').forEach(btn => btn.disabled = true);
    document.getElementById('post-game').style.display = 'block';
});

// =====================================================================
// GAME CODE DISPLAY
// =====================================================================

// Replaces the plain game code text with a copyable version after creation
function showGameCode(gameId) {
    const gameInfo = document.getElementById('gameInfo');
    gameInfo.innerHTML = `
        <br>Monster Mayhem
        Game Code: <strong>${gameId}</strong>
        <button onclick="copyGameCode('${gameId}')">Copy Code</button>
        <span id="copy-confirm" style="display:none; color:green;">Copied!</span>
    `;
}

function copyGameCode(gameId) {
    navigator.clipboard.writeText(gameId).then(() => {
        const confirm = document.getElementById('copy-confirm');
        confirm.style.display = 'inline';
        setTimeout(() => { confirm.style.display = 'none'; }, 2000);
    });
}

// =====================================================================
// COMBAT LOG
// Appends a round header and each fight result to the scrollable log.
// =====================================================================

function updateCombatLog(combatLog, roundNumber) {
    const list = document.getElementById('combat-log-list');
    if (!combatLog || combatLog.length === 0) return;

    const roundHeader = document.createElement('li');
    roundHeader.innerHTML = `<strong>--- Round ${roundNumber} ---</strong>`;
    roundHeader.classList.add('log-round-header');
    list.appendChild(roundHeader);

    for (const fight of combatLog) {
        const item = document.createElement('li');
        if (fight.removed === 'both') {
            item.textContent = `(${fight.row},${fight.col}) Both monsters destroyed!`;
        } else {
            item.textContent = `(${fight.row},${fight.col}) ${fight.survived} survived, ${fight.removed} removed!`;
        }
        list.appendChild(item);
    }

    list.scrollTop = list.scrollHeight;

    const placeholder = list.querySelector('.placeholder');
    if (placeholder) placeholder.remove();
}

// =====================================================================
// MISC UI
// =====================================================================

function toggleInstructions() {
    const content = document.getElementById('instructions-content');
    content.style.display = content.style.display === 'none' ? 'block' : 'none';
}