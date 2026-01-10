const socket = io();

// --- State ---
let myPlayerName = "";
let currentRoomId = null;
let isHost = false;

let currentWord = null;
let isRoundActive = false; // Input blocking flag
let inputBlockedUntil = 0; // Timestamp for handicap delay
let handicapTimeout = null; // Timer for hiding handicap bar
let handicapCountdownInterval = null; // Interval for countdown display
let blockTimerInterval = null;

// --- DOM Elements ---
const screens = {
    welcome: document.getElementById('screen-welcome'),
    lobby: document.getElementById('screen-lobby'),
    game: document.getElementById('screen-game'),
    result: document.getElementById('screen-result')
};

const ui = {
    playerName: document.getElementById('playerNameInput'),
    roomIdInput: document.getElementById('roomIdInput'),
    joinInputArea: document.getElementById('joinInputArea'),
    publicRoomArea: document.getElementById('publicRoomArea'),
    publicRoomList: document.getElementById('publicRoomList'),
    lobbyRoomId: document.getElementById('displayRoomId'),
    lobbyList: document.getElementById('lobbyPlayerList'),
    lobbyStartBtn: document.getElementById('btnStartGame'),
    settingsPanel: document.getElementById('settingsPanel'),
    winCount: document.getElementById('winCountSelect'),
    maxPlayers: document.getElementById('maxPlayersSelect'), // NEW
    handicapCheck: document.getElementById('handicapCheck'),
    courseInputs: document.querySelectorAll('input[name="course"]'),
    wordJp: document.getElementById('wordJapanese'),
    wordReading: document.getElementById('wordReading'),
    wordRomaji: document.getElementById('wordRomaji'),
    scoreboard: document.getElementById('scoreboard'), // Top header (scores only)
    gameProgressBar: document.getElementById('gameProgressBar'), // NEW: Central progress
    feedback: document.getElementById('feedbackOverlay'),
    countdownInfo: document.getElementById('countdownOverlay'),
    countdownVal: document.getElementById('countdownVal'),
    toast: document.getElementById('toast'),
    inputBtns: {
        createPrivate: document.getElementById('btnCreatePrivate'),
        createPublic: document.getElementById('btnCreatePublic'),
        joinPrivate: document.getElementById('btnJoinPrivateMenu'),
        joinPublic: document.getElementById('btnJoinPublicMenu'),
        joinPrivateConfirm: document.getElementById('btnJoinRoomConfirm'),
        returnLobby: document.getElementById('btnReturnLobby'),
        exitGame: document.getElementById('btnExitGame'),
        leaveLobby: document.getElementById('btnLeaveLobby')
    },
    // Chat Elements
    chatMessages: document.getElementById('chatMessages'),
    chatInput: document.getElementById('chatInput'),
    btnSendChat: document.getElementById('btnSendChat'),
    // Result Elements
    resultList: document.getElementById('resultList'),
    btnForceEnd: document.getElementById('btnForceEnd')
};

// --- Helper Functions ---
function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[name].classList.add('active');

    // Auto-scroll chat if entering lobby
    if (name === 'lobby') {
        scrollToBottom();
    }
}

function scrollToBottom() {
    ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight;
}

function showToast(msg) {
    ui.toast.textContent = msg;
    ui.toast.classList.add('show');
    setTimeout(() => ui.toast.classList.remove('show'), 3000);
}

