// game.js — match rules: roles, rounds, crash damage, money, upgrader, talents and bots.
// No rendering here: the renderer reads the state and the `events` queue.
import { Vehicle, Simulation, swapVehicles, makeSpec, WALL_RESTITUTION } from './physics.js';
const FLIP_REACH = 2.6;   // how far in front of the bumper the Alfa's flipper plate reaches (m)
import { CARS, CAR_LIST, TALENTS, START_CAR } from './cars.js';
import { CAR_GEO } from './cargeo.js';
export { CARS, CAR_LIST, TALENTS };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const rnd = (a, b) => a + Math.random() * (b - a);

export const RULES = {
  rounds: 5,
  upgraderTime: 45,       // s
  getReadyTime: 2,        // s, everyone waits before the start
  hunterDelay: 3,         // s, the hunter waits while the others drive off
  startMoney: 300,
  roundIncome: 50,        // everyone, at the start of every round
  runnerPerSecond: 1,     // runner, for every second still alive
  runnerWin: 120,         // every runner, when the runners win the round
  hunterPool: 300,        // hunter: 300 ÷ number of runners for each destroyed runner
  hunterWin: 150,         // hunter: destroyed everyone…
  hunterWinPerSecond: 1,  // …plus 1 for every second left on the clock
  maxChance: 0.8,         // the upgrader never gives a sure win
  // crash damage (no health): a car is wrecked when it can no longer go faster than this, or its driver is killed
  wreckSpeed: 50 / 3.6,
  // share of a hit's crash energy the car's body takes (see physics.js absorbHit: energy → crush → broken parts)
  hunterFromCars: 1 / 3,  // the hunter's sides/rear take a third (his front bumper takes nothing at all)
  ramBonus: 1.5,          // 'ram' talent: the runner takes 50% more…
  ramSelf: 0.5,           // …and the hunter half of his already small share
  fromWalls: 0.45,        // walls: every car takes 45% of the energy (the hunter as much as the runners)
  // a car that's off its wheels (roof, side, stuck on something) and doesn't move puts itself back after this long
  autoFlip: 3, autoFlipSpeed: 1.2,
  fromGround: 0.85,       // the ground (a car landing on its roof or side, rolling over): most of it
  // falls: a car lands on its wheels without harm from up to ~1 m (4.5 m/s); every metre above that
  // breaks the suspension and the rims, shakes the engine off its mounts and, from high up, hurts the driver
  landSafe: 4.5,          // m/s (per car: CARS[id].landing — a rally car or an army truck takes more)
  landRoofSafe: 2.5, landRoof: 0.35,   // on the roof or the side: from 2.5 m/s (30 cm) the body takes 35% of the fall
  landSusp: 0.2, landWheel: 0.12, landEngine: 0.07, landGearbox: 0.05, landBody: 0.06, landDriver: 0.07,
  wallMinSpeed: 3,        // m/s: softer knocks don't crush anything
  pushBarEnergy: 60000,   // J: what a new push bar soaks up from wall hits before it's flat
  pushBarSelf: 4,         // its car's front is this many times stiffer (takes that much less)…
  pushBarOther: 0.5,      // …and the car it hits takes this much more (both × the bar's state 0..1)
  // the VAZ's steel wedge: walls smash it (it comes off), cars hardly wear it
  wedgeWallEnergy: 55000,   // J of wall hits it soaks up before it breaks off
  wedgeCarEnergy: 500000,   // J of car hits that would wear it out (so it loses only a little per crash)
  wedgeSelf: 3,           // the VAZ's front is this many times stiffer behind the wedge…
  wedgeOther: 0.4,        // …and the car it rams takes this much more
  // the Alfa's flipper: the car in front goes up (lighter cars higher) and tips over away from it
  flipLift: 8.5, flipPush: 3.5, flipSpin: 2.0,
  runnerVsRunner: 0.6,    // two runners bumping
  creditWindow: 5,        // s: a runner that dies within this time after a hunter hit counts fully for the hunter
  // battle royale: everyone for himself, no roles and no hunter's breaks
  brVsCar: 1.3,           // share of a car-to-car crash every body takes (both bodies crumple: a bit more each)
  brKill: 120,            // for wrecking a car (the last one to hit it within creditWindow gets it)
  brWin: 150,             // the round's winner
};

// player colours (name tags, the players list)
export const CAR_COLORS = {
  hunter: '#ff4d4d',
  runners: ['#3d8bff', '#ffc21a', '#2fd06a', '#c46bff'],
  solo: ['#3d8bff', '#ff4d4d', '#ffc21a', '#2fd06a'],
};

const specCache = {};
export function specFor(carId) {
  if (!specCache[carId]) specCache[carId] = makeSpec(carId, CAR_GEO[carId], CARS[carId]);
  return specCache[carId];
}

export class Game {
  constructor(world) {
    this.world = world;
    this.events = [];             // for the UI / renderer: {type, ...}
    this.state = 'menu';
    this.settings = { bots: 2, chaseTime: 180, role: 'random', mode: 'tag' };
    this.players = [];
    this.sim = null;
    this.decoys = [];
    this.zones = [];              // oil, glue, spikes on the ground
    this.smokes = [];             // smoke screens (block the bots' view)
    this.harpoons = [];
    this.round = 0;
    this.score = { hunter: 0, runners: 0 };
    this.timer = 0;
    this.time = 0;                // chase clock
    this.alpha = 0;
    // arena: the free disc around the centre
    let r = 0;
    while (r < 400 && world.sdf(r, 0) > 0) r += 0.5;
    this.arenaR = Math.max(r - 4, 30);
  }

  emit(e) { this.events.push(e); if (this.events.length > 300) this.events.shift(); }
  get human() { return this.players.find((p) => !p.isBot); }
  get br() { return this.settings.mode === 'br'; }          // battle royale: everyone for himself
  get hunter() { return this.players.find((p) => p.role === 'hunter'); }
  get runners() { return this.players.filter((p) => p.role === 'runner'); }

  // ---------------------------------------------------------------- match flow
  newMatch(settings = {}) {
    Object.assign(this.settings, settings);
    const want = 1 + clamp(this.settings.bots | 0, 1, 3);
    if (this.players.length !== want) {
      const humanMoney = this.human ? this.human.money : RULES.startMoney;
      this.players = [];
      for (let i = 0; i < want; i++) {
        this.players.push({ id: i, name: i === 0 ? 'Ты' : `Бот ${i}`, isBot: i > 0, money: i === 0 ? humanMoney : RULES.startMoney });
      }
    }
    // test option from the menu: the human starts the match with this much money (bots keep the normal amount)
    if (this.settings.myMoney > 0) this.players[0].money = this.settings.myMoney;
    // roles: the hunter is fixed for the whole match and chosen at random (or as set in the menu for testing)
    let hunterIdx = Math.floor(Math.random() * this.players.length);
    if (this.settings.role === 'hunter') hunterIdx = 0;
    else if (this.settings.role === 'runner' && hunterIdx === 0) hunterIdx = 1 + Math.floor(Math.random() * (this.players.length - 1));
    const br = this.br;
    let ci = 0;
    this.sim = new Simulation(this.world);
    this.sim.onCarHit = (a, b, c, prev, p, n, mu) => this._carHit(a, b, c, prev, p, n, mu);
    this.sim.contactStiffness = (a, b, p, n) => { const s = this._crashSplit(a, b, p, n); return { ka: s.ka, kb: s.kb }; };
    this.sim.canCollide = (a, b) => this._canCollide(a, b);
    for (const [i, p] of this.players.entries()) {
      p.role = br ? 'solo' : i === hunterIdx ? 'hunter' : 'runner';
      // everyone starts the match in the role's starting car; cars won in the upgrader stay for the match
      p.car = br ? START_CAR.solo : START_CAR[p.role];
      p.garage = [p.car];
      p.color = br ? CAR_COLORS.solo[i % CAR_COLORS.solo.length]
        : p.role === 'hunter' ? CAR_COLORS.hunter : CAR_COLORS.runners[ci++ % CAR_COLORS.runners.length];
      p.charges = {}; p.cd = {};
      p.vehicle = this.sim.add(new Vehicle(specFor(p.car), this.world, { seed: 0x1234567 + i * 7919 }));
      p.vehicle.owner = p;
      p.vehicle.wallCrushFactor = RULES.fromWalls;
      p.alive = true; p.bot = { t: 0 };
      p.matchEarn = 0; p.wins = 0;
    }
    this.round = 0;
    this.score = { hunter: 0, runners: 0 };
    this.emit({ type: 'match', mode: this.settings.mode, hunter: br ? null : this.hunter.name });
    this._startUpgrade();
  }

