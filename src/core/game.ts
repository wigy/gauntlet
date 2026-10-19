import {
  ACTIVE_RANGE, CIDER_HEALTH, DEATH_DRAIN_CAP, ENTITY_RADIUS, FOOD_HEALTH, GENERATOR_HP_PER_RANK, HEALTH_DRAIN_PER_SEC,
  HERO_ORDER, HEROES, JOIN_HEALTH, LOW_HEALTH_WARNING, MAX_MONSTERS, MAX_SHOTS_PER_PLAYER, MELEE_COOLDOWN, MONSTERS,
  MONSTER_HIT_COOLDOWN, SHOT_COOLDOWN, SHOT_RADIUS, TREASURE_POINTS,
} from './defs';
import type { HeroClass, HeroDef, ItemKind, MonsterDef, MonsterKind } from './defs';
import { Tile, isEmptyLevel, mod, parseLevel, populate, tileAt } from './level';
import type { LevelData } from './level';
import { Rng } from './rng';

export const TICK = 1 / 60;
export const MAX_PLAYERS = 4;

/** One controller's state for one tick. dx/dy in -1..1. */
export interface PlayerInput {
  dx: number;
  dy: number;
  fire: boolean;
  magic: boolean;
}

export interface Player {
  slot: number;
  controller: string;
  hero: HeroClass;
  def: HeroDef;
  x: number;
  y: number;
  fx: number;
  fy: number;
  health: number;
  score: number;
  keys: number;
  potions: number;
  alive: boolean;
  shotCooldown: number;
  meleeCooldown: number;
  drainAcc: number;
  warned: 0 | 1 | 2;
  prevMagic: boolean;
}

export interface Monster {
  kind: MonsterKind;
  def: MonsterDef;
  rank: number;
  hp: number;
  x: number;
  y: number;
  fx: number;
  fy: number;
  hitCooldown: number;
  shotCooldown: number;
  /** Sorcerers blink: while > 0 they are invisible and shots pass through. */
  invisible: number;
  blinkTimer: number;
  /** Health Death has drained so far. */
  drained: number;
  wander: number;
  wdx: number;
  wdy: number;
  dead: boolean;
  bucket: number;
}

export interface Generator {
  kind: MonsterKind;
  hp: number;
  x: number;
  y: number;
  spawnTimer: number;
  dead: boolean;
}

export interface Item {
  kind: ItemKind;
  x: number;
  y: number;
}

export interface Shot {
  kind: 'arrow' | 'fireball' | 'rock';
  /** Player slot, or -1 for monster shots. */
  owner: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
  ttl: number;
}

export type Sfx = 'shoot' | 'hit' | 'kill' | 'pickup' | 'food' | 'potion' | 'door' | 'exit' | 'die' | 'magic' | 'join' | 'hurt';

export type GameEvent = { type: 'say'; text: string } | { type: 'sfx'; name: Sfx } | { type: 'flash' };

export type GameState = 'attract' | 'playing' | 'levelEnd' | 'gameover';

/**
 * The whole simulation. Pure logic, no DOM: advance with `step(inputs)` at a fixed TICK, read state for rendering,
 * and drain `events` for audio/announcements. Coordinates are in tiles; an entity's x/y is its centre.
 */
export class Game {
  state: GameState = 'attract';
  levelNumber = 0;
  level!: LevelData;
  players: (Player | null)[] = new Array(MAX_PLAYERS).fill(null);
  monsters: Monster[] = [];
  generators: Generator[] = [];
  items = new Map<number, Item>();
  shots: Shot[] = [];
  events: GameEvent[] = [];
  camera = { x: 0, y: 0 };
  /** Visible area in tiles; set by the renderer. Heroes may not spread further apart than this. */
  viewW = 20;
  viewH = 14;
  time = 0;
  stateTimer = 0;

  private rng: Rng;
  private buckets = new Map<number, Monster[]>();
  private generatorAt = new Map<number, Generator>();
  /** Previous fire state per controller, for edge-triggered joining. */
  private prevFire = new Map<string, boolean>();

  constructor(
    private readonly levelTexts: readonly string[],
    private readonly seed = 1,
    private readonly startLevel = 1,
  ) {
    if (levelTexts.length === 0) throw new Error('no levels');
    this.rng = new Rng(seed);
    this.loadLevel(startLevel);
  }