function updateLobby(roomState) {
    ui.lobbyRoomId.textContent = roomState.isPublic ? "PUBLIC ROOM" : roomState.id;
    ui.lobbyList.innerHTML = '';

    roomState.players.forEach(p => {
        const li = document.createElement('li');
        li.className = 'player-item';
        if (p.id === socket.id) li.classList.add('is-me');
        if (p.isHost) li.classList.add('is-host');

        let badges = '';
        if (p.isHost) badges += '<span class="player-badge badge-host">HOST</span>';
        if (p.id === socket.id) badges += '<span class="player-badge badge-me">YOU</span>';

        let kickBtn = '';
        // Allow host to kick others
        if (isHost && p.id !== socket.id) {
            kickBtn = `<button class="btn btn-sm btn-danger" onclick="kickPlayer('${p.id}')" style="margin-left:auto; font-size:0.7em; padding:2px 5px;">KICK</button>`;
        }

        li.innerHTML = `<span class="player-name">${p.name}</span><div>${badges}</div>${kickBtn}`;
        ui.lobbyList.appendChild(li);
    });

    isHost = roomState.players.find(p => p.id === socket.id)?.isHost || false;
    ui.lobbyStartBtn.disabled = !isHost;

    // Enable/disable inputs based on host
    const interactive = isHost ? 'auto' : 'none';
    const opacity = isHost ? '1' : '0.7';
    ui.settingsPanel.style.pointerEvents = interactive;
    ui.settingsPanel.style.opacity = opacity;

    if (ui.inputBtns.returnLobby) {
        ui.inputBtns.returnLobby.style.display = isHost ? 'inline-block' : 'none';
    }

    // Sync settings
    if (!isHost) {
        ui.winCount.value = roomState.settings.winCount;
        ui.maxPlayers.value = roomState.settings.maxPlayers || 4;
        ui.handicapCheck.checked = roomState.settings.handicap; // Sync handicap
        ui.courseInputs.forEach(cb => {
            cb.checked = roomState.settings.courses.includes(cb.value);
        });
    }
}

function renderScoreboard(players) {
    ui.scoreboard.innerHTML = '';
    // User requested fixed order (do not sort by score)
    const maxScore = Math.max(...players.map(p => p.score));

    players.forEach(p => {
        const div = document.createElement('div');
        div.className = 'score-item';
        div.id = `score-p-${p.id}`;
        if (p.score === maxScore && p.score > 0) div.classList.add('leading');

        div.innerHTML = `
            <div class="score-name">${p.name}</div>
            <div class="score-val">${p.score}</div>
        `;
        ui.scoreboard.appendChild(div);
    });
}

function renderMainProgressBar(players) {
    // This bar sits under the typing box and shows all players' progress in real-time
    ui.gameProgressBar.innerHTML = '';

    players.forEach(p => {
        // Skip self? Or show self too? Show all for comparison.
        // Self is usually visualized by typing itself, but bar is good for relative racing.

        const track = document.createElement('div');
        track.className = 'main-progress-track';

        // Color distinction
        const isMe = p.id === socket.id;
        const color = isMe ? 'var(--accent-color)' : 'var(--primary-light)';
        const name = isMe ? 'YOU' : p.name;

        track.innerHTML = `
            <div class="main-progress-label">${name}</div>
            <div class="main-progress-bar-bg">
                <div class="main-progress-fill" id="prog-fill-${p.id}" style="width: 0%; background-color: ${color};"></div>
            </div>
        `;
        ui.gameProgressBar.appendChild(track);
    });
}