  // swap the player's physics body when he changes car (keeps the pose)
  _ensureVehicle(p) {
    if (p.vehicle && p.vehicle.spec.id === p.car) return false;
    const old = p.vehicle;
    const v = new Vehicle(specFor(p.car), this.world, { seed: Math.floor(Math.random() * 1e9) });
    v.owner = p;
    v.wallCrushFactor = RULES.fromWalls;
    v.pushBar = CARS[p.car].pushBar ? 1 : 0;
    if (old) {
      const f = this._fwd(old);
      v.reset(old.pos[0], old.pos[2], Math.atan2(f[0], f[1]));
      v.frozen = old.frozen;
      this.sim.remove(old);
    }
    this.sim.add(v);
    p.vehicle = v;
    this.emit({ type: 'carChanged', player: p.id, car: p.car });
    return true;
  }

  _spawn() {
    for (const p of this.players) this._ensureVehicle(p);
    const br = this.br, rs = br ? this.players : this.runners, n = rs.length, base = Math.random() * Math.PI * 2;
    if (!br) this.hunter.vehicle.reset(0, 0, Math.random() * Math.PI * 2);
    rs.forEach((p, i) => {
      const a = base + (i / n) * Math.PI * 2, r = Math.min(55, this.arenaR * 0.55);
      p.vehicle.reset(Math.sin(a) * r, Math.cos(a) * r, a + Math.PI / 2); // facing along the circle
    });
    for (const p of this.players) {
      const v = p.vehicle;
      v.repair(); v.events.length = 0; v.frozen = true;
      v.pushBar = CARS[p.car].pushBar ? 1 : 0;
      p.alive = true; p.wreck = null; p.aliveTime = 0; p.lastHunterHit = -99; p.fx = []; p.wallHit = null;
      p.lastHitBy = null; p.lastHitT = -99; p.roundKills = 0;
      p.roundEarn = { income: 0, kills: 0, survive: 0, win: 0 };
      p.bot = { t: 0, target: null, dest: null, destT: 0, stuck: 0, reverseT: 0, modCd: rnd(1, 3), lastSeen: null };
    }
    for (const d of this.decoys) { this.sim.remove(d.vehicle); d.removed = true; }
    this.decoys = []; this.zones = []; this.smokes = []; this.harpoons = [];
  }

  _startUpgrade() {
    this.round++;
    this.state = 'upgrade';
    this.timer = RULES.upgraderTime;
    this._spawn();
    for (const p of this.players) {
      p.money += RULES.roundIncome;
      p.roundEarn.income = RULES.roundIncome;
      p.ready = false;
      if (p.isBot) this._planBotSpins(p);
    }
    this.emit({ type: 'state', state: 'upgrade' });
  }

  // cars of the player's role (the upgrader's list); in the battle royale all of them, with their own prices
  available(p) { return this.br ? CAR_LIST.solo : CAR_LIST[p.role]; }
  owns(p, carId) { return p.garage.includes(carId); }
  priceOf(carId) { const c = CARS[carId]; return this.br ? c.brPrice : c.price; }

  chanceFor(carId, bet) { const pr = this.priceOf(carId); return pr <= 0 ? 1 : clamp(bet / pr, 0, RULES.maxChance); }
  maxBet(p, carId) { return Math.max(0, Math.min(p.money, Math.floor(this.priceOf(carId) * RULES.maxChance))); }

  // the upgrader: the stake is gone either way; win → the car joins the player's garage and he drives it
  spin(p, carId, bet) {
    const c = CARS[carId];
    if (this.state !== 'upgrade' || !c || !this.available(p).includes(carId) || this.owns(p, carId) || this.priceOf(carId) <= 0) return null;
    bet = Math.floor(bet);
    if (bet < 1 || bet > p.money) return null;
    bet = Math.min(bet, this.maxBet(p, carId));
    const chance = this.chanceFor(carId, bet);
    p.money -= bet;
    const roll = Math.random();
    const win = roll < chance;
    if (win) { p.garage.push(carId); p.car = carId; this._ensureVehicle(p); }
    const res = { player: p.id, name: p.name, carId, car: c.name, bet, chance, roll, win };
    this.emit({ type: 'spin', ...res });
    return res;
  }

  // drive another car from the garage
  selectCar(p, carId) {
    if (this.state !== 'upgrade' || !this.owns(p, carId) || p.car === carId) return false;
    p.car = carId;
    this._ensureVehicle(p);
    return true;
  }

  setReady(p) { p.ready = true; }

  _planBotSpins(p) {
    p.botSpins = [];
    // aim for something a bit better than the current car (sometimes a long shot)
    const list = this.available(p);
    const cur = list.indexOf(p.car);
    const better = list.filter((id, i) => i > cur && !this.owns(p, id));
    if (!better.length || Math.random() < 0.2) return;
    const pick = Math.random() < 0.75 ? better[Math.min(better.length - 1, Math.floor(Math.random() * 2))] : better[Math.floor(Math.random() * better.length)];
    const bet = Math.floor(Math.min(p.money * rnd(0.4, 0.85), this.maxBet(p, pick)));
    if (bet >= 10) p.botSpins.push({ at: rnd(2, 8), id: pick, bet });
  }

  _startCountdown() {
    this.state = 'countdown';
    this.timer = RULES.getReadyTime;
    for (const p of this.players) {
      p.charges = {}; p.cd = {};
      const t = CARS[p.car].talent;
      // a talent with a cooldown works any number of times (p.cd counts down); the others have charges
      if (t && !TALENTS[t].passive) p.charges[t] = TALENTS[t].cooldown ? 1 : TALENTS[t].charges;
    }
    this.emit({ type: 'state', state: 'countdown' });
  }

  _startChase() {
    this.state = 'chase';
    this.timer = this.settings.chaseTime;
    this.time = 0;
    this.hunterHold = this.br ? 0 : RULES.hunterDelay;
    for (const p of this.players) p.vehicle.frozen = p.role === 'hunter';
    this.emit({ type: 'state', state: 'chase' });
  }

  _endRound(winner, reason) {
    if (this.state !== 'chase') return;
    const left = Math.max(this.timer, 0);
    this.state = 'roundEnd';
    this.timer = 6;
    this.score[winner]++;
    const h = this.hunter;
    if (winner === 'hunter') {
      const bonus = RULES.hunterWin + Math.floor(left * RULES.hunterWinPerSecond);
      h.money += bonus; h.roundEarn.win = bonus;
    }
    for (const p of this.runners) {
      const s = Math.floor(p.aliveTime * RULES.runnerPerSecond);
      p.money += s; p.roundEarn.survive = s;
      if (winner === 'runners') { p.money += RULES.runnerWin; p.roundEarn.win = RULES.runnerWin; }
    }
    for (const p of this.players) p.vehicle.frozen = true;
    this.lastRound = { winner, reason, round: this.round };
    this.emit({ type: 'roundEnd', winner, reason });
  }

  // battle royale: the last car still going wins the round (time out: the one who wrecked the most, then the least hurt)
  _endRoundBr(winner, reason) {
    if (this.state !== 'chase') return;
    this.state = 'roundEnd';
    this.timer = 6;
    for (const p of this.players) {
      const s = Math.floor(p.aliveTime * RULES.runnerPerSecond);
      p.money += s; p.roundEarn.survive = s;
    }
    if (winner) { winner.wins++; winner.money += RULES.brWin; winner.roundEarn.win = RULES.brWin; }
    for (const p of this.players) p.vehicle.frozen = true;
    this.lastRound = { winner: winner ? winner.id : null, reason, round: this.round, br: true };
    this.emit({ type: 'roundEnd', winner: winner ? winner.id : null, reason, br: true });
  }
  _brLeader(alive) {
    return alive.slice().sort((a, b) => (b.roundKills - a.roundKills) || (this.wear(a) - this.wear(b)))[0] || null;
  }
  // the match: most rounds won, then the most money
  brStandings() { return this.players.slice().sort((a, b) => (b.wins - a.wins) || (b.money - a.money)); }