  get livingPlayers(): Player[] {
    return this.players.filter((p): p is Player => !!p && p.alive);
  }

  // ---------------------------------------------------------------- levels

  loadLevel(n: number): void {
    this.levelNumber = n;
    const text = this.levelTexts[(n - 1) % this.levelTexts.length];
    const level = parseLevel(text);
    if (isEmptyLevel(level)) populate(level, this.seed * 7919 + n, n);
    this.level = level;
    this.monsters = [];
    this.generators = [];
    this.generatorAt.clear();
    this.buckets.clear();
    this.items.clear();
    this.shots = [];
    for (const m of level.monsters) this.addMonster(m.kind, m.rank, m.x + 0.5, m.y + 0.5);
    for (const g of level.generators) {
      const gen: Generator = { kind: g.kind, hp: g.rank * GENERATOR_HP_PER_RANK, x: g.x + 0.5, y: g.y + 0.5, spawnTimer: this.rng.next() * 2, dead: false };
      this.generators.push(gen);
      this.generatorAt.set(this.index(g.x, g.y), gen);
    }
    for (const it of level.items) this.items.set(this.index(it.x, it.y), { ...it });

    let k = 0;
    for (const p of this.players) {
      if (!p) continue;
      const pos = this.spawnPoint(k++);
      p.x = pos.x;
      p.y = pos.y;
      p.fx = 0;
      p.fy = 1;
    }
    this.updateCamera();
    if (this.state !== 'attract') this.say(`Level ${n}: ${level.name}`);
  }

  private spawnPoint(k: number): { x: number; y: number } {
    const starts = this.level.starts.length ? this.level.starts : [{ x: 1, y: 1 }];
    if (starts.length > 1) {
      const s = starts[k % starts.length];
      return { x: s.x + 0.5, y: s.y + 0.5 };
    }
    const s = starts[0];
    const offsets = [[0, 0], [1, 0], [0, 1], [1, 1]];
    const [ox, oy] = offsets[k % 4];
    const ok = tileAt(this.level, s.x + ox, s.y + oy) === Tile.Floor;
    return ok ? { x: s.x + ox + 0.5, y: s.y + oy + 0.5 } : { x: s.x + 0.5, y: s.y + 0.5 };
  }

  private addMonster(kind: MonsterKind, rank: number, x: number, y: number): Monster {
    const def = MONSTERS[kind];
    const m: Monster = {
      kind, def, rank, x, y, fx: 0, fy: 1,
      hp: kind === 'death' ? Infinity : def.hpPerRank * rank,
      hitCooldown: 0, shotCooldown: 1 + this.rng.next() * 2, invisible: 0, blinkTimer: 1 + this.rng.next() * 2,
      drained: 0, wander: 0, wdx: 0, wdy: 0, dead: false, bucket: -1,
    };
    this.monsters.push(m);
    this.rebucket(m);
    return m;
  }

  // ---------------------------------------------------------------- main step

  step(inputs: ReadonlyMap<string, PlayerInput>): void {
    this.time += TICK;
    this.handleJoins(inputs);

    if (this.state === 'levelEnd') {
      this.stateTimer -= TICK;
      if (this.stateTimer <= 0) {
        this.state = 'playing';
        this.loadLevel(this.levelNumber + 1);
      }
      return;
    }
    if (this.state !== 'playing') return;

    for (const p of this.players) if (p && p.alive) this.stepPlayer(p, inputs.get(p.controller));
    for (const m of this.monsters) if (!m.dead) this.stepMonster(m);
    for (const g of this.generators) if (!g.dead) this.stepGenerator(g);
    this.stepShots();

    this.monsters = this.monsters.filter((m) => !m.dead);
    this.generators = this.generators.filter((g) => !g.dead);
    this.updateCamera();

    if (this.state === 'playing' && this.livingPlayers.length === 0) {
      this.state = 'gameover';
      this.say('Game over');
    }
  }