// --- Typing Logic ---
// Expanded Map for small kana and variations
const kanaToRomaji = {
    'あ': ['a'], 'い': ['i'], 'う': ['u'], 'え': ['e'], 'お': ['o'],
    'か': ['ka', 'ca'], 'き': ['ki'], 'く': ['ku', 'cu', 'qu'], 'け': ['ke'], 'こ': ['ko', 'co'],
    'さ': ['sa'], 'し': ['si', 'shi', 'ci'], 'す': ['su'], 'せ': ['se', 'ce'], 'そ': ['so'],
    'た': ['ta'], 'ち': ['ti', 'chi'], 'つ': ['tu', 'tsu'], 'て': ['te'], 'と': ['to'],
    'な': ['na'], 'に': ['ni'], 'ぬ': ['nu'], 'ね': ['ne'], 'の': ['no'],
    'は': ['ha'], 'ひ': ['hi'], 'ふ': ['fu', 'hu'], 'へ': ['he'], 'ほ': ['ho'],
    'ま': ['ma'], 'み': ['mi'], 'む': ['mu'], 'め': ['me'], 'も': ['mo'],
    'や': ['ya'], 'ゆ': ['yu'], 'よ': ['yo'],
    'ら': ['ra'], 'り': ['ri'], 'る': ['ru'], 'れ': ['re'], 'ろ': ['ro'],
    'わ': ['wa'], 'を': ['wo'], 'ん': ['nn', 'xn', 'n'],
    'が': ['ga'], 'ぎ': ['gi'], 'ぐ': ['gu'], 'げ': ['ge'], 'ご': ['go'],
    'ざ': ['za'], 'じ': ['zi', 'ji'], 'ず': ['zu'], 'ぜ': ['ze'], 'ぞ': ['zo'],
    'だ': ['da'], 'ぢ': ['di'], 'づ': ['du'], 'で': ['de'], 'ど': ['do'],
    'ば': ['ba'], 'び': ['bi'], 'ぶ': ['bu'], 'べ': ['be'], 'ぼ': ['bo'],
    'ぱ': ['pa'], 'ぴ': ['pi'], 'ぷ': ['pu'], 'ぺ': ['pe'], 'ぽ': ['po'],

    // Small Kana & Combinations
    'ぁ': ['la', 'xa'], 'ぃ': ['li', 'xi'], 'ぅ': ['lu', 'xu'], 'ぇ': ['le', 'xe'], 'ぉ': ['lo', 'xo'],
    'ゃ': ['lya', 'xya'], 'ゅ': ['lyu', 'xyu'], 'ょ': ['lyo', 'xyo'],
    'っ': ['ltu', 'xtu', 'ltsu'],
    'ゎ': ['lwa', 'xwa'],

    // Compound Kana (Yoon)
    'きゃ': ['kya', 'kic'], 'きぃ': ['kyi'], 'きゅ': ['kyu'], 'きぇ': ['kye'], 'きょ': ['kyo'],
    'しゃ': ['sya', 'sha'], 'しぃ': ['syi'], 'しゅ': ['syu', 'shu'], 'シェ': ['sye', 'she'], 'しょ': ['syo', 'sho'],
    'しぇ': ['sye', 'she', 'sxe'],
    'ちゃ': ['tya', 'cha'], 'ちぃ': ['tyi'], 'ちゅ': ['tyu', 'chu'], 'チェ': ['tye', 'che'], 'ちょ': ['tyo', 'cho'],
    'にゃ': ['nya'], 'にぃ': ['nyi'], 'にゅ': ['nyu'], 'にぇ': ['nye'], 'にょ': ['nyo'],
    'ひゃ': ['hya'], 'ひぃ': ['hyi'], 'ひゅ': ['hyu'], 'ひぇ': ['hye'], 'ひょ': ['hyo'],
    'みゃ': ['mya'], 'みぃ': ['myi'], 'みゅ': ['myu'], 'みぇ': ['mye'], 'みょ': ['myo'],
    'りゃ': ['rya'], 'りぃ': ['ryi'], 'りゅ': ['ryu'], 'りぇ': ['rye'], 'りょ': ['ryo'],
    'ぎゃ': ['gya'], 'ぎぃ': ['gyi'], 'ぎゅ': ['gyu'], 'ぎぇ': ['gye'], 'ぎょ': ['gyo'],
    'じゃ': ['zya', 'ja', 'jya'], 'じぃ': ['zyi'], 'じゅ': ['zyu', 'ju', 'jyu'], 'じぇ': ['zye', 'je', 'jye'], 'ジェ': ['zye', 'je', 'jye'], 'じょ': ['zyo', 'jo', 'jyo'],
    'びゃ': ['bya'], 'びぃ': ['byi'], 'びゅ': ['byu'], 'びぇ': ['bye'], 'びょ': ['byo'],
    'ぴゃ': ['pya'], 'ぴぃ': ['pyi'], 'ぴゅ': ['pyu'], 'ぴぇ': ['pye'], 'ぴょ': ['pyo'],

    // New requests
    'てぃ': ['thi', 'txi', 'teli'], 'でぃ': ['dhi', 'dxi', 'deli'],

    // F-series
    'ふぁ': ['fa', 'fua'], 'ふぃ': ['fi', 'fui'], 'ふぅ': ['fu'], 'ふぇ': ['fe', 'fue'], 'ふぉ': ['fo', 'fuo'],

    // V-series
    'ゔぁ': ['va'], 'ゔぃ': ['vi'], 'ゔ': ['vu'], 'ゔぇ': ['ve'], 'ゔぉ': ['vo'],
    'ヴ': ['vu'], 'ヴァ': ['va'], 'ヴィ': ['vi'], 'ヴェ': ['ve'], 'ヴォ': ['vo'], // Katakana variants just in case

    // W-series variants
    'うぁ': ['wha'], 'うぃ': ['wi', 'whi'], 'うぇ': ['we', 'whe'], 'うぉ': ['who'],

    // T/D-series variants
    'てゃ': ['tha'], 'てぃ': ['thi', 'txi', 'teli'], 'てゅ': ['thu'], 'てぇ': ['the'], 'てょ': ['tho'],
    'でゃ': ['dha'], 'でぃ': ['dhi', 'dxi', 'deli'], 'でゅ': ['dhu'], 'でぇ': ['dhe'], 'でょ': ['dho'],

    // Symbols
    'ー': ['-'], '、': [','], '。': ['.', ','],
    '！': ['!'], '？': ['?'],
    '・': ['/']
};

