require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*", // Allow any origin
        methods: ["GET", "POST"]
    }
});

// Store active sessions
// Map<sessionId, { hostId, players: [], currentQuestionIndex, scores: {} }>
const sessions = new Map();

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Admin creates a session
    socket.on('create_session', ({ hostId, quizId }) => {
        // Check if host already has an active session
        let existingSessionId = null;
        for (const [sId, s] of sessions.entries()) {
            if (s.hostId === hostId) {
                existingSessionId = sId;
                break;
            }
        }

        if (existingSessionId) {
            const session = sessions.get(existingSessionId);

            // If quizId is provided and different from session's quizId, destroy old session
            if (quizId && session.quizId !== quizId) {
                console.log(`Host ${hostId} switching quiz from ${session.quizId} to ${quizId}. Destroying old session ${existingSessionId}.`);
                sessions.delete(existingSessionId);
                // We don't return here, we proceed to create a NEW session below
            } else {
                // Restore existing session (same quiz or no quizId provided)
                session.hostSocketId = socket.id; // Update host socket ID
                socket.join(existingSessionId);

                // Send back existing session details
                socket.emit('session_created', { sessionId: existingSessionId });

                // Restore state to host
                socket.emit('player_joined', { players: session.players });
                if (session.currentQuestionIndex >= 0) {
                    // Send current question if quiz started
                    const currentQ = session.questions[session.currentQuestionIndex];
                    socket.emit('new_question', {
                        question: currentQ,
                        index: session.currentQuestionIndex,
                        total: session.questions.length
                    });
                }

                console.log(`Host ${hostId} reconnected to session ${existingSessionId}`);
                return;
            }
        }

        const sessionId = Math.random().toString(36).substring(2, 8).toUpperCase();
        sessions.set(sessionId, {
            hostId,
            quizId, // Store quizId
            hostSocketId: socket.id,
            players: [],
            bannedPlayers: new Set(), // Track banned user IDs (socket IDs or user IDs if available)
            currentQuestionIndex: -1,
            scores: {},
            questions: [] // Will be populated by host
        });
        socket.join(sessionId);
        socket.emit('session_created', { sessionId });
        console.log(`Session ${sessionId} created by host ${hostId} for quiz ${quizId}`);
    });

    // User joins a session
    socket.on('join_session', ({ sessionId, playerName }) => {
        const session = sessions.get(sessionId);
        if (session) {
            // Check if user is banned
            // Note: In a real app with auth, we'd ban by userId. Here we rely on socket ID or name if persistent.
            // Since socket ID changes on reconnect, this simple ban is per-connection. 
            // To make it robust, we'd need a persistent userId sent from client.
            // For now, we'll assume the client sends the same socket connection or we just ban the current socket.
            // If the user refreshes, they get a new socket ID. 
            // To prevent rejoin after refresh, we should ideally ban by some persistent ID (like userId passed from client).

            // However, the current requirement is "session persistence". 
            // Let's assume the client might pass a userId if available, or we just ban the socket.
            // If we want to prevent rejoin, we need to check if this player (by name or ID) is in bannedPlayers.

            // For this implementation, let's assume we ban by Name to prevent simple rejoins, 
            // or better, if we had userId. The current join_session only sends playerName.
            // Let's stick to the current scope: ban the active player.

            // If we want to persist ban across refreshes without auth, we'd need IP or fingerprinting.
            // With auth (which we have), we should send userId.
            // Let's update join_session to accept userId if possible, but for now we'll check name.

            if (session.bannedPlayers.has(playerName)) {
                socket.emit('error', { message: 'You are banned from this session!' });
                return;
            }

            // Check if player is rejoining
            const existingPlayer = session.players.find(p => p.name === playerName);
            if (existingPlayer) {
                // Update socket ID
                // Remove old socket ID from scores if needed, or map new socket to old score
                // Here we use socket.id as key in scores, so we need to migrate score
                const oldSocketId = existingPlayer.id;
                const score = session.scores[oldSocketId] || 0;

                // Update player object
                existingPlayer.id = socket.id;
                existingPlayer.status = 'active'; // Reset status if they were somehow inactive

                // Migrate score
                delete session.scores[oldSocketId];
                session.scores[socket.id] = score;

                socket.join(sessionId);
                socket.emit('joined_success', { sessionId });

                // Send current game state if playing
                if (session.currentQuestionIndex >= 0) {
                    const currentQ = session.questions[session.currentQuestionIndex];
                    socket.emit('new_question', {
                        question: currentQ,
                        index: session.currentQuestionIndex,
                        total: session.questions.length
                    });
                }

                console.log(`Player ${playerName} rejoined session ${sessionId}`);
            } else {
                // New player
                session.players.push({ id: socket.id, name: playerName, score: 0, status: 'active' });
                session.scores[socket.id] = 0;
                socket.join(sessionId);

                socket.emit('joined_success', { sessionId });
                console.log(`Player ${playerName} joined session ${sessionId}`);
            }

            // Notify host and other players (always send full list)
            io.to(sessionId).emit('player_joined', {
                players: session.players
            });

        } else {
            socket.emit('error', { message: 'Session not found' });
        }
    });

    // ... (start_quiz, next_question, submit_answer remain mostly same, just ensure player check handles status)

    // Host starts quiz / sends questions
    socket.on('start_quiz', ({ sessionId, questions }) => {
        const session = sessions.get(sessionId);
        if (session && session.hostSocketId === socket.id) {
            session.questions = questions;
            session.currentQuestionIndex = 0;

            // Send first question
            io.to(sessionId).emit('new_question', {
                question: questions[0],
                index: 0,
                total: questions.length
            });
        }
    });

    // Host sends next question
    socket.on('next_question', ({ sessionId }) => {
        const session = sessions.get(sessionId);
        if (session && session.hostSocketId === socket.id) {
            session.currentQuestionIndex++;

            if (session.currentQuestionIndex < session.questions.length) {
                io.to(sessionId).emit('new_question', {
                    question: session.questions[session.currentQuestionIndex],
                    index: session.currentQuestionIndex,
                    total: session.questions.length
                });
            } else {
                io.to(sessionId).emit('quiz_ended', {
                    finalScores: session.players.filter(p => p.status !== 'banned')
                });
            }
        }
    });

    // Player submits answer
    socket.on('submit_answer', ({ sessionId, answerIndex, timeTaken }) => {
        const session = sessions.get(sessionId);
        if (session) {
            // Check if player is banned
            const player = session.players.find(p => p.id === socket.id);
            if (!player || player.status === 'banned') return;

            const currentQuestion = session.questions[session.currentQuestionIndex];
            const isCorrect = currentQuestion.correctAnswer === answerIndex;

            if (isCorrect) {
                // Simple scoring: 100 points for correct, bonus for speed
                const points = 100 + Math.max(0, (10 - timeTaken) * 10);
                session.scores[socket.id] += points;

                // Update player score in array
                if (player) {
                    player.score = session.scores[socket.id];
                }
            }

            // Send live leaderboard update to host
            if (session.hostSocketId) {
                io.to(session.hostSocketId).emit('leaderboard_update', {
                    players: session.players
                });
            }
        }
    });

    // Player warning (anti-cheat)
    socket.on('player_warning', ({ sessionId, reason }) => {
        const session = sessions.get(sessionId);
        if (session) {
            const player = session.players.find(p => p.id === socket.id);
            if (player) {
                player.warnings = (player.warnings || 0) + 1;

                // Notify host
                if (session.hostSocketId) {
                    io.to(session.hostSocketId).emit('leaderboard_update', {
                        players: session.players
                    });
                }
            }
        }
    });

    // Player is banned
    socket.on('ban_player', ({ sessionId, reason }) => {
        const session = sessions.get(sessionId);
        if (session) {
            const player = session.players.find(p => p.id === socket.id);
            if (player) {
                player.status = 'banned';
                session.bannedPlayers.add(player.name);

                // Notify host
                if (session.hostSocketId) {
                    io.to(session.hostSocketId).emit('player_banned', {
                        playerId: socket.id,
                        playerName: player.name,
                        reason,
                        players: session.players
                    });
                }

                // Notify player
                socket.emit('you_are_banned');
                console.log(`Player ${socket.id} (${player.name}) banned from session ${sessionId}`);
            }
        }
    });

    // Player is unbanned
    socket.on('unban_player', ({ sessionId, playerId }) => {
        const session = sessions.get(sessionId);
        if (session) {
            const player = session.players.find(p => p.id === playerId);
            if (player) {
                player.status = 'active';
                player.warnings = 0; // Reset warnings
                session.bannedPlayers.delete(player.name);

                // Notify host (update leaderboard)
                if (session.hostSocketId) {
                    io.to(session.hostSocketId).emit('leaderboard_update', {
                        players: session.players
                    });
                }

                // Notify player
                io.to(playerId).emit('you_are_unbanned');
                console.log(`Player ${playerId} (${player.name}) unbanned in session ${sessionId}`);
            }
        }
    });

    // Host resets session (clears data)
    socket.on('reset_session', ({ sessionId }) => {
        const session = sessions.get(sessionId);
        if (session && session.hostSocketId === socket.id) {
            // Notify all players
            io.to(sessionId).emit('session_closed');

            // Delete session
            sessions.delete(sessionId);
            console.log(`Session ${sessionId} reset by host ${session.hostId}`);
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        // Handle cleanup if needed
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