  next() { // after the round summary
    if (this.state !== 'roundEnd') return;
    if (this.round >= RULES.rounds) {
      this.state = 'matchEnd';
      const w = this.br ? this.brStandings()[0].id : this.score.hunter > this.score.runners ? 'hunter' : 'runners';
      this.emit({ type: 'matchEnd', winner: w, br: this.br });
    } else this._startUpgrade();
  }

  // ---------------------------------------------------------------- per frame
  // input: the human's controls; actions: modification ids the human used this frame
  update(dt, input, actions = []) {
    if (!this.sim) return 0;
    input = input || {};
    input = { throttle: +input.throttle || 0, brake: +input.brake || 0, steer: +input.steer || 0, handbrake: !!input.handbrake };
    const human = this.human;
    if (this.state === 'upgrade') {
      this.timer -= dt;
      for (const p of this.players) {
        if (!p.isBot) continue;
        for (const s of p.botSpins) if (!s.done && RULES.upgraderTime - this.timer >= s.at) { s.done = true; if (p.money >= s.bet) this.spin(p, s.id, s.bet); }
        if (p.botSpins.every((s) => s.done) && RULES.upgraderTime - this.timer > 3) p.ready = true;
      }
      if (this.timer <= 0 || this.players.every((p) => p.ready)) this._startCountdown();
    } else if (this.state === 'countdown') {
      this.timer -= dt;
      if (this.timer <= 0) this._startChase();
    } else if (this.state === 'chase') {
      this.timer -= dt; this.time += dt;
      if (this.hunterHold > 0) {
        this.hunterHold -= dt;
        if (this.hunterHold <= 0) { this.hunter.vehicle.frozen = false; this.emit({ type: 'hunterGo' }); }
      }
      for (const p of this.players) if (p.alive && p.role !== 'hunter') p.aliveTime += dt;
      for (const p of this.players) if (p.cd) for (const k in p.cd) if (p.cd[k] > 0) p.cd[k] = Math.max(0, p.cd[k] - dt);
    } else if (this.state === 'roundEnd') {
      this.timer -= dt;
      if (this.timer <= 0) this.next();
    }

    // controls (online: a remote player's keys arrive as p.netInput / p.netActions)
    for (const p of this.players) {
      const v = p.vehicle;
      if (p.remote) v.input = (this.state === 'chase' || this.state === 'countdown') && p.netInput ? p.netInput : null;
      else if (!p.isBot) v.input = this.state === 'chase' || this.state === 'countdown' ? input : null;
      else v.input = this.state === 'chase' && p.alive ? this._bot(p, dt) : null;
    }
    for (const d of this.decoys) d.vehicle.input = this._decoyDrive(d, dt);
    if (this.state === 'chase') {
      if (human && human.alive && !human.remote) for (const id of actions) this.useMod(human, id === 'talent' ? CARS[human.car].talent : id);
      for (const p of this.players) {
        if (!p.remote || !p.netActions || !p.netActions.length) continue;
        for (const id of p.netActions.splice(0)) if (p.alive) this.useMod(p, id === 'talent' ? CARS[p.car].talent : id);
      }
      this._applyZones(dt);
    }

    this.alpha = this.sim.step(dt);

    // wall / roll-over hits crush the body; hand the visual events to the renderer
    for (const p of this.players) {
      const v = p.vehicle;
      const evs = v.events.splice(0);
      for (const ev of evs) {
        if (ev.type === 'hit') {
          if (this.state === 'chase' && p.alive && ev.speed > RULES.wallMinSpeed &&
              (ev.kind === 'wall' || (ev.kind === 'ground' && this._upY(v) < 0.6))) this._wallHit(p, ev);
          continue;
        }
        p.fx.push(ev); if (p.fx.length > 64) p.fx.shift();
      }
      for (const ev of v.events) { p.fx.push(ev); if (p.fx.length > 64) p.fx.shift(); }   // impacts just made
      v.events.length = 0;
    }
    for (const d of this.decoys) d.vehicle.events.length = 0;
    if (this.state === 'chase') for (const p of this.players) if (p.alive) { this._landing(p); this._autoFlip(p, dt); }

    if (this.state === 'chase') {
      this._updateTimed(dt);
      this._sideSpikes();
      if (this.br) {
        const alive = this.players.filter((p) => p.alive);
        if (alive.length <= 1) this._endRoundBr(alive[0] || null, alive.length ? 'lastStanding' : 'allDestroyed');
        else if (this.timer <= 0) this._endRoundBr(this._brLeader(alive), 'time');
        return this.alpha;
      }
      const alive = this.runners.filter((p) => p.alive).length;
      if (alive === 0) this._endRound('hunter', 'allDestroyed');
      else if (!this.hunter.alive) this._endRound('runners', 'hunterDestroyed');
      else if (this.timer <= 0) this._endRound('runners', 'time');
    }
    return this.alpha;
  }

  // A fall: follow the vertical speed; when most of it is gone at once (the car hit the ground — or a car under
  // it), that was a landing at the fastest speed it fell. On the wheels it breaks the running gear and shakes the
  // rest (on the roof/side the body contacts crush it already, see _wallHit).
  _landing(p) {
    const v = p.vehicle, L = p.land || (p.land = { minVy: 0 });
    const vy = v.vel[1];
    if (vy < L.minVy) { L.minVy = vy; return; }
    if (vy < L.minVy * 0.3) return;                       // still falling / still being caught by the springs
    const fall = -L.minVy;
    L.minVy = Math.min(0, vy);
    const safe = CARS[p.car].landing || RULES.landSafe, up = this._upY(v);
    if (up < 0.6) {
      // on the roof: the whole roof comes down on the seats; on the side: the doors cave in
      if (fall <= RULES.landRoofSafe) return;
      const E = 0.5 * v.m * (fall * fall - RULES.landRoofSafe ** 2) * RULES.landRoof;
      if (up < -0.3) { const ds = v.driverSeat; v.absorbRoof([ds[0], v.topAt(ds[1]), ds[1]], [0, -1, 0], E); }
      else {
        const g = v.dirToLocal([0, -1, 0]), s = g[0] >= 0 ? 1 : -1, x1 = v.spec.outline[s > 0 ? 1 : 0];
        v.absorbHit([x1, 0.2, 0], [-s, 0, 0], E, 'ground');
      }
      this.emit({ type: 'fx', kind: 'landing', player: p.id, h: E / (v.m * 9.81 * 0.35), x: v.pos[0], y: v.pos[1], z: v.pos[2] });
      this._checkWreck(p);
      return;
    }
    if (fall <= safe) return;
    const h = (fall * fall - safe * safe) / (2 * 9.81);      // metres of drop above what the car takes
    const on = [];
    for (let i = 0; i < 4; i++) if (v.wheels[i].contact && !v.wheels[i].detached) on.push(i);
    const D = v.damage, share = on.length ? Math.min(2, 4 / on.length) : 1;
    for (const i of on.length ? on : [0, 1, 2, 3]) {
      D.susp[i] = Math.min(1, D.susp[i] + RULES.landSusp * h * share);
      D.wheels[i] = Math.min(1, D.wheels[i] + RULES.landWheel * h * share);
    }
    D.engine = Math.min(1, D.engine + RULES.landEngine * h);
    D.gearbox = Math.min(1, D.gearbox + RULES.landGearbox * h);
    D.body = Math.min(1, D.body + RULES.landBody * h);
    D.driver = Math.min(1, D.driver + RULES.landDriver * Math.max(0, h - 1.5));
    this.emit({ type: 'fx', kind: 'landing', player: p.id, h, x: v.pos[0], y: v.pos[1], z: v.pos[2] });
    this._checkWreck(p);
  }
  // lying on the roof or the side (or hung up with its wheels off the ground) and not moving: count up, then
  // put it back on its wheels where it is (p.flipT drives the countdown on the screen)
  _autoFlip(p, dt) {
    const v = p.vehicle;
    let onWheels = 0;
    for (const w of v.wheels) if (w.contact && !w.detached) onWheels++;
    const stuck = (this._upY(v) < 0.5 || onWheels < 2) && Math.abs(v.speed) < RULES.autoFlipSpeed && Math.hypot(v.vel[1], v.w[0], v.w[1], v.w[2]) < 1;
    if (!stuck) { p.flipT = 0; return; }
    p.flipT = (p.flipT || 0) + dt;
    if (p.flipT >= RULES.autoFlip) {
      p.flipT = 0;
      v.recover();
      this.emit({ type: 'fx', kind: 'autoFlip', player: p.id });
    }
  }
  _upY(v) { return 1 - 2 * (v.q[0] * v.q[0] + v.q[2] * v.q[2]); }