class TypingEngine {
    constructor() {
        this.reset();
        this.startTime = 0;
        this.charCount = 0;
        this.inputEnabledTime = 0; // When input became possible
        this.firstKeyTime = 0;
        this.reactionTimes = []; // Keep last 5
    }

    reset() {
        this.kanaParts = [];
        this.currentIndex = 0;
        this.currentTyped = "";
        this.completedString = "";
        this.startTime = 0; // Set on first key or word start? Usually word start for Total Time
        this.wordStartTime = Date.now();
        this.charCount = 0;
        this.firstKeyTime = 0;
        this.totalKeystrokes = 0;
        this.correctKeystrokes = 0;
    }

    setWord(kanaList, delay) {
        this.reset();
        this.kanaParts = this.normalizeKana(kanaList);
        this.updateDisplay();
        this.inputEnabledTime = Date.now() + (delay || 0);
        this.wordStartTime = Date.now(); // Reset start time
    }

    normalizeKana(originalKanaList) {
        const rawString = originalKanaList.join('');
        const parts = [];
        let i = 0;
        while (i < rawString.length) {
            if (i + 1 < rawString.length) {
                const two = rawString.substring(i, i + 2);
                if (kanaToRomaji[two]) {
                    parts.push(two);
                    i += 2;
                    continue;
                }
            }
            const one = rawString.substring(i, i + 1);
            parts.push(one);
            i++;
        }
        return parts;
    }

    handleInput(key) {
        if (Date.now() < this.inputEnabledTime) return false;

        if (this.firstKeyTime === 0) {
            this.firstKeyTime = Date.now();
            const rt = Math.max(0, this.firstKeyTime - this.inputEnabledTime);
            this.reactionTimes.push(rt);
            if (this.reactionTimes.length > 5) this.reactionTimes.shift();
        }

        this.totalKeystrokes++;

        if (this.currentIndex >= this.kanaParts.length) return false;

        const targetKana = this.kanaParts[this.currentIndex];
        let patterns = kanaToRomaji[targetKana] || [targetKana];

        // ... double consonant logic ...
        // "っ" implicit double consonant logic fix for 'jji', 'zzi' etc.
        if (targetKana === 'っ' && this.currentIndex + 1 < this.kanaParts.length) {
            const nextKana = this.kanaParts[this.currentIndex + 1];
            const nextPatterns = kanaToRomaji[nextKana];
            if (nextPatterns && nextPatterns.length > 0) {
                const nextChars = new Set();
                nextPatterns.forEach(p => {
                    if (p.length > 0) nextChars.add(p[0]);
                });
                patterns = [...patterns, ...nextChars];
            }
        }

        let nextInput = this.currentTyped + key;

        // ... "ん" completion logic ...
        if (targetKana === 'ん' && this.currentTyped === 'n' && key !== 'n' && key !== "'") {
            const matches = patterns.some(p => p.startsWith(nextInput));
            if (!matches) {
                this.completedString += 'n';
                this.currentIndex++;
                this.currentTyped = "";
                this.updateDisplay();
                this.charCount++;
                this.correctKeystrokes++; // Implicit 'n' counts as correct? Or just the key that triggered it?
                // Actually the key triggered next char, so let's just count this logic as valid.
                // We will re-evaluate the key against new target below

                if (this.currentIndex < this.kanaParts.length) {
                    return this.handleInput(key);
                }
                // Implicit 'n' was the last char. Finish word.
                return this.finishWord();
            }
        }

        const validPattern = patterns.find(p => p.startsWith(nextInput));

        if (validPattern) {
            this.currentTyped = nextInput;
            this.correctKeystrokes++;

            if (validPattern === this.currentTyped) {
                this.completedString += this.currentTyped;
                this.currentTyped = "";
                this.currentIndex++;
                this.charCount += validPattern.length; // Count actual keys
                this.updateDisplay();
            } else {
                this.updateDisplay();
            }

            // Report progress
            const total = this.kanaParts.length;
            const current = this.currentIndex;
            const pct = Math.min(1, (current + (this.currentTyped.length > 0 ? 0.5 : 0)) / total);
            socket.emit('reportProgress', { roomId: currentRoomId, progress: pct });

            if (this.currentIndex >= this.kanaParts.length) {
                return this.finishWord();
            }
            return 'valid';
        }



        // Bug fix: Check if we just completed "n" via implicit logic but user typed an extra char
        // e.g. "shinkansen" -> user typed "sinkansenx".
        // The 'x' triggered 'n' completion above (lines 322-338).
        // If we are now DONE, report completion immediately despite 'x' being invalid for *next* char (which doesn't exist).
        if (this.currentIndex >= this.kanaParts.length) {
            return this.finishWord();
        }

        return 'invalid';
    }

