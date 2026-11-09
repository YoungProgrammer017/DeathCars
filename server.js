// server.js — the online server of «Салки на выживание».
// It serves the game (the folder public/) and runs one shared room: the real match (physics, damage, bots) runs
// here; every browser sends its keys and gets the state of the arena 20 times a second. Free seats are bots.
// No dependencies: plain Node (a small WebSocket implementation is below). Start: node server.js

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game } from './public/game.js';
import { ArenaWorld } from './public/physics.js';
import { packPlayer, packVehicle, packZone, eventReplacer } from './public/netcodec.js';

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const ARENA_R = 104;            // the Colosseum (arena.js)
const SEATS = 4;

// ------------------------------------------------------------------ static files
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      // the cars are big and never change between versions of the same name: keep them a day
      'Cache-Control': rel.startsWith('/assets/') ? 'public, max-age=86400' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
});

// ------------------------------------------------------------------ WebSocket (RFC 6455, text frames)
class Socket {
  constructor(sock) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.parts = null; this.open = true;
    sock.setNoDelay(true);
    sock.on('data', (d) => this._data(d));
    sock.on('close', () => this._closed());
    sock.on('error', () => this._closed());
  }
  _closed() { if (!this.open) return; this.open = false; if (this.onclose) this.onclose(); }
  _data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) { this.close(); return; }
      const mk = off;
      if (masked) off += 4;
      if (b.length < off + len) return;
      const data = Buffer.from(b.subarray(off, off + len));
      if (masked) for (let i = 0; i < data.length; i++) data[i] ^= b[mk + (i & 3)];
      this.buf = b.subarray(off + len);
      if (op === 8) { this.close(); return; }
      if (op === 9) { this._frame(10, data); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2) this.parts = [data];
      else if (op === 0 && this.parts) this.parts.push(data);
      else continue;
      if (fin) { const msg = Buffer.concat(this.parts).toString('utf8'); this.parts = null; if (this.onmessage) this.onmessage(msg); }
    }
  }
  _frame(op, data) {
    if (!this.open) return;
    const n = data.length;
    let head;
    if (n < 126) head = Buffer.from([0x80 | op, n]);
    else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
    try { this.sock.write(Buffer.concat([head, data])); } catch { this._closed(); }
  }
  send(str) { this._frame(1, Buffer.from(str, 'utf8')); }
  get backlog() { return this.sock.writableLength; }
  close() { try { this._frame(8, Buffer.alloc(0)); this.sock.end(); } catch { /* ignore */ } this._closed(); }
}

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  join(new Socket(sock));
});

// ------------------------------------------------------------------ the room
const world = new ArenaWorld(ARENA_R);
const game = new Game(world);
const clients = new Set();
let matchId = 0, matchEndAt = 0, seq = 0;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function botName(p) { return `Бот ${p.id + 1}`; }
function makeBot(p) {
  p.remote = false; p.isBot = true; p.name = botName(p); p.netInput = null; p.netActions = [];
  p.bot = { t: 0 };
  if (game.state === 'upgrade' && !p.botSpins) game._planBotSpins(p);
  if (!p.botSpins) p.botSpins = [];
}
function seat(c) {
  if (c.pid != null || !game.sim || game.state === 'menu') return;
  const p = game.players.find((q) => !q.remote);
  if (!p) { c.ws.send(JSON.stringify({ t: 'full' })); return; }
  p.remote = true; p.isBot = false; p.name = c.name; p.netInput = null; p.netActions = [];
  if (game.state === 'upgrade') p.ready = false;
  c.pid = p.id;
  c.ws.send(JSON.stringify({ t: 'welcome', pid: p.id, mid: matchId }));
}
function startMatch(o) {
  game.newMatch({ mode: o.mode === 'br' ? 'br' : 'tag', bots: SEATS - 1, chaseTime: clamp(Number(o.chaseTime) || 180, 60, 300), role: 'random' });
  matchId++; matchEndAt = 0;
  for (const p of game.players) makeBot(p);
  for (const c of clients) {
    c.pid = null; seat(c);
    if (c.money > 0 && c.pid != null) game.players[c.pid].money = c.money;   // the test money each player picked in the menu
  }
  log(`match ${matchId} (${game.settings.mode}) for ${clients.size} player(s)`);
}
function toLobby() { game.state = 'menu'; game.sim = null; for (const c of clients) c.pid = null; }
const moneyOpt = (v) => ([5000, 20000, 100000].includes(Number(v)) ? Number(v) : 0);
function playerOf(c) { return c.pid == null ? null : game.players[c.pid]; }

