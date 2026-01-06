const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Load word lists
const wordLists = {
    easy: [],
    normal: [],
    hard: []
};

function loadWords() {
    try {
        const easyData = JSON.parse(fs.readFileSync(path.join(__dirname, 'words_easy.json'), 'utf8'));
        wordLists.easy = easyData.list;
        const normalData = JSON.parse(fs.readFileSync(path.join(__dirname, 'words_normal.json'), 'utf8'));
        wordLists.normal = normalData.list;
        const hardData = JSON.parse(fs.readFileSync(path.join(__dirname, 'words_hard.json'), 'utf8'));
        wordLists.hard = hardData.list;
        console.log(`Loaded words: Easy(${wordLists.easy.length}), Normal(${wordLists.normal.length}), Hard(${wordLists.hard.length})`);
    } catch (err) {
        console.error("Error loading word lists:", err);
    }
}
loadWords();

const rooms = {};

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
    // --- Public Room List ---
    socket.on('getPublicRooms', () => {
        const publicRooms = Object.values(rooms)
            .filter(r => r.isPublic && r.status === 'waiting')
            .map(r => ({
                id: r.id,
                hostName: r.players.find(p => p.isHost)?.name || 'Unknown',
                playerCount: r.players.length
            }));
        socket.emit('publicRoomsList', publicRooms);
    });

    // --- Lobby Events ---

    socket.on('createRoom', ({ playerName, isPublic }) => {
        const roomId = generateRoomId();
        rooms[roomId] = {
            id: roomId,
            isPublic: !!isPublic,
            hostId: socket.id,
            players: [{
                id: socket.id,
                name: playerName,
                score: 0,
                progress: 0,
                isHost: true,
                totalTime: 0,
                totalChars: 0,
                kpm: 0
            }],
            settings: {
                winCount: 10,
                maxPlayers: 4,
                handicap: false,
                courses: ['easy', 'normal', 'hard']
            },
            status: 'waiting',
            currentWord: null,
            processingWord: false
        };

        socket.join(roomId);
        socket.emit('roomCreated', { roomId, roomState: rooms[roomId] });
    });

    socket.on('joinRoom', ({ roomId, playerName }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('error', '部屋が見つかりません');
            return;
        }
        if (room.status !== 'waiting') {
            socket.emit('error', '対戦中または終了した部屋です');
            return;
        }
        if (room.players.some(p => p.id === socket.id)) return;

        if (room.players.length >= (room.settings.maxPlayers || 4)) {
            socket.emit('error', '満員です');
            return;
        }

        room.players.push({
            id: socket.id,
            name: playerName,
            score: 0,
            progress: 0,
            isHost: false,
            totalTime: 0,
            totalChars: 0,
            kpm: 0
        });

        socket.join(roomId);
        socket.emit('joinSuccess', { roomState: room });
        io.to(roomId).emit('playerJoined', { roomState: room });
    });

    socket.on('leaveRoom', ({ roomId }) => {
        leaveRoom(socket, roomId);
    });

    socket.on('updateSettings', ({ roomId, settings }) => {
        const room = rooms[roomId];
        if (!room) return;
        if (room.hostId !== socket.id) return;

        room.settings = { ...room.settings, ...settings };
        io.to(roomId).emit('settingsUpdated', { settings: room.settings });
    });

    socket.on('kickPlayer', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.id) return;

        // Find player socket
        const player = room.players.find(p => p.id === targetId);
        if (player) {
            // Remove from room
            room.players = room.players.filter(p => p.id !== targetId);
            io.to(targetId).emit('kicked');

            // Force leave logic (best effort, client handles reload)
            const targetSocket = io.sockets.sockets.get(targetId);
            if (targetSocket) targetSocket.leave(roomId);

            io.to(roomId).emit('playerLeft', { roomState: room });

            // Update public room list if applicable
            const publicRooms = Object.values(rooms)
                .filter(r => r.isPublic && r.status === 'waiting')
                .map(r => ({
                    id: r.id,
                    hostName: r.players.find(p => p.isHost)?.name || 'Unknown',
                    playerCount: r.players.length
                }));
            io.emit('publicRoomsList', publicRooms);
        }
    });

    socket.on('startGame', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.id) return;

        room.status = 'countdown';
        io.to(roomId).emit('gameStarting', { count: 3, players: room.players });

        let count = 3;
        const countdownInterval = setInterval(() => {
            count--;
            if (count > 0) {
                io.to(roomId).emit('countdown', { count });
            } else {
                clearInterval(countdownInterval);
                startGameLoop(roomId);
            }
        }, 1000);
    });

    socket.on('returnToLobby', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.id) return;

        room.status = 'waiting';
        room.players.forEach(p => {
            p.score = 0;
            p.progress = 0;
        });
        room.currentWord = null;
        room.processingWord = false;

        io.to(roomId).emit('gameReset', { roomState: room });
    });

    // --- Game Logic Events ---

    socket.on('reportProgress', ({ roomId, progress }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'playing') return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.progress = progress;
            io.to(roomId).emit('progressUpdated', { playerId: socket.id, progress });
        }
    });

    socket.on('wordCompleted', ({ roomId, timeTaken, charCount, reactionTime }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'playing') return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        // Update stats
        player.totalTime += timeTaken;
        player.totalChars += charCount;
        player.reactionTime = reactionTime; // Store reaction time

        if (player.totalTime > 0) {
            player.kpm = (player.totalChars / player.totalTime) * 60; // Keys Per Minute
        }

        if (room.processingWord) return;
        room.processingWord = true;

        player.score++;
        io.to(roomId).emit('wordSucccess', {
            winnerName: player.name,
            winnerId: player.id,
            scores: room.players.map(p => ({ id: p.id, score: p.score }))
        });

        if (player.score >= room.settings.winCount) {
            room.status = 'finished';
            io.to(roomId).emit('gameFinished', { winner: player });
            room.processingWord = false;
        } else {
            setTimeout(() => {
                room.players.forEach(p => p.progress = 0);
                io.to(roomId).emit('progressUpdated', { playerId: null, reset: true });
                room.processingWord = false;
                nextWord(roomId);
            }, 800); // 0.8s match with animation
        }
    });

    socket.on('reportRoundStats', ({ roomId, timeTaken, charCount, reactionTime }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        // Update stats for handicap calculation only
        player.totalTime += timeTaken;
        player.totalChars += charCount;
        player.reactionTime = reactionTime; // Update reaction time

        if (player.totalTime > 0) {
            player.kpm = (player.totalChars / player.totalTime) * 60;
        }
    });

    socket.on('disconnect', () => {
        for (const rId in rooms) {
            const room = rooms[rId];
            if (room.players.some(p => p.id === socket.id)) {
                leaveRoom(socket, rId);
            }
        }
    });
});

