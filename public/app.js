/* ==========================================================================
   BISCA — Client-Side Application (Socket.io + Telegram WebApp)
   
   WHAT THIS SCRIPT DOES:
   This file runs in the player's web browser (or inside the Telegram app).
   It manages the visual user interface (screens, buttons, cards, popups),
   handles user taps/clicks, and talks back-and-forth in real time with the 
   game server over an internet connection (using WebSockets).
   ========================================================================== */
'use strict';

/* --------------------------------------------------------- Telegram init -- */
// Check if the game is being opened inside the official Telegram messaging app.
// If it is, 'tg' gives us access to Telegram's native mobile features.
const tg = window.Telegram && window.Telegram.WebApp;

if (tg) {
  // Tell Telegram the web page has finished loading and is ready to display.
  tg.ready();
  
  // Expand the mini-app to take up the full height of the player's phone screen.
  tg.expand();
  
  // Set the top status bar and background colors to match our dark game theme.
  try { 
    tg.setHeaderColor('#0b0f1a'); 
    tg.setBackgroundColor('#070a12'); 
  } catch (_) {
    // If the user is on an older version of Telegram that doesn't support this, ignore the error.
  }
}

/* ----------------------------------------------------------- constants ---- */
// A dictionary (lookup table) translating suit names into their visual playing-card symbols.
const SUIT_SYMBOL = { 
  hearts: '♥', 
  diamonds: '♦', 
  clubs: '♣', 
  spades: '♠' 
};

// Suit hierarchy: ♥ > ♦ > ♣ > ♠ (same ranking as the engine)
const SUIT_RANK = { hearts: 4, diamonds: 3, clubs: 2, spades: 1 };

// Strength used ONLY to sort the hand (strongest → weakest).
// Ace of Hearts is treated as the absolute strongest card.
function handCardStrength(c) {
  if (!c) return -Infinity;                                   // hidden/blind cards → end
  if (c.suit === 'hearts' && c.value === 1) return Infinity;  // Ace of Hearts = strongest
  return SUIT_RANK[c.suit] * 100 + c.value;                   // suit dominates, then value
}

// Descending comparator (strongest first)
function compareCardsDesc(a, b) {
  return handCardStrength(b) - handCardStrength(a);
}

// "state" is the memory of the app. It holds all current information about who is 
// playing, what room they are in, whose turn it is, and what is currently happening.
const state = {
  playerId: null,        // Unique ID assigned to this player by the server
  name: 'Guest',         // Player's display name
  roomId: null,          // Code of the room/match currently joined (e.g. "ABCD")
  pendingJoin: null,
  isHost: false,         // True if this player created the room (can start the game)
  last: null,            // Holds the most recent game snapshot sent from the server
  botUsername: '',       // The Telegram username of the game bot (used to make shareable links)
  selectedCount: 2,      // Default maximum player capacity when creating a room
  timerHandle: null,     // The internal clock reference that ticks down the turn timer every second
  currentDeadline: null, // The exact timestamp (in milliseconds) when the current turn expires
  isTrickResolving: false,    // True during the 1.5s window after a trick ends
  activeLastTrickKey: null,  // Tracks which trick has been shown so it doesn't loop
  hideLastTrick: false,      // True when the 1.5s window expires to wipe the cards
  trickTimer: null,          // Holds the setTimeout reference for clearing the trick
};

/* ----------------------------------------------------------- helpers ------ */
// Helper shortcut to find a single HTML element on the page (like a button or text box).
const $ = (sel) => document.querySelector(sel);

// Helper shortcut to find multiple HTML elements on the page as a list.
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/**
 * Changes the visible screen on the device.
 * Hides all other screens and shows only the one with the given 'id' (e.g., home, lobby, game).
 */
function showScreen(id) {
  $$('.screen').forEach((s) => s.classList.remove('active')); // Hide all screens
  $('#' + id).classList.add('active');                       // Show the requested screen
}

/**
 * Displays a small temporary notification message (a "toast") at the bottom of the screen.
 * Automatically disappears after a couple of seconds.
 */
function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden'); // Make the toast visible
  clearTimeout(el._t);           // Cancel any previous timer if a toast was already showing
  el._t = setTimeout(() => el.classList.add('hidden'), ms); // Hide after 'ms' milliseconds
}

/**
 * Triggers a phone vibration (haptic feedback) when played inside Telegram on mobile.
 * Gives tactile feedback for button clicks, wins, warnings, or errors.
 */
function haptic(type = 'light') {
  if (tg && tg.HapticFeedback) {
    try {
      if (type === 'success' || type === 'error' || type === 'warning') {
        tg.HapticFeedback.notificationOccurred(type);
      } else {
        tg.HapticFeedback.impactOccurred(type);
      }
    } catch (_) {}
  }
}

/**
 * Generates up to 2 uppercase initials from a player's name (e.g., "John Doe" becomes "JD").
 * Used to display on player profile icons/avatars.
 */
