/**
 * Cuts AI-generated sprite sheets into individual transparent PNGs for public/sprites/.
 *
 *   npm run sprites                  # slices art/sheets/
 *   npm run sprites -- <sheet-dir>
 *
 * (The image generator may save JPEG data under a .png name; both formats are accepted.)
 * Expects heroes, monsters, items (sprites on a flat magenta background, spaced apart) and tiles
 * (a 2x2 grid of square textures) as .png or .jpg in <sheet-dir>. Sprites are found as connected blobs of non-magenta pixels and named
 * in reading order (rows top to bottom, then left to right) using SHEETS below; textures are cut from the quadrants.
 * Everything is downscaled to SIZE px with soft (area-coverage) alpha and the magenta fringe removed from the edges.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const SIZE = 128;
const OUT = 'public/sprites';

const SHEETS: Record<string, string[]> = {
  heroes: ['warrior', 'valkyrie', 'wizard', 'elf'],
  monsters: ['ghost', 'grunt', 'demon', 'lobber', 'sorcerer', 'death'],
  items: ['food', 'cider', 'potion', 'key', 'treasure', 'generator-crate', 'potion-purple', 'treasure-gold', 'generator'],
};
const TILES = ['wall-orange', 'floor', 'wall-teal', 'door'];

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Decode PNG or JPEG (sniffed from the magic bytes) into a pngjs image. */
function readImage(file: string): PNG {
  const buf = readFileSync(file);
  if (buf[0] === 0x89 && buf[1] === 0x50) return PNG.sync.read(buf);
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  const png = new PNG({ width: img.width, height: img.height });
  png.data.set(img.data);
  return png;
}

function isBackground(png: PNG, i: number): boolean {
  const r = png.data[i];
  const g = png.data[i + 1];
  const b = png.data[i + 2];
  return r > 190 && b > 190 && g < 100 && Math.abs(r - b) < 60;
}

/** Blobs of foreground pixels, found on a coarse grid (so nearby fragments like a sword tip join their owner). */
function findSprites(png: PNG, cell = 8): Box[] {
  const gw = Math.ceil(png.width / cell);
  const gh = Math.ceil(png.height / cell);
  const fg = new Uint8Array(gw * gh);
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (!isBackground(png, (y * png.width + x) * 4)) fg[Math.floor(y / cell) * gw + Math.floor(x / cell)]++;
    }
  }
  // A cell counts if a meaningful share of it is foreground (ignores stray noise pixels).
  const on = (gx: number, gy: number) => gx >= 0 && gy >= 0 && gx < gw && gy < gh && fg[gy * gw + gx] > cell;
  const seen = new Uint8Array(gw * gh);
  const boxes: Box[] = [];
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      if (seen[gy * gw + gx] || !on(gx, gy)) continue;
      const box: Box = { x0: gx, y0: gy, x1: gx, y1: gy };
      let count = 0;
      const stack = [[gx, gy]];
      seen[gy * gw + gx] = 1;
      while (stack.length) {
        const [cx, cy] = stack.pop()!;
        count++;
        box.x0 = Math.min(box.x0, cx);
        box.y0 = Math.min(box.y0, cy);
        box.x1 = Math.max(box.x1, cx);
        box.y1 = Math.max(box.y1, cy);
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (on(nx, ny) && !seen[ny * gw + nx]) {
              seen[ny * gw + nx] = 1;
              stack.push([nx, ny]);
            }
          }
        }
      }
      if (count >= 30) boxes.push({ x0: box.x0 * cell, y0: box.y0 * cell, x1: Math.min(png.width, (box.x1 + 1) * cell), y1: Math.min(png.height, (box.y1 + 1) * cell) });
    }
  }
  // Reading order: group into rows by vertical centre, then left to right.
  const rowTol = png.height / 8;
  boxes.sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1));
  const rows: Box[][] = [];
  for (const b of boxes) {
    const row = rows.find((r) => Math.abs((r[0].y0 + r[0].y1) / 2 - (b.y0 + b.y1) / 2) < rowTol);
    if (row) row.push(b);
    else rows.push([b]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.x0 - b.x0));
}

