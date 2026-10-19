import { Rng } from './rng';
import type { ItemKind, MonsterKind } from './defs';

/**
 * Level text format:
 *
 *   name: Breakfast        (header lines "key: value", all optional)
 *   wrap: none|x|y|both    edges that wrap around (toroidal maze)
 *   rank: 1..3             rank of generators and pre-placed monsters (default 3)
 *   ---
 *   <grid rows, all the same length>
 *
 * Grid legend: see TILE_CHARS / ITEM_CHARS / GENERATOR_CHARS / MONSTER_CHARS below.
 * A level with no starts and no entities (e.g. an imported wall-only map) gets populated by `populate()`.
 */

export const enum Tile {
  Floor = 0,
  Wall = 1,
  Door = 2,
  Exit = 3,
}

export interface Pos {
  x: number;
  y: number;
}

export interface PlacedItem extends Pos {
  kind: ItemKind;
}

export interface PlacedMonster extends Pos {
  kind: MonsterKind;
  rank: number;
}

export interface LevelData {
  name: string;
  width: number;
  height: number;
  wrapX: boolean;
  wrapY: boolean;
  tiles: Uint8Array;
  starts: Pos[];
  items: PlacedItem[];
  generators: PlacedMonster[];
  monsters: PlacedMonster[];
}

const TILE_CHARS: Record<string, Tile> = { '#': Tile.Wall, '.': Tile.Floor, ' ': Tile.Floor, E: Tile.Exit, D: Tile.Door };
const ITEM_CHARS: Record<string, ItemKind> = { F: 'food', C: 'cider', P: 'potion', K: 'key', T: 'treasure' };
const GENERATOR_CHARS: Record<string, MonsterKind> = { g: 'ghost', r: 'grunt', d: 'demon', l: 'lobber', o: 'sorcerer', x: 'death' };
const MONSTER_CHARS: Record<string, MonsterKind> = { G: 'ghost', R: 'grunt', M: 'demon', L: 'lobber', O: 'sorcerer', X: 'death' };

export function parseLevel(text: string): LevelData {
  const lines = text.replace(/\r/g, '').split('\n');
  const sep = lines.indexOf('---');
  const header = sep >= 0 ? lines.slice(0, sep) : [];
  const rows = (sep >= 0 ? lines.slice(sep + 1) : lines).filter((l) => l.length > 0);
  if (rows.length === 0) throw new Error('level has no grid');

  const meta: Record<string, string> = {};
  for (const h of header) {
    const m = /^\s*(\w+)\s*:\s*(.*?)\s*$/.exec(h);
    if (m) meta[m[1].toLowerCase()] = m[2];
  }
  const wrap = meta.wrap ?? 'none';
  const rank = clampRank(Number(meta.rank ?? 3));

  const width = Math.max(...rows.map((r) => r.length));
  const height = rows.length;
  const level: LevelData = {
    name: meta.name ?? 'Untitled',
    width,
    height,
    wrapX: wrap === 'x' || wrap === 'both',
    wrapY: wrap === 'y' || wrap === 'both',
    tiles: new Uint8Array(width * height),
    starts: [],
    items: [],
    generators: [],
    monsters: [],
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = rows[y][x] ?? '#';
      let tile = TILE_CHARS[ch];
      if (tile === undefined) {
        tile = Tile.Floor;
        if (ch === 'S') level.starts.push({ x, y });
        else if (ITEM_CHARS[ch]) level.items.push({ kind: ITEM_CHARS[ch], x, y });
        else if (GENERATOR_CHARS[ch]) level.generators.push({ kind: GENERATOR_CHARS[ch], rank, x, y });
        else if (MONSTER_CHARS[ch]) level.monsters.push({ kind: MONSTER_CHARS[ch], rank, x, y });
        else throw new Error(`unknown level char '${ch}' at ${x},${y}`);
      }
      level.tiles[y * width + x] = tile;
    }
  }
  return level;
}

function clampRank(r: number): number {
  return Number.isFinite(r) ? Math.max(1, Math.min(3, Math.round(r))) : 3;
}

export function tileAt(level: LevelData, x: number, y: number): Tile {
  if (level.wrapX) x = mod(x, level.width);
  if (level.wrapY) y = mod(y, level.height);
  if (x < 0 || y < 0 || x >= level.width || y >= level.height) return Tile.Wall;
  return level.tiles[y * level.width + x] as Tile;
}

