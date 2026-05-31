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