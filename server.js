const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const WORLD_SIZE  = 4500;
const TICK_MS     = 10;      // 20 ticks/sec
const SPEED       = 10;      // px per tick
const MAX_BOTS    = 6;
const MAX_PLAYERS = 8;
const MAX_TRAIL_WAYPOINTS = 2000; // safety cap

const DIRS = {
  UP:    { dx:  0, dy: -1 },
  DOWN:  { dx:  0, dy:  1 },
  LEFT:  { dx: -1, dy:  0 },
  RIGHT: { dx:  1, dy:  0 },
};
const OPPOSITE  = { UP: 'DOWN', DOWN: 'UP', LEFT: 'RIGHT', RIGHT: 'LEFT' };
const DIR_ORDER = ['UP', 'RIGHT', 'DOWN', 'LEFT'];

const PLAYER_COLORS = [
  '#00ffcc', '#ff0055', '#ffaa00', '#ff00ff',
  '#00ff00', '#9900ff', '#00bfff', '#ffffff'
];

const SPAWN_POSITIONS = [
  { x: WORLD_SIZE * 0.2,  y: WORLD_SIZE * 0.5,  dir: 'RIGHT' },
  { x: WORLD_SIZE * 0.8,  y: WORLD_SIZE * 0.5,  dir: 'LEFT'  },
  { x: WORLD_SIZE * 0.5,  y: WORLD_SIZE * 0.2,  dir: 'DOWN'  },
  { x: WORLD_SIZE * 0.5,  y: WORLD_SIZE * 0.8,  dir: 'UP'    },
  { x: WORLD_SIZE * 0.2,  y: WORLD_SIZE * 0.25, dir: 'RIGHT' },
  { x: WORLD_SIZE * 0.8,  y: WORLD_SIZE * 0.75, dir: 'LEFT'  },
  { x: WORLD_SIZE * 0.8,  y: WORLD_SIZE * 0.25, dir: 'LEFT'  },
  { x: WORLD_SIZE * 0.2,  y: WORLD_SIZE * 0.75, dir: 'RIGHT' },
];

// ─── STATE ────────────────────────────────────────────────────────────────────

const rooms = new Map(); // code → Room

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function genCode() {
  let code;
  do {
    code = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (rooms.has(code));
  return code;
}

function segsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const denom = (dx - cx) * (by - ay) - (dy - cy) * (bx - ax);
  if (denom === 0) return false;
  const u = ((dx - cx) * (cy - ay) - (dy - cy) * (cx - ax)) / denom;
  const v = ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / denom;
  return u >= 0 && u <= 1 && v >= 0 && v <= 1;
}

function spawnPlayer(index, id, name, color, isBot) {
  const spawn = SPAWN_POSITIONS[index % SPAWN_POSITIONS.length];
  return {
    id,
    name,
    color,
    isBot,
    isHost: false,
    alive: true,
    x: spawn.x,
    y: spawn.y,
    dir: spawn.dir,
    pendingDir: null,
    trail: [{ x: spawn.x, y: spawn.y }],
    // bot-only AI state
    decisionCooldown: 0,
    straightTicks: 0,
    agro: 0,
    agroTimer: 1500,
    lastAction: 0,
    consecutiveAction: 0,
  };
}

function respawnAll(room) {
  const players = Array.from(room.players.values());
  players.forEach((p, i) => {
    const spawn = SPAWN_POSITIONS[i % SPAWN_POSITIONS.length];
    p.alive = true;
    p.x = spawn.x;
    p.y = spawn.y;
    p.dir = spawn.dir;
    p.pendingDir = null;
    p.trail = [{ x: spawn.x, y: spawn.y }];
    p.decisionCooldown = 0;
    p.straightTicks = 0;
    p.agro = 0;
    p.agroTimer = 1500;
    p.lastAction = 0;
    p.consecutiveAction = 0;
  });
  room.tick = 0;
  room.gameRunning = false;
}

function getRoomInfo(room) {
  return {
    code: room.code,
    gameRunning: room.gameRunning,
    botCount: room.botCount,
    players: Array.from(room.players.values()).map(p => ({
      id:     p.id,
      name:   p.name,
      color:  p.color,
      isHost: p.isHost,
      isBot:  p.isBot,
    })),
  };
}

// ─── BOT INTELLIGENCE ─────────────────────────────────────────────────────────