    finishWord() {
        const now = Date.now();
        const timeTaken = (now - this.wordStartTime) / 1000;
        // True Time: Time from first keypress to finish
        const trueTime = (this.firstKeyTime > 0) ? (now - this.firstKeyTime) / 1000 : timeTaken;

        // Calculate average reaction time for this word? No, just report this word's reaction
        const currentReaction = (this.firstKeyTime > 0) ? (this.firstKeyTime - this.inputEnabledTime) : 0;

        // For average tracking in class
        // We actually report raw for server to average

        socket.emit('wordCompleted', {
            roomId: currentRoomId,
            timeTaken,
            charCount: this.charCount,
            reactionTime: Math.max(0, currentReaction),
            trueTime: Math.max(0.001, trueTime), // Avoid divide by zero
            totalKeystrokes: this.totalKeystrokes,
            correctKeystrokes: this.correctKeystrokes
        });
        return 'completed';
    }


    getCurrentStats() {
        // Partial stats for round end when not winner
        const now = Date.now();
        const timeTaken = (now - this.wordStartTime) / 1000;
        const trueTime = (this.firstKeyTime > 0) ? (now - this.firstKeyTime) / 1000 : timeTaken;
        const currentReaction = (this.firstKeyTime > 0) ? (this.firstKeyTime - this.inputEnabledTime) : 0;

        return {
            timeTaken,
            charCount: this.charCount,
            reactionTime: Math.max(0, currentReaction),
            trueTime: Math.max(0.001, trueTime),
            totalKeystrokes: this.totalKeystrokes,
            correctKeystrokes: this.correctKeystrokes
        };
    }

    updateDisplay() {
        let html = '';
        html += `<span class="romaji-char typed">${this.completedString}</span>`;

        if (this.currentIndex < this.kanaParts.length) {
            const target = this.kanaParts[this.currentIndex];
            let patterns = kanaToRomaji[target] || [target];

            let pattern = patterns.find(p => p.startsWith(this.currentTyped)) || patterns[0];

            // Special display for "っ" double consonant preview
            if (target === 'っ' && this.currentTyped.length === 1 && !['l', 'x'].includes(this.currentTyped)) {
                // User typed 'k', pattern might be 'ltu' but we want to show 'k'
                // We don't have a good pattern to show remaining... 
                // Just show what was typed.
                pattern = this.currentTyped + (patterns[0] === 'ltu' ? 'tu' : patterns[0].substring(1)); // hacky
                // Better: If we matched a NextChar, patterns includes that char.
            }

            html += `<span class="romaji-char typed">${this.currentTyped}</span>`;
            html += `<span class="romaji-char next">${pattern.substring(this.currentTyped.length)}</span>`;

            for (let i = this.currentIndex + 1; i < this.kanaParts.length; i++) {
                let p = kanaToRomaji[this.kanaParts[i]]?.[0] || this.kanaParts[i];
                html += `<span style="opacity:0.5">${p}</span>`;
            }
        }
        ui.wordRomaji.innerHTML = html;
        ui.wordReading.textContent = this.kanaParts.join('');
    }
}
const typer = new TypingEngine();

