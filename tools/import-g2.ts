/**
 * Converts the arcade Gauntlet II (1986) maze rips on VGMaps (https://www.vgmaps.com/Atlas/Arcade/, ripped by George)
 * into our level text format.
 *
 *   npm run import:g2                # all levels
 *   npm run import:g2 -- 1 9 78      # just these level numbers (prints them as ASCII)
 *
 * Output: public/levels/gauntlet2/NNN.txt + index.json, gitignored like the Gauntlet I import (the layouts are Atari's).
 *
 * The rips come as sheets of nine 512x512 maps (a 32x32 maze of 16 px tiles, wrapping at the edges), separated by
 * white. Unlike the Gauntlet I rips each map is cropped at its own offset and drawn in its own palette, with
 * shadows, sprites for transporters and force field posts, and Gauntlet II's special tiles. So per map we:
 *
 * 1. find the tile grid offset: the one where the centre of each cell is most purely floor or wall colour;
 * 2. take the floor palette (the most common set of colours in cell centres) and the wall palette (the most common
 *    sets among the rest);
 * 3. find exits (black with white EXIT text), transporters and force field posts (blobs of bright red: transporters
 *    are about 150 px, posts other sizes), then walls;
 * 4. read what's left from colours that are rare in the map: bright mottled blocks are breakable walls, dim patches
 *    and small glyphs on the floor are stun tiles, and the cells between two posts in line are force fields.
 *
 * Trap walls look like any other wall in the rips, so traps aren't imported. The rips carry no monsters or items:
 * populate() places them (with `style: g2`, the Gauntlet II ones too).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { BASE, fetchCached } from './vgmaps';

const OUT = 'public/levels/gauntlet2';
const MAP = 512;
const N = 32;
const WHITE = 0xffffff;
const BLACK = 0;

type Cell = number; // k + l * N
type Grid = string[];

interface Sheet {
  file: string;
  first: number;
  last: number;
  demo: boolean;
}

async function listSheets(): Promise<Sheet[]> {
  const html = (await fetchCached('index.htm')).toString('latin1');
  const files = [...new Set([...html.matchAll(/GauntletII-[^"]*Levels-\d+-\d+[^"]*\.png/g)].map((m) => m[0]))];
  return files.map((file) => {
    const [, a, b] = /Levels-(\d+)-(\d+)/.exec(file)!;
    return { file, first: Number(a), last: Number(b), demo: file.includes('Demo') };
  }).sort((a, b) => a.first - b.first);
}

/** A sheet as packed 0xRRGGBB pixels. */
function pixels(png: PNG): Int32Array {
  const out = new Int32Array(png.width * png.height);
  for (let i = 0; i < out.length; i++) out[i] = (png.data[i * 4] << 16) | (png.data[i * 4 + 1] << 8) | png.data[i * 4 + 2];
  return out;
}

function runs(n: number, filled: (i: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n;) {
    if (!filled(i)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && filled(j)) j++;
    out.push([i, j]);
    i = j;
  }
  return out;
}

/** The 512x512 maps on a sheet, in reading order. */
function cutMaps(png: PNG): Int32Array[] {
  const px = pixels(png);
  const { width, height } = png;
  const rowWhite = (y: number, x0 = 0, x1 = width) => {
    for (let x = x0; x < x1; x++) if (px[y * width + x] !== WHITE) return false;
    return true;
  };
  const maps: Int32Array[] = [];
  for (const [y0, y1] of runs(height, (y) => !rowWhite(y))) {
    if (y1 - y0 < MAP) continue;
    const colWhite = (x: number) => {
      for (let y = y0; y < y0 + MAP; y++) if (px[y * width + x] !== WHITE) return false;
      return true;
    };
    for (const [x0, x1] of runs(width, (x) => !colWhite(x))) {
      if (x1 - x0 !== MAP) continue;
      const m = new Int32Array(MAP * MAP);
      for (let y = 0; y < MAP; y++) m.set(px.subarray((y0 + y) * width + x0, (y0 + y) * width + x0 + MAP), y * MAP);
      maps.push(m);
    }
  }
  return maps;
}

const wrap = (v: number) => ((v % MAP) + MAP) % MAP;
const r8 = (c: number) => (c >> 16) & 255;
const g8 = (c: number) => (c >> 8) & 255;
const b8 = (c: number) => c & 255;
const lum = (c: number) => 0.3 * r8(c) + 0.59 * g8(c) + 0.11 * b8(c);