function raycast(players, sx, sy, angle, maxDist, ignoreId) {
  let ex = sx + Math.cos(angle) * maxDist;
  let ey = sy + Math.sin(angle) * maxDist;
  let best = maxDist;
  let hit = false;

  // World boundary
  if (ex < 0 || ex > WORLD_SIZE || ey < 0 || ey > WORLD_SIZE) {
    hit = true;
    best = Math.min(
      sx,
      sy,
      WORLD_SIZE - sx,
      WORLD_SIZE - sy,
      maxDist
    );
  }

  const RAY_ANGLES = {
    0:              { cos: 1,  sin: 0  },
    [Math.PI / 2]:  { cos: 0,  sin: 1  },
    [Math.PI]:      { cos: -1, sin: 0  },
    [-Math.PI / 2]: { cos: 0,  sin: -1 },
  };

  for (const p of players) {
    if (p.trail.length < 1) continue;
    const limit = p.id === ignoreId ? p.trail.length - 2 : p.trail.length - 1;
    for (let i = 0; i < limit; i++) {
      if (segsIntersect(sx, sy, ex, ey, p.trail[i].x, p.trail[i].y, p.trail[i + 1].x, p.trail[i + 1].y)) {
        // approximate distance
        const midX = (p.trail[i].x + p.trail[i + 1].x) / 2;
        const midY = (p.trail[i].y + p.trail[i + 1].y) / 2;
        const d = Math.hypot(midX - sx, midY - sy);
        if (d < best) { best = d; hit = true; }
      }
    }
    if (p.id !== ignoreId) {
      const last = p.trail[p.trail.length - 1];
      if (segsIntersect(sx, sy, ex, ey, last.x, last.y, p.x, p.y)) {
        const d = Math.hypot(p.x - sx, p.y - sy);
        if (d < best) { best = d; hit = true; }
      }
    }
  }

  return { hit, distance: best };
}

function angleDeg(dir) {
  return { UP: -Math.PI/2, DOWN: Math.PI/2, LEFT: Math.PI, RIGHT: 0 }[dir];
}

function botTick(bot, allPlayers, deltaMs) {
  bot.agroTimer -= deltaMs;
  if (bot.agroTimer <= 0) {
    bot.agroTimer = 1500;
    bot.agro += Math.random() < 0.5 ? 1 : -1;
    bot.agro = Math.max(-5, Math.min(5, bot.agro));
  }

  bot.decisionCooldown -= deltaMs;
  if (bot.decisionCooldown > 0) return;
  bot.decisionCooldown = 80; // ~12 decisions/sec

  const curIdx = DIR_ORDER.indexOf(bot.dir);
  const moves  = [0, 1, -1];
  let bestScore = -Infinity;
  let bestDirIdx = curIdx;
  const STEP = 40;

  for (const m of moves) {
    const tryIdx = (curIdx + m + 4) % 4;
    const tryDir = DIR_ORDER[tryIdx];
    if (tryDir === OPPOSITE[bot.dir]) continue;

    const ray = raycast(allPlayers, bot.x, bot.y, angleDeg(tryDir), STEP, bot.id);
    if (ray.hit && ray.distance <= 1) continue;

    let score = 0;
    let sx = bot.x + DIRS[tryDir].dx * Math.min(STEP, ray.distance - 1);
    let sy = bot.y + DIRS[tryDir].dy * Math.min(STEP, ray.distance - 1);
    let sdIdx = tryIdx;

    for (let step = 0; step < 10; step++) {
      const sd = DIR_ORDER[sdIdx];
      const fr = raycast(allPlayers, sx, sy, angleDeg(sd), STEP, bot.id);
      if (fr.hit && fr.distance <= 1) { score -= 99999; break; }
      const adv = Math.min(STEP, fr.distance - 1);
      score += adv;
      sx += DIRS[sd].dx * adv;
      sy += DIRS[sd].dy * adv;

      if (bot.agro > 0) {
        const target = allPlayers.filter(p => p.id !== bot.id && p.alive)
          .reduce((a, b) => Math.hypot(b.x-sx,b.y-sy) < Math.hypot(a.x-sx,a.y-sy) ? b : a, { x:sx+99999, y:sy+99999 });
        if (target) score += (10000 - Math.hypot(target.x-sx,target.y-sy)) * bot.agro;
      } else {
        for (const p of allPlayers) {
          if (p.id !== bot.id && p.alive) score += Math.hypot(p.x-sx,p.y-sy) * 0.5;
        }
      }

      if (fr.hit && fr.distance < STEP * 1.5) {
        const li = (sdIdx + 3) % 4, ri = (sdIdx + 1) % 4;
        const rL = raycast(allPlayers, sx, sy, angleDeg(DIR_ORDER[li]), STEP, bot.id);
        const rR = raycast(allPlayers, sx, sy, angleDeg(DIR_ORDER[ri]), STEP, bot.id);
        sdIdx = rL.distance > rR.distance ? li : ri;
      }
    }

    if (m === 0 && bot.straightTicks > 80) score -= (bot.straightTicks - 80) * 500;

    if (score > bestScore) { bestScore = score; bestDirIdx = tryIdx; }
  }

  const newDir = DIR_ORDER[bestDirIdx];
  if (newDir !== bot.dir && newDir !== OPPOSITE[bot.dir]) {
    bot.trail.push({ x: bot.x, y: bot.y });
    bot.dir = newDir;
    bot.straightTicks = 0;
  } else {
    bot.straightTicks++;
  }
}