ui.btnForceEnd.addEventListener('click', () => {
    if (isHost && currentRoomId) {
        if (confirm('本当に試合を強制終了しますか？')) {
            socket.emit('forceEndGame', { roomId: currentRoomId });
        }
    }
});


// --- Socket Events ---
socket.on('connect', () => console.log('Connected'));

socket.on('roomCreated', ({ roomId, roomState }) => {
    currentRoomId = roomId;
    isHost = true;
    showScreen('lobby');
    updateLobby(roomState);
});

socket.on('joinSuccess', ({ roomState }) => {
    currentRoomId = roomState.id;
    isHost = false;
    showScreen('lobby');
    updateLobby(roomState);
});

socket.on('playerJoined', ({ roomState }) => updateLobby(roomState));
socket.on('playerLeft', ({ roomState }) => {
    isHost = roomState.players.find(p => p.id === socket.id)?.isHost || false;

    // If we are in a game, just update the necessary parts, don't switch screen
    if (screens.game.classList.contains('active')) {
        if (isHost) {
            ui.btnForceEnd.style.display = 'block';
        } else {
            ui.btnForceEnd.style.display = 'none';
        }
        renderScoreboard(roomState.players);
    } else {
        // Otherwise, we are in the lobby, so do the full update.
        updateLobby(roomState);
    }
});

socket.on('settingsUpdated', ({ settings }) => {
    ui.winCount.value = settings.winCount;
    ui.maxPlayers.value = settings.maxPlayers || 4;
    ui.handicapCheck.checked = settings.handicap;
    ui.courseInputs.forEach(cb => {
        cb.checked = settings.courses.includes(cb.value);
    });
});

socket.on('kicked', () => {
    alert("ホストによりキックされました。");
    location.reload();
});

window.kickPlayer = (targetId) => {
    if (!isHost) return;
    if (confirm("このプレイヤーをキックしますか？")) {
        socket.emit('kickPlayer', { roomId: currentRoomId, targetId });
    }
};

socket.on('gameStarting', ({ count, players }) => {
    if (isHost) {
        ui.btnForceEnd.style.display = 'block';
    }
    ui.countdownInfo.style.display = 'flex';
    ui.countdownVal.textContent = count;
    ui.feedback.classList.remove('show'); // Clear previous 'GET!'
    renderScoreboard(players); // init scoreboard
    renderMainProgressBar(players); // init progress bars
});

socket.on('countdown', ({ count }) => {
    ui.countdownVal.textContent = count;
});

socket.on('newWord', ({ word, delay }) => {
    ui.countdownInfo.style.display = 'none';
    currentWord = word;
    isRoundActive = true;
    if (screens.game.style.display !== 'flex') showScreen('game');

    ui.wordJp.textContent = word.text;
    typer.setWord(word.kana, delay); // Pass delay for reaction time measurement base

    // Handicap Delay Handling
    const meterContainer = document.getElementById('handicapMeterContainer');
    const meterBar = document.getElementById('handicapMeterBar');
    const timerDisplay = document.getElementById('handicapTimer');

    // Clear any existing reset timer and countdown interval
    if (handicapTimeout) {
        clearTimeout(handicapTimeout);
        handicapTimeout = null;
    }
    if (handicapCountdownInterval) {
        clearInterval(handicapCountdownInterval);
        handicapCountdownInterval = null;
    }

    // Reset state first
    meterContainer.classList.remove('active');
    meterBar.style.transition = 'none';
    meterBar.style.width = '0%';
    timerDisplay.textContent = '0';

    // Force reflow to apply reset
    void meterBar.offsetWidth;

    if (delay > 0) {
        const endTime = Date.now() + delay;

        // Start new handicap
        meterContainer.classList.add('active');
        timerDisplay.textContent = delay;

        // Start countdown interval (update every 50ms for smooth display)
        handicapCountdownInterval = setInterval(() => {
            const remaining = Math.max(0, endTime - Date.now());
            timerDisplay.textContent = remaining;
            if (remaining <= 0) {
                clearInterval(handicapCountdownInterval);
                handicapCountdownInterval = null;
            }
        }, 50);

        // We need a slight delay to allow the 'width: 0%' to stick before starting transition?
        // Actually reflow above handles it.
        requestAnimationFrame(() => {
            meterBar.style.transition = `width ${delay}ms linear`;
            meterBar.style.width = '100%';
        });

        handicapTimeout = setTimeout(() => {
            meterContainer.classList.remove('active');
            meterBar.style.transition = 'none';
            meterBar.style.width = '0%';
            timerDisplay.textContent = '0';
            handicapTimeout = null;
            if (handicapCountdownInterval) {
                clearInterval(handicapCountdownInterval);
                handicapCountdownInterval = null;
            }
        }, delay);

    } else {
        inputBlockedUntil = 0;
        // Keep it hidden
    }

    const box = document.getElementById('wordBox');
    box.classList.remove('pulse');
    void box.offsetWidth;
    box.classList.add('pulse');
});

