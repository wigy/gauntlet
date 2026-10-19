import { Rng } from './rng';
import type { ItemKind, MonsterKind } from './defs';

/**
 * Level text format:
 *
 *   name: Breakfast        (header lines "key: value", all optional)
 *   wrap: none|x|y|both    edges that wrap around (toroidal maze)
 *   rank: 1..3             rank of generators and pre-placed monsters (default 3)
 *   style: g1|g2           g2 = Gauntlet II: populate() adds its monsters and items (default g1)
 *   thief: yes|no          a thief turns up every so often (default no)
 *   ---
 *   <grid rows, all the same length>
 *
 * Grid legend: see TILE_CHARS / ITEM_CHARS / GENERATOR_CHARS / MONSTER_CHARS below.
 * A level with no starts and no entities (e.g. an imported wall-only map) gets populated by `populate()`.
 */

/** One digit per tile in the network protocol, so there can be at most ten. */
export const enum Tile {
  Floor = 0,
  Wall = 1,
  Door = 2,
  Exit = 3,
  /** Gauntlet II: stepping on it removes every trap wall. */
  Trap = 4,
  TrapWall = 5,
  /** Gauntlet II: wall that breaks after a few shots. */
  Breakable = 6,
  /** Gauntlet II: stuns heroes who step on it. Hidden, with an occasional twinkle. */
  Stun = 7,
  /** Gauntlet II: sends a hero to the nearest other transporter. */
  Transporter = 8,
  /** Gauntlet II: passable, but burns heroes while it's on. */
  ForceField = 9,
}

/** Tiles that block movement and shots. */
export function isSolid(t: Tile): boolean {
  return t === Tile.Wall || t === Tile.Door || t === Tile.TrapWall || t === Tile.Breakable;
}