  private handleJoins(inputs: ReadonlyMap<string, PlayerInput>): void {
    for (const [controller, input] of inputs) {
      const pressed = input.fire && !this.prevFire.get(controller);
      this.prevFire.set(controller, input.fire);
      if (!pressed) continue;

      if (this.state === 'attract' || this.state === 'gameover') {
        this.newGame();
      }
      const player = this.players.find((p) => p && p.controller === controller) ?? null;
      if (player && player.alive) continue;
      if (player) {
        this.revive(player);
        continue;
      }
      const slot = this.players.indexOf(null);
      if (slot < 0) continue;
      const hero = HERO_ORDER.find((h) => !this.players.some((p) => p?.hero === h)) ?? HERO_ORDER[slot];
      const def = HEROES[hero];
      const p: Player = {
        slot, controller, hero, def, x: 0, y: 0, fx: 0, fy: 1, health: 0, score: 0, keys: 0, potions: 0,
        alive: false, shotCooldown: 0, meleeCooldown: 0, drainAcc: 0, warned: 0, prevMagic: input.magic,
      };
      this.players[slot] = p;
      this.revive(p);
    }
  }

  private newGame(): void {
    this.players = new Array(MAX_PLAYERS).fill(null);
    this.state = 'playing';
    this.loadLevel(this.startLevel);
  }

  private revive(p: Player): void {
    const anchor = this.livingPlayers[0];
    const pos = anchor ? { x: anchor.x, y: anchor.y } : this.spawnPoint(p.slot);
    p.x = pos.x;
    p.y = pos.y;
    p.health = JOIN_HEALTH;
    p.alive = true;
    p.warned = 0;
    this.sfx('join');
    this.say(`${p.def.title} joins`);
  }

  // ---------------------------------------------------------------- players

  private stepPlayer(p: Player, input: PlayerInput | undefined): void {
    input ??= { dx: 0, dy: 0, fire: false, magic: false };
    p.shotCooldown -= TICK;
    p.meleeCooldown -= TICK;

    p.drainAcc += TICK * HEALTH_DRAIN_PER_SEC;
    if (p.drainAcc >= 1) {
      p.drainAcc -= 1;
      this.hurtPlayer(p, 1, false);
      if (!p.alive) return;
    }

    let dx = Math.sign(Math.round(input.dx * 1.4));
    let dy = Math.sign(Math.round(input.dy * 1.4));
    if (dx || dy) {
      p.fx = dx;
      p.fy = dy;
    }

    // As in the arcade: holding fire plants you in place and shoots in the stick direction.
    if (input.fire) {
      if (p.shotCooldown <= 0 && this.shots.filter((s) => s.owner === p.slot).length < MAX_SHOTS_PER_PLAYER) {
        const len = Math.hypot(p.fx, p.fy) || 1;
        const vx = (p.fx / len) * p.def.shotSpeed;
        const vy = (p.fy / len) * p.def.shotSpeed;
        this.shots.push({ kind: 'arrow', owner: p.slot, x: p.x, y: p.y, vx, vy, damage: p.def.shotDamage, ttl: 2 });
        p.shotCooldown = SHOT_COOLDOWN;
        this.sfx('shoot');
      }
      dx = 0;
      dy = 0;
    }
    if (input.magic && !p.prevMagic) this.useMagic(p);
    p.prevMagic = input.magic;

    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      const sp = (p.def.speed * TICK) / len;
      this.movePlayerAxis(p, dx * sp, 0);
      this.movePlayerAxis(p, 0, dy * sp);
    }
    this.collectItems(p);

