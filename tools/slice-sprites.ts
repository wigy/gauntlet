/**
 * Cuts AI-generated sprite sheets into individual transparent PNGs for public/sprites/.
 *
 *   npm run sprites                  # slices art/sheets/
 *   npm run sprites -- <sheet-dir>
 *
 * (The image generator may save JPEG data under a .png name; both formats are accepted.)
 * Expects heroes, monsters, items, g2-monsters, g2-items (sprites on a flat magenta background, spaced apart) and tiles
 * (a 2x2 grid of square textures) as .png or .jpg in <sheet-dir>. Sprites are found as connected blobs of non-magenta pixels and named
 * in reading order (rows top to bottom, then left to right) using SHEETS below; textures are cut from the quadrants.
 * Everything is downscaled to SIZE px with soft (area-coverage) alpha and the magenta fringe removed from the edges.
 * HD copies for the 3D view go to public/sprites/hd/: sprites at HD_SIZE, textures (tiles, ceiling) at HD_TEXTURE.
 *
 * ceiling is one square texture (scaled to SIZE). tv is the first-person view's TV set on magenta with its screen
 * flat green: both become transparent (the renderer finds the screen as the hole in the middle), cropped to the set.
 *
 * <sheet-dir>/walk/<name>.png|jpg are walk sheets: one character in a 5x3 grid, columns facing WALK_DIRS (the other
 * three directions are mirrors), rows the walk frames. They become <name>-<dir>-<frame>.png. All frames of a sheet
 * share one scale, each column one horizontal centre and each row one baseline, so the animation doesn't jitter.
 * An optional <name>-diag sheet (2x3: se, ne) replaces the diagonal columns, which the image generator draws better
 * on their own; it is scaled so the figures are as tall as in the main sheet. A walk sheet whose background is an
 * off-shade of magenta is keyed on the colour of its corners instead.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const SIZE = 128;
const HD_SIZE = 256;
const HD_TEXTURE = 512;
const OUT = 'public/sprites';
const HD_OUT = 'public/sprites/hd';

const SHEETS: Record<string, string[]> = {
  heroes: ['warrior', 'valkyrie', 'wizard', 'elf'],
  monsters: ['ghost', 'grunt', 'demon', 'lobber', 'sorcerer', 'death'],
  items: ['food', 'cider', 'potion', 'key', 'treasure', 'generator-crate', 'potion-purple', 'treasure-gold', 'generator'],
  'g2-monsters': ['supersorcerer', 'dragon', 'thief', 'acid'],
  'g2-items': ['amulet', 'poison', 'it'],
};
const TILES = ['wall-orange', 'floor', 'wall-teal', 'door'];
const TV_WIDTH = 480;
const WALK_DIRS = ['s', 'se', 'e', 'ne', 'n'];
const WALK_DIAG_DIRS = ['se', 'ne'];
const WALK_FRAMES = 3;

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

/** Background colour of the sheet being cut, when it isn't the usual bright magenta. */
let keyColor: [number, number, number] | null = null;

function isBackground(png: PNG, i: number): boolean {
  const r = png.data[i];
  const g = png.data[i + 1];
  const b = png.data[i + 2];
  if (keyColor) return Math.abs(r - keyColor[0]) + Math.abs(g - keyColor[1]) + Math.abs(b - keyColor[2]) < 90;
  return r > 190 && b > 190 && g < 100 && Math.abs(r - b) < 60;
}