  // one crash = one hit: a second touch of the same spot right after only adds the energy above the first one
  _wallHit(p, ev) {
    const v = p.vehicle;
    let E = 0.5 * ev.mu * ev.speed * ev.speed * (1 - WALL_RESTITUTION * WALL_RESTITUTION);
    const w = p.wallHit;
    if (w && this.time - w.t < 0.4 && Math.hypot(ev.p[0] - w.p[0], ev.p[2] - w.p[2]) < 1.2) {
      const add = Math.max(0, E - w.E); w.E = Math.max(w.E, E); w.t = this.time; E = add;
    } else p.wallHit = { t: this.time, E, p: ev.p };
    if (E <= 0) return;
    let Eb = E * (ev.kind === 'ground' ? RULES.fromGround : RULES.fromWalls);
    // a push bar takes a front hit first, and bends
    if (v.pushBar > 0 && v.isFrontHit(ev.p, ev.n)) {
      const take = Math.min(Eb * 0.85, v.pushBar * RULES.pushBarEnergy);
      v.pushBar = Math.max(0, v.pushBar - take / RULES.pushBarEnergy);
      Eb -= take;
      this.emit({ type: 'fx', kind: 'pushBar', player: p.id, state: v.pushBar });
    }
    // the VAZ's wedge takes nearly all of a front hit, and a hard one smashes it off
    if (v.ram > 0 && v.isFrontHit(ev.p, ev.n)) {
      const take = Math.min(Eb * 0.9, v.ram * RULES.wedgeWallEnergy);
      v.ram = Math.max(0, v.ram - take / RULES.wedgeWallEnergy);
      Eb -= take;
      if (v.ram < 0.02) { v.ram = 0; this.emit({ type: 'fx', kind: 'ramOff', player: p.id }); }
      else this.emit({ type: 'fx', kind: 'ram', player: p.id, state: v.ram });
    }
    // the roof (upside down, on the side against a wall) crushes too; the floor pan doesn't
    const ny = ev.n[1] / (Math.hypot(ev.n[0], ev.n[1], ev.n[2]) || 1);
    if (ny < -0.6) v.absorbRoof(ev.p, ev.n, Eb);
    else if (ny > 0.6) return;
    else v.absorbHit(ev.p, ev.n, Eb, ev.kind);
    this._checkWreck(p);
  }

  // wrecked = can't go faster than RULES.wreckSpeed any more (or the driver is dead). Standing still is fine.
  _checkWreck(p) {
    if (!p.alive) return;
    // a smashed wheel or a broken suspension (red on the panel): the wheel comes off
    const v = p.vehicle, D = v.damage;
    for (let i = 0; i < 4; i++) {
      if (!v.wheels[i].detached && (D.wheels[i] >= 0.9 || D.susp[i] >= 0.8) && v.detachWheel(i)) {
        this.emit({ type: 'fx', kind: 'wheelOff', player: p.id, wheel: i });
      }
    }
    const why = p.vehicle.wreckReason(RULES.wreckSpeed);
    if (why) this._destroy(p, why);
  }

  // a 0..1 measure of how hurt a car is (bots use it)
  wear(p) {
    const D = p.vehicle.damage;
    return Math.max(D.engine, D.gearbox, ...D.susp, D.driver * 0.9, ...D.wheels.map((d) => d * 0.6), ...D.brakes.map((d) => d * 0.5));
  }

  _destroy(p, why) {
    p.alive = false;
    p.wreck = why || 'drive';
    p.vehicle.destroyed = true;
    const v = p.vehicle;
    // the blast throws every wheel off
    for (let i = 0; i < 4; i++) v.detachWheel(i);
    this.emit({ type: 'fx', kind: 'wheelOff', player: p.id, wheel: -1 });
    this.emit({ type: 'fx', kind: 'explode', x: v.pos[0], y: v.pos[1], z: v.pos[2], player: p.id });
    if (this.br) {
      // whoever hit it last (not long ago) gets the credit; crashed on its own — nobody
      const k = p.lastHitBy && p.lastHitBy !== p && this.time - p.lastHitT <= RULES.creditWindow ? p.lastHitBy : null;
      if (k) { k.money += RULES.brKill; k.roundEarn.kills += RULES.brKill; k.roundKills++; }
      this.emit({ type: 'kill', victim: p.name, victimId: p.id, by: k ? k.name : null, byId: k ? k.id : null, reward: k ? RULES.brKill : 0, full: !!k, why: p.wreck, br: true });
    } else if (p.role === 'runner') {
      const h = this.hunter;
      const full = this.time - p.lastHunterHit <= RULES.creditWindow;
      const reward = Math.round(RULES.hunterPool / this.runners.length * (full ? 1 : 0.5));
      h.money += reward; h.roundEarn.kills += reward;
      this.emit({ type: 'kill', victim: p.name, victimId: p.id, by: h.name, reward, full, why: p.wreck });
    } else {
      this.emit({ type: 'kill', victim: p.name, victimId: p.id, by: null, reward: 0, hunter: true, why: p.wreck });
    }
    for (const hp of this.harpoons) if (hp.runner === p) hp.t = 0;
  }

  _canCollide(a, b) {
    const da = a.decoy, db = b.decoy;
    if (!da && !db) return true;
    if (da && db) return false;
    const other = da ? b.owner : a.owner;
    if (this.br) return !!other && other !== (da ? a : b).decoyOwner;   // anyone but its owner (and it pops)
    return other && other.role === 'hunter';                            // a decoy only bumps into the hunter
  }

  // Who takes how much of a car-to-car crash. Each body's stiffness at the touching spot is divided by its share
  // factor (a body that takes less of the energy acts stiffer); the hunter's front bumper is a ram: rigid.
  _crashSplit(a, b, p, n) {
    const la = a.toLocal(p), na = a.dirToLocal(n);                 // n points from b into a
    const lb = b.toLocal(p), nb = b.dirToLocal([-n[0], 0, -n[2]]);
    const pa = a.owner, pb = b.owner;
    let fa = 1, fb = 1, H = null;
    if (pa && pb && !a.decoy && !b.decoy && this.br) {
      // battle royale: the same for everyone; only the 'ram' talent hits harder and takes less
      fa = fb = RULES.brVsCar;
      if (CARS[pa.car].talent === 'ram') { fa *= RULES.ramSelf; fb *= RULES.ramBonus; }
      if (CARS[pb.car].talent === 'ram') { fb *= RULES.ramSelf; fa *= RULES.ramBonus; }
    } else if (pa && pb && !a.decoy && !b.decoy) {
      H = pa.role === 'hunter' ? pa : pb.role === 'hunter' ? pb : null;
      if (H) {
        const ram = CARS[H.car].talent === 'ram';
        const fH = RULES.hunterFromCars * (ram ? RULES.ramSelf : 1), fR = ram ? RULES.ramBonus : 1;
        if (H === pa) { fa = fH; fb = fR; } else { fa = fR; fb = fH; }
      } else fa = fb = RULES.runnerVsRunner;
    }
    // a push bar: its car's front much stiffer, the car it hits takes more
    const bar = (v, l, n) => (v.pushBar > 0 && v.isFrontHit(l, n) ? v.pushBar : 0);
    const ba = pa && pb ? bar(a, la, na) : 0, bb = pa && pb ? bar(b, lb, nb) : 0;
    if (ba) fb *= 1 + RULES.pushBarOther * ba;
    if (bb) fa *= 1 + RULES.pushBarOther * bb;
    // the VAZ's wedge: the same, harder
    const wedge = (v, l, n) => (v.ram > 0 && v.isFrontHit(l, n) ? 1 : 0);
    const ra = pa && pb ? wedge(a, la, na) : 0, rb = pa && pb ? wedge(b, lb, nb) : 0;
    if (ra) fb *= 1 + RULES.wedgeOther;
    if (rb) fa *= 1 + RULES.wedgeOther;
    let ka = a.stiffnessAt(na) / fa * (1 + RULES.pushBarSelf * ba) * (1 + RULES.wedgeSelf * ra), kb = b.stiffnessAt(nb) / fb * (1 + RULES.pushBarSelf * bb) * (1 + RULES.wedgeSelf * rb);
    if (H === pa && a.isFrontHit(la, na)) ka = Infinity;
    if (H === pb && b.isFrontHit(lb, nb)) kb = Infinity;
    return { la, na, lb, nb, ka, kb, fa, fb, H, ra, rb };
  }

