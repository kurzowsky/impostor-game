const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

// Upewnij się, że masz plik words.js w tym samym folderze!
const categoriesDB = require("./words");

app.use(express.static("public"));

const rooms = {};

// --- FUNKCJE POMOCNICZE ---

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function resetRoomGame(room) {
    room.gameState = {
        active: false,
        turnIndex: 0,
        turnsCount: 0,
        votes: {},
        currentWord: "",
        impostorCanGuess: true,
    };
    room.players.forEach((p) => (p.role = null));
}

function normalizeText(text) {
    if (!text) return "";
    return text
        .trim()
        .toLowerCase()
        .replace(/ą/g, "a")
        .replace(/ć/g, "c")
        .replace(/ę/g, "e")
        .replace(/ł/g, "l")
        .replace(/ń/g, "n")
        .replace(/ó/g, "o")
        .replace(/ś/g, "s")
        .replace(/ź/g, "z")
        .replace(/ż/g, "z");
}

io.on("connection", (socket) => {
    // --- TWORZENIE POKOJU ---
    socket.on("createRoom", ({ nickname, roomName, password }) => {
        if (rooms[roomName]) {
            socket.emit("errorMsg", "Nazwa zajęta!");
            return;
        }
        rooms[roomName] = {
            name: roomName,
            password: password,
            hostId: socket.id,
            players: [],
            gameState: {},
        };
        resetRoomGame(rooms[roomName]);
        joinRoomLogic(socket, roomName, nickname);
    });

    // --- DOŁĄCZANIE ---
    socket.on("joinRoom", ({ nickname, roomName, password }) => {
        const room = rooms[roomName];
        if (!room) {
            socket.emit("errorMsg", "Brak pokoju.");
            return;
        }
        if (room.password && room.password !== password) {
            socket.emit("errorMsg", "Złe hasło!");
            return;
        }
        if (room.gameState.active) {
            socket.emit("errorMsg", "Gra trwa.");
            return;
        }
        if (room.players.find((p) => p.name === nickname)) {
            socket.emit("errorMsg", "Nick zajęty.");
            return;
        }
        joinRoomLogic(socket, roomName, nickname);
    });

    function joinRoomLogic(socket, roomName, nickname) {
        const room = rooms[roomName];
        socket.data.roomName = roomName;
        socket.data.nickname = nickname;
        socket.join(roomName);
        room.players.push({ id: socket.id, name: nickname, role: null });

        emitRoomUpdate(room);
        socket.emit("joinedLobby");
    }

    function emitRoomUpdate(room) {
        io.to(room.name).emit("updateRoom", {
            roomName: room.name,
            players: room.players,
            hostId: room.hostId,
            gameActive: room.gameState.active,
            availableCategories: Object.keys(categoriesDB),
        });
    }

    // --- KICK ---
    socket.on("kickPlayer", (targetId) => {
        const roomName = socket.data.roomName;
        const room = rooms[roomName];
        if (!room || room.hostId !== socket.id || targetId === socket.id)
            return;

        const targetSocket = io.sockets.sockets.get(targetId);
        room.players = room.players.filter((p) => p.id !== targetId);
        if (targetSocket) {
            targetSocket.leave(roomName);
            targetSocket.emit("kicked");
        }
        emitRoomUpdate(room);
    });

    // --- START GRY ---
    socket.on("startGame", (selectedCategories) => {
        const roomName = socket.data.roomName;
        const room = rooms[roomName];
        if (!room || room.hostId !== socket.id) return;
        if (room.players.length < 3) {
            socket.emit("errorMsg", "Min. 3 graczy!");
            return;
        }

        if (!selectedCategories || selectedCategories.length === 0) {
            socket.emit("errorMsg", "Wybierz min. 1 kategorię!");
            return;
        }

        let gameDeck = [];
        selectedCategories.forEach((cat) => {
            if (categoriesDB[cat]) {
                gameDeck = gameDeck.concat(categoriesDB[cat]);
            }
        });

        if (gameDeck.length === 0) {
            socket.emit("errorMsg", "Błąd: Pusta lista słów!");
            return;
        }

        room.gameState.active = true;
        room.gameState.impostorCanGuess = true;
        room.players = shuffleArray(room.players);
        room.gameState.turnIndex = 0;
        room.gameState.turnsCount = 0;
        room.gameState.votes = {};

        const impostorIndex = Math.floor(Math.random() * room.players.length);
        room.gameState.currentWord =
            gameDeck[Math.floor(Math.random() * gameDeck.length)];

        room.players.forEach((player, index) => {
            const role = index === impostorIndex ? "impostor" : "civilian";
            player.role = role;
            io.to(player.id).emit("gameStarted", {
                role: role,
                word: role === "civilian" ? room.gameState.currentWord : null,
                hostId: room.hostId,
            });
        });

        emitRoomUpdate(room);
        io.to(roomName).emit("updateTurn", room.players[0]);
    });

    // --- ZGADYWANIE ---
    socket.on("guessWord", (guess) => {
        const room = rooms[socket.data.roomName];
        if (!room || !room.gameState.active) return;
        const player = room.players.find((p) => p.id === socket.id);
        if (
            !player ||
            player.role !== "impostor" ||
            !room.gameState.impostorCanGuess
        )
            return;

        const normalizedGuess = normalizeText(guess);
        const normalizedSecret = normalizeText(room.gameState.currentWord);

        if (normalizedGuess === normalizedSecret) {
            finishGame(room, {
                winner: "IMPOSTOR",
                msg: `Impostor ZGADŁ! Hasło: ${room.gameState.currentWord}. Wygrał: ${player.name}`,
                secretWord: room.gameState.currentWord,
            });
        } else {
            finishGame(room, {
                winner: "CIVILIANS",
                msg: `Impostor pomylił się (${guess})! Hasło: ${room.gameState.currentWord}.`,
                secretWord: room.gameState.currentWord,
            });
        }
    });

    socket.on("forceEndGame", () => {
        const room = rooms[socket.data.roomName];
        if (room && room.hostId === socket.id && room.gameState.active) {
            finishGame(room, {
                winner: "NONE",
                msg: "Host zakończył grę.",
                secretWord: room.gameState.currentWord,
            });
        }
    });

    // --- TURY ---
    socket.on("nextTurn", () => {
        const room = rooms[socket.data.roomName];
        if (!room || !room.gameState.active) return;
        if (socket.id === room.players[room.gameState.turnIndex].id) {
            room.gameState.turnsCount++;

            // Jeśli koniec rundy -> Start Głosowania
            if (room.gameState.turnsCount >= room.players.length) {
                io.to(room.name).emit("startVoting", room.players);

                // Wyślij info, że nikt jeszcze nie zagłosował
                io.to(room.name).emit(
                    "updateVotingStatus",
                    room.players.map((p) => p.name),
                );
            } else {
                room.gameState.turnIndex =
                    (room.gameState.turnIndex + 1) % room.players.length;
                io.to(room.name).emit(
                    "updateTurn",
                    room.players[room.gameState.turnIndex],
                );
            }
        }
    });

    // --- GŁOSOWANIE ---
    socket.on("vote", (targetId) => {
        const room = rooms[socket.data.roomName];
        if (!room || !room.gameState.active) return;

        room.gameState.votes[socket.id] = targetId;

        // --- AKTUALIZACJA STATUSU GŁOSOWANIA (KTO JESZCZE NIE GŁOSOWAŁ) ---
        const pendingPlayers = room.players
            .filter((p) => !room.gameState.votes[p.id])
            .map((p) => p.name);
        io.to(room.name).emit("updateVotingStatus", pendingPlayers);
        // ------------------------------------------------------------------

        const civilians = room.players.filter((p) => p.role === "civilian");
        const allCiviliansVoted = civilians.every(
            (c) => room.gameState.votes[c.id] !== undefined,
        );

        if (allCiviliansVoted && room.gameState.impostorCanGuess) {
            room.gameState.impostorCanGuess = false;
            const impostor = room.players.find((p) => p.role === "impostor");
            if (impostor)
                io.to(impostor.id).emit(
                    "guessLocked",
                    "Wszyscy cywile zagłosowali. Zgadywanie zablokowane!",
                );
        }

        if (Object.keys(room.gameState.votes).length === room.players.length) {
            finishVoting(room);
        }
    });

    function finishVoting(room) {
        let counts = { SKIP: 0 };
        room.players.forEach((p) => (counts[p.id] = 0));
        Object.values(room.gameState.votes).forEach((t) => {
            if (counts[t] !== undefined) counts[t]++;
        });

        let max = -1,
            winner = null;
        for (const [id, c] of Object.entries(counts)) {
            if (c > max) {
                max = c;
                winner = id;
            } else if (c === max) winner = "TIE";
        }

        if (winner === "SKIP" || winner === "TIE") {
            io.to(room.name).emit("votingResult", { result: "skip" });
            room.gameState.votes = {};
            room.gameState.turnsCount = 0;
            room.gameState.turnIndex =
                (room.gameState.turnIndex + 1) % room.players.length;
            room.gameState.impostorCanGuess = true;
            setTimeout(() => {
                if (rooms[room.name])
                    io.to(room.name).emit(
                        "resumeGame",
                        room.players[room.gameState.turnIndex],
                    );
            }, 3000);
            return;
        }

        const ejected = room.players.find((p) => p.id === winner);

        if (ejected.role === "impostor")
            finishGame(room, {
                winner: "CIVILIANS",
                msg: "Impostor wyrzucony!",
                secretWord: room.gameState.currentWord,
            });
        else
            finishGame(room, {
                winner: "IMPOSTOR",
                msg: `Wyrzucono niewinnego (${ejected.name}).`,
                secretWord: room.gameState.currentWord,
            });
    }

    function finishGame(room, data) {
        const impostorPlayer = room.players.find((p) => p.role === "impostor");
        const impostorName = impostorPlayer ? impostorPlayer.name : "Nieznany";
        data.impostorName = impostorName;

        io.to(room.name).emit("gameOver", data);
        setTimeout(() => {
            if (rooms[room.name]) {
                resetRoomGame(room);
                io.to(room.name).emit("returnToLobby");
                emitRoomUpdate(room);
            }
        }, 9000);
    }

    // --- ROZŁĄCZANIE (Z PRZEKAZANIEM HOSTA) ---
    socket.on("disconnect", () => {
        const roomName = socket.data.roomName;
        if (!roomName || !rooms[roomName]) return;
        const room = rooms[roomName];

        // 1. Usuń gracza
        room.players = room.players.filter((p) => p.id !== socket.id);
        delete room.gameState.votes[socket.id];

        // 2. Jeśli pusto -> usuń pokój
        if (room.players.length === 0) {
            delete rooms[roomName];
            return;
        }

        // 3. JEŚLI WYSZEDŁ HOST -> NOWY HOST
        if (socket.id === room.hostId) {
            room.hostId = room.players[0].id; // Pierwszy z listy przejmuje władzę
        }

        // 4. Jeśli gra trwała i za mało graczy -> Reset
        if (room.gameState.active && room.players.length < 3) {
            resetRoomGame(room);
            io.to(roomName).emit("gameReset", "Za mało graczy. Gra przerwana.");
            io.to(roomName).emit("returnToLobby");
        }

        emitRoomUpdate(room);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serwer działa na porcie ${PORT}`);
});