// ─── GAME LOOP ────────────────────────────────────────────────────────────────

function gameTick(room) {
  const allPlayers = Array.from(room.players.values());

  // Bot AI
  for (const p of allPlayers) {
    if (p.isBot && p.alive) botTick(p, allPlayers, TICK_MS);
  }

  // Apply pending direction changes from human players
  for (const p of allPlayers) {
    if (!p.alive || p.isBot) continue;
    if (p.pendingDir && p.pendingDir !== OPPOSITE[p.dir]) {
      p.trail.push({ x: p.x, y: p.y });
      p.dir = p.pendingDir;
    }
    p.pendingDir = null;
  }

  // Move everyone
  for (const p of allPlayers) {
    if (!p.alive) continue;
    p.x += DIRS[p.dir].dx * SPEED;
    p.y += DIRS[p.dir].dy * SPEED;

    if (p.x < 0 || p.x > WORLD_SIZE || p.y < 0 || p.y > WORLD_SIZE) {
      p.alive = false;
    }

    // Trim trail to cap memory
    if (p.trail.length > MAX_TRAIL_WAYPOINTS) p.trail.shift();
  }

  // Collision detection
  for (const p of allPlayers) {
    if (!p.alive) continue;
    const prev = p.trail[p.trail.length - 1];

    for (const target of allPlayers) {
      if (!p.alive) break;
      const segments = target.trail;
      const limit = target.id === p.id ? segments.length - 2 : segments.length - 1;

      for (let i = 0; i < limit; i++) {
        if (segsIntersect(prev.x, prev.y, p.x, p.y, segments[i].x, segments[i].y, segments[i+1].x, segments[i+1].y)) {
          p.alive = false;
          break;
        }
      }

      if (p.alive && target.id !== p.id && target.trail.length > 0) {
        const tl = target.trail[target.trail.length - 1];
        if (segsIntersect(prev.x, prev.y, p.x, p.y, tl.x, tl.y, target.x, target.y)) {
          p.alive = false;
        }
      }
    }
  }

  room.tick++;

  // Broadcast state
  const state = {
    tick: room.tick,
    players: allPlayers.map(p => ({
      id:    p.id,
      name:  p.name,
      color: p.color,
      alive: p.alive,
      x:     p.x,
      y:     p.y,
      dir:   p.dir,
      isBot: p.isBot,
      trail: p.trail,
    })),
  };
  io.to(room.code).emit('game_state', state);

  // Win condition
  const alive = allPlayers.filter(p => p.alive);
  if (alive.length <= 1 && allPlayers.length > 1) {
    clearInterval(room.gameLoop);
    room.gameLoop = null;
    const winner = alive[0] || null;
    io.to(room.code).emit('game_over', {
      winnerId:   winner ? winner.id : null,
      winnerName: winner ? winner.name : 'DRAW',
    });
    setTimeout(() => {
      respawnAll(room);
      io.to(room.code).emit('room_update', getRoomInfo(room));
    }, 4000);
  }
}

// ─── SOCKET.IO EVENTS ─────────────────────────────────────────────────────────

