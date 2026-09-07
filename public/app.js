/* ==========================================================================
   BISCA — client (Socket.io + Telegram WebApp)
   ========================================================================== */
'use strict';

/* --------------------------------------------------------- Telegram init -- */
const tg = window.Telegram && window.Telegram.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  try { tg.setHeaderColor('#0b0f1a'); tg.setBackgroundColor('#070a12'); } catch (_) {}
}

/* ----------------------------------------------------------- constants ---- */
const SUIT_SYMBOL = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
const state = {
  playerId: null,
  name: 'Guest',
  roomId: null,
  isHost: false,
  last: null,          // last public state
  botUsername: '',
  selectedCount: 4,
  timerHandle: null,
};

/* ----------------------------------------------------------- helpers ------ */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showScreen(id) {
  $$('.screen').forEach((s) => s.classList.remove('active'));
  $('#' + id).classList.add('active');
}

function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function haptic(type = 'light') {
  if (tg && tg.HapticFeedback) {
    try {
      if (type === 'success' || type === 'error' || type === 'warning') tg.HapticFeedback.notificationOccurred(type);
      else tg.HapticFeedback.impactOccurred(type);
    } catch (_) {}
  }
}

function initials(name) {
  return (name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

function hearts(n) { return '❤️'.repeat(Math.max(0, n)) || '💀'; }

/* client id fallback for browser testing (persist across reloads) */
function clientId() {
  let id = localStorage.getItem('bisca_cid');
  if (!id) { id = 'web_' + Math.random().toString(36).slice(2, 10); localStorage.setItem('bisca_cid', id); }
  return id;
}

/* ------------------------------------------------------------ socket ------ */
const socket = io({ transports: ['websocket', 'polling'] });

socket.on('connect', () => authenticate());
socket.on('state', (s) => renderGame(s));
socket.on('disconnect', () => toast('Reconnecting…'));

function authenticate() {
  const payload = tg
    ? { initData: tg.initData, name: tgName() }
    : { clientId: clientId(), name: state.name };
  socket.emit('auth', payload, (res) => {
    if (res && res.ok) {
      state.playerId = res.playerId;
      state.name = res.name;
      $('#my-name').textContent = res.name;
      // Auto-join if launched from a deep link (?startapp=ROOM).
      maybeAutoJoin();
    }
  });
}

function tgName() {
  const u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
  if (!u) return 'Guest';
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Player';
}

function startParam() {
  if (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) return tg.initDataUnsafe.start_param;
  const p = new URLSearchParams(location.search);
  return p.get('startapp') || p.get('tgWebAppStartParam') || null;
}

function maybeAutoJoin() {
  const room = startParam();
  if (room) doJoin(room);
}

/* --------------------------------------------------------- config fetch --- */
fetch('/config').then((r) => r.json()).then((c) => { state.botUsername = c.botUsername || ''; }).catch(() => {});

/* ========================================================== HOME =========== */
$('#btn-create').onclick = () => { haptic(); buildCountGrid(); showScreen('screen-create'); };
$('#btn-join').onclick = () => {
  const code = $('#input-room').value.trim().toUpperCase();
  if (code.length < 4) return toast('Enter a valid room code');
  doJoin(code);
};
$('#input-room').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
$('#btn-rules').onclick = showRules;

$$('[data-back]').forEach((b) => (b.onclick = () => { haptic(); showScreen('screen-home'); }));

/* ========================================================= CREATE ========== */
function buildCountGrid() {
  const grid = $('#player-count-grid');
  grid.innerHTML = '';
  for (let n = 2; n <= 8; n++) {
    const cell = document.createElement('div');
    cell.className = 'count-cell' + (n === state.selectedCount ? ' selected' : '');
    cell.textContent = n;
    cell.onclick = () => {
      state.selectedCount = n;
      haptic();
      $$('.count-cell').forEach((c) => c.classList.remove('selected'));
      cell.classList.add('selected');
    };
    grid.appendChild(cell);
  }
}
$('#btn-create-confirm').onclick = () => {
  socket.emit('createRoom', { maxPlayers: state.selectedCount }, (res) => {
    if (res.error) return toast('Error: ' + res.error);
    state.roomId = res.roomId; state.isHost = true;
    haptic('success');
  });
};

/* ========================================================== JOIN =========== */
function doJoin(roomId) {
  socket.emit('joinRoom', { roomId }, (res) => {
    if (res.error) return toast(joinError(res.error));
    state.roomId = res.roomId;
    haptic('success');
  });
}
function joinError(code) {
  return ({
    ROOM_NOT_FOUND: 'Room not found',
    ROOM_FULL: 'Room is full',
    GAME_IN_PROGRESS: 'Game already started',
  })[code] || code;
}

/* ========================================================= LOBBY =========== */
$('#btn-start').onclick = () => socket.emit('startGame', {}, (res) => { if (res.error) toast(res.error); });
$('#btn-copy').onclick = () => {
  navigator.clipboard && navigator.clipboard.writeText(state.roomId);
  toast('Room code copied');
};
$('#btn-invite').onclick = () => {
  const link = inviteLink();
  const text = `Join my BISCA game! Code: ${state.roomId}`;
  if (tg && tg.openTelegramLink && state.botUsername) {
    const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
    tg.openTelegramLink(share);
  } else if (tg && tg.switchInlineQuery) {
    tg.switchInlineQuery(state.roomId, ['users', 'groups']);
  } else {
    navigator.clipboard && navigator.clipboard.writeText(link);
    toast('Invite link copied');
  }
};
function inviteLink() {
  if (state.botUsername) return `https://t.me/${state.botUsername}/app?startapp=${state.roomId}`;
  return `${location.origin}/?startapp=${state.roomId}`;
}

function renderLobby(s) {
  $('#lobby-code').textContent = s.id;
  $('#lobby-count').textContent = `${s.players.length}/${s.maxPlayers}`;
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
  const meHost = s.hostId === state.playerId;
  state.isHost = meHost;
  const canStart = meHost && s.players.length >= 2;
  const btn = $('#btn-start');
  btn.style.display = meHost ? '' : 'none';
  btn.disabled = !canStart;
  $('#lobby-hint').textContent = meHost
    ? (canStart ? `Ready! ${s.players.length} players joined.` : 'Waiting for at least 2 players…')
    : 'Waiting for the host to start…';
}

/* =========================================================== GAME =========== */
function renderGame(s) {
  state.last = s;
  state.roomId = s.id;

  if (s.phase === 'lobby') { showScreen('screen-lobby'); renderLobby(s); return; }

  showScreen('screen-game');
  const me = s.players.find((p) => p.isSelf) || {};

  // HUD
  $('#hud-round').textContent = s.roundNumber;
  $('#hud-cards').textContent = s.cardsThisRound;
  const turnName = s.currentTurnId
    ? (s.players.find((p) => p.id === s.currentTurnId) || {}).name || '—'
    : '—';
  $('#hud-turn').textContent = s.currentTurnId === state.playerId ? 'YOU' : turnName;
  startTimer(s.turnDeadline);

  // blind banner
  $('#blind-banner').classList.toggle('hidden', !s.blind || s.phase === 'roundEnd' || s.phase === 'gameOver');

  // opponents
  renderOpponents(s, me);

  // trick area
  renderTrick(s);

  // my status
  $('#my-name').textContent = (me.name || 'You') + (s.dealerId === me.id ? ' 🎴' : '');
  $('#my-lives').textContent = hearts(me.lives);
  $('#my-bid').textContent = `Bid: ${me.bid == null ? '–' : me.bid} | Won: ${me.tricksWon}`;

  // hand
  renderHand(s, me);

  // phase-specific modals
  handlePhase(s, me);
}

function renderOpponents(s, me) {
  const wrap = $('#opponents');
  wrap.innerHTML = '';
  s.players.filter((p) => !p.isSelf).forEach((p) => {
    const el = document.createElement('div');
    el.className = 'opp' + (p.id === s.currentTurnId ? ' turn' : '') + (p.eliminated ? ' dead' : '');
    let cardsHtml = '';
    for (let i = 0; i < p.handCount; i++) {
      const c = p.hand[i];
      if (c) cardsHtml += miniCard(c);            // blind round: visible
      else cardsHtml += '<div class="mini-card"></div>';
    }
    el.innerHTML = `
      ${p.connected ? '' : '<span class="opp-offline">offline</span>'}
      <div class="avatar">${initials(p.name)}</div>
      <div class="opp-name">${escapeHtml(p.name)}${p.isHost ? ' 👑' : ''}</div>
      <div class="opp-lives">${hearts(p.lives)}</div>
      <div class="opp-bid">${p.bid == null ? '' : `Bid ${p.bid} · Won ${p.tricksWon}`}</div>
      <div class="opp-cards">${cardsHtml}</div>`;
    wrap.appendChild(el);
  });
}

function miniCard(c) {
  return `<div class="mini-card face suit-${c.suit}">${c.value}${SUIT_SYMBOL[c.suit]}</div>`;
}

function renderTrick(s) {
  const area = $('#trick-area');
  area.innerHTML = '';
  const plays = s.currentTrick.length ? s.currentTrick : (s.lastTrick ? s.lastTrick.plays : []);
  const isLast = !s.currentTrick.length && s.lastTrick;
  plays.forEach((pl) => {
    const div = document.createElement('div');
    div.className = 'trick-play';
    div.innerHTML = `${bigCard(pl.card, pl.aceChoice)}<span class="trick-name">${escapeHtml(pl.name)}</span>`;
    area.appendChild(div);
  });
  const msg = $('#table-msg');
  if (isLast && s.lastTrick) msg.textContent = `${s.lastTrick.winnerName} won the trick`;
  else if (!plays.length && s.phase === 'betting') msg.textContent = 'Waiting for bids…';
  else msg.textContent = '';
}

function bigCard(c, aceChoice) {
  const sym = SUIT_SYMBOL[c.suit];
  const ace = aceChoice ? `<span class="ace-badge">${aceChoice === 'win' ? 'WINS' : 'LOSES'}</span>` : '';
  return `<div class="card ${c.suit}">
      <div class="corner">${c.value}<br>${sym}</div>
      <div class="pip">${sym}</div>
      <div class="corner br">${c.value}<br>${sym}</div>${ace}
    </div>`;
}

function renderHand(s, me) {
  const hand = $('#hand');
  hand.innerHTML = '';
  const myTurn = s.currentTurnId === state.playerId && s.phase === 'playing';
  (me.hand || []).forEach((c, i) => {
    const el = document.createElement('div');
    if (!c) {
      // blind round: my own card is hidden
      el.className = 'card back small';
      el.innerHTML = '🙈';
    } else {
      el.className = `card ${c.suit}` + (myTurn ? ' playable' : ' disabled');
      const sym = SUIT_SYMBOL[c.suit];
      el.innerHTML = `<div class="corner">${c.value}<br>${sym}</div>
        <div class="pip">${sym}</div>
        <div class="corner br">${c.value}<br>${sym}</div>`;
      if (myTurn) el.onclick = () => attemptPlay(c);
    }
    hand.appendChild(el);
  });
  // In blind round we still need clickable placeholders to play
  if (s.blind && myTurn && me.handCount > 0) {
    hand.querySelectorAll('.card.back').forEach((el, idx) => {
      el.classList.remove('disabled');
      el.onclick = () => attemptPlayBlind();
    });
  }
}

/* --------------------------------------------------------- interactions --- */
function attemptPlay(card) {
  if (card.suit === 'hearts' && card.value === 1) return openAceModal(card);
  socket.emit('playCard', { cardId: card.id, aceChoice: null }, afterPlay);
}
function attemptPlayBlind() {
  // We don't know our card id in a blind round; server plays our (only) card.
  const me = state.last.players.find((p) => p.isSelf);
  // handCount is 1 in blind rounds; send a sentinel — server matches the single card.
  socket.emit('playCard', { cardId: '__blind__', aceChoice: null }, (res) => {
    if (res.error === 'CARD_NOT_IN_HAND') {
      // Server needs the real id; ask for a sync then retry with the actual card.
      socket.emit('sync', {}, () => {});
    }
    afterPlay(res);
  });
}
function afterPlay(res) {
  if (res && res.error) { toast(playError(res.error)); haptic('error'); }
  else haptic('light');
}
function playError(code) {
  return ({ NOT_YOUR_TURN: 'Not your turn', ACE_CHOICE_REQUIRED: 'Choose WIN or LOSE',
    CARD_NOT_IN_HAND: 'Card unavailable' })[code] || code;
}

/* =========================================================== MODALS ======== */
function modal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-overlay"><div class="modal">${html}</div></div>`;
  return root.querySelector('.modal');
}
function closeModal() { $('#modal-root').innerHTML = ''; }

let currentModalKey = null;
function handlePhase(s, me) {
  // Bidding: show my bid modal only when it's my turn and I haven't bid.
  if (s.phase === 'betting' && s.currentTurnId === state.playerId && me.bid == null) {
    const key = 'bid-' + s.roundNumber + '-' + me.tricksWon;
    if (currentModalKey !== key) { currentModalKey = key; openBidModal(s); }
    return;
  }
  if (s.phase === 'roundEnd' && s.roundSummary) {
    const key = 'sum-' + s.roundNumber;
    if (currentModalKey !== key) { currentModalKey = key; openSummaryModal(s); }
    return;
  }
  if (s.phase === 'gameOver') {
    if (currentModalKey !== 'over') { currentModalKey = 'over'; openGameOverModal(s); }
    return;
  }
  // Otherwise ensure transient modals are cleared (except ace, handled inline).
  if (['bid'].includes(currentModalKey?.split('-')[0])) { closeModal(); currentModalKey = null; }
  if (s.phase === 'playing' && currentModalKey && currentModalKey.startsWith('bid')) { closeModal(); currentModalKey = null; }
}

function openBidModal(s) {
  const max = s.cardsThisRound;
  const forbidden = s.forbiddenBid;
  let cells = '';
  for (let n = 0; n <= max; n++) {
    const bad = forbidden === n;
    cells += `<div class="bid-cell ${bad ? 'forbidden' : ''}" data-bid="${n}">${n}</div>`;
  }
  const blind = s.blind ? '<p class="sub">🙈 Blind round — bid 0 or 1 without seeing your card.</p>' : '';
  const el = modal(`
    <h2>Your Bid</h2>
    <p class="sub">How many tricks will you win? (0–${max})</p>
    ${blind}
    <div class="bid-grid">${cells}</div>
    ${forbidden != null ? `<p class="forbidden-note">You're last: you cannot bid ${forbidden}.</p>` : ''}
  `);
  el.querySelectorAll('.bid-cell').forEach((cell) => {
    if (cell.classList.contains('forbidden')) return;
    cell.onclick = () => {
      const value = parseInt(cell.dataset.bid, 10);
      socket.emit('bid', { value }, (res) => {
        if (res.error) { toast(res.error === 'ILLEGAL_BID' ? 'That bid is not allowed' : res.error); haptic('error'); }
        else { closeModal(); currentModalKey = null; haptic('success'); }
      });
    };
  });
}

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
function sendAce(card, choice) {
  socket.emit('playCard', { cardId: card.id, aceChoice: choice }, (res) => {
    closeModal();
    afterPlay(res);
  });
}

function openSummaryModal(s) {
  let rows = '';
  s.roundSummary.forEach((r) => {
    const out = r.lives <= 0;
    const cls = r.lost === 0 ? 'ok' : 'neg';
    rows += `<tr class="${out ? 'row-out' : ''}">
      <td style="text-align:left">${escapeHtml(r.name)}</td>
      <td>${r.bid}</td><td>${r.won}</td>
      <td class="${cls}">${r.lost === 0 ? '✓' : '-' + r.lost}</td>
      <td>${hearts(r.lives)}</td></tr>`;
  });
  modal(`
    <h2>Round ${s.roundNumber} Results</h2>
    <p class="sub">Exact bid = safe. Otherwise −1 life per trick off.</p>
    <table class="summary-table">
      <thead><tr><th style="text-align:left">Player</th><th>Bid</th><th>Won</th><th>Δ Lives</th><th>Lives</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="sub">Next round starting…</p>
  `);
  haptic('warning');
}

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
  if (tg && tg.HapticFeedback && won) tg.HapticFeedback.notificationOccurred('success');
}

/* ------------------------------------------------------------- rules ------ */
function showRules() {
  modal(`
    <h2>🃏 How to Play BISCA</h2>
    <ul class="rules-list">
      <li>🎯 <b>Objective:</b> Be the last player standing! Everyone starts with <b>5 Lives (❤️)</b>. Reach 0 lives and you are eliminated 💀.</li>
      
      <li>📦 <b>Deck:</b> Standard 40-card deck (cards 1 to 10 for each of the 4 suits).</li>
      
      <li>👑 <b>Card Strength (Suit First, Then Rank):</b>
        <br>• <b>Suits:</b> ♥️ (Hearts) &gt; ♦️ (Diamonds) &gt; ♣️ (Clubs) &gt; ♠️ (Spades). A higher suit <i>always</i> beats a lower suit (e.g., 2♥️ beats 10♦️).
        <br>• <b>Numbers:</b> 🔟 (highest) &gt; 9 &gt; 8 &gt; 7 &gt; 6 &gt; 5 &gt; 4 &gt; 3 &gt; 2 &gt; 1️⃣ (lowest) — compared <i>only</i> when cards share the same suit.
      </li>

      <li>✨ <b>Special Card – Ace of Hearts (1♥️):</b>
        <br>When played, you decide on the spot:
        <br>• 🥇 <b>"WINS":</b> Beats every card in the trick.
        <br>• 🪦 <b>"LOSES":</b> Loses to every card in the trick.
      </li>

      <li>🔄 <b>Round Structure:</b>
        <br>Hand sizes decrease each round: <b>5 ➔ 4 ➔ 3 ➔ 2 ➔ 1</b> cards, then loop back to <b>5</b> until only one survivor remains!
      </li>

      <li>🗣️ <b>Phase 1: Bidding:</b>
        <br>Each player declares how many tricks they expect to win (from 0 up to their hand size).
        <br>⚠️ <i>Last Player Rule:</i> The last bidder cannot pick a number that makes total bids equal the number of tricks in play. Someone <b>must</b> fail!
      </li>

      <li>⚔️ <b>Phase 2: Taking Tricks:</b>
        <br>The first player leads a card, and everyone plays one card clockwise 🔁. The strongest card takes the trick and leads the next one.
      </li>

      <li>💔 <b>Phase 3: Life Calculation:</b>
        <br>• <b>Exact Bid:</b> Safe! You lose 0 lives.
        <br>• <b>Missed Bid:</b> Lose <b>1 Life (❤️) per trick difference</b> (whether you took too many or too few).
      </li>

      <li>🙈 <b>Special 1-Card Round ("Blind"):</b>
        <br>Do <b>NOT</b> look at your card! Place it on your forehead so opponents see it, but you don't 👁️. Everyone bids 0 or 1 (the last bidder restriction still applies), cards are played, and lives are lost.
      </li>
    </ul>
    <button class="btn btn-primary btn-block" onclick="document.getElementById('modal-root').innerHTML=''">Got it! 👍</button>
  `);
}

/* ------------------------------------------------------------- timer ------ */
function startTimer(deadline) {
  clearInterval(state.timerHandle);
  const el = $('#hud-timer');
  if (!deadline) { el.textContent = '—'; el.classList.remove('low'); return; }
  const tick = () => {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    el.textContent = left;
    el.classList.toggle('low', left <= 10);
    if (left <= 0) clearInterval(state.timerHandle);
  };
  tick();
  state.timerHandle = setInterval(tick, 1000);
}

/* ------------------------------------------------------------- utils ------ */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Telegram BackButton integration */
if (tg && tg.BackButton) {
  tg.BackButton.onClick(() => {
    if ($('#modal-root').innerHTML) { closeModal(); return; }
    if ($('#screen-game').classList.contains('active')) return; // no leaving mid-game via back
    showScreen('screen-home');
    tg.BackButton.hide();
  });
}