  // Car-to-car crash: the energy lost in the hit (½·μ·v², the bodies crumple instead of bouncing) is split between
  // the two bodies like between two springs in a row (the softer one takes more), then turns into crush and parts.
  _carHit(a, b, closing, prev, p, n, mu) {
    if (this.state !== 'chase') return;
    if (a.decoy || b.decoy) {
      const d = this.decoys.find((x) => x.vehicle === (a.decoy ? a : b));
      if (d && d.t > 0) { d.t = 0; this.emit({ type: 'fx', kind: 'decoyPop', x: d.vehicle.pos[0], y: d.vehicle.pos[1], z: d.vehicle.pos[2] }); }
      return;
    }
    const pa = a.owner, pb = b.owner;
    const E = 0.5 * mu * Math.max(0, closing * closing - prev * prev);
    const s = this._crashSplit(a, b, p, n);
    if (s.H) (s.H === pa ? pb : pa).lastHunterHit = this.time;
    if (this.br) { pa.lastHitBy = pb; pa.lastHitT = this.time; pb.lastHitBy = pa; pb.lastHitT = this.time; }
    // a roof (one car on its side or upside down) is rigid for the physics, but it takes its share of the damage
    const roof = (n) => n[1] < -0.6 * Math.hypot(n[0], n[1], n[2]);
    const roofA = roof(s.na), roofB = roof(s.nb);
    const ka = roofA ? a.stiff.roof / s.fa : s.ka, kb = roofB ? b.stiff.roof / s.fb : s.kb;
    const shareA = ka === Infinity ? 0 : kb === Infinity ? 1 : kb / (ka + kb);
    // crush = √(2·E·share/k') = √(2·E·share·f/k): same as the bodies' plastic overlap in the physics
    if (roofA) a.absorbRoof(s.la, s.na, E * shareA * s.fa); else a.absorbHit(s.la, s.na, E * shareA * s.fa, 'car');
    if (roofB) b.absorbRoof(s.lb, s.nb, E * (1 - shareA) * s.fb); else b.absorbHit(s.lb, s.nb, E * (1 - shareA) * s.fb, 'car');
    // the wedge wears a little and lifts the car it rams
    for (const [v, pl, o, on] of [[a, pa, b, s.ra], [b, pb, a, s.rb]]) {
      if (!on) continue;
      v.ram = Math.max(0, v.ram - E / RULES.wedgeCarEnergy);
      if (closing - prev > 1) o.vel[1] += Math.min(2, (closing - prev) * 0.15);
      if (v.ram < 0.02) { v.ram = 0; this.emit({ type: 'fx', kind: 'ramOff', player: pl.id }); }
      else this.emit({ type: 'fx', kind: 'ram', player: pl.id, state: v.ram });
    }
    this._checkWreck(pa); this._checkWreck(pb);
    this.emit({ type: 'carHit', a: pa.id, b: pb.id, speed: closing, x: p[0], y: p[1], z: p[2] });
  }

  // ---------------------------------------------------------------- modifications
  talentOf(p) { return CARS[p.car].talent; }
  // cars on the Alfa's flipper plate: just in front of its bumper, about as wide as the car
  _flipTargets(p) {
    const v = p.vehicle, sp = v.spec, x1 = sp.outline[1], zf = sp.bodyFront, out = [], l = new Float64Array(3), q = [0, 0, 0];
    for (const o of this.players) {
      if (o === p || !o.alive || !o.vehicle) continue;
      const ov = o.vehicle;
      if (Math.hypot(ov.pos[0] - v.pos[0], ov.pos[2] - v.pos[2]) > 10) continue;
      const W = ov.outlineWorld();
      for (let i = 0; i < W.length; i += 3) {
        q[0] = W[i]; q[1] = W[i + 1]; q[2] = W[i + 2];
        v.toLocal(q, l);
        if (l[2] > zf - 0.5 && l[2] < zf + FLIP_REACH && Math.abs(l[0]) < x1 + 0.7 && l[1] > -0.9 && l[1] < 1.5) { out.push(o); break; }
      }
    }
    return out;
  }
  talentName(id) { const t = TALENTS[id]; return (this.br && t.nameBr) || t.name; }
  talentDesc(id) { const t = TALENTS[id]; return (this.br && t.descBr) || t.desc; }

  useMod(p, id) {
    const T = TALENTS[id];
    if (this.state !== 'chase' || !p.alive || !(p.charges[id] > 0)) return false;
    if (T && T.cooldown && p.cd && p.cd[id] > 0) return false;
    if (p.role === 'hunter' && this.hunterHold > 0) return false;
    const v = p.vehicle, f = this._fwd(v), x = v.pos[0], z = v.pos[2];
    const H = this.hunter;
    let ok = true;
    switch (id) {
      case 'nitro': v.boost = 3; this.emit({ type: 'fx', kind: 'nitro', player: p.id }); break;
      case 'repair': {
        if (this.wear(p) < 0.05) { ok = false; break; }
        v.repairParts(0.5);
        this.emit({ type: 'fx', kind: 'repair', player: p.id });
        break;
      }
      case 'smoke': {
        const s = { x: x - f[0] * 4, z: z - f[1] * 4, r: 8, t: 8 };
        this.smokes.push(s); this.emit({ type: 'fx', kind: 'smoke', x: s.x, z: s.z, r: s.r, t: s.t }); break;
      }
      case 'oil': {
        const zn = { type: 'oil', x: x - f[0] * 5, z: z - f[1] * 5, r: 4.5, t: 14 };
        this.zones.push(zn); this.emit({ type: 'fx', kind: 'zone', zone: zn }); break;
      }
      case 'jump': {
        if (v.wheels.filter((w) => w.contact).length < 2) { ok = false; break; }
        v.vel[1] += 6.8; v.vel[0] += f[0] * 1.5; v.vel[2] += f[1] * 1.5;
        this.emit({ type: 'fx', kind: 'jump', player: p.id }); break;
      }
      case 'decoy': ok = this._spawnDecoy(p); break;
      case 'flip': {
        // the plate kicks up whatever is on it (it fires even with nothing there)
        const hit = this._flipTargets(p);
        for (const o of hit) {
          const ov = o.vehicle, k = clamp(Math.pow(1500 / ov.m, 0.35), 0.62, 1.1);
          ov.vel[1] += RULES.flipLift * k;
          ov.vel[0] += f[0] * RULES.flipPush * k; ov.vel[2] += f[1] * RULES.flipPush * k;
          ov.w[0] += f[1] * RULES.flipSpin * k; ov.w[2] -= f[0] * RULES.flipSpin * k;   // its near side goes up
          o.lastHitBy = p; o.lastHitT = this.time;
          if (!this.br && p.role === 'hunter' && o.role !== 'hunter') o.lastHunterHit = this.time;
        }
        if (hit.length) v.vel[1] -= 0.6;
        this.emit({ type: 'fx', kind: 'flip', player: p.id, hit: hit.map((o) => o.id) });
        break;
      }
      case 'swapRunner': {
        // the danger: the hunter (battle royale: the nearest rival); swap with the one furthest from it
        const T = this.br ? this._nearestRival(p) : H;
        const others = (this.br ? this.players : this.runners).filter((o) => o !== p && o !== T && o.alive);
        if (!T || !others.length) { ok = false; if (this.br && !p.isBot) this.emit({ type: 'toast', player: p.id, text: 'Подмена: нужно хотя бы два соперника' }); break; }
        others.sort((a, b) => this._dist(a.vehicle, T.vehicle) - this._dist(b.vehicle, T.vehicle));
        const o = others[others.length - 1];
        this.emit({ type: 'fx', kind: 'swap', a: p.id, b: o.id, from: [x, z], to: [o.vehicle.pos[0], o.vehicle.pos[2]] });
        swapVehicles(v, o.vehicle);
        break;
      }
      case 'swapHunter': {
        const T = this.br ? this._nearestRival(p) : H;   // battle royale: the nearest rival
        if (!T) { ok = false; break; }
        if (this._dist(v, T.vehicle) < 30) { ok = false; if (!p.isBot) this.emit({ type: 'toast', player: p.id, text: (this.br ? 'Соперник' : 'Ловец') + ' ближе 30 м — обмен невозможен' }); break; }
        this.emit({ type: 'fx', kind: 'swap', a: p.id, b: T.id, from: [x, z], to: [T.vehicle.pos[0], T.vehicle.pos[2]] });
        swapVehicles(v, T.vehicle);
        break;
      }
      case 'spikes': {
        const d = 14, zn = { type: 'spikes', owner: p, x: x + f[0] * d, z: z + f[1] * d, dx: -f[1], dz: f[0], len: 4.5, wid: 0.8, t: 20, hit: new Set() };
        this.zones.push(zn); this.emit({ type: 'fx', kind: 'zone', zone: zn }); break;
      }
      case 'glue': {
        const zn = { type: 'glue', owner: p, x: x + f[0] * 18, z: z + f[1] * 18, r: 5, t: 10 };
        this.zones.push(zn); this.emit({ type: 'fx', kind: 'zone', zone: zn }); break;
      }
      case 'harpoon': {
        let best = null, bd = 30;
        for (const r of this.br ? this.players : this.runners) {
          if (!r.alive || r === p) continue;
          const dx = r.vehicle.pos[0] - x, dz = r.vehicle.pos[2] - z, d = Math.hypot(dx, dz);
          if (d < bd && (dx * f[0] + dz * f[1]) / d > Math.cos(0.7)) { bd = d; best = r; }
        }
        if (!best) { ok = false; if (!p.isBot) this.emit({ type: 'toast', player: p.id, text: 'Гарпун: впереди никого ближе 30 м' }); break; }
        // (the record's fields: hunter = who pulls, runner = who is pulled)
        const hp = { hunter: p, runner: best, t: 2.5 };
        this.harpoons.push(hp); this.emit({ type: 'fx', kind: 'harpoon', hunter: p.id, runner: best.id }); break;
      }
      default: ok = false;
    }
    if (ok) {
      if (T && T.cooldown) { p.cd = p.cd || {}; p.cd[id] = T.cooldown; } else p.charges[id]--;
      this.emit({ type: 'talent', player: p.id, id });
    }
    return ok;
  }

