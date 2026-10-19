import { HEROES, MONSTERS } from '../core/defs';
import type { GameState, Generator, Item, Monster, Player, Shot } from '../core/game';
import { Tile, mod } from '../core/level';
import type { LevelData } from '../core/level';
import type { LevelInfo, Snapshot } from './protocol';

/**
 * Client-side copy of the server's game, shaped like core/Game so the renderer can draw it unchanged.
 * Entities keep their object identity across snapshots (matched by id), which the renderer relies on for
 * interpolation and effects. The camera follows our own hero.
 */
export class Mirror {
  state: GameState = 'attract';
  levelNumber = 0;
  level: LevelData = {
    name: '', width: 1, height: 1, wrapX: false, wrapY: false, tiles: new Uint8Array([Tile.Wall]),
    starts: [], items: [], generators: [], monsters: [],
  };
  players: (Player | null)[] = [null, null, null, null];
  monsters: Monster[] = [];
  generators: Generator[] = [];
  items = new Map<number, Item>();
  shots: Shot[] = [];
  camera = { x: 0, y: 0 };
  viewW = 20;
  viewH = 14;
  /** Our controller id on the server. */
  you = '';

  private monsterById = new Map<number, Monster>();
  private generatorById = new Map<number, Generator>();
  private shotById = new Map<number, Shot>();
  private hasCamera = false;

  get me(): Player | null {
    return this.players.find((p) => p?.controller === this.you) ?? null;
  }

  /** Forget the current game (after leaving it). */
  reset(): void {
    this.state = 'attract';
    this.you = '';
    this.players = [null, null, null, null];
    this.setLevel({ number: 0, name: '', width: 1, height: 1, wrapX: false, wrapY: false, tiles: String(Tile.Wall) });
  }

  setLevel(info: LevelInfo): void {
    this.levelNumber = info.number;
    this.level = {
      name: info.name, width: info.width, height: info.height, wrapX: info.wrapX, wrapY: info.wrapY,
      tiles: Uint8Array.from(info.tiles, (c) => Number(c)), starts: [], items: [], generators: [], monsters: [],
    };
    this.monsters = [];
    this.generators = [];
    this.shots = [];
    this.items.clear();
    this.monsterById.clear();
    this.generatorById.clear();
    this.shotById.clear();
    this.hasCamera = false;
  }

  apply(s: Snapshot): void {
    this.state = s.state;
    this.you = s.you;

    const players: (Player | null)[] = [null, null, null, null];
    for (const [slot, controller, name, hero, x, y, fx, fy, health, score, keys, potions, alive] of s.players) {
      const old = this.players[slot];
      const p: Player = old && old.controller === controller ? old : {
        slot, controller, name, hero, def: HEROES[hero], x, y, fx, fy, health, score, keys, potions, alive: !!alive,
        shotCooldown: 0, meleeCooldown: 0, drainAcc: 0, warned: 0, prevMagic: false,
      };
      Object.assign(p, { name, hero, def: HEROES[hero], x, y, fx, fy, health, score, keys, potions, alive: !!alive });
      players[slot] = p;
    }
    this.players = players;

    this.monsters = this.sync(this.monsterById, s.monsters, ([id, kind, rank, hp, x, y, fx, inv], old) => {
      const m: Monster = old ?? {
        kind, def: MONSTERS[kind], rank, hp, x, y, fx, fy: 1, hitCooldown: 0, shotCooldown: 0, invisible: 0, blinkTimer: 0,
        drained: 0, wander: 0, wdx: 0, wdy: 0, dead: false, bucket: -1,
      };
      Object.assign(m, { rank, hp: hp < 0 ? Infinity : hp, x, y, fx, invisible: inv ? 1 : 0 });
      return [id, m];
    });
    this.generators = this.sync(this.generatorById, s.generators, ([id, kind, hp, x, y], old) => {
      const g: Generator = old ?? { kind, hp, x, y, spawnTimer: 0, dead: false };
      g.hp = hp;
      return [id, g];
    });
    this.shots = this.sync(this.shotById, s.shots, ([id, kind, owner, x, y, vx, vy, ttl], old) => {
      const shot: Shot = old ?? { kind, owner, x, y, vx, vy, damage: 0, ttl };
      Object.assign(shot, { x, y, vx, vy, ttl });
      return [id, shot];
    });

    if (s.items) {
      this.items.clear();
      for (const [key, kind] of s.items) this.items.set(key, { kind, x: key % this.level.width, y: Math.floor(key / this.level.width) });
    }
    if (s.tiles) for (const [i, t] of s.tiles) this.level.tiles[i] = t;

    const focus = this.me ?? this.players.find((p) => p) ?? null;
    if (focus && (focus.alive || !this.hasCamera)) {
      this.camera = { x: focus.x, y: focus.y };
      this.hasCamera = true;
    }
  }

  /** Update the objects for `rows` in place (by id), drop the ones that are gone, and return the live list. */
  private sync<R extends [number, ...unknown[]], T>(byId: Map<number, T>, rows: R[], make: (row: R, old: T | undefined) => [number, T]): T[] {
    const seen = new Set<number>();
    const out: T[] = [];
    for (const row of rows) {
      const [id, obj] = make(row, byId.get(row[0]));
      byId.set(id, obj);
      seen.add(id);
      out.push(obj);
    }
    for (const id of byId.keys()) if (!seen.has(id)) byId.delete(id);
    return out;
  }

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
}
