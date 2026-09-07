# 🃏 BISCA — Telegram Mini App (Multiplayer Card Game)

A production-ready, real-time multiplayer implementation of **BISCA**, built as a
**Telegram Mini App** and deployable as a **single Render web service**.

- **Backend:** Node.js · Express · Socket.io · `node-telegram-bot-api`
- **Frontend:** Vanilla HTML5/CSS3/JS (dark glassmorphic, mobile-first) + Telegram WebApp SDK
- **State:** In-memory room manager (Room IDs, turn timers, reconnection grace)
- **Deploy:** One port, one process — trivial on Render’s free tier

---

## 🎮 The Rules (implemented exactly)

| Rule | Implementation |
|---|---|
| **Deck** | 40 cards, values 1–10 × 4 suits |
| **Suit power** | ♥ > ♦ > ♣ > ♠ (absolute — higher suit always beats lower) |
| **Number power** | 10 (high) → 1 (low), only compared within the same suit |
| **Ace of Hearts** | On play, owner declares **WINS** (beats all) or **LOSES** (loses to all) |
| **Rounds** | 5 → 4 → 3 → 2 → 1 cards, then repeat forever |
| **Bidding** | Each bids 0…cards. **Last bidder** cannot make the bids total = cards |
| **Lives** | Start at 5 ❤️. Exact bid = safe; else −1 life per trick off (over or under) |
| **Blind round** | 1-card round: you never see your own card, but you see everyone else’s |
| **Win** | Last player with ≥1 life standing |

---

## 📁 Project Structure

```
bisca-tma/
├── package.json            # deps + start/dev/test scripts
├── render.yaml             # Render Blueprint (one-click deploy)
├── .env.example            # env var template
├── .gitignore
├── README.md
├── server/
│   ├── server.js           # Express + Socket.io + Telegram bot, static serving
│   └── game/
│       ├── BiscaEngine.js  # pure rules: deck, trick logic, ace, lives, sequence
│       └── RoomManager.js  # state machine: rooms, turns, timers, disconnects
├── public/
│   ├── index.html          # Telegram viewport + SDK + screens
│   ├── style.css           # glassmorphic responsive theme
│   └── app.js              # client socket, rendering, TG integration, animations
└── test/
    ├── engine.test.js      # 21 unit tests (npm test)
    └── sim.js              # headless full-game simulation
```

---

## 🚀 Deployment Guide

### 1 · Create the Telegram Bot (@BotFather)

1. In Telegram open **[@BotFather](https://t.me/BotFather)** → `/newbot`.
   Choose a name and a **username** (must end in `bot`, e.g. `MyBiscaBot`).
2. Copy the **BOT TOKEN** it gives you (looks like `123456789:AA...`).
3. Create the Mini App: `/newapp` → pick your bot →
   - **Title / description / photo:** anything you like.
   - **Web App URL:** your Render URL (you’ll get it in step 3), e.g.
     `https://bisca-tma.onrender.com`
   - **Short name:** e.g. `app` → this makes the link `t.me/MyBiscaBot/app`.
4. *(Optional, nicer UX)* `/setmenubutton` → choose your bot → set the button to
   open the same Web App URL.

> You can set a placeholder URL now and edit it after Render gives you the real one.

### 2 · Push to a Public GitHub Repo

```bash
cd bisca-tma
git init
git add .
git commit -m "BISCA Telegram Mini App"
git branch -M main
git remote add origin https://github.com/<YOUR_USER>/bisca-tma.git
git push -u origin main
```

### 3 · Deploy on Render

**Option A — Blueprint (fastest):**
1. [dashboard.render.com](https://dashboard.render.com) → **New +** → **Blueprint**.
2. Connect your GitHub repo. Render reads `render.yaml` automatically.
3. When prompted, fill the secrets (see env vars below), then **Apply**.

**Option B — Manual Web Service:**
1. **New +** → **Web Service** → connect your repo.
2. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/health`
   - **Instance Type:** Free is fine to start.
3. Add **Environment Variables**:

| Key | Value | Notes |
|---|---|---|
| `BOT_TOKEN` | `123456789:AA...` | From BotFather (secret) |
| `BOT_USERNAME` | `MyBiscaBot` | Without the `@`; builds invite links |
| `BASE_URL` | `https://bisca-tma.onrender.com` | Your live Render URL |
| `PORT` | *(leave unset)* | Render injects it automatically |

4. **Create Web Service.** Wait for the first deploy to go green.
5. Copy your live URL and paste it back into BotFather (`/setmenubutton` and the
   Mini App URL from step 1) and into the `BASE_URL` env var. Redeploy if changed.

> **Free-tier note:** Render free services sleep after inactivity and cold-start
> in ~30–60 s. For always-on play, use a paid instance or ping `/health`.

### 4 · Test & Launch

1. Open **@YourBot** in Telegram → `/start` → tap **▶️ Play BISCA**.
2. **Host:** create a room, pick the player count, tap **👥 Invite Friends**
   (opens Telegram share with a `t.me/MyBiscaBot/app?startapp=ROOMID` deep link).
3. **Friends:** tap the shared link → they auto-join the waiting room.
4. Host taps **Start Game** once ≥2 players are in. Play!

**Local dev:**
```bash
cp .env.example .env    # add your token (bot optional locally)
npm install
npm run dev             # http://localhost:3000  (open in a browser to test UI)
```
Without a `BOT_TOKEN`, the bot is skipped and Telegram `initData` validation is
bypassed so you can test the whole game flow in a normal browser (open multiple
tabs to simulate players).

---

## 🧠 Architecture Notes

- **`BiscaEngine.js`** is 100% pure & deterministic — no state, no I/O. All rules
  (trick resolution, ace mechanic, forbidden-bid math, life loss, round cycle)
  live here and are covered by `npm test`.
- **`RoomManager.js`** owns all mutable state and the phase machine
  `lobby → betting → playing → roundEnd → … → gameOver`, plus per-turn timers,
  auto-play on timeout, and a 60 s reconnection grace window.
- **`server.js`** wires Socket.io events, validates Telegram `initData` (HMAC per
  the official spec), serves the static app, and runs the bot via long polling.
- **Per-viewer state:** `publicState(roomId, viewerId)` hides other players’ hands
  — and in blind rounds hides **your own** card while revealing everyone else’s.

---

## 🔌 Socket API (quick reference)

| Event (client → server) | Payload | Purpose |
|---|---|---|
| `auth` | `{initData}` or `{clientId,name}` | Identify player |
| `createRoom` | `{maxPlayers}` | Host a room |
| `joinRoom` | `{roomId}` | Join / reconnect |
| `startGame` | – | Host starts |
| `bid` | `{value}` | Place a bid |
| `playCard` | `{cardId, aceChoice}` | Play a card |
| `sync` | – | Request fresh snapshot |
| **`state`** *(server → client)* | full room view | Pushed on every change |

## License
MIT
