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
                totalChars: 0,
                kpm: 0,
                reactionTime: 0,
                reactionCount: 0,
                totalTrueTime: 0,
                totalKeystrokes: 0,
                totalKeystrokes: 0,
                correctKeystrokes: 0,
                statsHistory: [] // [{kpm, reaction}, ...] max 5
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
            totalChars: 0,
            kpm: 0,
            reactionTime: 0,
            reactionCount: 0,
            totalTrueTime: 0,
            totalKeystrokes: 0,
            totalKeystrokes: 0,
            correctKeystrokes: 0,
            statsHistory: []
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

    // --- Chat Events ---
    socket.on('chatMessage', ({ roomId, message }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('error', '部屋が存在しません(再接続してください)');
            return;
        }

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        const now = new Date();
        const timeStr = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

        io.to(roomId).emit('chatMessage', {
            time: timeStr,
            name: player.name,
            message: message,
            isSystem: false
        });
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

    socket.on('wordCompleted', ({ roomId, timeTaken, charCount, reactionTime, trueTime, totalKeystrokes, correctKeystrokes }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'playing') return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        // Update stats
        player.totalTime += timeTaken;
        player.totalChars += charCount;
        player.reactionTime += reactionTime; // Sum it up, avg later
        player.reactionCount++;



        // Push to history for handicap
        const currentKpm = (charCount / timeTaken) * 60;
        player.statsHistory.push({ kpm: currentKpm, reaction: reactionTime });
        if (player.statsHistory.length > 5) player.statsHistory.shift();

        // Extended stats
        player.totalTrueTime += (trueTime || 0);
        player.totalKeystrokes += (totalKeystrokes || 0);
        player.correctKeystrokes += (correctKeystrokes || 0);

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

            // Calculate final stats for all players
            room.players.forEach(p => {
                p.finalStats = {
                    score: p.score,
                    totalTime: p.totalTime,
                    totalChars: p.totalChars,
                    kpm: p.totalTime > 0 ? (p.totalChars / p.totalTime) * 60 : 0,
                    trueKpm: p.totalTrueTime > 0 ? (p.totalChars / p.totalTrueTime) * 60 : 0,
                    avgReaction: p.reactionCount > 0 ? (p.reactionTime / p.reactionCount) : 0,
                    accuracy: p.totalKeystrokes > 0 ? (p.correctKeystrokes / p.totalKeystrokes) * 100 : 0
                };
            });

            io.to(roomId).emit('gameFinished', {
                winner: player,
                players: room.players
            });
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

    socket.on('reportRoundStats', ({ roomId, timeTaken, charCount, reactionTime, trueTime, totalKeystrokes, correctKeystrokes }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        // Update stats for handicap calculation only AND final stats
        player.totalTime += timeTaken;
        player.totalChars += charCount;

        // Also update extended stats even for losers of the round, so final stats are accurate
        player.reactionTime += reactionTime;
        player.reactionCount++;
        player.totalTrueTime += (trueTime || 0);
        player.totalKeystrokes += (totalKeystrokes || 0);
        player.correctKeystrokes += (correctKeystrokes || 0);

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
        p.totalTime = 0;
        p.totalChars = 0;
        p.kpm = 0;
        p.reactionTime = 0;
        p.reactionCount = 0;
        p.totalTrueTime = 0;
        p.totalKeystrokes = 0;
        p.correctKeystrokes = 0;
        // Do NOT reset statsHistory here, to persist handicap data across matches
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

    // Fallback if all lists are empty (e.g. file load error)
    if (candidateList.length === 0) {
        candidateList = [{ text: "Error", kana: ["え", "ら", "ー"] }];
    }

    const randomWord = candidateList[Math.floor(Math.random() * candidateList.length)];
    // Double check randomWord validity
    if (!randomWord || !randomWord.kana) {
        console.error("Invalid word selected:", randomWord);
        // Emergency fallback
        room.currentWord = { text: "Error", kana: ["え", "ら", "ー"] };
    } else {
        room.currentWord = randomWord;
    }

    // Handicap Calculation
    // Only applies if Handicap Setting is ON
    if (room.settings.handicap) {
        // Calculate averages for all players
        const playerStats = room.players.map(p => {
            if (p.statsHistory.length === 0) return { id: p.id, avgKpm: 0, avgReaction: 500 };
            const sumKpm = p.statsHistory.reduce((a, b) => a + b.kpm, 0);
            const sumReaction = p.statsHistory.reduce((a, b) => a + b.reaction, 0);
            return {
                id: p.id,
                avgKpm: sumKpm / p.statsHistory.length,
                avgReaction: sumReaction / p.statsHistory.length
            };
        });

        // Find fastest Avg KPM
        let maxAvgKpm = 0;
        playerStats.forEach(ps => { if (ps.avgKpm > maxAvgKpm) maxAvgKpm = ps.avgKpm; });

        // Calculate delay for each player
        const charLen = room.currentWord.kana.length; // Approximate

        playerStats.forEach(ps => {
            if (ps.avgKpm < 1) {
                // No handicap for initial round or slow players
                io.to(ps.id).emit('newWord', { word: room.currentWord, delay: 0 });
            } else {
                // Determine handicap relative to the fastest player?
                // Actually the standard logic is usually "Handicap everyone to the Slowest player's level" 
                // OR "Handicap the FASTEST players to match the SLOWEST".
                // The previous logic seemed to try "Handicap THIS player if they are faster than the SLOWEST".
                // Let's stick to: Make everyone finish at the same time as the SLOWEST player (ideal fair match).

                let minAvgKpm = 9999;
                playerStats.forEach(ops => { if (ops.avgKpm > 0 && ops.avgKpm < minAvgKpm) minAvgKpm = ops.avgKpm; });

                // If everyone is 0, min is 9999, so reset
                if (minAvgKpm === 9999) minAvgKpm = ps.avgKpm;

                // If I am faster than the slowest player, I get a delay.
                if (minAvgKpm < ps.avgKpm) {
                    // Time calculation
                    const kpsFast = ps.avgKpm / 60;
                    const kpsSlow = minAvgKpm / 60;

                    const reactionFast = ps.avgReaction || 500;
                    // We need the reaction time of the slowest player too
                    const slowPlayerStat = playerStats.find(s => Math.abs(s.avgKpm - minAvgKpm) < 0.01) || { avgReaction: 500 };

                    const fastTimeMs = (charLen / kpsFast) * 1000 + reactionFast;
                    const slowTimeMs = (charLen / kpsSlow) * 1000 + slowPlayerStat.avgReaction;

                    const delay = Math.max(0, Math.min(5000, slowTimeMs - fastTimeMs));

                    io.to(ps.id).emit('newWord', { word: room.currentWord, delay: delay });
                } else {
                    io.to(ps.id).emit('newWord', { word: room.currentWord, delay: 0 });
                }
            }
        });
    } else {
        io.to(roomId).emit('newWord', { word: room.currentWord, delay: 0 });
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