/** Pixels of cell (k, l) within `r0..r1` of its centre, for a grid offset (ox, oy). */
function region(m: Int32Array, ox: number, oy: number, k: number, l: number, r0: number, r1: number): number[] {
  const out: number[] = [];
  const cx = 16 * k + ox + 8;
  const cy = 16 * l + oy + 8;
  for (let dy = r0; dy < r1; dy++) for (let dx = r0; dx < r1; dx++) out.push(m[wrap(cy + dy) * MAP + wrap(cx + dx)]);
  return out;
}

function counts<T>(xs: T[]): Map<T, number> {
  const c = new Map<T, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return c;
}

/** The set of colours with at least 3 pixels, as a sortable key. */
function signature(px: number[]): string {
  return [...counts(px)].filter(([, v]) => v >= 3).map(([c]) => c).sort((a, b) => a - b).join(',');
}

function mostCommon(keys: string[], n: number): string[] {
  return [...counts(keys)].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}

const colours = (key: string) => (key ? key.split(',').map(Number) : []);

/** Floor palette (most common cell-centre colour set) and wall palette (most common sets among the non-floor rest). */
function palettes(m: Int32Array, ox: number, oy: number, skip = new Set<Cell>()): { F: Set<number>; W: Set<number>; fF: number[] } {
  const cen: number[][] = [];
  for (let l = 0; l < N; l++) for (let k = 0; k < N; k++) cen.push(region(m, ox, oy, k, l, -5, 5));
  const F = new Set(colours(mostCommon(cen.map(signature), 1)[0]));
  const fF = cen.map((px) => px.filter((c) => F.has(c)).length / px.length);
  const rest = cen.filter((_, i) => !skip.has(i) && fF[i] < 0.5).map(signature);
  const W = new Set(mostCommon(rest, 2).flatMap(colours).filter((c) => !F.has(c)));
  return { F, W, fF };
}

/**
 * Grid offset where cell centres are most purely floor or wall, and how many cells are still mixed there (a poor fit
 * means walls drawn in perspective or too close to the floor colours to read).
 */
function findOffset(m: Int32Array): [number, number, number] {
  let ox = 8;
  let oy = 8;
  let best = Infinity;
  for (let pass = 0; pass < 2; pass++) {
    const { F, W } = palettes(m, ox, oy);
    const cls = new Uint8Array(MAP * MAP);
    for (let i = 0; i < cls.length; i++) cls[i] = F.has(m[i]) ? 1 : W.has(m[i]) ? 2 : 0;
    best = Infinity;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        let mixed = 0;
        for (let l = 0; l < N; l++) {
          for (let k = 0; k < N; k++) {
            let f = 0;
            let w = 0;
            for (let dy = 3; dy < 13; dy++) {
              const row = wrap(16 * l + y + dy) * MAP;
              for (let dx = 3; dx < 13; dx++) {
                const c = cls[row + wrap(16 * k + x + dx)];
                if (c === 1) f++;
                else if (c === 2) w++;
              }
            }
            if (f < 80 && w < 80) mixed++;
          }
        }
        if (mixed < best) [best, ox, oy] = [mixed, x, y];
      }
    }
  }
  return [ox, oy, best];
}

