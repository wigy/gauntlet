import {
  ACID_HIT_COOLDOWN, ACTIVE_RANGE, AMULET_NAMES, AMULET_TIME, AMULETS, BREAKABLE_HITS, CIDER_HEALTH, DEATH_DRAIN_CAP,
  DIZZY_TIME, DRAGON_POINTS, ENTITY_RADIUS, MAGIC_STUN, SUPER_SHOTS, FOOD_HEALTH, FORCE_FIELD_DPS, FORCE_FIELD_PERIOD, GENERATOR_HP_PER_RANK,
  HEALTH_DRAIN_PER_SEC, HERO_ORDER, HEROES, JOIN_HEALTH, LOW_HEALTH_WARNING, MAX_MONSTERS, MAX_SHOTS_PER_PLAYER,
  MELEE_COOLDOWN, MONSTERS, MONSTER_HIT_COOLDOWN, POISON_HEALTH, SHOT_COOLDOWN, SHOT_RADIUS, STUN_GRACE, STUN_TIME,
  THIEF_INTERVAL, THIEF_STEAL_POINTS, TREASURE_POINTS, WALLS_TO_EXITS_TIME,
} from './defs';
import type { AmuletKind, HeroClass, HeroDef, ItemKind, MonsterDef, MonsterKind } from './defs';
import { Tile, isEmptyLevel, isSolid, levelTitle, mod, parseLevel, populate, tileAt } from './level';
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
  /** Display name; empty for local players, who go by their hero's title. */
  name: string;
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
  /** Gauntlet II: seconds left stunned (by a stun tile), during which the hero can't move or shoot. */
  stun: number;
  /** Seconds before a stun tile can stun again. */
  stunGrace: number;
  /** Seconds left of poisoned dizziness: the controls are reversed. */
  dizzy: number;
  amulet: AmuletKind | null;
  amuletTime: number;
  /** Holding the It ball: every monster comes for this hero. Touching another hero passes it on. */
  it: boolean;
  /** Tile index of the transporter the hero arrived on, which doesn't fire again until they step off it. */
  portedTo: number;
}

/** The Gauntlet II fields of a fresh player. */
function freshEffects(): Pick<Player, 'stun' | 'stunGrace' | 'dizzy' | 'amulet' | 'amuletTime' | 'it' | 'portedTo'> {
  return { stun: 0, stunGrace: 0, dizzy: 0, amulet: null, amuletTime: 0, it: false, portedTo: -1 };
}

/** Force fields are all on or all off together, on for the first half of each period. */
export function forceFieldOn(time: number): boolean {
  return mod(time, FORCE_FIELD_PERIOD) < FORCE_FIELD_PERIOD / 2;
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
  /** Thieves: what they stole (dropped when shot), and seconds left before they vanish. */
  loot: ItemKind | null;
  life: number;
  /** Seconds left stunned by a potion (monsters it can't kill). */
  stunned: number;
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
  kind: 'arrow' | 'fireball' | 'rock' | 'super';
  /** Player slot, or -1 for monster shots. */
  owner: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
  ttl: number;
  /** Reflective shots: wall bounces left. */
  bounces: number;
  /** Super shots: what they've already hit, so they hit each thing once on the way through. */
  hit?: object[];
}

export type Sfx =
  | 'shoot' | 'hit' | 'kill' | 'pickup' | 'food' | 'potion' | 'door' | 'exit' | 'die' | 'magic' | 'join' | 'hurt'
  | 'stun' | 'teleport' | 'trap' | 'break' | 'steal' | 'amulet' | 'zap' | 'roar';

export type GameEvent = { type: 'say'; text: string } | { type: 'sfx'; name: Sfx } | { type: 'flash' };

export type GameState = 'attract' | 'playing' | 'levelEnd' | 'gameover';