function leaveRoom(socket, roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex === -1) return;

    room.players.splice(playerIndex, 1);
    socket.leave(roomId);

    if (room.players.length === 0) {
        delete rooms[roomId];
    } else {
        if (room.hostId === socket.id) {
            room.players[0].isHost = true;
            room.hostId = room.players[0].id;
        }
        io.to(roomId).emit('playerLeft', { roomState: room });
    }
}

function startGameLoop(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.status = 'playing';
    room.players.forEach(p => {
        p.score = 0;
        p.progress = 0;
        // Keep stats? Or reset? Let's keep stats for handicap calculation over matches?
        // Maybe reset for new game to measure current form.
        p.totalTime = 0;
        p.totalChars = 0;
        p.kpm = 0; // Wait, if we reset, handicap first round is 0.
    });

    nextWord(roomId);
}

function nextWord(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    let candidateList = [];
    if (room.settings.courses.includes('easy')) candidateList.push(...wordLists.easy);
    if (room.settings.courses.includes('normal')) candidateList.push(...wordLists.normal);
    if (room.settings.courses.includes('hard')) candidateList.push(...wordLists.hard);

    if (candidateList.length === 0) candidateList = wordLists.normal;

    const randomWord = candidateList[Math.floor(Math.random() * candidateList.length)];
    room.currentWord = randomWord;

    // Handicap Calculation
    // Only applies if Handicap Setting is ON
    if (room.settings.handicap) {
        // Find fastest KPM
        let maxKpm = 0;
        room.players.forEach(p => { if (p.kpm > maxKpm) maxKpm = p.kpm; });

        // Calculate delay for each player
        // Estimated keys needed ~ word text length * 1.7 (kana avg) or use actual kana length
        const charLen = randomWord.kana.length; // Approximate

        room.players.forEach(p => {
            const playerKpm = p.kpm || 100; // default assumption if 0
            if (playerKpm < 1) { // Not played yet 
                // No handicap for initial round or slow players
                io.to(p.id).emit('newWord', { word: randomWord, delay: 0 });
            } else {
                // Let's find SLOWEST player.
                let minKpm = 9999;
                room.players.forEach(op => { if (op.kpm > 0 && op.kpm < minKpm) minKpm = op.kpm; });
                if (minKpm === 9999) minKpm = playerKpm;

                if (minKpm < playerKpm) {
                    // Time calculation with Reaction Time
                    // Predicted Time = (Len / KPS) + ReactionTime

                    const kpsFast = playerKpm / 60;
                    const kpsSlow = minKpm / 60;

                    const reactionFast = p.reactionTime || 500; // ms
                    // Ideally we find the SPECIFIC slow player who is minKpm. 
                    const slowPlayerObj = room.players.find(sp => sp.kpm === minKpm) || { reactionTime: 500 };

                    // Note: reactionTime is in ms. (Len/KPS) is in seconds.
                    const fastTimeMs = (charLen / kpsFast) * 1000 + reactionFast;
                    const slowTimeMs = (charLen / kpsSlow) * 1000 + (slowPlayerObj.reactionTime || 500);

                    const delay = Math.max(0, Math.min(5000, slowTimeMs - fastTimeMs));

                    io.to(p.id).emit('newWord', { word: randomWord, delay: delay });
                } else {
                    io.to(p.id).emit('newWord', { word: randomWord, delay: 0 });
                }
            }
        });
    } else {
        io.to(roomId).emit('newWord', { word: randomWord, delay: 0 });
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
