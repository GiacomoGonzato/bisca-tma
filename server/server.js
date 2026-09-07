/**
 * server.js
 * Single Render web service that:
 *   1. Serves the Telegram Mini App static frontend (/public).
 *   2. Runs Socket.io game rooms for multiplayer BISCA.
 *   3. Runs the Telegram bot (long polling) that greets users and opens the app.
 *
 * ONE port, ONE process — the simplest possible Render deployment.
 */

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const RoomManager = require('./game/RoomManager');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const BOT_USERNAME = process.env.BOT_USERNAME || '';

// ----------------------------------------------------------- HTTP + Sockets -

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Expose non-secret config to the client (bot username for invite links).
app.get('/config', (_req, res) => {
  res.json({ botUsername: BOT_USERNAME, baseUrl: BASE_URL });
});

// SPA fallback.
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// -------------------------------------------------- Telegram auth (optional) -

/**
 * Validate Telegram WebApp initData per the official algorithm.
 * Returns the parsed user object if valid, else null.
 * If BOT_TOKEN is missing (local dev), validation is skipped.
 */
function verifyInitData(initData) {
  if (!initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const dataCheck = [...params.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');
    if (BOT_TOKEN) {
      const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
      const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
      if (calc !== hash) return null;
    }
    const userRaw = params.get('user');
    return userRaw ? JSON.parse(userRaw) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ Room manager --

// Push an updated, per-viewer state to every socket in a room.
const rooms = new RoomManager((roomId) => {
  const room = rooms.getRoom(roomId);
  if (!room) return;
  for (const p of room.players) {
    if (p.socketId) {
      io.to(p.socketId).emit('state', rooms.publicState(roomId, p.id));
    }
  }
});

// Map socketId -> { roomId, playerId } for disconnect handling.
const sessions = new Map();

io.on('connection', (socket) => {
  // ---- identify: derive a stable playerId from Telegram or a client uuid ---
  let identity = { id: null, name: 'Guest' };

  socket.on('auth', (payload = {}, cb = () => {}) => {
    const tgUser = verifyInitData(payload.initData);
    if (tgUser) {
      identity = {
        id: `tg_${tgUser.id}`,
        name: [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || tgUser.username || 'Player',
      };
    } else {
      // Fallback for browser testing.
      identity = {
        id: payload.clientId || `web_${socket.id}`,
        name: payload.name || 'Guest',
      };
    }
    cb({ ok: true, playerId: identity.id, name: identity.name });
  });

  // ---- create a room -------------------------------------------------------
  socket.on('createRoom', ({ maxPlayers } = {}, cb = () => {}) => {
    if (!identity.id) return cb({ error: 'NOT_AUTHED' });
    const room = rooms.createRoom(identity.id, identity.name, maxPlayers || 4);
    rooms.setSocket(room.id, identity.id, socket.id);
    sessions.set(socket.id, { roomId: room.id, playerId: identity.id });
    socket.join(room.id);
    cb({ ok: true, roomId: room.id, playerId: identity.id });
    rooms.onUpdate(room.id);
  });

  // ---- join a room ---------------------------------------------------------
  socket.on('joinRoom', ({ roomId } = {}, cb = () => {}) => {
    if (!identity.id) return cb({ error: 'NOT_AUTHED' });
    roomId = String(roomId || '').toUpperCase().trim();
    const res = rooms.addPlayer(roomId, identity.id, identity.name);
    if (res.error) return cb({ error: res.error });
    rooms.setSocket(roomId, identity.id, socket.id);
    sessions.set(socket.id, { roomId, playerId: identity.id });
    socket.join(roomId);
    cb({ ok: true, roomId, playerId: identity.id, rejoined: !!res.rejoined });
    rooms.onUpdate(roomId);
  });

  // ---- host starts the game ------------------------------------------------
  socket.on('startGame', (_ = {}, cb = () => {}) => {
    const s = sessions.get(socket.id);
    if (!s) return cb({ error: 'NO_SESSION' });
    const res = rooms.startGame(s.roomId, s.playerId);
    if (res.error) return cb({ error: res.error });
    cb({ ok: true });
  });

  // ---- place a bid ---------------------------------------------------------
  socket.on('bid', ({ value } = {}, cb = () => {}) => {
    const s = sessions.get(socket.id);
    if (!s) return cb({ error: 'NO_SESSION' });
    const res = rooms.placeBid(s.roomId, s.playerId, value | 0);
    if (res.error) return cb({ error: res.error });
    cb({ ok: true });
  });

  // ---- play a card ---------------------------------------------------------
  socket.on('playCard', ({ cardId, aceChoice } = {}, cb = () => {}) => {
    const s = sessions.get(socket.id);
    if (!s) return cb({ error: 'NO_SESSION' });
    const res = rooms.playCard(s.roomId, s.playerId, cardId, aceChoice || null);
    if (res.error) return cb({ error: res.error });
    cb({ ok: true });
  });

  // ---- request a fresh snapshot -------------------------------------------
  socket.on('sync', (_ = {}, cb = () => {}) => {
    const s = sessions.get(socket.id);
    if (!s) return cb({ error: 'NO_SESSION' });
    cb({ ok: true, state: rooms.publicState(s.roomId, s.playerId) });
  });

  socket.on('disconnect', () => {
    const s = sessions.get(socket.id);
    if (s) {
      rooms.handleDisconnect(s.roomId, s.playerId);
      sessions.delete(socket.id);
    }
  });
});

// --------------------------------------------------------------- Telegram ---

function setupBot() {
  if (!BOT_TOKEN) {
    console.warn('[bot] BOT_TOKEN not set — Telegram bot disabled (web still works).');
    return;
  }
  // Lazy require so local dev without the token still boots.
  const TelegramBot = require('node-telegram-bot-api');
  const bot = new TelegramBot(BOT_TOKEN, { polling: true });

  const appUrl = BASE_URL; // Mini App URL configured in BotFather points here.

  bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const startParam = (match && match[1] || '').trim();
    const url = startParam ? `${appUrl}?startapp=${encodeURIComponent(startParam)}` : appUrl;

    bot.sendMessage(chatId, '🃏 *Welcome to BISCA!*\nThe last player standing wins. Tap below to play.', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '▶️ Play BISCA', web_app: { url } }]],
      },
    }).catch((e) => console.error('[bot] send error', e.message));
  });

  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id,
      '*BISCA* — bid your tricks, win exactly what you called.\n' +
      '• 5 lives each. Miss your bid → lose 1 life per trick off.\n' +
      '• Suits: ♥ > ♦ > ♣ > ♠. Ace of Hearts can WIN or LOSE.\n' +
      '• Last player alive wins. /start to play.',
      { parse_mode: 'Markdown' });
  });

  bot.on('polling_error', (e) => console.error('[bot] polling', e.code || e.message));
  console.log('[bot] Telegram bot running via long polling.');
}

setupBot();

server.listen(PORT, () => {
  console.log(`🃏 BISCA server on port ${PORT}  (BASE_URL=${BASE_URL})`);
});