/** Key on the corner colour if the sheet's background isn't the bright magenta isBackground expects. */
function detectKey(png: PNG): void {
  keyColor = null;
  const corners = [0, png.width - 1, (png.height - 1) * png.width, png.height * png.width - 1].map((p) => p * 4);
  if (corners.every((i) => isBackground(png, i))) return;
  keyColor = [0, 1, 2].map((k) => avg(corners.map((i) => png.data[i + k]))) as [number, number, number];
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

/**
 * Sprites laid out in a cols x rows grid, which may be too tight for findSprites (a weapon nearly touching the next
 * figure). The grid lines go through the emptiest columns and rows of pixels near where even spacing puts them, and
 * each sprite is the bounding box of the foreground in its cell. Reading order, like findSprites.
 */
function gridSprites(png: PNG, cols: number, rows: number, cell = 8): Box[] {
  const gw = Math.ceil(png.width / cell);
  const gh = Math.ceil(png.height / cell);
  const fg = new Uint16Array(gw * gh);
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (!isBackground(png, (y * png.width + x) * 4)) fg[Math.floor(y / cell) * gw + Math.floor(x / cell)]++;
    }
  }
  const on = (gx: number, gy: number) => fg[gy * gw + gx] > cell;
  const cuts = (n: number, len: number, count: (i: number) => number) => {
    const out = [0];
    for (let k = 1; k < n; k++) {
      const mid = Math.round((k * len) / n);
      const reach = Math.round(len / n / 4);
      let best = mid;
      for (let i = mid - reach; i <= mid + reach; i++) if (count(i) < count(best)) best = i;
      out.push(best);
    }
    out.push(len);
    return out;
  };
  const xs = cuts(cols, gw, (gx) => Array.from({ length: gh }, (_, gy) => +on(gx, gy)).reduce((a, b) => a + b, 0));
  const ys = cuts(rows, gh, (gy) => Array.from({ length: gw }, (_, gx) => +on(gx, gy)).reduce((a, b) => a + b, 0));
  const boxes: Box[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (let gy = ys[r]; gy < ys[r + 1]; gy++) {
        for (let gx = xs[c]; gx < xs[c + 1]; gx++) {
          if (!on(gx, gy)) continue;
          box.x0 = Math.min(box.x0, gx * cell);
          box.y0 = Math.min(box.y0, gy * cell);
          box.x1 = Math.max(box.x1, Math.min(png.width, (gx + 1) * cell));
          box.y1 = Math.max(box.y1, Math.min(png.height, (gy + 1) * cell));
        }
      }
      if (box.x0 === Infinity) throw new Error(`no sprite in grid cell ${c},${r}`);
      boxes.push(box);
    }
  }
  return boxes;
}

/**
 * Area-average a source box into a size x size image. With `key`, background becomes transparent and the box is padded
 * square (or cut from `crop` instead, still keeping only the pixels inside `box`). Scaling up samples the nearest pixel.
 */
function resample(png: PNG, box: Box, key: boolean, crop?: Box, size = SIZE): PNG {
  let { x0, y0, x1, y1 } = crop ?? box;
  if (key && !crop) {
    const side = Math.max(x1 - x0, y1 - y0);
    const cx = (x0 + x1) / 2;
    x0 = cx - side / 2;
    x1 = cx + side / 2;
    y0 = y1 - side; // bottom-aligned: feet on the floor
  }
  const out = new PNG({ width: size, height: size });
  const sx = (x1 - x0) / size;
  const sy = (y1 - y0) / size;
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const ys = Math.floor(y0 + oy * sy);
      const xs = Math.floor(x0 + ox * sx);
      for (let y = ys; y < Math.max(ys + 1, Math.floor(y0 + (oy + 1) * sy)); y++) {
        for (let x = xs; x < Math.max(xs + 1, Math.floor(x0 + (ox + 1) * sx)); x++) {
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
      const o = (oy * size + ox) * 4;
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
  const size = png.width;
  const reach = Math.round((2 * size) / SIZE);
  const alphaAt = (x: number, y: number) => (x < 0 || y < 0 || x >= size || y >= size ? 0 : png.data[(y * size + x) * 4 + 3]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      if (png.data[o + 3] === 0) continue;
      let edge = png.data[o + 3] < 255;
      for (let d = 1; d <= reach && !edge; d++) edge = !alphaAt(x - d, y) || !alphaAt(x + d, y) || !alphaAt(x, y - d) || !alphaAt(x, y + d);
      if (!edge) continue;
      const [r, g, b] = [png.data[o], png.data[o + 1], png.data[o + 2]];
      const spill = Math.min(r, b) - g;
      if (spill <= 0) continue;
      png.data[o] = r - spill * 0.8;
      png.data[o + 2] = b - spill * 0.8;
    }
  }
}

function isScreenGreen(png: PNG, i: number): boolean {
  const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
  return g > 120 && g > r * 1.5 && g > b * 1.5;
}

/** The foreground of a whole sheet, cropped and scaled to `width`, with magenta and screen green transparent. */
function cutout(png: PNG, width: number): PNG {
  const clear = (i: number) => isBackground(png, i) || isScreenGreen(png, i);
  let x0 = png.width, y0 = png.height, x1 = 0, y1 = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (isBackground(png, (y * png.width + x) * 4)) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + 1);
      y1 = Math.max(y1, y + 1);
    }
  }
  const height = Math.round((width * (y1 - y0)) / (x1 - x0));
  const out = new PNG({ width, height });
  const s = (x1 - x0) / width;
  for (let oy = 0; oy < height; oy++) {
    for (let ox = 0; ox < width; ox++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = Math.floor(y0 + oy * s); y < Math.floor(y0 + (oy + 1) * s); y++) {
        for (let x = Math.floor(x0 + ox * s); x < Math.floor(x0 + (ox + 1) * s); x++) {
          n++;
          const i = (y * png.width + x) * 4;
          if (clear(i)) continue;
          r += png.data[i];
          g += png.data[i + 1];
          b += png.data[i + 2];
          a++;
        }
      }
      const o = (oy * width + ox) * 4;
      const cover = n ? a / n : 0;
      // Pull the green and pink fringes out of the edge pixels.
      const [cr, cg, cb] = a ? [r / a, g / a, b / a] : [0, 0, 0];
      out.data[o] = cover < 1 ? Math.min(cr, cg + 40) : cr;
      out.data[o + 1] = cover < 1 ? Math.min(cg, Math.max(cr, cb)) : cg;
      out.data[o + 2] = cover < 1 ? Math.min(cb, cg + 40) : cb;
      out.data[o + 3] = Math.round(255 * Math.min(1, Math.max(0, (cover - 0.15) / 0.7)));
    }
  }
  return out;
}