  _spawnDecoy(p) {
    const v = p.vehicle, f = this._fwd(v);
    const side = Math.random() < 0.5 ? 1 : -1;
    const ang = Math.atan2(f[0], f[1]) + side * 0.45;
    const x = v.pos[0] - f[1] * side * 3.2, z = v.pos[2] + f[0] * side * 3.2;
    if (this.world.sdf(x, z) < 3) return false;
    const d = new Vehicle(v.spec, this.world, { seed: Math.floor(Math.random() * 1e9) });
    d.decoy = true; d.decoyOwner = p;
    d.reset(x, z, ang);
    const sp = Math.max(v.speed, 12);
    d.vel[0] = Math.sin(ang) * sp; d.vel[2] = Math.cos(ang) * sp;
    for (const w of d.wheels) w.omega = sp / w.radius;
    this.sim.add(d);
    const rec = { owner: p, vehicle: d, t: 6, heading: ang };
    this.decoys.push(rec);
    // bot hunters fall for it most of the time (battle royale: the bots that were after its owner)
    for (const h of this.players) {
      if (!h.isBot || h === p || Math.random() >= 0.7) continue;
      if (this.br ? h.bot.target === p : h.role === 'hunter') h.bot.decoy = rec;
    }
    this.emit({ type: 'fx', kind: 'decoy', owner: p.id, decoy: rec });
    return true;
  }

  _decoyDrive(d) {
    const v = d.vehicle;
    const want = this._avoidWalls(v, d.heading);
    return { throttle: 1, brake: 0, steer: this._steerTo(v, want), handbrake: false };
  }

  // Spikes along a car's sides (GT3 R): the tyres they touch burst — less the more that side is caved in
  spikeSharpness(v, side) {
    let sum = 0, n = 0;
    for (let i = 0; i < v.stations.length; i++) if (v.stations[i].nx * side > 0.9) { sum += v.crush[i]; n++; }
    return clamp(1 - (n ? sum / n : 0) / 0.22, 0, 1);
  }
  _sideSpikes() {
    for (const p of this.players) {
      if (!p.alive || !CARS[p.car].sideSpikes) continue;
      const v = p.vehicle, sp = v.spec, x1 = sp.outline[1];
      const zs = sp.wheels.map((w) => w.pos[2] - sp.com[2]), z0 = Math.min(...zs) + 0.45, z1 = Math.max(...zs) - 0.45;
      const yS = 0.38 - sp.com[1];
      for (const o of this.players) {
        if (o === p || !o.alive || this._dist(v, o.vehicle) > 7) continue;
        const ov = o.vehicle;
        for (const wh of ov.wheels) {
          if (wh.detached) continue;
          const l = v.toLocal([wh.cp[0] + wh.n[0] * wh.radius, wh.cp[1] + wh.n[1] * wh.radius, wh.cp[2] + wh.n[2] * wh.radius]);
          const side = l[0] >= 0 ? 1 : -1, out = Math.abs(l[0]) - x1;
          if (out < -0.12 || out > 0.38 || l[2] < z0 - 0.2 || l[2] > z1 + 0.2 || Math.abs(l[1] - yS) > wh.radius + 0.05) continue;
          const dmg = 0.8 * this.spikeSharpness(v, side);
          if (dmg < 0.12 || ov.damage.wheels[wh.idx] >= dmg - 0.01) continue;
          ov.damage.wheels[wh.idx] = dmg;
          if (!wh.toeSign) wh.toeSign = Math.random() < 0.5 ? -1 : 1;
          this.emit({ type: 'fx', kind: 'puncture', player: o.id, wheel: wh.idx, by: p.id });
        }
      }
    }
  }

  _applyZones(dt) {
    for (const p of this.players) {
      const v = p.vehicle;
      v.extDamp = 0; v.extForce.fill(0);
      for (const wh of v.wheels) wh.zoneGrip = 1;
      for (const zn of this.zones) {
        if (zn.type === 'oil') {
          for (const wh of v.wheels) if (Math.hypot(wh.cp[0] - zn.x, wh.cp[2] - zn.z) < zn.r) wh.zoneGrip = 0.3;
        } else if (zn.type === 'glue' && zn.owner !== p) {
          if (Math.hypot(v.pos[0] - zn.x, v.pos[2] - zn.z) < zn.r) v.extDamp = 1.8;
        } else if (zn.type === 'spikes' && zn.owner !== p) {
          for (const wh of v.wheels) {
            if (!wh.contact) continue;
            const rx = wh.cp[0] - zn.x, rz = wh.cp[2] - zn.z;
            const u = rx * zn.dx + rz * zn.dz, w = rx * -zn.dz + rz * zn.dx;
            const key = p.id * 10 + wh.idx;
            if (Math.abs(u) < zn.len && Math.abs(w) < zn.wid && !zn.hit.has(key)) {
              zn.hit.add(key);
              v.damage.wheels[wh.idx] = Math.max(v.damage.wheels[wh.idx], 0.8);
              if (!wh.toeSign) wh.toeSign = Math.random() < 0.5 ? -1 : 1;
              this.emit({ type: 'fx', kind: 'puncture', player: p.id, wheel: wh.idx });
            }
          }
        }
      }
    }
    for (const hp of this.harpoons) {
      if (hp.t <= 0) continue;
      const a = hp.hunter.vehicle, b = hp.runner.vehicle;
      const dx = a.pos[0] - b.pos[0], dz = a.pos[2] - b.pos[2], d = Math.hypot(dx, dz);
      if (d > 50 || !hp.runner.alive || !hp.hunter.alive) { hp.t = 0; continue; }
      b.extForce[0] += dx / d * 7; b.extForce[2] += dz / d * 7;
      b.extDamp = Math.max(b.extDamp, 0.6);
    }
  }