/** Tiles drawn as wall blocks. */
export function isWallLike(t: Tile): boolean {
  return t === Tile.Wall || t === Tile.TrapWall || t === Tile.Breakable;
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
  style: 'g1' | 'g2';
  thief: boolean;
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

const TILE_CHARS: Record<string, Tile> = {
  '#': Tile.Wall, '.': Tile.Floor, ' ': Tile.Floor, E: Tile.Exit, D: Tile.Door,
  '^': Tile.Trap, '%': Tile.TrapWall, '*': Tile.Breakable, '~': Tile.Stun, '@': Tile.Transporter, '=': Tile.ForceField,
};
const ITEM_CHARS: Record<string, ItemKind> = { F: 'food', C: 'cider', P: 'potion', K: 'key', T: 'treasure', A: 'amulet', B: 'poison', I: 'it' };
const GENERATOR_CHARS: Record<string, MonsterKind> = { g: 'ghost', r: 'grunt', d: 'demon', l: 'lobber', o: 'sorcerer', x: 'death', u: 'supersorcerer' };
const MONSTER_CHARS: Record<string, MonsterKind> = {
  G: 'ghost', R: 'grunt', M: 'demon', L: 'lobber', O: 'sorcerer', X: 'death', U: 'supersorcerer', Z: 'dragon', H: 'thief', Y: 'acid',
};
const CHAR_OF_TILE = Object.fromEntries(Object.entries(TILE_CHARS).filter(([c]) => c !== ' ').map(([c, t]) => [t, c])) as Record<Tile, string>;

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/**
 * The level's name, or '' when it only repeats the level number (arcade levels 1-7 are called "One".."Seven"),
 * so announcements say "Level 1" rather than "Level 1: One".
 */
export function levelTitle(n: number, name: string): string {
  const t = name.trim().toLowerCase();
  return t === String(n) || t === NUMBER_WORDS[n] ? '' : name;
}

/** Largest level the editor and server accept, in tiles. */
export const MAX_LEVEL_SIZE = 100;

/** Every character of the grid legend, for editors. */
export const LEGEND = { TILE_CHARS, ITEM_CHARS, GENERATOR_CHARS, MONSTER_CHARS } as const;

/**
 * The text form of a level (inverse of parseLevel). Ranks are per level in the text format, so mixed ranks
 * collapse to the highest one.
 */
export function levelToText(level: LevelData): string {
  const { width, height } = level;
  const grid: string[][] = [];
  for (let y = 0; y < height; y++) {
    const row: string[] = [];
    for (let x = 0; x < width; x++) {
      row.push(CHAR_OF_TILE[level.tiles[y * width + x] as Tile] ?? '.');
    }
    grid.push(row);
  }
  const charOf = <K extends string>(map: Record<string, K>, kind: K) => Object.keys(map).find((c) => map[c] === kind)!;
  for (const s of level.starts) grid[s.y][s.x] = 'S';
  for (const it of level.items) grid[it.y][it.x] = charOf(ITEM_CHARS, it.kind);
  for (const g of level.generators) grid[g.y][g.x] = charOf(GENERATOR_CHARS, g.kind);
  for (const m of level.monsters) grid[m.y][m.x] = charOf(MONSTER_CHARS, m.kind);
  const ranks = [...level.generators, ...level.monsters].filter((m) => m.kind !== 'death').map((m) => m.rank);
  const rank = ranks.length ? Math.max(...ranks) : 3;
  const wrap = level.wrapX && level.wrapY ? 'both' : level.wrapX ? 'x' : level.wrapY ? 'y' : 'none';
  const extra = (level.style === 'g2' ? 'style: g2\n' : '') + (level.thief ? 'thief: yes\n' : '');
  return `name: ${level.name}\nwrap: ${wrap}\nrank: ${rank}\n${extra}---\n${grid.map((r) => r.join('')).join('\n')}\n`;
}

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
    style: meta.style === 'g2' ? 'g2' : 'g1',
    thief: meta.thief === 'yes',
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

/**
 * Breadth-first distances (in tiles, 4-connected) from the given sources; -1 = unreachable. Walls block; doors, trap
 * walls and breakable walls only block when `passDoors` is false. Stepping on a transporter also reaches every other
 * transporter (one step further).
 */
export function bfsDistances(level: LevelData, sources: Pos[], passDoors = true): Int32Array {
  const { width, height } = level;
  const dist = new Int32Array(width * height).fill(-1);
  const queue: number[] = [];
  let transporters: number[] | null = null;
  const visit = (ni: number, d: number) => {
    if (dist[ni] >= 0) return;
    dist[ni] = d;
    queue.push(ni);
  };
  for (const s of sources) visit(s.y * width + s.x, 0);
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
      if (t === Tile.Wall || (!passDoors && isSolid(t))) continue;
      visit(ni, dist[i] + 1);
    }
    if (level.tiles[i] === Tile.Transporter) {
      transporters ??= level.tiles.reduce<number[]>((a, t, k) => (t === Tile.Transporter ? (a.push(k), a) : a), []);
      for (const k of transporters) visit(k, dist[i] + 1);
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
 * and scales difficulty. Gauntlet II levels (`style: g2`) also get its monsters (super sorcerers, acid puddles, the
 * odd dragon), amulets, poison, the It ball and thieves.
 */
export function populate(level: LevelData, seed: number, depth: number): void {
  const rng = new Rng(seed);
  const { width, height } = level;
  const exits: Pos[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (level.tiles[y * width + x] === Tile.Exit) exits.push({ x, y });

  // Start as far from the exits as possible (so the whole maze gets played), preferring open 2x2 areas for 4 heroes.
  // If the exits are shut away in a small part of the maze (some arcade mazes are, until the walls turn into exits),
  // start in the biggest open area instead, at its far end.
  let fromExit = bfsDistances(level, exits.length ? exits : [{ x: width >> 1, y: height >> 1 }]);
  const floor = (i: number) => level.tiles[i] === Tile.Floor;
  const reached = fromExit.filter((d, i) => d >= 0 && floor(i)).length;
  const total = level.tiles.filter((t) => t === Tile.Floor).length;
  if (reached < total * 0.4) {
    // The biggest area, measured from its far end (so the start lands at the other end).
    const seen = new Uint8Array(width * height);
    let size = 0;
    for (let i = 0; i < seen.length; i++) {
      if (seen[i] || !floor(i)) continue;
      const d = bfsDistances(level, [{ x: i % width, y: Math.floor(i / width) }]);
      let n = 0;
      let far = i;
      for (let j = 0; j < d.length; j++) {
        if (d[j] < 0 || !floor(j)) continue;
        seen[j] = 1;
        n++;
        if (d[j] > d[far]) far = j;
      }
      if (n > size) {
        size = n;
        fromExit = bfsDistances(level, [{ x: far % width, y: Math.floor(far / width) }]);
      }
    }
  }
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
  const g2 = level.style === 'g2';
  if (g2 && depth >= 10) pool.push('supersorcerer');

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
  if (g2) {
    itemPlan.push(['amulet', rng.chance(0.6) ? 1 : 0], ['poison', rng.int(2)], ['it', depth >= 6 && rng.chance(0.25) ? 1 : 0]);
    for (let n = depth >= 4 ? rng.int(3) : 0; n > 0; n--) {
      const p = take(8);
      if (p) level.monsters.push({ kind: 'acid', rank: 1, x: p.x, y: p.y });
    }
    if (depth >= 8 && rng.chance(0.35)) {
      // Dragons are big: they need open floor around them.
      const roomy = candidates.filter((c) => fromStart[c.y * width + c.x] >= 12
        && [-1, 0, 1].every((dy) => [-1, 0, 1].every((dx) => tileAt(level, c.x + dx, c.y + dy) === Tile.Floor)));
      if (roomy.length) {
        const p = rng.pick(roomy);
        used.add(p.y * width + p.x);
        level.monsters.push({ kind: 'dragon', rank: 1, x: p.x, y: p.y });
      }
    }
    if (!level.thief) level.thief = depth >= 4 && rng.chance(0.5);
  }
  for (const [kind, count] of itemPlan) {
    for (let n = 0; n < count; n++) {
      const p = take(3);
      if (p) level.items.push({ kind, x: p.x, y: p.y });
    }
  }
}