socket.on('progressUpdated', ({ playerId, progress, reset }) => {
    if (reset) {
        document.querySelectorAll('.main-progress-fill').forEach(el => el.style.width = '0%');
        return;
    }
    const bar = document.getElementById(`prog-fill-${playerId}`);
    if (bar) bar.style.width = `${progress * 100}%`;
});

socket.on('wordSucccess', ({ winnerName, winnerId, scores }) => {
    isRoundActive = false;
    renderScoreboard(scores.map(s => ({
        id: s.id,
        score: s.score,
        name: document.querySelector(`#score-p-${s.id} .score-name`)?.textContent || "Player"
    })));

    // Send partial stats if I am NOT the winner (or always, to be safe)
    if (winnerId !== socket.id) {
        const stats = typer.getCurrentStats();
        if (stats.charCount > 0) {
            socket.emit('reportRoundStats', {
                roomId: currentRoomId,
                timeTaken: stats.timeTaken,
                charCount: stats.charCount,
                reactionTime: stats.reactionTime
            });
        }
    }

    const overlay = ui.feedback;
    overlay.textContent = `${winnerName} GET!!`;
    overlay.classList.remove('show');
    void overlay.offsetWidth;
    overlay.classList.add('show');
    overlay.style.color = (winnerId === socket.id) ? 'var(--success-color)' : 'var(--error-color)';
});

socket.on('gameFinished', ({ winner, players, forcedByHost }) => {
    ui.btnForceEnd.style.display = 'none';
    setTimeout(() => {
        showScreen('result');
        if (forcedByHost) {
            document.getElementById('winnerName').textContent = '強制終了';
        } else if (winner) {
            document.getElementById('winnerName').textContent = winner.name;
        } else {
            document.getElementById('winnerName').textContent = '試合終了'; // Fallback
        }


        ui.resultList.innerHTML = ''; // Ensure clean slate

        // Sort players by score descend
        players.sort((a, b) => b.score - a.score);

        players.forEach(p => {
            const stats = p.finalStats || {};
            const tr = document.createElement('tr');
            if (!forcedByHost && winner && p.id === winner.id) tr.className = 'result-winner-row';

            tr.innerHTML = `
                <td>${p.name}</td>
                <td>${stats.score}</td>
                <td>${(stats.accuracy || 0).toFixed(1)}%</td>
                <td>${(stats.kpm || 0).toFixed(0)} <span style="font-size:0.7em">kpm</span></td>
                <td>${(stats.trueKpm || 0).toFixed(0)} <span style="font-size:0.7em">kpm</span></td>
                <td>${(stats.avgReaction || 0).toFixed(0)} <span style="font-size:0.7em">ms</span></td>
            `;
            ui.resultList.appendChild(tr);
        });

    }, 1500);
});

socket.on('gameReset', ({ roomState }) => {
    ui.btnForceEnd.style.display = 'none';
    currentWord = null;
    showScreen('lobby');
    updateLobby(roomState);
});

socket.on('publicRoomsList', (list) => {
    ui.publicRoomList.innerHTML = '';
    if (list.length === 0) {
        ui.publicRoomList.innerHTML = '<li>現在待機中のパブリックルームはありません</li>';
        return;
    }
    list.forEach(r => {
        const li = document.createElement('li');
        li.innerHTML = `<span>Host: ${r.hostName} (${r.playerCount}人)</span> <button class="btn btn-sm" onclick="joinPublic('${r.id}')">参加</button>`;
        ui.publicRoomList.appendChild(li);
    });
});

