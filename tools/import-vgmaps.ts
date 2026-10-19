/**
 * Converts the arcade Gauntlet (1985) maze rips on VGMaps (https://www.vgmaps.com/Atlas/Arcade/, ripped by RBR Arcade)
 * into our level text format.
 *
 *   npm run import:g1                # all levels
 *   npm run import:g1 -- 1 9 78      # just these level numbers (prints them as ASCII)
 *
 * Output: public/levels/gauntlet1/NNN-<name>.txt + index.json. Downloads are cached in .import-cache/.
 * Both are gitignored: the layouts are Atari's, so they're generated locally rather than committed.
 *
 * The rips are 528x528 px: 33x33 cells of 16 px. The arcade maze is a 32x32 torus, so cell row/column 32 repeats
 * row/column 0. If that edge is solid wall we keep the repeat (an enclosed 33-wide map); if it has openings we drop it
 * and mark the level as wrapping on that axis.
 * They only show walls and exits (no monsters, items or doors); the game fills them in with populate().
 * Walls vs floor are told apart by 2-means clustering of each cell's average colour (wall cluster = brighter one);
 * a cell that is mostly pure black is an exit.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { BASE, fetchCached } from './vgmaps';

const OUT = 'public/levels/gauntlet1';
const CELL = 16;
const SIZE = 33;

type RGB = [number, number, number];

async function listLevels(): Promise<{ num: number; file: string; name: string }[]> {
  const html = (await fetchCached('index.htm')).toString('latin1');
  const seen = new Map<number, { num: number; file: string; name: string }>();
  for (const m of html.matchAll(/Gauntlet-Level-(\d+)-([A-Za-z0-9]+)\.png/g)) {
    const num = Number(m[1]);
    const name = m[2].replace(/([a-z])([A-Z])/g, '$1 $2');
    seen.set(num, { num, file: m[0], name });
  }
  return [...seen.values()].sort((a, b) => a.num - b.num);
}

export function convert(png: PNG): { rows: string[]; wrapX: boolean; wrapY: boolean } {
  const px = (x: number, y: number): RGB => {
    const i = (y * png.width + x) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2]];
  };
  const means: RGB[] = [];
  const black: number[] = [];
  for (let ty = 0; ty < SIZE; ty++) {
    for (let tx = 0; tx < SIZE; tx++) {
      const sum: RGB = [0, 0, 0];
      let n = 0;
      for (let y = 3; y < 10; y++) {
        for (let x = 3; x < 10; x++) {
          const c = px(tx * CELL + x, ty * CELL + y);
          sum[0] += c[0];
          sum[1] += c[1];
          sum[2] += c[2];
          n++;
        }
      }
      means.push([sum[0] / n, sum[1] / n, sum[2] / n]);
      let b = 0;
      for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) if (px(tx * CELL + x, ty * CELL + y).every((v) => v === 0)) b++;
      black.push(b);
    }
  }

  const isExit = (i: number) => black[i] > 150;
  const pts = means.filter((_, i) => !isExit(i));
  const bright = (c: RGB) => Math.max(...c) + (Math.max(...c) - Math.min(...c));
  let centers: RGB[] = [pts.reduce((a, b) => (bright(b) < bright(a) ? b : a)), pts.reduce((a, b) => (bright(b) > bright(a) ? b : a))];
  const dist = (a: RGB, b: RGB) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  for (let iter = 0; iter < 20; iter++) {
    const groups: RGB[][] = [[], []];
    for (const p of pts) groups[dist(p, centers[1]) < dist(p, centers[0]) ? 1 : 0].push(p);
    centers = groups.map((g, k): RGB => {
      if (!g.length) return centers[k];
      return [0, 1, 2].map((c) => g.reduce((s, p) => s + p[c], 0) / g.length) as RGB;
    });
  }

  const rows: string[] = [];
  for (let ty = 0; ty < SIZE; ty++) {
    let row = '';
    for (let tx = 0; tx < SIZE; tx++) {
      const i = ty * SIZE + tx;
      row += isExit(i) ? 'E' : dist(means[i], centers[1]) < dist(means[i], centers[0]) ? '#' : '.';
    }
    rows.push(row);
  }
  const wrapX = rows.some((r) => r[0] !== '#');
  const wrapY = [...rows[0]].some((c) => c !== '#');
  const kept = (wrapY ? rows.slice(0, SIZE - 1) : rows).map((r) => (wrapX ? r.slice(0, SIZE - 1) : r));
  return { rows: kept, wrapX, wrapY };
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).map(Number).filter(Boolean);
  const levels = (await listLevels()).filter((l) => !only.length || only.includes(l.num));
  if (!levels.length) throw new Error('no Gauntlet levels found on the VGMaps index');
  mkdirSync(OUT, { recursive: true });
  const index: string[] = [];
  for (const l of levels) {
    const png = PNG.sync.read(await fetchCached(l.file));
    if (png.width < SIZE * CELL || png.height < SIZE * CELL) throw new Error(`${l.file}: unexpected size ${png.width}x${png.height}`);
    const { rows, wrapX, wrapY } = convert(png);
    const wrap = wrapX && wrapY ? 'both' : wrapX ? 'x' : wrapY ? 'y' : 'none';
    const text = `name: ${l.name}\nwrap: ${wrap}\nsource: ${BASE}${l.file}\n---\n${rows.join('\n')}\n`;
    const file = `${String(l.num).padStart(3, '0')}-${l.name.replace(/\s+/g, '')}.txt`;
    writeFileSync(join(OUT, file), text);
    index.push(file);
    if (only.length) console.log(`${file}\n${text}`);
    else process.stdout.write(`\r${l.num}/${levels.length} ${l.name}`.padEnd(40));
  }
  if (!only.length) {
    writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 1));
    console.log(`\nwrote ${index.length} levels to ${OUT}`);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