io.on('connection', socket => {
  console.log(`[+] ${socket.id}`);

  // ── Create Room ──────────────────────────────────────────────────────────────
  socket.on('create_room', ({ name, botCount = 0 }) => {
    const code  = genCode();
    const room  = {
      code,
      players:    new Map(),
      gameRunning: false,
      gameLoop:   null,
      tick:       0,
      botCount:   Math.min(botCount, MAX_BOTS),
    };
    rooms.set(code, room);

    socket.currentRoom = code;
    socket.join(code);

    const colorIdx = 0;
    const player = spawnPlayer(0, socket.id, name || 'Player 1', PLAYER_COLORS[colorIdx], false);
    player.isHost = true;
    room.players.set(socket.id, player);

    socket.emit('room_joined', {
      room:        getRoomInfo(room),
      playerId:    socket.id,
      playerColor: player.color,
    });
    console.log(`[Room] Created ${code} by ${name}`);
  });

  // ── Join Room ────────────────────────────────────────────────────────────────
  socket.on('join_room', ({ code, name }) => {
    const room = rooms.get((code || '').toUpperCase().trim());
    if (!room)           return socket.emit('join_error', { message: 'Room not found. Check the code.' });
    if (room.gameRunning) return socket.emit('join_error', { message: 'Game already in progress.' });
    const humanCount = Array.from(room.players.values()).filter(p => !p.isBot).length;
    if (humanCount >= MAX_PLAYERS) return socket.emit('join_error', { message: 'Room is full.' });

    socket.currentRoom = code.toUpperCase().trim();
    socket.join(socket.currentRoom);

    const idx    = room.players.size;
    const color  = PLAYER_COLORS[idx % PLAYER_COLORS.length];
    const player = spawnPlayer(idx, socket.id, name || `Player ${idx + 1}`, color, false);
    room.players.set(socket.id, player);

    socket.emit('room_joined', {
      room:        getRoomInfo(room),
      playerId:    socket.id,
      playerColor: player.color,
    });
    socket.to(socket.currentRoom).emit('room_update', getRoomInfo(room));
    console.log(`[Room] ${socket.id} joined ${socket.currentRoom}`);
  });

  // ── Start Game (host only) ───────────────────────────────────────────────────
  socket.on('start_game', () => {
    const room = rooms.get(socket.currentRoom);
    if (!room) return;
    const me = room.players.get(socket.id);
    if (!me || !me.isHost || room.gameRunning) return;

    // Add bots
    const existingCount = room.players.size;
    for (let b = 0; b < room.botCount; b++) {
      const botId   = `bot_${room.code}_${b}`;
      const idx     = existingCount + b;
      const color   = PLAYER_COLORS[idx % PLAYER_COLORS.length];
      const bot     = spawnPlayer(idx, botId, `BOT-${b + 1}`, color, true);
      room.players.set(botId, bot);
    }

    // Respawn everyone at correct spawn slots
    const players = Array.from(room.players.values());
    players.forEach((p, i) => {
      const spawn = SPAWN_POSITIONS[i % SPAWN_POSITIONS.length];
      p.alive = true;
      p.x = spawn.x; p.y = spawn.y; p.dir = spawn.dir;
      p.pendingDir = null;
      p.trail = [{ x: spawn.x, y: spawn.y }];
      p.decisionCooldown = 0; p.straightTicks = 0;
      p.agro = 0; p.agroTimer = 1500;
    });

    room.gameRunning = true;
    room.tick = 0;
    io.to(room.code).emit('game_start', { players: getRoomInfo(room).players });
    room.gameLoop = setInterval(() => gameTick(room), TICK_MS);
    console.log(`[Game] Started in ${room.code} with ${room.players.size} players`);
  });

  // ── Direction Change ─────────────────────────────────────────────────────────
  socket.on('change_dir', ({ dir }) => {
    const room = rooms.get(socket.currentRoom);
    if (!room || !room.gameRunning) return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    if (DIRS[dir] && dir !== OPPOSITE[p.dir] && dir !== p.dir) {
      p.pendingDir = dir;
    }
  });

  // ── Update bot count (host, pre-game) ────────────────────────────────────────
  socket.on('set_bots', ({ count }) => {
    const room = rooms.get(socket.currentRoom);
    if (!room) return;
    const me = room.players.get(socket.id);
    if (!me || !me.isHost || room.gameRunning) return;
    room.botCount = Math.min(Math.max(0, count), MAX_BOTS);
    io.to(room.code).emit('room_update', getRoomInfo(room));
  });

  // ── Disconnect ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const room = rooms.get(socket.currentRoom);
    if (!room) return;

    room.players.delete(socket.id);
    console.log(`[-] ${socket.id} left ${socket.currentRoom}`);

    const humans = Array.from(room.players.values()).filter(p => !p.isBot);

    if (humans.length === 0) {
      if (room.gameLoop) clearInterval(room.gameLoop);
      rooms.delete(room.code);
      console.log(`[Room] Deleted ${room.code} (empty)`);
      return;
    }

    // Reassign host if needed
    if (!humans.some(p => p.isHost)) {
      humans[0].isHost = true;
    }

    io.to(room.code).emit('room_update', getRoomInfo(room));
  });
});

// ─── START SERVER ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 MEGA TRON Server running → http://localhost:${PORT}\n`);
});