/** Connected blobs of `mask` pixels on the torus: centre and size. */
function blobs(mask: Uint8Array, minSize: number): { cx: number; cy: number; size: number }[] {
  const seen = new Uint8Array(mask.length);
  const out: { cx: number; cy: number; size: number }[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    const x0 = i % MAP;
    const y0 = (i - x0) / MAP;
    const stack = [i];
    seen[i] = 1;
    let n = 0;
    let sx = 0;
    let sy = 0;
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % MAP;
      const y = (j - x) / MAP;
      n++;
      // Offsets from the first pixel, so blobs across the wrap average correctly.
      sx += ((x - x0 + MAP * 1.5) % MAP) - MAP / 2;
      sy += ((y - y0 + MAP * 1.5) % MAP) - MAP / 2;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const q = wrap(y + dy) * MAP + wrap(x + dx);
          if (mask[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
    }
    if (n >= minSize) out.push({ cx: wrap(x0 + sx / n), cy: wrap(y0 + sy / n), size: n });
  }
  return out;
}

/** Maps whose grid fits worse than this (cells neither floor nor wall) don't convert reliably. */
const MAX_MIXED = 55;

export function convert(m: Int32Array): { rows: Grid; wrapX: boolean; wrapY: boolean } | { problem: string } {
  const [ox, oy, mixed] = findOffset(m);
  if (mixed > MAX_MIXED) return { problem: `walls not readable (${mixed} unclear cells)` };
  const at = (k: number, l: number): Cell => (((l % N) + N) % N) * N + (((k % N) + N) % N);
  const full: number[][] = [];
  const mid: number[][] = [];
  const cen: number[][] = [];
  for (let l = 0; l < N; l++) {
    for (let k = 0; k < N; k++) {
      full.push(region(m, ox, oy, k, l, -8, 8));
      mid.push(region(m, ox, oy, k, l, -6, 6));
      cen.push(region(m, ox, oy, k, l, -5, 5));
    }
  }
  const T: string[] = new Array(N * N).fill('');
  const black = full.map((px) => px.filter((c) => c === BLACK).length);
  const white = full.map((px) => px.filter((c) => Math.min(r8(c), g8(c), b8(c)) >= 200).length);
  for (let i = 0; i < T.length; i++) if (black[i] >= 60 && white[i] >= 10) T[i] = 'E';

  const exits = new Set(T.flatMap((t, i) => (t === 'E' ? [i] : [])));
  const { F, W, fF } = palettes(m, ox, oy, exits);
  // Colours that show up in many cells are floor, wall or shadow; the rare ones are what's special.
  const coverage = new Map<number, number>();
  for (const px of full) for (const [c, v] of counts(px)) if (v >= 3) coverage.set(c, (coverage.get(c) ?? 0) + 1);
  const common = new Set([...coverage].filter(([, v]) => v >= 60).map(([c]) => c));

  // Transporters and force field posts are bright red sprites (not on the tile grid, hence blobs).
  const plain = new Set([...W, ...F].filter((c) => c !== BLACK));
  const red = new Uint8Array(MAP * MAP);
  for (let i = 0; i < red.length; i++) {
    const c = m[i];
    red[i] = r8(c) >= 130 && g8(c) <= 70 && b8(c) <= 70 && r8(c) - g8(c) >= 100 && !plain.has(c) ? 1 : 0;
  }
  for (const b of blobs(red, 30)) {
    const i = at(Math.floor((b.cx - ox) / 16), Math.floor((b.cy - oy) / 16));
    if (!T[i]) T[i] = b.size >= 140 && b.size <= 165 ? '@' : 'R';
  }

  const frac = (px: number[], set: Set<number>) => px.filter((c) => set.has(c)).length / px.length;
  for (let i = 0; i < T.length; i++) if (!T[i] && frac(cen[i], W) >= 0.5) T[i] = '#';
  for (let i = 0; i < T.length; i++) {
    if (T[i]) continue;
    const foreign = mid[i].filter((c) => !common.has(c)).length / mid[i].length;
    if (white[i] >= 40) T[i] = 'M';
    else if (fF[i] >= 0.85 && foreign < 0.03) T[i] = '.';
    else if (foreign >= 0.35) T[i] = 'P';
    else if (foreign >= 0.08) T[i] = '^';
    else T[i] = fF[i] >= 0.5 ? '.' : '#';
  }

  // Patches: lighter than the floor = breakable wall, otherwise a stun tile.
  const floorPx = cen.flat().filter((c) => F.has(c));
  const floorL = floorPx.reduce((s, c) => s + lum(c), 0) / Math.max(1, floorPx.length);
  for (let i = 0; i < T.length; i++) {
    if (T[i] !== 'P') continue;
    const fo = mid[i].filter((c) => !common.has(c));
    T[i] = fo.reduce((s, c) => s + lum(c), 0) / fo.length > floorL * 1.15 + 4 ? '*' : '~';
  }
  // Sprites spill into the cells around them: undo what that spill made of those cells.
  for (let i = 0; i < T.length; i++) {
    if (T[i] !== 'R' && T[i] !== '@') continue;
    for (let dl = -1; dl <= 1; dl++) {
      for (let dk = -1; dk <= 1; dk++) {
        const q = at((i % N) + dk, Math.floor(i / N) + dl);
        if ('^*~M'.includes(T[q])) T[q] = fF[q] >= 0.3 ? '.' : '#';
      }
    }
  }

  // Force fields run between two posts in line, through anything but walls (whose colours aren't black).
  const wallish = new Set([...W].filter((c) => c !== BLACK));
  const posts = T.flatMap((t, i) => (t === 'R' ? [i] : []));
  for (const a of posts) {
    for (const b of posts) {
      if (b <= a) continue;
      const [ak, al, bk, bl] = [a % N, Math.floor(a / N), b % N, Math.floor(b / N)];
      let gap: Cell[];
      if (al === bl && Math.abs(ak - bk) - 1 <= 8) gap = range(Math.min(ak, bk) + 1, Math.max(ak, bk)).map((k) => at(k, al));
      else if (ak === bk && Math.abs(al - bl) - 1 <= 8) gap = range(Math.min(al, bl) + 1, Math.max(al, bl)).map((l) => at(ak, l));
      else continue;
      if (gap.every((g) => !'ER@'.includes(T[g]) && frac(cen[g], wallish) < 0.6)) for (const g of gap) T[g] = '=';
    }
  }
  for (const p of posts) T[p] = '#';

  // Trap walls can't be told from walls, so floor glyphs become stun tiles, unless there are so many that they must
  // be floor texture.
  const glyphs = T.filter((t) => t === '^').length;
  for (let i = 0; i < T.length; i++) if (T[i] === '^') T[i] = glyphs <= 40 ? '~' : '.';
  if (T.filter((t) => t === '~').length > 60) for (let i = 0; i < T.length; i++) if (T[i] === '~') T[i] = '.';
  for (let i = 0; i < T.length; i++) if (T[i] === 'M') T[i] = '*';

  // The maze is a torus: put a solid row and column (if any) at the edges, and wrap where there is none.
  const solid = (t: string) => t === '#';
  const rowWalls = range(0, N).map((l) => range(0, N).filter((k) => solid(T[at(k, l)])).length);
  const colWalls = range(0, N).map((k) => range(0, N).filter((l) => solid(T[at(k, l)])).length);
  const top = rowWalls.indexOf(Math.max(...rowWalls));
  const left = colWalls.indexOf(Math.max(...colWalls));
  const rows = range(0, N).map((l) => range(0, N).map((k) => T[at(k + left, l + top)]).join(''));
  const walls = T.filter((t) => t === '#').length / T.length;
  if (walls > 0.6) return { problem: `${Math.round(walls * 100)}% walls doesn't look right` };
  if (!T.includes('E')) return { problem: 'no exit found' };
  return { rows, wrapX: colWalls[left] < N, wrapY: rowWalls[top] < N };
}

function range(a: number, b: number): number[] {
  return Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).map(Number).filter(Boolean);
  const sheets = await listSheets();
  if (!sheets.length) throw new Error('no Gauntlet II sheets found on the VGMaps index');
  mkdirSync(OUT, { recursive: true });
  const index: string[] = [];
  const skipped: string[] = [];
  for (const sheet of sheets) {
    const maps = cutMaps(PNG.sync.read(await fetchCached(sheet.file)));
    // The first sheet starts with the attract-mode demo maze; the last ends with secret rooms.
    const levels = maps.slice(sheet.demo ? 1 : 0).slice(0, sheet.last - sheet.first + 1);
    levels.forEach((m, i) => {
      const num = sheet.first + i;
      if (only.length && !only.includes(num)) return;
      const result = convert(m);
      if ('problem' in result) {
        skipped.push(`${num} (${result.problem})`);
        return;
      }
      const { rows, wrapX, wrapY } = result;
      const wrap = wrapX && wrapY ? 'both' : wrapX ? 'x' : wrapY ? 'y' : 'none';
      const text = `name: Maze ${num}\nwrap: ${wrap}\nstyle: g2\nsource: ${BASE}${sheet.file}\n---\n${rows.join('\n')}\n`;
      const file = `${String(num).padStart(3, '0')}.txt`;
      writeFileSync(join(OUT, file), text);
      index.push(file);
      if (only.length) console.log(`${file}\n${text}`);
      else process.stdout.write(`\r${num} `);
    });
  }
  if (!only.length) {
    writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 1));
    console.log(`\nwrote ${index.length} levels to ${OUT}`);
  }
  if (skipped.length) console.log(`skipped ${skipped.length}: ${skipped.join(', ')}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