export function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Breadth-first distances (in tiles, 4-connected, through floor/door/exit) from the given sources; -1 = unreachable. */
export function bfsDistances(level: LevelData, sources: Pos[], passDoors = true): Int32Array {
  const { width, height } = level;
  const dist = new Int32Array(width * height).fill(-1);
  const queue: number[] = [];
  for (const s of sources) {
    const i = s.y * width + s.x;
    if (dist[i] < 0) {
      dist[i] = 0;
      queue.push(i);
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const i = queue[qi];
    const x = i % width;
    const y = (i - x) / width;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let nx = x + dx;
      let ny = y + dy;
      if (level.wrapX) nx = mod(nx, width);
      if (level.wrapY) ny = mod(ny, height);
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = ny * width + nx;
      const t = level.tiles[ni];
      if (dist[ni] >= 0 || t === Tile.Wall || (!passDoors && t === Tile.Door)) continue;
      dist[ni] = dist[i] + 1;
      queue.push(ni);
    }
  }
  return dist;
}

export function isEmptyLevel(level: LevelData): boolean {
  return level.starts.length === 0 && level.items.length === 0 && level.generators.length === 0 && level.monsters.length === 0;
}

/**
 * Fill a wall-only map (like the imported arcade layouts, which carry no monsters or items) with a start,
 * generators, monsters and pickups. Deterministic for a given seed. `depth` is the 1-based level number
 * and scales difficulty.
 */
export function populate(level: LevelData, seed: number, depth: number): void {
  const rng = new Rng(seed);
  const { width, height } = level;
  const exits: Pos[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (level.tiles[y * width + x] === Tile.Exit) exits.push({ x, y });

  // Start as far from the exits as possible (so the whole maze gets played), preferring open 2x2 areas for 4 heroes.
  const fromExit = bfsDistances(level, exits.length ? exits : [{ x: width >> 1, y: height >> 1 }]);
  let best: Pos | null = null;
  let bestScore = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = fromExit[y * width + x];
      if (d < 0 || level.tiles[y * width + x] !== Tile.Floor) continue;
      const open = [[1, 0], [0, 1], [1, 1]].every(([dx, dy]) => tileAt(level, x + dx, y + dy) === Tile.Floor);
      const score = d + (open ? 1000 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
  }
  if (!best) throw new Error(`level '${level.name}' has no reachable floor`);
  level.starts = [best];

  const fromStart = bfsDistances(level, [best]);
  const used = new Set<number>([best.y * width + best.x]);
  const candidates: Pos[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (level.tiles[i] === Tile.Floor && fromStart[i] >= 4) candidates.push({ x, y });
    }
  }
  const take = (minDist: number): Pos | null => {
    for (let tries = 0; tries < 40 && candidates.length; tries++) {
      const p = rng.pick(candidates);
      const i = p.y * width + p.x;
      if (used.has(i) || fromStart[i] < minDist) continue;
      used.add(i);
      return p;
    }
    return null;
  };

  const area = candidates.length;
  const rank = Math.min(3, 1 + Math.floor(depth / 6));
  const pool: MonsterKind[] = ['ghost', 'grunt'];
  if (depth >= 3) pool.push('demon');
  if (depth >= 5) pool.push('lobber');
  if (depth >= 7) pool.push('sorcerer');

  const generatorCount = Math.round(Math.min(14, 2 + depth * 0.6) * (area / 600));
  for (let n = 0; n < generatorCount; n++) {
    const p = take(8);
    if (p) level.generators.push({ kind: rng.pick(pool), rank: 1 + rng.int(rank), x: p.x, y: p.y });
  }
  const monsterCount = Math.round(Math.min(40, 6 + depth * 2) * (area / 600));
  for (let n = 0; n < monsterCount; n++) {
    const p = take(6);
    if (p) level.monsters.push({ kind: rng.pick(pool), rank: 1 + rng.int(rank), x: p.x, y: p.y });
  }
  if (depth >= 9 && rng.chance(0.3)) {
    const p = take(10);
    if (p) level.monsters.push({ kind: 'death', rank: 1, x: p.x, y: p.y });
  }

  const scale = Math.max(1, area / 500);
  const itemPlan: [ItemKind, number][] = [
    ['food', Math.round(3 * scale)],
    ['cider', rng.int(2)],
    ['potion', 1 + rng.int(2)],
    ['treasure', Math.round(3 * scale)],
  ];
  const hasDoors = level.tiles.some((t) => t === Tile.Door);
  if (hasDoors) itemPlan.push(['key', 2 + rng.int(2)]);
  for (const [kind, count] of itemPlan) {
    for (let n = 0; n < count; n++) {
      const p = take(3);
      if (p) level.items.push({ kind, x: p.x, y: p.y });
    }
  }
}