/** Write an output at the normal size and its HD copy at `hd`. */
function emit(file: string, make: (size: number) => PNG, hd: number): void {
  writeFileSync(join(OUT, file), PNG.sync.write(make(SIZE)));
  writeFileSync(join(HD_OUT, file), PNG.sync.write(make(hd)));
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function findSheet(dir: string, name: string): string | undefined {
  return ['png', 'jpg', 'jpeg'].map((ext) => join(dir, `${name}.${ext}`)).find((f) => existsSync(f));
}

function main(): void {
  const dir = process.argv[2] ?? 'art/sheets';
  mkdirSync(HD_OUT, { recursive: true });

  for (const [sheet, names] of Object.entries(SHEETS)) {
    const file = findSheet(dir, sheet);
    if (!file) continue;
    const png = readImage(file);
    const boxes = findSprites(png);
    if (boxes.length !== names.length) console.warn(`${sheet}: found ${boxes.length} sprites, expected ${names.length}`);
    boxes.slice(0, names.length).forEach((box, i) => emit(`${names[i]}.png`, (size) => resample(png, box, true, undefined, size), HD_SIZE));
    console.log(`${sheet}: ${boxes.slice(0, names.length).length} sprites`);
  }

  const walkDir = join(dir, 'walk');
  const walkSheets = existsSync(walkDir) ? [...new Set(readdirSync(walkDir).map((f) => f.replace(/\.(png|jpe?g)$/, '')))] : [];
  // Crop side per figure height in each main sheet, so its diagonal sheet comes out at the same scale.
  const sidePerHeight = new Map<string, number>();
  for (const name of walkSheets.sort()) {
    const file = findSheet(walkDir, name);
    if (!file) continue;
    const png = readImage(file);
    detectKey(png);
    const diag = name.endsWith('-diag');
    const dirs = diag ? WALK_DIAG_DIRS : WALK_DIRS;
    const cols = dirs.length;
    const boxes = gridSprites(png, cols, WALK_FRAMES);
    const tallest = Math.max(...boxes.map((b) => b.y1 - b.y0));
    const widest = Math.max(...boxes.map((b) => b.x1 - b.x0));
    const ratio = diag ? sidePerHeight.get(name.slice(0, -5)) : undefined;
    const side = ratio ? Math.max(widest, tallest * ratio) : Math.max(widest, tallest);
    if (!diag) sidePerHeight.set(name, side / tallest);
    const centre = dirs.map((_, c) => avg([0, 1, 2].map((r) => (boxes[r * cols + c].x0 + boxes[r * cols + c].x1) / 2)));
    const base = [0, 1, 2].map((r) => Math.max(...boxes.slice(r * cols, (r + 1) * cols).map((b) => b.y1)));
    boxes.forEach((box, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const crop = { x0: centre[c] - side / 2, x1: centre[c] + side / 2, y0: base[r] - side, y1: base[r] };
      emit(`${name.replace(/-diag$/, '')}-${dirs[c]}-${r}.png`, (size) => resample(png, box, true, crop, size), HD_SIZE);
    });
    console.log(`walk/${name}: ${boxes.length} frames`);
  }
  keyColor = null;

  const ceilingFile = findSheet(dir, 'ceiling');
  if (ceilingFile) {
    const png = readImage(ceilingFile);
    emit('ceiling.png', (size) => resample(png, { x0: 0, y0: 0, x1: png.width, y1: png.height }, false, undefined, size), HD_TEXTURE);
    console.log('ceiling: 1 texture');
  }

  const tvFile = findSheet(dir, 'tv');
  if (tvFile) {
    writeFileSync(join(OUT, 'tv.png'), PNG.sync.write(cutout(readImage(tvFile), TV_WIDTH)));
    console.log('tv: 1 frame');
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
      emit(`${name}.png`, (size) => resample(png, box, false, undefined, size), HD_TEXTURE);
    });
    console.log(`tiles: ${TILES.length} textures`);
  }
}

main();