    if (tileAt(this.level, Math.floor(p.x), Math.floor(p.y)) === Tile.Exit) {
      p.score += 100 * this.levelNumber;
      this.state = 'levelEnd';
      this.stateTimer = 1.2;
      this.sfx('exit');
    }
  }

  private movePlayerAxis(p: Player, dx: number, dy: number): void {
    if (!dx && !dy) return;
    const nx = this.wrapX(p.x + dx);
    const ny = this.wrapY(p.y + dy);
    const r = ENTITY_RADIUS;

    const door = this.findTile(nx, ny, r, Tile.Door);
    if (door && p.keys > 0) {
      p.keys--;
      this.openDoor(door.x, door.y);
      this.sfx('door');
    }
    if (this.tileBlocked(nx, ny, r)) return;

    const blocker = this.monsterAt(nx, ny, r, null);
    if (blocker) {
      if (p.meleeCooldown <= 0) {
        p.meleeCooldown = MELEE_COOLDOWN;
        this.damageMonster(blocker, p.def.meleeDamage, p);
      }
      return;
    }
    const gen = this.generatorNear(nx, ny, r);
    if (gen) {
      if (p.meleeCooldown <= 0) {
        p.meleeCooldown = MELEE_COOLDOWN;
        this.damageGenerator(gen, p.def.meleeDamage, p);
      }
      return;
    }
    // Shared screen: nobody may walk out of view of the others.
    for (const o of this.players) {
      if (!o || o === p || !o.alive) continue;
      if (Math.abs(this.dxw(o.x, nx)) > this.viewW - 2 || Math.abs(this.dyw(o.y, ny)) > this.viewH - 2) {
        const before = Math.abs(this.dxw(o.x, p.x)) > this.viewW - 2 || Math.abs(this.dyw(o.y, p.y)) > this.viewH - 2;
        if (!before) return;
      }
    }
    p.x = nx;
    p.y = ny;
  }

  private collectItems(p: Player): void {
    const r = ENTITY_RADIUS;
    for (const [tx, ty] of this.tilesUnder(p.x, p.y, r)) {
      const key = this.index(tx, ty);
      const it = this.items.get(key);
      if (!it) continue;
      this.items.delete(key);
      switch (it.kind) {
        case 'food':
          p.health += FOOD_HEALTH;
          this.sfx('food');
          break;
        case 'cider':
          p.health += CIDER_HEALTH;
          this.sfx('food');
          break;
        case 'potion':
          p.potions++;
          this.sfx('potion');
          break;
        case 'key':
          p.keys++;
          this.sfx('pickup');
          break;
        case 'treasure':
          p.score += TREASURE_POINTS;
          this.sfx('pickup');
          break;
      }
      if (p.health > LOW_HEALTH_WARNING + 100) p.warned = 0;
    }
  }

  private useMagic(p: Player): void {
    if (p.potions <= 0) return;
    p.potions--;
    this.events.push({ type: 'flash' });
    this.sfx('magic');
    const power = 6 * p.def.magic;
    for (const m of this.monsters) {
      if (m.dead || !this.onScreen(m.x, m.y)) continue;
      if (m.kind === 'death') this.killMonster(m, p, 1000);
      else this.damageMonster(m, power, p);
    }
    for (const g of this.generators) if (!g.dead && this.onScreen(g.x, g.y)) this.damageGenerator(g, power / 2, p);
  }

  private hurtPlayer(p: Player, amount: number, armored = true): void {
    if (!p.alive) return;
    p.health -= armored ? amount * (1 - p.def.armor) : amount;
    if (armored) this.sfx('hurt');
    if (p.health <= 0) {
      p.health = 0;
      p.alive = false;
      this.sfx('die');
      this.say(`${p.def.title} has died`);
      return;
    }
    if (p.health < 100 && p.warned < 2) {
      p.warned = 2;
      this.say(`${p.def.title} is about to die!`);
    } else if (p.health < LOW_HEALTH_WARNING && p.warned < 1) {
      p.warned = 1;
      this.say(`${p.def.title} needs food, badly!`);
    }
  }

  // ---------------------------------------------------------------- monsters

  private stepMonster(m: Monster): void {
    m.hitCooldown -= TICK;
    m.shotCooldown -= TICK;
    const target = this.nearestPlayer(m.x, m.y);
    if (!target || target.dist > ACTIVE_RANGE) return;
    const { dx, dy, dist } = target;

    if (m.kind === 'sorcerer') {
      m.blinkTimer -= TICK;
      if (m.invisible > 0) m.invisible -= TICK;
      if (m.blinkTimer <= 0) {
        m.blinkTimer = 1.5 + this.rng.next() * 2;
        m.invisible = 0.8 + this.rng.next();
      }
    }

    let mx = Math.abs(dx) > 0.3 ? Math.sign(dx) : 0;
    let my = Math.abs(dy) > 0.3 ? Math.sign(dy) : 0;

    if (m.def.shoots === 'rock') {
      // Lobbers keep their distance and lob rocks over walls.
      if (dist < 5) {
        mx = -mx;
        my = -my;
      } else if (dist < 8) {
        mx = my = 0;
      }
      if (m.shotCooldown <= 0 && dist < 10) {
        m.shotCooldown = 2.5 + this.rng.next();
        const t = Math.max(0.6, dist / 6);
        this.shots.push({ kind: 'rock', owner: -1, x: m.x, y: m.y, vx: dx / t, vy: dy / t, damage: m.def.damagePerRank * m.rank, ttl: t });
      }
    } else if (m.def.shoots === 'fireball' && m.shotCooldown <= 0 && dist < 9) {
      const aligned = Math.abs(dx) < 0.5 || Math.abs(dy) < 0.5 || Math.abs(Math.abs(dx) - Math.abs(dy)) < 0.5;
      if (aligned) {
        m.shotCooldown = 2 + this.rng.next();
        const sx = Math.abs(dx) < 0.5 ? 0 : Math.sign(dx);
        const sy = Math.abs(dy) < 0.5 ? 0 : Math.sign(dy);
        const len = Math.hypot(sx, sy) || 1;
        this.shots.push({ kind: 'fireball', owner: -1, x: m.x, y: m.y, vx: (sx / len) * 7, vy: (sy / len) * 7, damage: m.def.damagePerRank * m.rank, ttl: 2 });
      }
    }

    if (m.wander > 0) {
      m.wander -= TICK;
      mx = m.wdx;
      my = m.wdy;
    }
    if (!mx && !my) return;
    m.fx = mx;
    m.fy = my;
    const len = Math.hypot(mx, my);
    const sp = (m.def.speed * TICK) / len;
    const movedX = this.moveMonsterAxis(m, mx * sp, 0);
    const movedY = this.moveMonsterAxis(m, 0, my * sp);
    if (!movedX && !movedY && m.wander <= 0 && this.rng.chance(0.05)) {
      m.wander = 0.3 + this.rng.next() * 0.5;
      m.wdx = this.rng.int(3) - 1;
      m.wdy = this.rng.int(3) - 1;
    }
  }

  private moveMonsterAxis(m: Monster, dx: number, dy: number): boolean {
    if (!dx && !dy) return false;
    const nx = this.wrapX(m.x + dx);
    const ny = this.wrapY(m.y + dy);
    const r = ENTITY_RADIUS;
    if (this.tileBlocked(nx, ny, r)) return false;
    for (const p of this.players) {
      if (!p || !p.alive) continue;
      if (Math.abs(this.dxw(nx, p.x)) < r * 2 && Math.abs(this.dyw(ny, p.y)) < r * 2) {
        this.monsterTouches(m, p);
        return false;
      }
    }
    if (this.monsterAt(nx, ny, r, m) || this.generatorNear(nx, ny, r)) return false;
    m.x = nx;
    m.y = ny;
    this.rebucket(m);
    return true;
  }

  private monsterTouches(m: Monster, p: Player): void {
    if (m.hitCooldown > 0) return;
    if (m.kind === 'death') {
      m.hitCooldown = 0.12;
      const amount = Math.min(10, DEATH_DRAIN_CAP - m.drained);
      m.drained += amount;
      this.hurtPlayer(p, amount, false);
      this.sfx('hurt');
      if (m.drained >= DEATH_DRAIN_CAP) {
        m.dead = true;
        this.unbucket(m);
      }
      return;
    }
    m.hitCooldown = MONSTER_HIT_COOLDOWN;
    this.hurtPlayer(p, m.def.damagePerRank * m.rank);
    if (m.def.kamikaze) {
      m.dead = true;
      this.unbucket(m);
    }
  }

  private damageMonster(m: Monster, amount: number, by: Player | null): void {
    if (m.dead || m.def.shotImmune) return;
    m.hp -= amount;
    this.sfx('hit');
    if (m.hp <= 0) this.killMonster(m, by, m.def.pointsPerRank * m.rank);
    else {
      // Wounded monsters drop a rank, like the arcade.
      m.rank = Math.max(1, Math.ceil(m.hp / m.def.hpPerRank));
    }
  }

  private killMonster(m: Monster, by: Player | null, points: number): void {
    m.dead = true;
    this.unbucket(m);
    if (by) by.score += points;
    this.sfx('kill');
  }

  private stepGenerator(g: Generator): void {
    const near = this.nearestPlayer(g.x, g.y);
    if (!near || near.dist > ACTIVE_RANGE || this.monsters.length >= MAX_MONSTERS) return;
    g.spawnTimer -= TICK;
    if (g.spawnTimer > 0) return;
    g.spawnTimer = 1 + this.rng.next() * 2;
    const rank = Math.max(1, Math.ceil(g.hp / GENERATOR_HP_PER_RANK));
    const gx = Math.floor(g.x);
    const gy = Math.floor(g.y);
    const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]];
    const start = this.rng.int(dirs.length);
    for (let k = 0; k < dirs.length; k++) {
      const [ox, oy] = dirs[(start + k) % dirs.length];
      const x = this.wrapX(gx + ox + 0.5);
      const y = this.wrapY(gy + oy + 0.5);
      if (tileAt(this.level, Math.floor(x), Math.floor(y)) !== Tile.Floor) continue;
      if (this.monsterAt(x, y, ENTITY_RADIUS, null) || this.generatorNear(x, y, ENTITY_RADIUS)) continue;
      if (this.livingPlayers.some((p) => Math.abs(this.dxw(x, p.x)) < 0.9 && Math.abs(this.dyw(y, p.y)) < 0.9)) continue;
      this.addMonster(g.kind, rank, x, y);
      return;
    }
  }

  private damageGenerator(g: Generator, amount: number, by: Player | null): void {
    g.hp -= amount;
    this.sfx('hit');
    if (g.hp <= 0) {
      g.dead = true;
      this.generatorAt.delete(this.index(Math.floor(g.x), Math.floor(g.y)));
      if (by) by.score += 50 * GENERATOR_HP_PER_RANK;
      this.sfx('kill');
    }
  }

  // ---------------------------------------------------------------- shots

  private stepShots(): void {
    for (const s of this.shots) {
      s.ttl -= TICK;
      s.x = this.wrapX(s.x + s.vx * TICK);
      s.y = this.wrapY(s.y + s.vy * TICK);

      if (s.kind === 'rock') {
        // Rocks fly over walls and burst where they land.
        if (s.ttl <= 0) {
          for (const p of this.livingPlayers) {
            if (Math.abs(this.dxw(s.x, p.x)) < 0.8 && Math.abs(this.dyw(s.y, p.y)) < 0.8) this.hurtPlayer(p, s.damage);
          }
        }
        continue;
      }
      if (s.ttl <= 0) continue;
      const tx = Math.floor(s.x);
      const ty = Math.floor(s.y);
      const t = tileAt(this.level, tx, ty);
      if (t === Tile.Wall || t === Tile.Door) {
        s.ttl = 0;
        continue;
      }

      if (s.owner >= 0) {
        const shooter = this.players[s.owner];
        const m = this.monsterAt(s.x, s.y, SHOT_RADIUS, null);
        if (m && !(m.kind === 'sorcerer' && m.invisible > 0)) {
          s.ttl = 0;
          this.damageMonster(m, s.damage, shooter);
          continue;
        }
        const g = this.generatorNear(s.x, s.y, SHOT_RADIUS);
        if (g) {
          s.ttl = 0;
          this.damageGenerator(g, s.damage, shooter);
          continue;
        }
        const key = this.index(tx, ty);
        const it = this.items.get(key);
        if (it && (it.kind === 'food' || it.kind === 'cider' || it.kind === 'potion')) {
          // Shooting the food is a classic mistake.
          this.items.delete(key);
          s.ttl = 0;
          if (it.kind !== 'potion' && shooter) this.say(`${shooter.def.title} shot the food!`);
        }
      } else {
        for (const p of this.livingPlayers) {
          if (Math.abs(this.dxw(s.x, p.x)) < ENTITY_RADIUS + SHOT_RADIUS && Math.abs(this.dyw(s.y, p.y)) < ENTITY_RADIUS + SHOT_RADIUS) {
            this.hurtPlayer(p, s.damage);
            s.ttl = 0;
            break;
          }
        }
      }
    }
    this.shots = this.shots.filter((s) => s.ttl > 0);
  }

  // ---------------------------------------------------------------- geometry helpers

  index(tx: number, ty: number): number {
    return mod(ty, this.level.height) * this.level.width + mod(tx, this.level.width);
  }

  private wrapX(x: number): number {
    return this.level.wrapX ? mod(x, this.level.width) : x;
  }

  private wrapY(y: number): number {
    return this.level.wrapY ? mod(y, this.level.height) : y;
  }

  /** Shortest signed delta from a to b along x, honouring wrap. */
  dxw(a: number, b: number): number {
    const d = b - a;
    const w = this.level.width;
    return this.level.wrapX ? mod(d + w / 2, w) - w / 2 : d;
  }

  dyw(a: number, b: number): number {
    const d = b - a;
    const h = this.level.height;
    return this.level.wrapY ? mod(d + h / 2, h) - h / 2 : d;
  }

  private tilesUnder(x: number, y: number, r: number): [number, number][] {
    const out: [number, number][] = [];
    for (let ty = Math.floor(y - r); ty <= Math.floor(y + r - 1e-6); ty++) {
      for (let tx = Math.floor(x - r); tx <= Math.floor(x + r - 1e-6); tx++) out.push([tx, ty]);
    }
    return out;
  }

  private tileBlocked(x: number, y: number, r: number): boolean {
    return this.tilesUnder(x, y, r).some(([tx, ty]) => {
      const t = tileAt(this.level, tx, ty);
      return t === Tile.Wall || t === Tile.Door;
    });
  }

  private findTile(x: number, y: number, r: number, want: Tile): { x: number; y: number } | null {
    for (const [tx, ty] of this.tilesUnder(x, y, r)) if (tileAt(this.level, tx, ty) === want) return { x: tx, y: ty };
    return null;
  }

  /** Doors open as a whole connected run. */
  private openDoor(x: number, y: number): void {
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop()!;
      if (tileAt(this.level, cx, cy) !== Tile.Door) continue;
      this.level.tiles[this.index(cx, cy)] = Tile.Floor;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }

  private rebucket(m: Monster): void {
    const key = this.index(Math.floor(m.x), Math.floor(m.y));
    if (key === m.bucket) return;
    this.unbucket(m);
    m.bucket = key;
    let list = this.buckets.get(key);
    if (!list) this.buckets.set(key, (list = []));
    list.push(m);
  }

  private unbucket(m: Monster): void {
    if (m.bucket < 0) return;
    const list = this.buckets.get(m.bucket);
    if (list) {
      const i = list.indexOf(m);
      if (i >= 0) list.splice(i, 1);
    }
    m.bucket = -1;
  }

  private monsterAt(x: number, y: number, r: number, self: Monster | null): Monster | null {
    const reach = r + ENTITY_RADIUS;
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const list = this.buckets.get(this.index(cx + ox, cy + oy));
        if (!list) continue;
        for (const m of list) {
          if (m === self || m.dead) continue;
          if (Math.abs(this.dxw(x, m.x)) < reach && Math.abs(this.dyw(y, m.y)) < reach) return m;
        }
      }
    }
    return null;
  }

  private generatorNear(x: number, y: number, r: number): Generator | null {
    for (const [tx, ty] of this.tilesUnder(x, y, r)) {
      const g = this.generatorAt.get(this.index(tx, ty));
      if (g && !g.dead) return g;
    }
    return null;
  }

  private nearestPlayer(x: number, y: number): { p: Player; dx: number; dy: number; dist: number } | null {
    let best: { p: Player; dx: number; dy: number; dist: number } | null = null;
    for (const p of this.players) {
      if (!p || !p.alive) continue;
      const dx = this.dxw(x, p.x);
      const dy = this.dyw(y, p.y);
      const dist = Math.hypot(dx, dy);
      if (!best || dist < best.dist) best = { p, dx, dy, dist };
    }
    return best;
  }

  onScreen(x: number, y: number): boolean {
    return Math.abs(this.dxw(this.camera.x, x)) <= this.viewW / 2 + 0.5 && Math.abs(this.dyw(this.camera.y, y)) <= this.viewH / 2 + 0.5;
  }

  private updateCamera(): void {
    const living = this.livingPlayers;
    if (living.length === 0) {
      if (this.state === 'attract' || !this.players.some(Boolean)) {
        const s = this.level.starts[0] ?? { x: 0, y: 0 };
        this.camera = { x: s.x + 0.5, y: s.y + 0.5 };
      }
      return;
    }
    const a = living[0];
    let sx = 0;
    let sy = 0;
    for (const p of living) {
      sx += this.dxw(a.x, p.x);
      sy += this.dyw(a.y, p.y);
    }
    this.camera = { x: this.wrapX(a.x + sx / living.length), y: this.wrapY(a.y + sy / living.length) };
  }

  private say(text: string): void {
    this.events.push({ type: 'say', text });
  }

  private sfx(name: Sfx): void {
    this.events.push({ type: 'sfx', name });
  }
}