export interface GameOptions {
  /**
   * Server-run game: players are added with addPlayer() instead of joining on FIRE, each player has their own camera
   * (no shared-screen limit), potions hit what's around the drinker, and (re)spawns happen at the level start.
   */
  online?: boolean;
}

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
  /** Monsters bigger than a tile (dragons), which the buckets don't cover. */
  private bigMonsters: Monster[] = [];
  private generatorAt = new Map<number, Generator>();
  /** Shots taken by each breakable wall, by tile index. */
  private wallHits = new Map<number, number>();
  private transporters: number[] = [];
  /** Seconds until the next thief, on levels that have them. */
  private thiefTimer = 0;
  private itPassedAt = -10;
  /** Seconds played on this level. */
  private levelTime = 0;
  /** Previous fire state per controller, for edge-triggered joining. */
  private prevFire = new Map<string, boolean>();

  constructor(
    private readonly levelTexts: readonly string[],
    private readonly seed = 1,
    private readonly startLevel = 1,
    private readonly options: GameOptions = {},
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
    this.bigMonsters = [];
    this.generators = [];
    this.generatorAt.clear();
    this.buckets.clear();
    this.items.clear();
    this.shots = [];
    this.wallHits.clear();
    this.levelTime = 0;
    this.transporters = [];
    level.tiles.forEach((t, i) => t === Tile.Transporter && this.transporters.push(i));
    this.thiefTimer = level.thief ? THIEF_INTERVAL * (0.5 + this.rng.next()) : Infinity;
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
      p.it = false;
      p.stun = 0;
      p.portedTo = -1;
    }
    this.updateCamera();
    const title = levelTitle(n, level.name);
    if (this.state !== 'attract') this.say(title ? `Level ${n}: ${title}` : `Level ${n}`);
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
      hp: kind === 'death' || kind === 'acid' ? Infinity : def.hp ?? def.hpPerRank * rank,
      hitCooldown: 0, shotCooldown: 1 + this.rng.next() * 2, invisible: 0, blinkTimer: 1 + this.rng.next() * 2,
      drained: 0, wander: 0, wdx: 0, wdy: 0, dead: false, bucket: -1, loot: null, life: Infinity, stunned: 0,
    };
    this.monsters.push(m);
    if (def.radius !== undefined) this.bigMonsters.push(m);
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
    this.stepThief();
    this.stall();
    this.stepShots();

    this.monsters = this.monsters.filter((m) => !m.dead);
    if (this.bigMonsters.length) this.bigMonsters = this.bigMonsters.filter((m) => !m.dead);
    this.generators = this.generators.filter((g) => !g.dead);
    this.updateCamera();

    if (this.state === 'playing' && this.livingPlayers.length === 0) {
      this.state = 'gameover';
      this.say('Game over');
    }
  }

  /** Online: begin play with whoever has been added so far. */
  start(): void {
    this.state = 'playing';
    this.loadLevel(this.startLevel);
  }

  /** Online: add a player at the level start, as `hero` if it's free. Returns null when all slots are taken. */
  addPlayer(controller: string, name: string, hero?: HeroClass): Player | null {
    const slot = this.players.indexOf(null);
    if (slot < 0) return null;
    if (!hero || this.players.some((p) => p?.hero === hero)) {
      hero = HERO_ORDER.find((h) => !this.players.some((p) => p?.hero === h)) ?? HERO_ORDER[slot];
    }
    const p: Player = {
      slot, controller, name, hero, def: HEROES[hero], x: 0, y: 0, fx: 0, fy: 1, health: 0, score: 0, keys: 0, potions: 0,
      alive: false, shotCooldown: 0, meleeCooldown: 0, drainAcc: 0, warned: 0, prevMagic: false, ...freshEffects(),
    };
    this.players[slot] = p;
    if (this.state === 'attract') {
      // Not started yet: start() will place everyone.
      p.health = JOIN_HEALTH;
      p.alive = true;
    } else {
      this.revive(p);
    }
    return p;
  }

  removePlayer(controller: string): void {
    const slot = this.players.findIndex((p) => p?.controller === controller);
    if (slot < 0) return;
    const p = this.players[slot]!;
    this.players[slot] = null;
    this.shots = this.shots.filter((s) => s.owner !== slot);
    this.say(`${this.who(p)} left`);
  }

  private who(p: Player): string {
    return p.name || p.def.title;
  }

  private handleJoins(inputs: ReadonlyMap<string, PlayerInput>): void {
    for (const [controller, input] of inputs) {
      const pressed = input.fire && !this.prevFire.get(controller);
      this.prevFire.set(controller, input.fire);
      if (!pressed) continue;
      if (this.options.online) {
        const player = this.players.find((p) => p && p.controller === controller);
        if (player && !player.alive && (this.state === 'playing' || this.state === 'levelEnd')) this.revive(player);
        continue;
      }

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
        slot, controller, name: '', hero, def, x: 0, y: 0, fx: 0, fy: 1, health: 0, score: 0, keys: 0, potions: 0,
        alive: false, shotCooldown: 0, meleeCooldown: 0, drainAcc: 0, warned: 0, prevMagic: input.magic, ...freshEffects(),
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
    const anchor = this.options.online ? undefined : this.livingPlayers[0];
    const pos = anchor ? { x: anchor.x, y: anchor.y } : this.spawnPoint(p.slot);
    p.x = pos.x;
    p.y = pos.y;
    p.health = JOIN_HEALTH;
    p.alive = true;
    p.warned = 0;
    Object.assign(p, freshEffects());
    this.sfx('join');
    this.say(`${this.who(p)} joins`);
  }

  // ---------------------------------------------------------------- players

  private stepPlayer(p: Player, input: PlayerInput | undefined): void {
    input ??= { dx: 0, dy: 0, fire: false, magic: false };
    p.shotCooldown -= TICK;
    p.meleeCooldown -= TICK;
    p.stun = Math.max(0, p.stun - TICK);
    p.stunGrace = Math.max(0, p.stunGrace - TICK);
    p.dizzy = Math.max(0, p.dizzy - TICK);
    // Transportability runs out only once the hero is out of the wall it was walking through; super shots run out
    // by use.
    if (p.amulet && p.amulet !== 'supershot' && (p.amulet !== 'transport' || !this.tileBlocked(p.x, p.y, ENTITY_RADIUS))) {
      p.amuletTime -= TICK;
      if (p.amuletTime <= 0) p.amulet = null;
    }

    p.drainAcc += TICK * HEALTH_DRAIN_PER_SEC;
    if (p.drainAcc >= 1) {
      p.drainAcc -= 1;
      this.hurtPlayer(p, 1, false);
      if (!p.alive) return;
    }

    const stunned = p.stun > 0;
    const sign = p.dizzy > 0 ? -1 : 1;
    let dx = stunned ? 0 : sign * Math.sign(Math.round(input.dx * 1.4));
    let dy = stunned ? 0 : sign * Math.sign(Math.round(input.dy * 1.4));
    if (dx || dy) {
      p.fx = dx;
      p.fy = dy;
    }

    // As in the arcade: holding fire plants you in place and shoots in the stick direction.
    if (input.fire && !stunned) {
      if (p.shotCooldown <= 0 && this.shots.filter((s) => s.owner === p.slot).length < MAX_SHOTS_PER_PLAYER) {
        const len = Math.hypot(p.fx, p.fy) || 1;
        const vx = (p.fx / len) * p.def.shotSpeed;
        const vy = (p.fy / len) * p.def.shotSpeed;
        const sup = p.amulet === 'supershot';
        this.shots.push({
          kind: sup ? 'super' : 'arrow', owner: p.slot, x: p.x, y: p.y, vx, vy, damage: p.def.shotDamage * (sup ? 2 : 1), ttl: 2,
          bounces: p.amulet === 'reflect' ? 3 : 0,
        });
        p.shotCooldown = SHOT_COOLDOWN;
        this.sfx('shoot');
        if (sup && --p.amuletTime <= 0) p.amulet = null;
      }
      dx = 0;
      dy = 0;
    }
    if (input.magic && !p.prevMagic && !stunned) this.useMagic(p);
    p.prevMagic = input.magic;

    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      const sp = (p.def.speed * TICK) / len;
      this.movePlayerAxis(p, dx * sp, 0);
      this.movePlayerAxis(p, 0, dy * sp);
    }
    this.collectItems(p);
    this.tileEffects(p);
    if (p.it) this.passIt(p);
  }

  /** What the floor under a hero does: exits, traps, stun tiles, transporters, force fields. */
  private tileEffects(p: Player): void {
    const tx = Math.floor(p.x);
    const ty = Math.floor(p.y);
    const here = this.index(tx, ty);
    if (here !== p.portedTo) p.portedTo = -1;
    switch (tileAt(this.level, tx, ty)) {
      case Tile.Exit:
        p.score += 100 * this.levelNumber;
        this.state = 'levelEnd';
        this.stateTimer = 1.2;
        this.sfx('exit');
        return;
      case Tile.Trap:
        this.springTrap(here);
        break;
      case Tile.Stun:
        if (p.stunGrace <= 0) {
          p.stun = STUN_TIME;
          p.stunGrace = STUN_TIME + STUN_GRACE;
          this.sfx('stun');
        }
        break;
      case Tile.Transporter:
        if (p.portedTo < 0) this.transport(p, here);
        break;
    }
    if (forceFieldOn(this.time) && this.tilesUnder(p.x, p.y, ENTITY_RADIUS * 0.8).some(([x, y]) => tileAt(this.level, x, y) === Tile.ForceField)) {
      if (p.amulet !== 'invulnerability') this.hurtPlayer(p, FORCE_FIELD_DPS * TICK, false);
      if (Math.floor(this.time * 8) !== Math.floor((this.time - TICK) * 8)) this.sfx('zap');
    }
  }

  /** Every trap wall in the level vanishes, and the trap with them. */
  private springTrap(at: number): void {
    const tiles = this.level.tiles;
    tiles[at] = Tile.Floor;
    for (let i = 0; i < tiles.length; i++) if (tiles[i] === Tile.TrapWall) tiles[i] = Tile.Floor;
    this.sfx('trap');
  }

  /** Off to the nearest other transporter (ties broken at random), if it's free to land on. */
  private transport(p: Player, from: number): void {
    const w = this.level.width;
    let best: number[] = [];
    let bestD = Infinity;
    for (const i of this.transporters) {
      if (i === from) continue;
      const d = Math.hypot(this.dxw(p.x, (i % w) + 0.5), this.dyw(p.y, Math.floor(i / w) + 0.5));
      if (d < bestD - 1e-6) {
        bestD = d;
        best = [i];
      } else if (Math.abs(d - bestD) <= 1e-6) {
        best.push(i);
      }
    }
    if (!best.length) return;
    const to = best.length > 1 ? this.rng.pick(best) : best[0];
    const x = (to % w) + 0.5;
    const y = Math.floor(to / w) + 0.5;
    if (this.monsterAt(x, y, ENTITY_RADIUS, null)) return;
    p.x = x;
    p.y = y;
    p.portedTo = to;
    this.sfx('teleport');
  }

  /** The It ball sticks to whoever touches the hero holding it. */
  private passIt(p: Player): void {
    if (this.time - this.itPassedAt < 1.5) return;
    for (const o of this.livingPlayers) {
      if (o === p || Math.abs(this.dxw(p.x, o.x)) > ENTITY_RADIUS * 2.2 || Math.abs(this.dyw(p.y, o.y)) > ENTITY_RADIUS * 2.2) continue;
      p.it = false;
      o.it = true;
      this.itPassedAt = this.time;
      this.say(`${this.who(o)} is It`);
      return;
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
    if (p.amulet === 'transport' ? this.outsideLevel(nx, ny, r) : this.tileBlocked(nx, ny, r)) return;

    const blocker = this.monsterAt(nx, ny, r, null);
    if (blocker) {
      if (p.meleeCooldown <= 0 && !blocker.def.tough) {
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
    for (const o of this.options.online ? [] : this.players) {
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
        case 'amulet': {
          const kind = this.rng.pick(AMULETS);
          p.amulet = kind;
          p.amuletTime = kind === 'supershot' ? SUPER_SHOTS : AMULET_TIME;
          this.sfx('amulet');
          this.say(`${this.who(p)} has ${AMULET_NAMES[kind].toLowerCase()}`);
          break;
        }
        case 'poison':
          this.hurtPlayer(p, POISON_HEALTH, false);
          p.dizzy = DIZZY_TIME;
          this.sfx('hurt');
          this.say(`${this.who(p)} drank poison`);
          break;
        case 'it':
          for (const o of this.players) if (o) o.it = false;
          p.it = true;
          this.itPassedAt = this.time;
          this.sfx('pickup');
          this.say(`${this.who(p)} is It`);
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
      if (m.dead || !this.inMagicRange(p, m.x, m.y)) continue;
      if (m.kind === 'death') this.killMonster(m, p, 1000);
      else if (m.def.tough) m.stunned = MAGIC_STUN;
      else this.damageMonster(m, power, p);
    }
    for (const g of this.generators) if (!g.dead && this.inMagicRange(p, g.x, g.y)) this.damageGenerator(g, power / 2, p);
  }

  /** Potions hit everything on screen: the shared screen locally, the drinker's own view online. */
  private inMagicRange(p: Player, x: number, y: number): boolean {
    if (!this.options.online) return this.onScreen(x, y);
    return Math.abs(this.dxw(p.x, x)) <= this.viewW / 2 + 0.5 && Math.abs(this.dyw(p.y, y)) <= this.viewH / 2 + 0.5;
  }

  private hurtPlayer(p: Player, amount: number, armored = true): void {
    if (!p.alive || (armored && p.amulet === 'invulnerability')) return;
    p.health -= armored ? amount * (1 - p.def.armor) : amount;
    if (armored) this.sfx('hurt');
    if (p.health <= 0) {
      p.health = 0;
      p.alive = false;
      this.sfx('die');
      this.say(`${this.who(p)} has died`);
      return;
    }
    if (p.health < 100 && p.warned < 2) {
      p.warned = 2;
      this.say(`${this.who(p)} is about to die!`);
    } else if (p.health < LOW_HEALTH_WARNING && p.warned < 1) {
      p.warned = 1;
      this.say(`${this.who(p)} needs food, badly!`);
    }
  }

  // ---------------------------------------------------------------- monsters

  private stepMonster(m: Monster): void {
    m.hitCooldown -= TICK;
    m.shotCooldown -= TICK;
    if (m.stunned > 0) {
      m.stunned -= TICK;
      return;
    }
    if (m.kind === 'thief') {
      m.life -= TICK;
      if (m.life <= 0) {
        // Gone, with whatever it stole.
        m.dead = true;
        this.unbucket(m);
        return;
      }
    }
    const target = this.targetFor(m);
    if (!target || target.dist > ACTIVE_RANGE) return;
    const { dx, dy, dist } = target;

    if (m.kind === 'sorcerer' || m.kind === 'supersorcerer') {
      m.blinkTimer -= TICK;
      if (m.invisible > 0) m.invisible -= TICK;
      if (m.blinkTimer <= 0) {
        m.blinkTimer = 1.5 + this.rng.next() * 2;
        m.invisible = 0.8 + this.rng.next();
      }
    }

    let mx = Math.abs(dx) > 0.3 ? Math.sign(dx) : 0;
    let my = Math.abs(dy) > 0.3 ? Math.sign(dy) : 0;
    // Thieves run off with their loot; everyone keeps away from a repulsive hero.
    if ((m.kind === 'thief' && m.loot) || (target.p.amulet === 'repulsive' && dist < 7)) {
      mx = -mx;
      my = -my;
    }

    if (m.kind === 'dragon' || (m.kind === 'supersorcerer' && m.invisible <= 0)) {
      // Aimed fireballs, in any direction.
      if (m.shotCooldown <= 0 && dist < 9) {
        m.shotCooldown = (m.kind === 'dragon' ? 1.1 : 2) + this.rng.next();
        const speed = m.kind === 'dragon' ? 6 : 7;
        this.shots.push({ kind: 'fireball', owner: -1, x: m.x, y: m.y, vx: (dx / dist) * speed, vy: (dy / dist) * speed, damage: m.def.damagePerRank * m.rank, ttl: 2, bounces: 0 });
        if (m.kind === 'dragon') this.sfx('roar');
      }
    } else if (m.def.shoots === 'rock') {
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
        this.shots.push({ kind: 'rock', owner: -1, x: m.x, y: m.y, vx: dx / t, vy: dy / t, damage: m.def.damagePerRank * m.rank, ttl: t, bounces: 0 });
      }
    } else if (m.def.shoots === 'fireball' && m.shotCooldown <= 0 && dist < 9) {
      const aligned = Math.abs(dx) < 0.5 || Math.abs(dy) < 0.5 || Math.abs(Math.abs(dx) - Math.abs(dy)) < 0.5;
      if (aligned) {
        m.shotCooldown = 2 + this.rng.next();
        const sx = Math.abs(dx) < 0.5 ? 0 : Math.sign(dx);
        const sy = Math.abs(dy) < 0.5 ? 0 : Math.sign(dy);
        const len = Math.hypot(sx, sy) || 1;
        this.shots.push({ kind: 'fireball', owner: -1, x: m.x, y: m.y, vx: (sx / len) * 7, vy: (sy / len) * 7, damage: m.def.damagePerRank * m.rank, ttl: 2, bounces: 0 });
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
    const r = m.def.radius ?? ENTITY_RADIUS;
    if (this.tileBlocked(nx, ny, r)) return false;
    for (const p of this.players) {
      if (!p || !p.alive) continue;
      if (Math.abs(this.dxw(nx, p.x)) < r + ENTITY_RADIUS && Math.abs(this.dyw(ny, p.y)) < r + ENTITY_RADIUS) {
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
    if (m.kind === 'thief') {
      if (!m.loot) this.steal(m, p);
      return;
    }
    m.hitCooldown = m.kind === 'acid' ? ACID_HIT_COOLDOWN : MONSTER_HIT_COOLDOWN;
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
    if (m.hp <= 0) this.killMonster(m, by, m.kind === 'dragon' ? DRAGON_POINTS : m.def.pointsPerRank * m.rank);
    else if (m.def.hp === undefined) {
      // Wounded monsters drop a rank, like the arcade.
      m.rank = Math.max(1, Math.ceil(m.hp / m.def.hpPerRank));
    }
  }

  private killMonster(m: Monster, by: Player | null, points: number): void {
    m.dead = true;
    this.unbucket(m);
    if (by) by.score += points;
    this.sfx('kill');
    if (m.loot) this.drop(m.loot, m.x, m.y);
  }

  /** Put an item on the floor near (x, y), if there's a free floor tile. */
  private drop(kind: ItemKind, x: number, y: number): void {
    for (const [ox, oy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const tx = Math.floor(x) + ox;
      const ty = Math.floor(y) + oy;
      const key = this.index(tx, ty);
      if (tileAt(this.level, tx, ty) !== Tile.Floor || this.items.has(key) || this.generatorAt.has(key)) continue;
      this.items.set(key, { kind, x: mod(tx, this.level.width), y: mod(ty, this.level.height) });
      return;
    }
  }

  /** A thief takes a potion, a key or some points, then runs for it. */
  private steal(m: Monster, p: Player): void {
    if (p.potions > 0) {
      p.potions--;
      m.loot = 'potion';
    } else if (p.keys > 0) {
      p.keys--;
      m.loot = 'key';
    } else {
      p.score = Math.max(0, p.score - THIEF_STEAL_POINTS);
      m.loot = 'treasure';
    }
    m.life = 6;
    this.sfx('steal');
    this.say(`A thief robbed ${this.who(p)}!`);
  }

  /** Linger too long and the walls give way: every wall becomes an exit. */
  private stall(): void {
    if (this.livingPlayers.length === 0) return;
    const before = this.levelTime;
    this.levelTime += TICK;
    if (before >= WALLS_TO_EXITS_TIME || this.levelTime < WALLS_TO_EXITS_TIME) return;
    const tiles = this.level.tiles;
    for (let i = 0; i < tiles.length; i++) if (tiles[i] === Tile.Wall) tiles[i] = Tile.Exit;
    this.say('All walls are now exits');
  }

  /** Levels with thieves get one every so often, appearing at the start. */
  private stepThief(): void {
    if (!this.level.thief || this.livingPlayers.length === 0) return;
    this.thiefTimer -= TICK;
    if (this.thiefTimer > 0) return;
    this.thiefTimer = THIEF_INTERVAL * (1 + this.rng.next());
    if (this.monsters.some((m) => m.kind === 'thief')) return;
    const s = this.level.starts[0] ?? { x: 1, y: 1 };
    const x = s.x + 0.5;
    const y = s.y + 0.5;
    if (this.monsterAt(x, y, ENTITY_RADIUS, null) || this.livingPlayers.some((p) => Math.abs(this.dxw(x, p.x)) < 1 && Math.abs(this.dyw(y, p.y)) < 1)) return;
    const m = this.addMonster('thief', 1, x, y);
    m.life = 30;
  }

  /**
   * Who a monster goes for: thieves pick the hero with the most to steal; otherwise whoever holds the It ball, or the
   * nearest hero. Invisible heroes aren't seen at all.
   */
  private targetFor(m: Monster): { p: Player; dx: number; dy: number; dist: number } | null {
    let pick: Player | null = null;
    if (m.kind === 'thief' && !m.loot) {
      let best = -1;
      for (const p of this.livingPlayers) {
        const worth = p.potions * 1000 + p.keys * 500 + p.score / 1000;
        if (p.amulet !== 'invisibility' && worth > best) [best, pick] = [worth, p];
      }
    } else {
      pick = this.livingPlayers.find((p) => p.it && p.amulet !== 'invisibility') ?? null;
    }
    if (!pick) return this.nearestPlayer(m.x, m.y, true);
    const dx = this.dxw(m.x, pick.x);
    const dy = this.dyw(m.y, pick.y);
    return { p: pick, dx, dy, dist: Math.hypot(dx, dy) };
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
      const ox = s.x;
      const oy = s.y;
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
      if (isSolid(t)) {
        if (t === Tile.Breakable && s.owner >= 0) this.hitWall(tx, ty, this.players[s.owner]);
        if (s.bounces > 0 && t !== Tile.Breakable) {
          // Reflective shots: back off and flip whichever axis ran into the wall.
          s.bounces--;
          s.x = ox;
          s.y = oy;
          const hitX = isSolid(tileAt(this.level, Math.floor(ox + s.vx * TICK), Math.floor(oy)));
          const hitY = isSolid(tileAt(this.level, Math.floor(ox), Math.floor(oy + s.vy * TICK)));
          if (hitX || !hitY) s.vx = -s.vx;
          if (hitY || !hitX) s.vy = -s.vy;
          continue;
        }
        s.ttl = 0;
        continue;
      }

      if (s.owner >= 0) {
        const shooter = this.players[s.owner];
        // Super shots go through everything they hit, hitting each thing once.
        const pierce = s.kind === 'super';
        const m = this.monsterAt(s.x, s.y, SHOT_RADIUS, null);
        if (m && m.invisible <= 0 && !(pierce && s.hit?.includes(m))) {
          if (pierce) (s.hit ??= []).push(m);
          else s.ttl = 0;
          this.damageMonster(m, s.damage, shooter);
          continue;
        }
        const g = this.generatorNear(s.x, s.y, SHOT_RADIUS);
        if (g && !(pierce && s.hit?.includes(g))) {
          if (pierce) (s.hit ??= []).push(g);
          else s.ttl = 0;
          this.damageGenerator(g, s.damage, shooter);
          continue;
        }
        const key = this.index(tx, ty);
        const it = this.items.get(key);
        if (it && (it.kind === 'food' || it.kind === 'cider' || it.kind === 'potion')) {
          // Shooting the food is a classic mistake.
          this.items.delete(key);
          if (!pierce) s.ttl = 0;
          if (it.kind !== 'potion' && shooter) this.say(`${this.who(shooter)} shot the food!`);
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

  /** A shot hits a breakable wall: it crumbles after BREAKABLE_HITS of them. */
  private hitWall(tx: number, ty: number, by: Player | null): void {
    const key = this.index(tx, ty);
    const hits = (this.wallHits.get(key) ?? 0) + 1;
    this.sfx('hit');
    if (hits < BREAKABLE_HITS) {
      this.wallHits.set(key, hits);
      return;
    }
    this.wallHits.delete(key);
    this.level.tiles[key] = Tile.Floor;
    if (by) by.score += 10;
    this.sfx('break');
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
    return this.tilesUnder(x, y, r).some(([tx, ty]) => isSolid(tileAt(this.level, tx, ty)));
  }

  /** Off the edge of a level that doesn't wrap (what still stops a hero with transportability). */
  private outsideLevel(x: number, y: number, r: number): boolean {
    const { width, height, wrapX, wrapY } = this.level;
    return (!wrapX && (x - r < 0 || x + r > width)) || (!wrapY && (y - r < 0 || y + r > height));
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
    // Big monsters (dragons) reach further than the neighbouring buckets, so they're checked separately.
    for (const m of this.bigMonsters) {
      if (m === self || m.dead) continue;
      const reach = r + (m.def.radius ?? ENTITY_RADIUS);
      if (Math.abs(this.dxw(x, m.x)) < reach && Math.abs(this.dyw(y, m.y)) < reach) return m;
    }
    const reach = r + ENTITY_RADIUS;
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const list = this.buckets.get(this.index(cx + ox, cy + oy));
        if (!list) continue;
        for (const m of list) {
          if (m === self || m.dead || m.def.radius !== undefined) continue;
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

  private nearestPlayer(x: number, y: number, visibleOnly = false): { p: Player; dx: number; dy: number; dist: number } | null {
    let best: { p: Player; dx: number; dy: number; dist: number } | null = null;
    for (const p of this.players) {
      if (!p || !p.alive || (visibleOnly && p.amulet === 'invisibility')) continue;
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