// --- Chat Socket Events ---
socket.on('chatMessage', ({ time, name, message, isSystem }) => {
    const div = document.createElement('div');
    div.className = `chat-msg ${isSystem ? 'system' : ''}`;

    if (isSystem) {
        div.textContent = message;
    } else {
        div.innerHTML = `<span class="chat-time">${time}</span><span class="chat-name">${name}:</span><span class="chat-content">${message}</span>`;
    }

    ui.chatMessages.appendChild(div);
    scrollToBottom();
});


window.joinPublic = (rid) => {
    if (!myPlayerName) myPlayerName = ui.playerName.value || "Guest";
    socket.emit('joinRoom', { roomId: rid, playerName: myPlayerName });
};

// --- Chat Interactions ---
function sendChat() {
    const msg = ui.chatInput.value.trim();
    if (!msg || !currentRoomId) return;

    socket.emit('chatMessage', { roomId: currentRoomId, message: msg });
    ui.chatInput.value = '';
}

ui.btnSendChat.addEventListener('click', sendChat);
ui.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
});


// --- UI Interactions ---

function getPlayerName() {
    const name = ui.playerName.value.trim();
    if (!name) { showToast("名前を入力してください"); return null; }
    myPlayerName = name;
    return name;
}

ui.inputBtns.createPrivate.addEventListener('click', () => {
    const name = getPlayerName();
    if (name) socket.emit('createRoom', { playerName: name, isPublic: false });
});

ui.inputBtns.createPublic.addEventListener('click', () => {
    const name = getPlayerName();
    if (name) socket.emit('createRoom', { playerName: name, isPublic: true });
});

ui.inputBtns.joinPrivate.addEventListener('click', () => {
    ui.joinInputArea.style.display = 'block';
    ui.publicRoomArea.style.display = 'none';
});

ui.inputBtns.joinPublic.addEventListener('click', () => {
    const name = getPlayerName();
    if (!name) return;
    ui.joinInputArea.style.display = 'none';
    ui.publicRoomArea.style.display = 'block';
    socket.emit('getPublicRooms');
});

ui.inputBtns.joinPrivateConfirm.addEventListener('click', () => {
    const name = getPlayerName();
    const rid = ui.roomIdInput.value.trim().toUpperCase();
    if (name && rid) {
        socket.emit('joinRoom', { roomId: rid, playerName: name });
    }
});

ui.inputBtns.leaveLobby.addEventListener('click', () => {
    socket.emit('leaveRoom', { roomId: currentRoomId });
    showScreen('welcome');
});

ui.inputBtns.returnLobby.addEventListener('click', () => {
    socket.emit('returnToLobby', { roomId: currentRoomId });
});

ui.inputBtns.exitGame.addEventListener('click', () => {
    socket.emit('leaveRoom', { roomId: currentRoomId });
    location.reload();
});

ui.lobbyStartBtn.addEventListener('click', () => {
    if (isHost) socket.emit('startGame', { roomId: currentRoomId });
});

const broadcastSettings = () => {
    if (!isHost || !currentRoomId) return;
    const courses = [];
    ui.courseInputs.forEach(cb => { if (cb.checked) courses.push(cb.value); });
    const settings = {
        winCount: parseInt(ui.winCount.value),
        maxPlayers: parseInt(ui.maxPlayers.value),
        handicap: ui.handicapCheck.checked,
        courses: courses
    };
    socket.emit('updateSettings', { roomId: currentRoomId, settings });
};

ui.winCount.addEventListener('change', broadcastSettings);
ui.maxPlayers.addEventListener('change', broadcastSettings);
ui.handicapCheck.addEventListener('change', broadcastSettings);
ui.courseInputs.forEach(cb => cb.addEventListener('change', broadcastSettings));

document.addEventListener('keydown', (e) => {
    if (!screens.game.classList.contains('active') || !currentWord) return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.key.length !== 1) return;

    // Block input if handicapped
    if (!isRoundActive) return;
    if (Date.now() < inputBlockedUntil) {
        e.preventDefault();
        return;
    }

    const key = e.key.toLowerCase();
    const res = typer.handleInput(key);

    if (res === 'completed') {
        // socket.emit('wordCompleted', ... ) is handled inside typer
        currentWord = null;
    } else if (res === 'invalid') {
        const el = document.querySelector('.romaji-char.next');
        if (el) {
            el.classList.add('error');
            setTimeout(() => el.classList.remove('error'), 300);
        }
    }
});