function initials(name) {
  return (name || '?')
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/**
 * Converts a player's remaining life points into heart emojis.
 * For example: 3 becomes "❤️❤️❤️". If 0 lives remain, returns a skull "💀".
 */
function hearts(n) { 
  return '❤️'.repeat(Math.max(0, n || 0)) || '💀'; 
}

/**
 * Generates or retrieves a unique persistent client ID for testing in a normal browser
 * outside of Telegram. It saves this ID in the browser's local memory so it survives page reloads.
 */
function clientId() {
  let id = localStorage.getItem('bisca_cid');
  if (!id) { 
    id = 'web_' + Math.random().toString(36).slice(2, 10); 
    localStorage.setItem('bisca_cid', id); 
  }
  return id;
}

/* ------------------------------------------------------------ socket ------ */
// Establish an active, live two-way internet connection (WebSocket) to the game server.
const socket = io({ transports: ['websocket', 'polling'] });

// When the device connects (or reconnects) to the server, send our login information.
socket.on('connect', () => authenticate());

// Whenever the server broadcasts an updated game state, re-draw the screen to reflect it.
socket.on('state', (s) => renderGame(s));

// If the internet connection drops, notify the player.
socket.on('disconnect', () => toast('Reconnecting…'));

/**
 * Sends authentication details to the server so it knows who is connecting.
 * If in Telegram, sends verified Telegram account data.
 * If in a desktop browser, sends a saved client ID.
 */
function authenticate() {
  const payload = tg
    ? { initData: tg.initData, name: tgName() }
    : { clientId: clientId(), name: state.name };

  // Send the "auth" message to the server
  socket.emit('auth', payload, (res) => {
    if (res && res.ok) {
      state.playerId = res.playerId;
      state.name = res.name;
      $('#my-name').textContent = res.name;

      // If the player clicked a shared link to join a specific room, join it automatically.
      maybeAutoJoin();
    }
  });
}

/**
 * Reads the user's real name from Telegram's secure data.
 * Falls back to username or "Player" if no name is set.
 */
function tgName() {
  const u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
  if (!u) return 'Guest';
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Player';
}

/**
 * Looks for an invite code attached to the link used to open the game 
 * (for example: https://t.me/bot?startapp=ROOM123).
 */
function startParam() {
  if (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) {
    return tg.initDataUnsafe.start_param;
  }
  const p = new URLSearchParams(location.search);
  return p.get('startapp') || p.get('tgWebAppStartParam') || null;
}

/**
 * Automatically joins a game room if an invite code was found in the link.
 */
function maybeAutoJoin() {
  // Prefer a code captured at startup; fall back to reading the link now
  const room = state.pendingJoin || startParam();
  if (room) {
    state.pendingJoin = room;   // keep it in case the first attempt is too early
    doJoin(room);
  }
}


/* --------------------------------------------------------- config fetch --- */
// Asks the server for general app configuration settings (like the Telegram Bot's username).
fetch('/config')
  .then((r) => r.json())
  .then((c) => { state.botUsername = c.botUsername || ''; })
  .catch(() => {});

/* ========================================================== HOME =========== */
// HOME SCREEN: When the player taps "Create Game", prepare the player-count picker and show create screen.
$('#btn-create').onclick = () => { 
  haptic(); 
  buildCountGrid(); 
  showScreen('screen-create'); 
};

// HOME SCREEN: When the player taps "Join Game", read the text box and join the room.
$('#btn-join').onclick = () => {
  const code = $('#input-room').value.trim().toUpperCase();
  if (code.length < 4) return toast('Enter a valid room code');
  doJoin(code);
};

// Automatically convert whatever the player types in the room code box into UPPERCASE letters.
$('#input-room').addEventListener('input', (e) => { 
  e.target.value = e.target.value.toUpperCase(); 
});

// HOME SCREEN: When the player taps "Rules", open the how-to-play popup.
$('#btn-rules').onclick = showRules;

// Any button marked with "data-back" will take the player back to the Home screen.
$$('[data-back]').forEach((b) => (b.onclick = () => { 
  haptic(); 
  showScreen('screen-home'); 
}));

/* ========================================================= CREATE ========== */
/**
 * Builds the selectable grid of numbers (from 2 to 8) on the Create Game screen,
 * allowing the host to choose the maximum number of players for the match.
 */
function buildCountGrid() {
  const grid = $('#player-count-grid');
  grid.innerHTML = ''; // Clear out any existing buttons

  for (let n = 2; n <= 8; n++) {
    const cell = document.createElement('div');
    cell.className = 'count-cell' + (n === state.selectedCount ? ' selected' : '');
    cell.textContent = n;
    
    // When a number is clicked, highlight it and remember the chosen number
    cell.onclick = () => {
      state.selectedCount = n;
      haptic();
      $$('.count-cell').forEach((c) => c.classList.remove('selected'));
      cell.classList.add('selected');
    };
    grid.appendChild(cell);
  }
}

// CREATE SCREEN: When host confirms room creation, tell the server to create it.
$('#btn-create-confirm').onclick = () => {
  socket.emit('createRoom', { maxPlayers: state.selectedCount }, (res) => {
    if (res.error) return toast('Error: ' + res.error);
    state.roomId = res.roomId; 
    state.isHost = true;
    haptic('success');
  });
};

/* ========================================================== JOIN =========== */
/**
 * Sends a request to the server to join an existing game room using its code.
 */
function doJoin(roomId, attempt = 0) {
  // If the socket isn't connected yet, wait and try again shortly
  if (!socket.connected || !state.playerId) {
    if (attempt < 10) {
      return setTimeout(() => doJoin(roomId, attempt + 1), 400);
    }
  }

  socket.emit('joinRoom', { roomId }, (res) => {
    if (res && res.error) {
      // Room may not be registered on the server for a brief moment — retry a few times
      if (res.error === 'ROOM_NOT_FOUND' && attempt < 5) {
        return setTimeout(() => doJoin(roomId, attempt + 1), 600);
      }
      return toast(joinError(res.error));
    }
    state.roomId = res.roomId;
    state.pendingJoin = null;   // success → stop retrying
    haptic('success');
  });
}

/**
 * Translates technical error codes from the server into friendly sentences for the user.
 */
function joinError(code) {
  return ({
    ROOM_NOT_FOUND: 'Room not found',
    ROOM_FULL: 'Room is full',
    GAME_IN_PROGRESS: 'Game already started',
  })[code] || code;
}

/* ========================================================= LOBBY =========== */
// LOBBY SCREEN: When the host clicks "Start Game", send the start command to the server.
$('#btn-start').onclick = () => socket.emit('startGame', {}, (res) => { 
  if (res.error) toast(res.error); 
});

// LOBBY SCREEN: Copy the 4-letter room code to the device's clipboard.
$('#btn-copy').onclick = () => {
  navigator.clipboard && navigator.clipboard.writeText(state.roomId);
  toast('Room code copied');
};

// LOBBY SCREEN: Open Telegram's friend-picker/share dialog so the player can invite others.
$('#btn-invite').onclick = () => {
  const link = inviteLink();
  const text = `Join my BISCA game! Code: ${state.roomId}`;
  
  if (tg && tg.openTelegramLink && state.botUsername) {
    // Open Telegram's share sheet with pre-filled message and link
    const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
    tg.openTelegramLink(share);
  } else if (tg && tg.switchInlineQuery) {
    // Alternate Telegram sharing method
    tg.switchInlineQuery(state.roomId, ['users', 'groups']);
  } else {
    // If running in a regular web browser, just copy the link to clipboard
    navigator.clipboard && navigator.clipboard.writeText(link);
    toast('Invite link copied');
  }
};

/**
 * Builds the URL link that other people can click to directly join this game room.
 */
function inviteLink() {
  if (state.botUsername) return `https://t.me/${state.botUsername}/app?startapp=${state.roomId}`;
  return `${location.origin}/?startapp=${state.roomId}`;
}

/**
 * Redraws the Lobby screen UI whenever player lists or room info change.
 * Displays all joined players, online/offline status, host badge, and the Start button.
 */
function renderLobby(s) {
  $('#lobby-code').textContent = s.id;
  $('#lobby-count').textContent = `${s.players.length}/${s.maxPlayers}`;
  
  // Render the list of players currently inside the room
  const list = $('#lobby-players');
  list.innerHTML = '';
  s.players.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="avatar">${initials(p.name)}</span>
      <span class="pl-name">${escapeHtml(p.name)}${p.isSelf ? ' (you)' : ''}</span>
      ${p.isHost ? '<span class="tag-host">HOST</span>' : ''}
      <span class="dot ${p.connected ? '' : 'off'}"></span>`;
    list.appendChild(li);
  });

  // Check if I am the host of this room
  const meHost = s.hostId === state.playerId;
  state.isHost = meHost;
  
  // Game requires at least 2 players to start
  const canStart = meHost && s.players.length >= 2;
  const btn = $('#btn-start');
  btn.style.display = meHost ? '' : 'none'; // Only the host sees the Start button
  btn.disabled = !canStart;

  // Informative helper text at the bottom of the lobby
  $('#lobby-hint').textContent = meHost
    ? (canStart ? `Ready! ${s.players.length} players joined.` : 'Waiting for at least 2 players…')
    : 'Waiting for the host to start…';
}

/* =========================================================== GAME =========== */
/**
 * THE MAIN GAME RENDER FUNCTION:
 * This runs every time the server sends new game information (state 's').
 * It updates everything the player sees: turn indicator, cards in hand,
 * cards on the table, opponents' lives, and prompts for bids/actions.
 */
function renderGame(s) {
  state.last = s;
  state.roomId = s.id;

  // If the game has not started yet and is still in the lobby, show the lobby screen instead
  if (s.phase === 'lobby') { 
    showScreen('screen-lobby'); 
    renderLobby(s); 
    return; 
  }

  // Switch display to the active gameplay screen
  showScreen('screen-game');
  const me = s.players.find((p) => p.isSelf) || {};

  // 1. Heads-Up Display (HUD): Update round number, cards dealt this round, and whose turn it is
  $('#hud-round').textContent = s.roundNumber;
  $('#hud-cards').textContent = s.cardsThisRound;
  const turnName = s.currentTurnId
    ? (s.players.find((p) => p.id === s.currentTurnId) || {}).name || '—'
    : '—';
  $('#hud-turn').textContent = s.currentTurnId === state.playerId ? 'YOU' : turnName;
  
  // Start/update the countdown timer for the current player's turn
  startTimer(s.turnDeadline);

  // 2. Blind Banner: Show special banner during 1-card "Blind" rounds (unless round/game ended)
  $('#blind-banner').classList.toggle('hidden', !s.blind || s.phase === 'roundEnd' || s.phase === 'gameOver');

  // 3. Draw opponents' status around the table
  renderOpponents(s, me);

  // 4. Draw the cards played in the center of the table (the trick)
  renderTrick(s);

  // 5. Update my own personal status bar (name, dealer icon, remaining lives, bid vs won)
  $('#my-name').textContent = (me.name || 'You') + (s.dealerId === me.id ? ' 🎴' : '');
  $('#my-lives').textContent = hearts(me.lives);
  const bidEl   = $('#my-bid');
  const bidVal  = me.bid;
  const wonVal  = me.tricksWon || 0;

  if (bidVal == null) {
    // Not bid yet → neutral
    bidEl.className = 'bid-badge pending';
    bidEl.innerHTML = `🎯 <b>–</b><span class="bid-sep">·</span>🏆 <b>${wonVal}</b>`;
  } else {
    const met  = wonVal === bidVal;
    const diff = bidVal - wonVal;
    const hint = met ? '✓ on target'
               : diff > 0 ? `+${diff} to go`
               : `${Math.abs(diff)} over`;
    bidEl.className = 'bid-badge ' + (met ? 'met' : 'missing');
    bidEl.innerHTML =
      `🎯 <b>${bidVal}</b><span class="bid-sep">·</span>🏆 <b>${wonVal}</b>`;
  }

  // 6. Draw my playable cards at the bottom of the screen
  renderHand(s, me);

  // 7. Check if a popup needs to be shown (bidding choice, round summary, or game over)
  handlePhase(s, me);
}

/**
 * Draws all opponent players at the top of the screen:
 * shows their name, avatar, remaining lives (hearts), bid vs won tricks, and cards.
 */
function renderOpponents(s, me) {
  const wrap = $('#opponents');
  wrap.innerHTML = '';
  
  // Filter out myself so we only render other players
  s.players.filter((p) => !p.isSelf).forEach((p) => {
    const el = document.createElement('div');
    el.className = 'opp' + (p.id === s.currentTurnId ? ' turn' : '') + (p.eliminated ? ' dead' : '');
    
    // Draw opponents' cards
    let cardsHtml = '';
    for (let i = 0; i < p.handCount; i++) {
      const c = p.hand?.[i];
      if (c) cardsHtml += miniCard(c);            // In blind round: opponents' cards are visible to you!
      else cardsHtml += '<div class="mini-card"></div>'; // In normal round: opponent cards are face down
    }
    
    el.innerHTML = `
      ${p.connected ? '' : '<span class="opp-offline">offline</span>'}
      <div class="avatar">${initials(p.name)}</div>
      <div class="opp-name">${escapeHtml(p.name)}${p.isHost ? ' 👑' : ''}</div>
      <div class="opp-lives">${hearts(p.lives)}</div>
      ${oppBidBadge(p)}
      <div class="opp-cards">${cardsHtml}</div>`;
    wrap.appendChild(el);
  });
}

/**
 * Builds the compact colored Bid/Won badge for an opponent.
 * Green = on target (bid === won), Orange = off target, empty = not bid yet.
 */
function oppBidBadge(p) {
  if (p.bid == null) return '<div class="opp-bid"></div>'; // not bid yet → nothing
  const won = p.tricksWon || 0;
  const met = won === p.bid;
  const cls = met ? 'met' : 'missing';
  return `<div class="opp-bid opp-badge ${cls}">
    🎯${p.bid}<span class="opp-sep">·</span>🏆${won}
  </div>`;
}

/**
 * Helper that generates the HTML for a tiny card face (used for opponents' hands).
 */
function miniCard(c) {
  return `<div class="mini-card face suit-${c.suit}">${c.value}${SUIT_SYMBOL[c.suit]}</div>`;
}

/**
 * Generates a unique fingerprint for a completed trick based on round, cards, and winner.
 */
function getTrickKey(s) {
  if (!s.lastTrick || !s.lastTrick.plays) return null;
  const cardIds = s.lastTrick.plays
    .map((p) => (p.card ? `${p.card.suit}_${p.card.value}` : 'x'))
    .join('-');
  return `r${s.roundNumber}_${cardIds}_w:${s.lastTrick.winnerName}`;
}

/**
 * Draws the middle of the table (the "trick" area) where played cards appear.
 * Shows all cards for 1.5s upon trick completion, then clears them so the next trick can start.
 */
function renderTrick(s) {
  const area = $('#trick-area');
  const msg = $('#table-msg');
  area.innerHTML = '';

  let plays = [];
  let isLast = false;

  // 1. If cards are actively being played in the current trick
  if (s.currentTrick && s.currentTrick.length > 0) {
    plays = s.currentTrick;
    state.isTrickResolving = false;
    state.hideLastTrick = false;
    clearTimeout(state.trickTimer);
  } 
  // 2. If currentTrick is empty and lastTrick exists, the trick just concluded
  else if (s.lastTrick && s.lastTrick.plays && s.lastTrick.plays.length > 0) {
    const trickKey = getTrickKey(s);

    // If this is a newly completed trick we haven't timed yet:
    if (state.activeLastTrickKey !== trickKey) {
      state.activeLastTrickKey = trickKey;
      state.isTrickResolving = true;
      state.hideLastTrick = false;

      // Start the 1.5-second (1500 ms) timer
      clearTimeout(state.trickTimer);
      state.trickTimer = setTimeout(() => {
        state.isTrickResolving = false;
        state.hideLastTrick = true; // Mark cards as ready to disappear

        // Re-render the game: cards vanish and the winner's hand unlocks
        if (state.last) {
          renderGame(state.last);
        }
      }, 2000);
    }

    // Show cards if we are still within the 1.5s window
    if (!state.hideLastTrick) {
      plays = s.lastTrick.plays;
      isLast = true;
    }
  }

  // Render the cards in the center of the table (or nothing if cleared)
  plays.forEach((pl) => {
    const div = document.createElement('div');
    div.className = 'trick-play';
    div.innerHTML = `${bigCard(pl.card, pl.aceChoice)}<span class="trick-name">${escapeHtml(pl.name)}</span>`;
    area.appendChild(div);
  });

  // Display contextual status message
  if (isLast && s.lastTrick) {
    msg.textContent = `${s.lastTrick.winnerName} won the trick!`;
  } else if (!plays.length && s.phase === 'betting') {
    msg.textContent = 'Waiting for bids…';
  } else if (!plays.length && s.phase === 'playing') {
    // Message displayed during the clean table state before the leader plays
    const leader = s.players.find((p) => p.id === s.currentTurnId);
    msg.textContent = leader ? `Waiting for ${leader.isSelf ? 'you' : leader.name} to lead…` : '';
  } else {
    msg.textContent = '';
  }
}

/**
 * Helper that generates the HTML for a full-sized card (corners, suit icon, number).
 * If the card is an Ace of Hearts with a declared power, it also displays a "WINS" or "LOSES" badge.
 */
function bigCard(c, aceChoice) {
  const sym = SUIT_SYMBOL[c.suit];
  const ace = aceChoice ? `<span class="ace-badge">${aceChoice === 'win' ? 'WINS' : 'LOSES'}</span>` : '';
  return `<div class="card ${c.suit}">
      <div class="corner">${c.value}<br>${sym}</div>
      <div class="pip">${sym}</div>
      <div class="corner br">${c.value}<br>${sym}</div>${ace}
    </div>`;
}

/**
 * Draws the player's own hand of cards at the bottom of the screen.
 * Highlights playable cards when it is the player's turn to play.
 */
function renderHand(s, me) {
  const hand = $('#hand');
  hand.innerHTML = '';
  const myTurn = s.currentTurnId === state.playerId && 
                 s.phase === 'playing' && 
                 !state.isTrickResolving; // Locks interaction while viewing trick results

  const sortedHand = (me.hand || []).slice().sort(compareCardsDesc);
  sortedHand.forEach((c) => {
    const el = document.createElement('div');
    if (!c) {
      // In a 1-card "Blind" round, your own card is hidden from you with a monkey emoji
      el.className = 'card back small';
      el.innerHTML = '🙈';
    } else {
      // Normal card: show its value and suit
      el.className = `card ${c.suit}` + (myTurn ? ' playable' : ' disabled');
      const sym = SUIT_SYMBOL[c.suit];
      el.innerHTML = `<div class="corner">${c.value}<br>${sym}</div>
        <div class="pip">${sym}</div>
        <div class="corner br">${c.value}<br>${sym}</div>`;
      
      // Clicking a card when it's your turn attempts to play it
      if (myTurn) el.onclick = () => attemptPlay(c);
    }
    hand.appendChild(el);
  });

  // During a blind round, the player still needs to tap their face-down card to play it
  if (s.blind && myTurn && me.handCount > 0) {
    hand.querySelectorAll('.card.back').forEach((el) => {
      el.classList.remove('disabled');
      el.onclick = () => attemptPlayBlind();
    });
  }
}

/* --------------------------------------------------------- interactions --- */
/**
 * Called when a player clicks one of their normal cards to play it.
 * If the card is the special Ace of Hearts, prompts them to choose WINS or LOSES.
 * Otherwise, immediately tells the server to play the card.
 */
function attemptPlay(card) {
  if (card.suit === 'hearts' && card.value === 1) {
    return openAceModal(card); // Ace of Hearts requires choosing power
  }
  socket.emit('playCard', { cardId: card.id, aceChoice: null }, afterPlay);
}

/**
 * Called when playing a card in the 1-card Blind round (where the player can't see their card).
 */
function attemptPlayBlind() {
  socket.emit('playCard', { cardId: '__blind__', aceChoice: null }, (res) => {
    // 1. If the server tells us our blind card happens to be the Ace of Hearts,
    // open the special modal asking whether we want it to WIN or LOSE.
    if (res && res.error === 'ACE_CHOICE_REQUIRED') {
      haptic('warning');
      return openBlindAceModal();
    }
    // 2. If the card was somehow out of sync with the server, refresh state
    if (res && res.error === 'CARD_NOT_IN_HAND') {
      socket.emit('sync', {}, () => {});
      return toast('Syncing card… please tap again');
    }

    afterPlay(res);
  });
}

/**
 * Callback handling the server's response after a card play request.
 * Vibrates the phone with success or shows an error message.
 */
function afterPlay(res) {
  if (res && res.error) { 
    toast(playError(res.error)); 
    haptic('error'); 
  } else { 
    haptic('light'); 
  }
}

/**
 * Translates technical card-play errors into clear messages.
 */
function playError(code) {
  return ({ 
    NOT_YOUR_TURN: 'Not your turn', 
    ACE_CHOICE_REQUIRED: 'Choose WIN or LOSE',
    CARD_NOT_IN_HAND: 'Card unavailable' 
  })[code] || code;
}

/* =========================================================== MODALS ======== */
/**
 * Creates and displays a popup window (modal) over the screen with the given HTML content.
 */
function modal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-overlay"><div class="modal">${html}</div></div>`;
  return root.querySelector('.modal');
}

/**
 * Closes and removes any currently open popup window.
 */
function closeModal() { 
  $('#modal-root').innerHTML = ''; 
}

let currentModalKey = null; // Remembers which modal is currently open so it doesn't re-open repeatedly

/**
 * Decides whether a popup window needs to be shown based on what phase the game is currently in.
 */
function handlePhase(s, me) {
  // PHASE: BETTING/BIDDING
  // If it is my turn to bid and I have not bid yet, open the bidding screen
  if (s.phase === 'betting' && s.currentTurnId === state.playerId && me.bid == null) {
    const key = 'bid-' + s.roundNumber + '-' + me.tricksWon;
    if (currentModalKey !== key) { 
      currentModalKey = key; 
      openBidModal(s); 
    }
    return;
  }
  
  // PHASE: ROUND END
  // Show the score summary table explaining who lost lives
  if (s.phase === 'roundEnd' && s.roundSummary) {
    // If the last trick is still in its 1.5s showcase, defer the summary modal
    if (state.isTrickResolving) {
      return;
    }
    const key = 'sum-' + s.roundNumber;
    if (currentModalKey !== key) { 
      currentModalKey = key; 
      openSummaryModal(s); 
    }
    return;
  }
  
  // PHASE: GAME OVER
  // Show the winner celebration screen
  if (s.phase === 'gameOver') {
    if (currentModalKey !== 'over') { 
      currentModalKey = 'over'; 
      openGameOverModal(s); 
    }
    return;
  }
  
  // Close any temporary popups once their phase has passed
  if (['bid', 'sum'].includes(currentModalKey?.split('-')[0])) { 
    closeModal(); 
    currentModalKey = null; 
  }
  if (s.phase === 'playing' && currentModalKey && currentModalKey.startsWith('bid')) { 
    closeModal(); 
    currentModalKey = null; 
  }
}

/**
 * Displays the Bidding Modal where the player predicts how many tricks they will win.
 * - In Blind rounds: shows opponents' cards so you can deduce your chances.
 * - In Normal rounds: shows your own cards.
 * - Enforces the "Forbidden Bid" rule for the last bidder (total bids cannot equal total tricks).
 */
function openBidModal(s) {
  const me = s.players.find((p) => p.isSelf) || {};
  const max = s.cardsThisRound;
  const forbidden = s.forbiddenBid;

  let cardsHtml = '';

  if (s.blind) {
    // --- 1-CARD BLIND ROUND ---
    // You cannot see your own card, so the popup shows all opponents' visible cards instead!
    const oppCards = s.players
      .filter((p) => !p.isSelf && !p.eliminated)
      .map((p) => {
        const c = p.hand && p.hand[0];
        const cardView = c ? bigCard(c) : '<div class="card back small">?</div>';
        return `
          <div style="display:flex; flex-direction:column; align-items:center; gap:4px;">
            <span style="font-size:12px; font-weight:600;">${escapeHtml(p.name)}</span>
            ${cardView}
          </div>`;
      })
      .join('');

    cardsHtml = `
      <p class="sub" style="margin: 6px 0 10px; color: #f59e0b;">
        🙈 <b>Blind Round:</b> You can't see your card. Here are your opponents':
      </p>
      <div class="modal-cards" style="display:flex; justify-content:center; gap:12px; margin-bottom:14px; flex-wrap:wrap;">
        ${oppCards}
      </div>`;
  } else if (me.hand && me.hand.length) {
    // --- NORMAL ROUNDS (2 to 5 cards) ---
    // Show your own cards inside the popup for easy reference while choosing a bid
    const cards = me.hand
    .filter(Boolean)
    .slice()                 // copy → don't mutate the real hand
    .sort(compareCardsDesc)  // strongest → weakest (Ace♥ first)
    .map((c) => bigCard(c))
    .join('');
      cardsHtml = `
        <div class="modal-cards" style="display:flex; justify-content:center; gap:8px; margin:14px 0; flex-wrap:wrap;">
          ${cards}
        </div>`;
  }

  // Build the clickable number buttons (from 0 up to max possible tricks this round)
  let cells = '';
  for (let n = 0; n <= max; n++) {
    const bad = forbidden === n;
    cells += `<div class="bid-cell ${bad ? 'forbidden' : ''}" data-bid="${n}">${n}</div>`;
  }

  // Create the modal popup HTML
  const el = modal(`
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
      <h2 style="margin:0;">Your Bid</h2>
      <div id="bid-modal-timer" style="font-size:14px; font-weight:700; background:rgba(255,255,255,0.12); padding:4px 10px; border-radius:12px; color:#f3f4f6; display:inline-flex; align-items:center; gap:4px;">
        ⏱️ <span class="time-sec">—</span>
      </div>
    </div>
    <p class="sub">How many tricks will you win? (0–${max})</p>
    ${cardsHtml}
    <div class="bid-grid">${cells}</div>
    ${forbidden != null ? `<p class="forbidden-note">You're last: you cannot bid ${forbidden}.</p>` : ''}
  `);

  // Update the timer displayed inside the bidding popup immediately
  updateTimerUI();

  // Attach click events to each number button
  el.querySelectorAll('.bid-cell').forEach((cell) => {
    if (cell.classList.contains('forbidden')) return; // Disable the forbidden bid number
    cell.onclick = () => {
      const value = parseInt(cell.dataset.bid, 10);
      // Send the chosen bid to the server
      socket.emit('bid', { value }, (res) => {
        if (res.error) { 
          toast(res.error === 'ILLEGAL_BID' ? 'That bid is not allowed' : res.error); 
          haptic('error'); 
        } else { 
          closeModal(); 
          currentModalKey = null; 
          haptic('success'); 
        }
      });
    };
  });
}

/**
 * Opens a popup when the player plays the Ace of Hearts (1♥).
 * Lets the player declare its power for the trick:
 * - "WINS": Beats every other card in the trick.
 * - "LOSES": Loses to every other card in the trick.
 */
function openAceModal(card) {
  const el = modal(`
    <h2>Ace of Hearts ♥</h2>
    <p class="sub">Declare its power for this trick.</p>
    <div class="ace-choices">
      <button class="ace-btn ace-win">👑 WINS<br><small>beats everything</small></button>
      <button class="ace-btn ace-lose">🪫 LOSES<br><small>loses to all</small></button>
    </div>
  `);
  el.querySelector('.ace-win').onclick = () => sendAce(card, 'win');
  el.querySelector('.ace-lose').onclick = () => sendAce(card, 'lose');
}

/**
 * Sends the Ace of Hearts play along with the chosen power ("win" or "lose") to the server.
 */
function sendAce(card, choice) {
  socket.emit('playCard', { cardId: card.id, aceChoice: choice }, (res) => {
    closeModal();
    afterPlay(res);
  });
}

/**
 * Opens the choice modal if the player's secret card in the 1-card Blind round
 * turns out to be the Ace of Hearts.
 */
function openBlindAceModal() {
  const el = modal(`
    <h2>🃏 Ace of Hearts ♥!</h2>
    <p class="sub">Surprise! Your blind card is the Ace of Hearts. Choose its power for this trick:</p>
    <div class="ace-choices">
      <button class="ace-btn ace-win">👑 WINS<br><small>beats everything</small></button>
      <button class="ace-btn ace-lose">🪫 LOSES<br><small>loses to all</small></button>
    </div>
  `);
  el.querySelector('.ace-win').onclick = () => sendBlindAce('win');
  el.querySelector('.ace-lose').onclick = () => sendBlindAce('lose');
}

/**
 * Sends the blind Ace of Hearts choice ("win" or "lose") to the server.
 */
function sendBlindAce(choice) {
  socket.emit('playCard', { cardId: '__blind__', aceChoice: choice }, (res) => {
    closeModal();
    afterPlay(res);
  });
}

/**
 * Displays the Round Summary popup at the end of every round.
 * Shows a scoreboard table: each player's bid, how many tricks they won,
 * how many lives they lost, and their remaining lives.
 */
function openSummaryModal(s) {
  const me = s.players.find((p) => p.isSelf) || {};
  const myName = me.name;

  // Rank players: most lives first; eliminated sink to the bottom,
  // ties broken by fewest lives lost this round.
  const ranked = s.roundSummary
    .slice()
    .sort((a, b) => (b.lives - a.lives) || (a.lost - b.lost));

  const medals = ['🥇', '🥈', '🥉'];

  let rows = '';
  ranked.forEach((r, i) => {
    const out    = r.lives <= 0;
    const isSelf = myName != null && r.name === myName;
    const safe   = r.lost === 0;
    const rank   = out ? '💀' : (medals[i] || `${i + 1}`);
    const delta    = safe ? '✓ safe' : `−${r.lost} ❤️`;
    const deltaCls = safe ? 'ok' : 'neg';

    rows += `
      <tr class="sum-row ${out ? 'row-out' : ''} ${isSelf ? 'row-self' : ''}">
        <td class="sum-rank">${rank}</td>
        <td class="sum-name">${escapeHtml(r.name)}${isSelf ? '<span class="you-tag">YOU</span>' : ''}</td>
        <td class="sum-target">
          <span class="chip">🎯 ${r.bid}</span>
          <span class="chip ${safe ? 'chip-hit' : 'chip-miss'}">🏆 ${r.won}</span>
        </td>
        <td class="sum-delta ${deltaCls}">${delta}</td>
        <td class="sum-lives">${hearts(r.lives)}</td>
      </tr>`;
  });

  modal(`
    <h2>Round ${s.roundNumber} Results</h2>
    <p class="sub">🎯 Bid = 🏆 Won → <b>safe</b>. Else −1 ❤️ per trick off.</p>
    <table class="summary-table">
      <thead>
        <tr>
          <th>#</th>
          <th style="text-align:left">Player</th>
          <th>Bid / Won</th>
          <th>Δ</th>
          <th>Lives</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="sub">Next round starting…</p>
  `);
  haptic('warning');
}

/**
 * Displays the Game Over popup when only one player remains alive.
 * Shows the winner's name, a victory crown, and a "Play Again" button.
 */
function openGameOverModal(s) {
  const won = s.winnerId === state.playerId;
  modal(`
    <div class="podium">
      <div class="crown">${won ? '🏆' : '👑'}</div>
      <h2>${won ? 'You Win!' : 'Game Over'}</h2>
      <div class="winner-name">${escapeHtml(s.winnerName || '—')}</div>
      <p class="sub">is the last player standing.</p>
      <button class="btn btn-primary btn-lg btn-block" onclick="location.reload()">🔁 Play Again</button>
    </div>
  `);
  haptic('success');
  if (tg && tg.HapticFeedback && won) {
    tg.HapticFeedback.notificationOccurred('success');
  }
}

/* ------------------------------------------------------------- rules ------ */
/**
 * Opens a complete, scrollable explanation popup of the BISCA rules.
 */
function showRules() {
  modal(`
    <h2>🃏 How to Play BISCA</h2>
    <ul class="rules-list" style="max-height: 60vh; overflow-y: auto; padding-right: 8px; margin-bottom: 16px;">
      <li><b>Objective:</b> Be the last player standing! Everyone starts with <b>5 Lives (❤️)</b>. Reach 0 lives and you are eliminated.</li>
      
      <li><b>Deck:</b> Standard 40-card deck (cards 1 to 10 for each of the 4 suits).</li>
      
      <li><b>Card Strength (Suit First, Then Rank):</b>
        <br>• <b>Suits:</b> ♥️ &gt; ♦️ &gt; ♣️ &gt; ♠️. A higher suit <i>always</i> beats a lower suit (e.g., 2♥️ beats 10♦️).
        <br>• <b>Numbers:</b> A higher number beats a lower number (e.g., 8 beats 3) — compared <i>only</i> when cards share the same suit.
      </li>

      <li><b>Special Card – Ace of Hearts (1♥️):</b>
        <br>When played, you decide on the spot:
        <br>• <b>"WINS":</b> Beats every card in the trick.
        <br>• <b>"LOSES":</b> Loses to every card in the trick.
      </li>

      <li><b>Round Structure:</b>
        <br>Hand sizes decrease each round:
        <br><b>5 ➔ 4 ➔ 3 ➔ 2 ➔ 1</b> cards.
        <br>Then loop back to <b>5</b> until only one survivor remains!
      </li>

      <li><b>Phase 1: Bidding:</b>
        <br>Each player declares how many tricks they expect to win (from 0 up to their hand size).
        <br>⚠️ <i>Last Player Rule:</i> The last bidder cannot pick a number that makes total bids equal the number of tricks in play. Someone <b>must</b> fail!
      </li>

      <li><b>Phase 2: Taking Tricks:</b>
        <br>The first player leads a card, and everyone plays one card clockwise. The strongest card takes the trick and leads the next one.
      </li>

      <li><b>Phase 3: Life Calculation:</b>
        <br>• <b>Exact Bid:</b> Safe! You lose 0 lives.
        <br>• <b>Missed Bid:</b> Lose <b>1 Life (❤️) per trick difference</b> (whether you took too many or too few).
      </li>

      <li><b>Special 1-Card Round ("Blind"):</b>
        <br>Look at other players' cards!
        <br>Everyone bids 0 or 1 (the last bidder restriction still applies), cards are played, and lives are lost.
      </li>
    </ul>
    <button class="btn btn-primary btn-block" onclick="document.getElementById('modal-root').innerHTML=''">Got it! 👍</button>
  `);
}

/* ------------------------------------------------------------- timer ------ */
/**
 * Calculates remaining seconds until the turn deadline and updates the countdown clock on screen.
 * If 10 seconds or fewer remain, turns the timer RED to warn the player.
 */
function updateTimerUI() {
  const hud = $('#hud-timer');
  const modalTimer = $('#bid-modal-timer');
  const modalTimerSec = modalTimer ? modalTimer.querySelector('.time-sec') : null;

  // If no deadline is active, clear out timer indicators
  if (!state.currentDeadline) {
    if (hud) { hud.textContent = '—'; hud.classList.remove('low'); }
    if (modalTimerSec) { modalTimerSec.textContent = '—'; modalTimer.classList.remove('low'); }
    return;
  }

  // Calculate remaining seconds
  const left = Math.max(0, Math.ceil((state.currentDeadline - Date.now()) / 1000));
  const isLow = left <= 10; // True if 10 seconds or less remain

  // 1. Update the background HUD timer at the top of the game screen
  if (hud) {
    hud.textContent = left;
    hud.classList.toggle('low', isLow);
  }

  // 2. Update the timer inside the Bidding popup (if open)
  if (modalTimer) {
    if (modalTimerSec) modalTimerSec.textContent = `${left}s`;
    modalTimer.classList.toggle('low', isLow);
    if (isLow) {
      modalTimer.style.color = '#ef4444'; // Red color
      modalTimer.style.background = 'rgba(239, 68, 68, 0.2)';
    } else {
      modalTimer.style.color = '#f3f4f6';
      modalTimer.style.background = 'rgba(255, 255, 255, 0.12)';
    }
  }

  // When timer reaches zero, stop the clock interval
  if (left <= 0) {
    clearInterval(state.timerHandle);
  }
}

/**
 * Starts or resets the turn countdown clock with a new target deadline timestamp.
 */
function startTimer(deadline) {
  state.currentDeadline = deadline;
  clearInterval(state.timerHandle); // Stop any previous timer
  updateTimerUI();                  // Run immediately once
  if (deadline) {
    // Run updateTimerUI every 1000 milliseconds (1 second)
    state.timerHandle = setInterval(updateTimerUI, 1000);
  }
}

/* ------------------------------------------------------------- utils ------ */
/**
 * Security helper: escapes dangerous characters (like <, >, &) in player names
 * to prevent malicious code injection (XSS attacks) from breaking the page.
 */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ 
    '&': '&amp;', 
    '<': '&lt;', 
    '>': '&gt;', 
    '"': '&quot;', 
    "'": '&#39;' 
  }[c]));
}

/* Telegram Native Back-Button Integration */
// Connects Telegram's native top-left back button so that tapping it:
// 1. Closes any open modal/popup first, OR
// 2. Navigates back to the home screen (unless mid-game).
if (tg && tg.BackButton) {
  tg.BackButton.onClick(() => {
    // If a popup is open, close it
    if ($('#modal-root').innerHTML) { 
      closeModal(); 
      return; 
    }
    // Prevent accidentally exiting during an active match
    if ($('#screen-game').classList.contains('active')) return;
    
    // Otherwise return to the home screen
    showScreen('screen-home');
    tg.BackButton.hide();
  });
}

/* Capture invite code as early as possible */
(function captureInviteEarly() {
  const room = startParam();
  if (room) state.pendingJoin = room;
})();