/** Area-average a source box into a SIZE x SIZE image. With `key`, background becomes transparent and the box is padded square. */
function resample(png: PNG, box: Box, key: boolean): PNG {
  let { x0, y0, x1, y1 } = box;
  if (key) {
    const side = Math.max(x1 - x0, y1 - y0);
    const cx = (x0 + x1) / 2;
    x0 = cx - side / 2;
    x1 = cx + side / 2;
    y0 = y1 - side; // bottom-aligned: feet on the floor
  }
  const out = new PNG({ width: SIZE, height: SIZE });
  const sx = (x1 - x0) / SIZE;
  const sy = (y1 - y0) / SIZE;
  for (let oy = 0; oy < SIZE; oy++) {
    for (let ox = 0; ox < SIZE; ox++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = Math.floor(y0 + oy * sy); y < Math.floor(y0 + (oy + 1) * sy); y++) {
        for (let x = Math.floor(x0 + ox * sx); x < Math.floor(x0 + (ox + 1) * sx); x++) {
          n++;
          if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
          // Padding to a square must not pull in parts of neighbouring sprites.
          if (key && (x < box.x0 || x >= box.x1 || y < box.y0 || y >= box.y1)) continue;
          const i = (y * png.width + x) * 4;
          if (key && isBackground(png, i)) continue;
          r += png.data[i];
          g += png.data[i + 1];
          b += png.data[i + 2];
          a++;
        }
      }
      const o = (oy * SIZE + ox) * 4;
      const cover = n > 0 ? a / n : 0;
      out.data[o] = a ? r / a : 0;
      out.data[o + 1] = a ? g / a : 0;
      out.data[o + 2] = a ? b / a : 0;
      // Soft edges, with a little contrast so faint halo pixels vanish and the body stays opaque.
      out.data[o + 3] = Math.round(255 * Math.min(1, Math.max(0, (cover - 0.15) / 0.7)));
    }
  }
  if (key) despill(out);
  return out;
}

/** Antialiased JPEG edges blend sprite and magenta; pull that pink cast out of pixels near transparency. */
function despill(png: PNG): void {
  const alphaAt = (x: number, y: number) => (x < 0 || y < 0 || x >= SIZE || y >= SIZE ? 0 : png.data[(y * SIZE + x) * 4 + 3]);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const o = (y * SIZE + x) * 4;
      if (png.data[o + 3] === 0) continue;
      let edge = png.data[o + 3] < 255;
      for (let d = 1; d <= 2 && !edge; d++) edge = !alphaAt(x - d, y) || !alphaAt(x + d, y) || !alphaAt(x, y - d) || !alphaAt(x, y + d);
      if (!edge) continue;
      const [r, g, b] = [png.data[o], png.data[o + 1], png.data[o + 2]];
      const spill = Math.min(r, b) - g;
      if (spill <= 0) continue;
      png.data[o] = r - spill * 0.8;
      png.data[o + 2] = b - spill * 0.8;
    }
  }
}

function findSheet(dir: string, name: string): string | undefined {
  return ['png', 'jpg', 'jpeg'].map((ext) => join(dir, `${name}.${ext}`)).find((f) => existsSync(f));
}

function main(): void {
  const dir = process.argv[2] ?? 'art/sheets';
  mkdirSync(OUT, { recursive: true });

  for (const [sheet, names] of Object.entries(SHEETS)) {
    const file = findSheet(dir, sheet);
    if (!file) continue;
    const png = readImage(file);
    const boxes = findSprites(png);
    if (boxes.length !== names.length) console.warn(`${sheet}: found ${boxes.length} sprites, expected ${names.length}`);
    boxes.slice(0, names.length).forEach((box, i) => writeFileSync(join(OUT, `${names[i]}.png`), PNG.sync.write(resample(png, box, true))));
    console.log(`${sheet}: ${boxes.slice(0, names.length).length} sprites`);
  }

  const tilesFile = findSheet(dir, 'tiles');
  if (tilesFile) {
    const png = readImage(tilesFile);
    const hw = png.width / 2;
    const hh = png.height / 2;
    const inset = Math.round(png.width * 0.015); // skip the dark gutters between quadrants
    TILES.forEach((name, i) => {
      const qx = (i % 2) * hw;
      const qy = Math.floor(i / 2) * hh;
      const box = { x0: qx + inset, y0: qy + inset, x1: qx + hw - inset, y1: qy + hh - inset };
      writeFileSync(join(OUT, `${name}.png`), PNG.sync.write(resample(png, box, false)));
    });
    console.log(`tiles: ${TILES.length} textures`);
  }
}

main();