function join(ws) {
  const c = { ws, name: 'Игрок', pid: null };
  clients.add(c);
  ws.onmessage = (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const p = playerOf(c);
    switch (m.t) {
      case 'hello':
        c.name = String(m.name || '').replace(/[<>&"]/g, '').trim().slice(0, 16) || 'Игрок';
        c.money = moneyOpt(m.money);
        seat(c);
        sendLobby();
        break;
      case 'money':
        c.money = moneyOpt(m.v);
        break;
      case 'start':
        c.money = moneyOpt(m.money);
        if (!game.sim || game.state === 'menu' || game.state === 'matchEnd') startMatch(m);
        break;
      case 'in':
        if (p && Array.isArray(m.i)) p.netInput = { throttle: clamp(+m.i[0] || 0, 0, 1), brake: clamp(+m.i[1] || 0, 0, 1), steer: clamp(+m.i[2] || 0, -1, 1), handbrake: !!m.i[3] };
        break;
      case 'act':
        if (!p || game.state !== 'chase') break;
        if (m.a === 'recover') {
          const v = p.vehicle, upY = 1 - 2 * (v.q[0] * v.q[0] + v.q[2] * v.q[2]);
          if (p.alive && (upY < 0.5 || Math.abs(v.speed) < 3)) { v.recover(); game.emit({ type: 'toast', player: p.id, text: 'Машина снова на колёсах' }); }
        } else if (m.a === 'talent' && p.netActions.length < 4) p.netActions.push('talent');
        break;
      case 'spin': {
        const res = p && game.state === 'upgrade' ? game.spin(p, String(m.car), Number(m.bet) || 0) : null;
        ws.send(JSON.stringify({ t: 'spinRes', res }));
        break;
      }
      case 'sel':
        if (p && game.state === 'upgrade') game.selectCar(p, String(m.car));
        break;
      case 'ready':
        if (p && game.state === 'upgrade') game.setReady(p);
        break;
    }
  };
  ws.onclose = () => {
    clients.delete(c);
    const p = playerOf(c);
    if (p && p.remote) makeBot(p);
    if (!clients.size && game.sim) toLobby();      // nobody left: stop the match
    sendLobby();
  };
  ws.send(JSON.stringify({ t: 'hi' }));
}

function sendLobby() {
  const msg = JSON.stringify({ t: 'lobby', st: game.sim ? game.state : 'menu', mid: matchId, mode: game.settings.mode,
    names: [...clients].map((c) => c.name) });
  for (const c of clients) c.ws.send(msg);
}

function snapshot() {
  for (const zn of game.zones) if (!zn._nid) zn._nid = ++seq;
  for (const d of game.decoys) if (!d._nid) d._nid = ++seq;
  const ev = game.events.splice(0);
  for (const e of ev) { if (e.zone && !e.zone._nid) e.zone._nid = ++seq; if (e.decoy && !e.decoy._nid) e.decoy._nid = ++seq; }
  const fx = {};
  for (const p of game.players) if (p.fx && p.fx.length) fx[p.id] = p.fx.splice(0);
  return JSON.stringify({
    t: 's', id: matchId, st: game.state, tm: Math.round(game.timer * 100) / 100, rd: game.round, sc: game.score,
    hh: game.hunterHold, lr: game.lastRound || null, mode: game.settings.mode, ct: game.settings.chaseTime, time: game.time,
    pl: game.players.map(packPlayer),
    z: game.zones.map((zn) => ({ ...packZone(zn), id: zn._nid })),
    hp: game.harpoons.map((h) => [h.hunter.id, h.runner.id]),
    dc: game.decoys.map((d) => ({ id: d._nid, o: d.owner.id, car: d.vehicle.spec.id, t: d.t, v: packVehicle(d.vehicle) })),
    ev, fx,
  }, eventReplacer);
}

// ------------------------------------------------------------------ the loop
let last = performance.now(), snapT = 0, lobbyT = 0;
setInterval(() => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (game.sim && game.state !== 'menu') {
    try { game.update(dt, null, []); } catch (e) { log('update failed: ' + (e && e.stack)); }
    if (game.state === 'matchEnd') {
      if (!matchEndAt) matchEndAt = now;
      else if (now - matchEndAt > 25000) { toLobby(); sendLobby(); }
    }
    snapT += dt;
    if (snapT >= 0.05) {
      snapT = 0;
      const msg = snapshot();
      for (const c of clients) if (c.ws.backlog < 512 * 1024) c.ws.send(msg);
    }
  }
  lobbyT += dt;
  if (lobbyT > 2) { lobbyT = 0; sendLobby(); }        // also keeps idle connections alive
}, 1000 / 60);

function log(s) { console.log(new Date().toISOString().slice(11, 19), s); }
server.listen(PORT, () => log(`Салки: http://localhost:${PORT}`));