  _updateTimed(dt) {
    for (const zn of this.zones) zn.t -= dt;
    for (const s of this.smokes) s.t -= dt;
    for (const hp of this.harpoons) hp.t -= dt;
    this.zones = this.zones.filter((z) => z.t > 0);
    this.smokes = this.smokes.filter((s) => s.t > 0);
    this.harpoons = this.harpoons.filter((h) => h.t > 0);
    for (const d of this.decoys) {
      d.t -= dt;
      if (d.t <= 0 && !d.removed) {
        d.removed = true;
        this.sim.remove(d.vehicle);
        this.emit({ type: 'fx', kind: 'decoyGone', decoy: d, x: d.vehicle.pos[0], y: d.vehicle.pos[1], z: d.vehicle.pos[2] });
      }
    }
    this.decoys = this.decoys.filter((d) => !d.removed);
  }

  // ---------------------------------------------------------------- bots
  _fwd(v) { // forward direction on the ground (x, z)
    const q = v.q;
    const fx = 2 * (q[0] * q[2] + q[3] * q[1]), fz = 1 - 2 * (q[0] * q[0] + q[1] * q[1]);
    const l = Math.hypot(fx, fz) || 1;
    return [fx / l, fz / l];
  }
  _heading(v) { const f = this._fwd(v); return Math.atan2(f[0], f[1]); }
  _dist(a, b) { return Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]); }
  _nearestRival(p) {
    let best = null, bd = Infinity;
    for (const o of this.players) {
      if (o === p || !o.alive) continue;
      const d = this._dist(p.vehicle, o.vehicle);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  // steering input (+ = left) towards a world heading
  _steerTo(v, heading) {
    const err = wrap(heading - this._heading(v));
    return clamp(err * 2.2, -1, 1);
  }

  // bend a wanted heading away from walls ahead
  _avoidWalls(v, want) {
    const sp = Math.max(Math.abs(v.speed), 5);
    const look = 5 + sp * 0.9;
    const probe = (ang) => this.world.sdf(v.pos[0] + Math.sin(ang) * look, v.pos[2] + Math.cos(ang) * look);
    if (probe(want) > 5) return want;
    let best = want, bv = -1e9;
    for (let k = -6; k <= 6; k++) {
      const a = want + k * 0.25, s = probe(a) - Math.abs(k) * 0.4;
      if (s > bv) { bv = s; best = a; }
    }
    return best;
  }

  // free distance from (x, z) along a heading until the wall
  _rayWall(x, z, ang, max = 100) {
    const sx = Math.sin(ang), sz = Math.cos(ang);
    for (let d = 2; d < max; d += 2) if (this.world.sdf(x + sx * d, z + sz * d) < 1.6) return d;
    return max;
  }

  _drive(p, dt, tx, tz, opts = {}) {
    const v = p.vehicle, b = p.bot;
    const sp = Math.abs(v.speed), heading = this._heading(v);
    const want = Math.atan2(tx - v.pos[0], tz - v.pos[2]);
    const head = opts.ram && this._rayWall(v.pos[0], v.pos[2], want, 30) >= 30 ? want : this._avoidWalls(v, want);
    const err = wrap(head - heading);
    let steer = clamp(err * 2.2, -1, 1), throttle = 1, brake = 0;
    if (Math.abs(err) > 1.2 && sp > 20 && !opts.noBrake) { throttle = 0; brake = 0.6; }
    // going at the wall too fast to stop or turn away: turn towards the middle and brake
    const travel = sp > 4 ? Math.atan2(v.vel[0], v.vel[2]) : heading;
    const wallD = this._rayWall(v.pos[0], v.pos[2], travel);
    const stopD = opts.ram ? Math.min(sp * sp / (2 * 13) + sp * 0.3 + 3, 24) : sp * sp / (2 * 13) + sp * 0.3 + 3;
    if (wallD < stopD) {
      steer = clamp(wrap(Math.atan2(-v.pos[0], -v.pos[2]) - heading) * 3, -1, 1);
      if (wallD < stopD * 0.75 && sp > 8) { throttle = 0; brake = 1; } else { throttle = 0.25; brake = 0; }
    }
    // other cars (and wrecks): predict the closest approach and steer clear (keep right when head-on).
    // The hunter only avoids wrecks; an attacker in the battle royale avoids everyone but his target.
    const f = this._fwd(v);
    for (const o of this.players) {
      if (o === p || (opts.ignore && (opts.ignore === true ? o.alive : o === opts.ignore))) continue;
      const ov = o.vehicle;
      const dx = ov.pos[0] - v.pos[0], dz = ov.pos[2] - v.pos[2];
      const wx = ov.vel[0] - v.vel[0], wz = ov.vel[2] - v.vel[2], w2 = wx * wx + wz * wz;
      let t = w2 > 1 ? -(dx * wx + dz * wz) / w2 : 0;
      if (t < 0 || t > 2.2) { if (Math.hypot(dx, dz) > 6) continue; t = 0; }
      const cx = dx + wx * t, cz = dz + wz * t, miss = Math.hypot(cx, cz);
      if (miss > 5) continue;
      const lat = cx * f[1] - cz * f[0];   // > 0: it will pass on our left
      const k = (1 - miss / 5) * (1.6 - t * 0.5);
      steer = clamp(steer + (Math.abs(lat) < 0.5 ? -1 : -Math.sign(lat)) * k * 2, -1, 1);
      if (t < 0.9 && miss < 3 && sp > 15) { throttle = 0; brake = 0.8; }
    }
    // stuck against something: back off for a moment
    if (Math.abs(v.speed) < 1.5) b.stuck += dt; else b.stuck = 0;
    if (b.stuck > 1.2 && b.reverseT <= 0) { b.reverseT = 1.1; b.stuck = 0; b.revSteer = -Math.sign(steer || 1); }
    if (b.reverseT > 0) {
      b.reverseT -= dt;
      return { throttle: 0, brake: 1, steer: b.revSteer, handbrake: false };
    }
    return { throttle, brake, steer, handbrake: false };
  }

  _visible(from, to) {
    for (const s of this.smokes) {
      const ax = from.pos[0], az = from.pos[2], bx = to.pos[0] - ax, bz = to.pos[2] - az;
      const l2 = bx * bx + bz * bz || 1;
      const t = clamp(((s.x - ax) * bx + (s.z - az) * bz) / l2, 0, 1);
      if (Math.hypot(ax + bx * t - s.x, az + bz * t - s.z) < s.r) return false;
    }
    return true;
  }

  _bot(p, dt) {
    const b = p.bot;
    b.t += dt; b.modCd -= dt;
    if (CARS[p.car].talent === 'flip' && !(p.cd && p.cd.flip > 0) && !(p.role === 'hunter' && this.hunterHold > 0)) {
      const foes = this._flipTargets(p).filter((o) => this.br || (o.role === 'hunter') !== (p.role === 'hunter'));
      if (foes.length) this.useMod(p, 'flip');
    }
    if (this.br) return this._botBr(p, dt);
    return p.role === 'hunter' ? this._botHunter(p, dt) : this._botRunner(p, dt, this.hunter);
  }

  // battle royale: hunt the others; badly hurt — run from whoever is nearest
  _botBr(p, dt) {
    const b = p.bot, threat = this._nearestRival(p);
    if (!threat) return { throttle: 0, brake: 1, steer: 0, handbrake: false };
    const w = this.wear(p);
    if (b.flee ? w < 0.4 : w > 0.65 + (p.id % 3) * 0.08) { b.flee = !b.flee; b.dest = null; b.target = null; }
    if (b.flee) return this._botRunner(p, dt, threat);
    return this._botHunter(p, dt);
  }

  _botHunter(p, dt) {
    const v = p.vehicle, b = p.bot, f = this._fwd(v);
    if (this.hunterHold > 0) return null;
    // fooled by a decoy?
    if (b.decoy && b.decoy.t <= 0) b.decoy = null;
    let tv = null, tp = null;
    if (b.decoy) tv = b.decoy.vehicle;
    else {
      const alive = (this.br ? this.players : this.runners).filter((r) => r.alive && r !== p);
      if (!b.target || !b.target.alive || b.t - (b.targetT || 0) > 6) {
        let best = null, bs = 1e9;
        for (const r of alive) {
          const dx = r.vehicle.pos[0] - v.pos[0], dz = r.vehicle.pos[2] - v.pos[2], d = Math.hypot(dx, dz);
          const behind = (dx * f[0] + dz * f[1]) / (d || 1) < 0 ? 18 : 0;
          const s = d + behind - this.wear(r) * 25;   // prefer close, in front, already damaged
          if (s < bs) { bs = s; best = r; }
        }
        b.target = best; b.targetT = b.t;
      }
      if (!b.target) return { throttle: 0, brake: 0, steer: 0, handbrake: false };
      tp = b.target;
      tv = tp.vehicle;
    }
    let tx = tv.pos[0], tz = tv.pos[2];
    if (this._visible(v, tv)) {
      b.lastSeen = [tx, tz, tv.vel[0], tv.vel[2]]; b.lostT = 0;
    } else {
      b.lostT = (b.lostT || 0) + dt;
      if (b.lastSeen) { tx = b.lastSeen[0]; tz = b.lastSeen[1]; }
      if (b.lostT > 2.5) { b.target = null; b.lostT = 0; }
    }
    const d = Math.hypot(tx - v.pos[0], tz - v.pos[2]);
    // aim at the interception point: where the target will be when we can get there
    const vx = b.lastSeen ? b.lastSeen[2] : 0, vz = b.lastSeen ? b.lastSeen[3] : 0;
    const rx = tx - v.pos[0], rz = tz - v.pos[2];
    const s = Math.max(Math.abs(v.speed), 30) + 6;
    const qa = vx * vx + vz * vz - s * s, qb = 2 * (rx * vx + rz * vz), qc = rx * rx + rz * rz;
    let lead = d / s;
    if (qa < -1e-3) { const disc = qb * qb - 4 * qa * qc; if (disc >= 0) lead = (-qb - Math.sqrt(disc)) / (2 * qa); }
    lead = clamp(lead, 0, d < 15 ? 0.35 : 2.5);
    let ax = tx + vx * lead, az = tz + vz * lead;
    // keep the aim point inside the arena
    const ar = Math.hypot(ax, az), lim = this.arenaR - 6;
    if (ar > lim) { ax *= lim / ar; az *= lim / ar; }
    // modifications
    if (b.modCd <= 0 && tp) {
      const dx = tx - v.pos[0], dz = tz - v.pos[2];
      const ahead = (dx * f[0] + dz * f[1]) / (d || 1);
      if (p.charges.harpoon > 0 && d < 28 && ahead > 0.8) { if (this.useMod(p, 'harpoon')) b.modCd = 3; }
      else if (p.charges.glue > 0 && d > 14 && d < 30 && ahead > 0.9 && Math.random() < 0.02) { if (this.useMod(p, 'glue')) b.modCd = 4; }
      else if (p.charges.spikes > 0 && d > 10 && d < 24 && ahead > 0.9 && Math.random() < 0.02) { if (this.useMod(p, 'spikes')) b.modCd = 4; }
    }
    // close in hard — unless the hunter's own car is already badly hurt
    const ram = d < 30 && this.wear(p) < 0.6;
    if (ram) { ax = tx + vx * 0.3; az = tz + vz * 0.3; }
    // battle royale: two cars going for each other nose to nose — swing out and come at its side instead
    if (this.br && tp && d > 9 && d < 40) {
      const tf = this._fwd(tv);
      if (tf[0] * f[0] + tf[1] * f[1] < -0.6) {
        const side = ((v.pos[0] - tx) * tf[1] - (v.pos[2] - tz) * tf[0]) >= 0 ? 1 : -1;
        ax = tx + tf[1] * side * 4; az = tz - tf[0] * side * 4;
      }
    }
    if (this.br && b.modCd <= 0 && tp && d < 45) {
      const use = (id) => { if (p.charges[id] > 0 && this.useMod(p, id)) { b.modCd = rnd(2, 4); return true; } return false; };
      if (this.wear(p) > 0.3 && use('repair')) {}
      else if (d > 15 && Math.random() < 0.03 && use('nitro')) {}
    }
    return this._drive(p, dt, ax, az, { noBrake: ram, ram, ignore: this.br ? tp : true });
  }

  // run from `T` (the hunter; in the battle royale the nearest rival)
  _botRunner(p, dt, T) {
    const v = p.vehicle, b = p.bot, H = T.vehicle, f = this._fwd(v);
    const hx = H.pos[0] + H.vel[0] * 0.8, hz = H.pos[2] + H.vel[2] * 0.8;
    const dH = this._dist(v, H);
    b.destT -= dt;
    if (!b.dest || b.destT <= 0 || Math.hypot(b.dest[0] - v.pos[0], b.dest[1] - v.pos[2]) < 14) {
      let best = null, bs = -1e9;
      const R = this.arenaR;
      for (const rr of [0.25, 0.5, 0.72]) {
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2, cx = Math.sin(a) * R * rr, cz = Math.cos(a) * R * rr;
          const toX = cx - v.pos[0], toZ = cz - v.pos[2], dMe = Math.hypot(toX, toZ) || 1;
          const toHx = hx - v.pos[0], toHz = hz - v.pos[2], dHh = Math.hypot(toHx, toHz) || 1;
          const towardHunter = (toX * toHx + toZ * toHz) / (dMe * dHh);
          const turn = Math.abs(wrap(Math.atan2(toX, toZ) - Math.atan2(f[0], f[1])));
          let crowd = 0;
          for (const o of this.br ? this.players : this.runners) if (o !== p && o !== T && o.alive) crowd += Math.max(0, 30 - Math.hypot(cx - o.vehicle.pos[0], cz - o.vehicle.pos[2]));
          const s = Math.hypot(cx - hx, cz - hz) - 0.35 * dMe - (towardHunter > 0.3 ? 80 * towardHunter : 0) - turn * 6 - crowd + Math.random() * 8;
          if (s > bs) { bs = s; best = [cx, cz]; }
        }
      }
      b.dest = best; b.destT = rnd(2.5, 4.0);
    }
    let tx = b.dest[0], tz = b.dest[1];
    // the hunter is about to hit: swerve sideways
    const rvx = H.vel[0] - v.vel[0], rvz = H.vel[2] - v.vel[2];
    const toMeX = v.pos[0] - H.pos[0], toMeZ = v.pos[2] - H.pos[2];
    const closing = (rvx * toMeX + rvz * toMeZ) / (dH || 1);
    // decide once per approach whether to dodge (bots aren't perfect)
    if (dH > 30) b.dodge = undefined;
    else if (b.dodge === undefined) b.dodge = Math.random() < 0.45;
    if (b.dodge && dH < 22 && closing > 4) {
      const side = (toMeX * H.vel[2] - toMeZ * H.vel[0]) > 0 ? 1 : -1; // which side of the hunter's path we're on
      tx = v.pos[0] + H.vel[2] * side * 2 + f[0] * 10; tz = v.pos[2] - H.vel[0] * side * 2 + f[1] * 10;
    }
    // modifications
    if (b.modCd <= 0 && dH < 45) {
      const behind = (-toMeX * f[0] + -toMeZ * f[1]) / (dH || 1) < -0.3;
      const tHit = closing > 1 ? dH / closing : 99;
      const use = (id) => { if (p.charges[id] > 0 && this.useMod(p, id)) { b.modCd = rnd(2, 4); return true; } return false; };
      if (this.wear(p) > 0.4 && use('repair')) {}
      else if (tHit < 0.7 && dH < 12 && use('jump')) {}
      else if (tHit < 1.5 && use('swapRunner')) {}
      else if (dH > 30 && dH < 40 && this.wear(p) > 0.3 && Math.random() < 0.05 && use('swapHunter')) {}
      else if (behind && dH < 25 && Math.random() < 0.08 && (use('oil') || use('smoke'))) {}
      else if (closing > 3 && dH < 30 && Math.random() < 0.05 && this._rayWall(v.pos[0], v.pos[2], this._heading(v)) > 70 && (use('nitro') || use('decoy'))) {}
    }
    return this._drive(p, dt, tx, tz);
  }
}
