import { Tile, isSolid, isWallLike, tileAt } from '../core/level';
import type { LevelData } from '../core/level';

/**
 * A small first-person view of the maze from one hero's eyes, raycast like Wolfenstein 3D into a low-resolution
 * buffer: textured walls and floor, and everything else as billboards (sprites that always face the camera). Walls are
 * one tile high and the eye is half a tile above the floor. There's no roof, as in the arcade (lobbers throw rocks over
 * the walls): above the walls is darkness, and a billboard behind a wall shows wherever it rises above it.
 * Coordinates are tiles, as in the game.
 */

/** Something drawn as a billboard. dx/dy are its offset from the eye (already wrapped). */
export interface Billboard {
  dx: number;
  dy: number;
  img: CanvasImageSource;
  flip: boolean;
  /** Height of the (square) image in tiles. */
  size: number;
  /** Height of the image's bottom edge above the floor, in tiles. */
  lift: number;
  alpha: number;
  /** Glows by itself: not darkened with distance. */
  bright?: boolean;
}

export interface Eye {
  x: number;
  y: number;
  /** Viewing direction in radians (0 = east, y down). */
  angle: number;
  /** Vertical head bob in pixels of the output buffer. */
  bob: number;
}

export interface Textures {
  wall?: CanvasImageSource;
  door?: CanvasImageSource;
  floor?: CanvasImageSource;
}

interface Texture {
  w: number;
  h: number;
  data: Uint8ClampedArray;
  /** The same pixels a whole RGBA pixel at a time (little-endian: 0xAABBGGRR). */
  px: Uint32Array;
  /** Mipmaps: this texture, then copies halved in size down to MIN_MIP, for drawing it small without sparkle. */
  mips: Texture[];
}

const MIN_MIP = 16;

/** The mipmap to sample when one screen pixel covers `texels` texture pixels. */
function mip(t: Texture, texels: number): Texture {
  const level = texels < 2 ? 0 : Math.min(t.mips.length - 1, Math.floor(Math.log2(texels)));
  return t.mips[level];
}

function readPixels(src: CanvasImageSource, w: number, h: number): Texture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  const data = g.getImageData(0, 0, w, h).data;
  return { w, h, data, px: new Uint32Array(data.buffer), mips: [] };
}

/** Half the field of view, as the length of the camera plane (0.66 is about 66 degrees). */
const PLANE = 0.66;
const MAX_STEPS = 64;

/** Colour multipliers for floor tiles that do something. */
const FLOOR_TINT: Partial<Record<Tile, [number, number, number]>> = {
  [Tile.Exit]: [0.6, 1.1, 1.9],
  [Tile.Trap]: [1.2, 1.05, 0.75],
  [Tile.Stun]: [1.5, 1.4, 0.5],
  [Tile.Transporter]: [1.8, 0.6, 0.6],
};

export class FirstPersonView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private image: ImageData | null = null;
  private zbuf = new Float32Array(0);
  private out32 = new Uint32Array(0);
  /** Per column, the rows the wall covers (floor and darkness are only drawn outside them). */
  private wallTop = new Int32Array(0);
  private wallEnd = new Int32Array(0);
  private textures = new WeakMap<object, Texture>();
  private fallback = new Map<string, Texture>();

  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }

  private resize(w: number, h: number): void {
    if (this.image && this.image.width === w && this.image.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.image = this.ctx.createImageData(w, h);
    this.out32 = new Uint32Array(this.image.data.buffer);
    this.zbuf = new Float32Array(w);
    this.wallTop = new Int32Array(w);
    this.wallEnd = new Int32Array(w);
  }

  /** Pixel data of an image, read once and cached; a flat colour stands in for one that hasn't loaded. */
  private texture(img: CanvasImageSource | undefined, color: string): Texture {
    if (img) {
      const cached = this.textures.get(img);
      if (cached) return cached;
      const w = (img as HTMLImageElement).width;
      const h = (img as HTMLImageElement).height;
      if (w && h) {
        const tex = readPixels(img, w, h);
        tex.mips.push(tex);
        for (let mw = w >> 1, mh = h >> 1; Math.min(mw, mh) >= MIN_MIP; mw >>= 1, mh >>= 1) {
          const m = readPixels(img, mw, mh);
          m.mips.push(m);
          tex.mips.push(m);
        }
        this.textures.set(img, tex);
        return tex;
      }
    }
    let tex = this.fallback.get(color);
    if (!tex) {
      const n = parseInt(color.slice(1), 16);
      const data = new Uint8ClampedArray([(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]);
      tex = { w: 1, h: 1, data, px: new Uint32Array(data.buffer), mips: [] };
      tex.mips.push(tex);
      this.fallback.set(color, tex);
    }
    return tex;
  }

  /** Render the view into `canvas` (w x h pixels). `fieldOn`: force fields are burning. */
  render(level: LevelData, eye: Eye, tex: Textures, billboards: Billboard[], w: number, h: number, fieldOn: boolean): void {
    this.resize(w, h);
    const out = this.image!.data;
    const zbuf = this.zbuf;
    const wallTex = this.texture(tex.wall, '#8a5030');
    const doorTex = this.texture(tex.door, '#a07030');
    const floorTex = this.texture(tex.floor, '#302a3a');

    const dirX = Math.cos(eye.angle);
    const dirY = Math.sin(eye.angle);
    // y grows downwards, so the camera's right-hand side is the direction turned +90 degrees.
    const planeX = -dirY * PLANE;
    const planeY = dirX * PLANE;
    const horizon = Math.round(h / 2 + eye.bob);

    const out32 = this.out32;
    const wallTop = this.wallTop;
    const wallEnd = this.wallEnd;

    // Walls: one ray per column, stepping through the grid (DDA) until it hits something solid.
    for (let x = 0; x < w; x++) {
      const camX = (2 * x) / w - 1;
      const rayX = dirX + planeX * camX;
      const rayY = dirY + planeY * camX;
      let mapX = Math.floor(eye.x);
      let mapY = Math.floor(eye.y);
      const ddx = Math.abs(1 / rayX);
      const ddy = Math.abs(1 / rayY);
      const stepX = rayX < 0 ? -1 : 1;
      const stepY = rayY < 0 ? -1 : 1;
      let sideX = rayX < 0 ? (eye.x - mapX) * ddx : (mapX + 1 - eye.x) * ddx;
      let sideY = rayY < 0 ? (eye.y - mapY) * ddy : (mapY + 1 - eye.y) * ddy;
      let ySide = false;
      let tile = Tile.Floor;
      let steps = 0;
      for (; steps < MAX_STEPS; steps++) {
        if (sideX < sideY) {
          sideX += ddx;
          mapX += stepX;
          ySide = false;
        } else {
          sideY += ddy;
          mapY += stepY;
          ySide = true;
        }
        tile = tileAt(level, mapX, mapY);
        if (isSolid(tile)) break;
      }
      if (steps === MAX_STEPS) {
        zbuf[x] = Infinity;
        wallTop[x] = wallEnd[x] = horizon;
        continue;
      }
      const dist = Math.max(0.05, ySide ? sideY - ddy : sideX - ddx);
      zbuf[x] = dist;
      const lineH = h / dist;
      const base = isWallLike(tile) ? wallTex : doorTex;
      const t = mip(base, base.h / lineH);
      let wallX = ySide ? eye.x + dist * rayX : eye.y + dist * rayY;
      wallX -= Math.floor(wallX);
      let texX = (wallX * t.w) | 0;
      if ((!ySide && rayX < 0) || (ySide && rayY > 0)) texX = t.w - 1 - texX;
      const top = horizon - lineH / 2;
      const y0 = Math.max(0, Math.ceil(top));
      const y1 = Math.min(h, Math.ceil(top + lineH));
      wallTop[x] = y0;
      wallEnd[x] = y1;
      const light = shade(dist) * (ySide ? 0.72 : 1);
      // Breakable walls look a little paler, so you can spot them.
      const lr = tile === Tile.Breakable ? light * 1.25 : light;
      const lb = tile === Tile.Breakable ? light * 0.95 : light;
      const texStep = t.h / lineH;
      let texPos = (y0 - top) * texStep;
      for (let y = y0; y < y1; y++, texPos += texStep) {
        out32[y * w + x] = shadePixel(t.px[Math.min(t.h - 1, texPos | 0) * t.w + texX], lr, light, lb);
      }
    }

    // Above the walls: darkness, faintly lighter overhead than at the far horizon.
    for (let y = 0; y < Math.min(h, horizon + 1); y++) {
      const k = 1 - y / Math.max(1, horizon);
      const dark = (0xff000000 | (Math.round(4 + 10 * k) << 16) | (Math.round(3 + 8 * k) << 8) | Math.round(4 + 9 * k)) >>> 0;
      const row = y * w;
      for (let x = 0; x < w; x++) if (y < wallTop[x] || y >= wallEnd[x]) out32[row + x] = dark;
    }

    // Floor, a row at a time (every pixel on a row is the same distance away), skipping wall pixels.
    const lx = dirX - planeX;
    const ly = dirY - planeY;
    const rx = dirX + planeX;
    const ry = dirY + planeY;
    for (let y = Math.max(0, horizon + 1); y < h; y++) {
      const p = y - horizon;
      const dist = (0.5 * h) / p;
      const light = shade(dist);
      const stepX = (dist * (rx - lx)) / w;
      const stepY = (dist * (ry - ly)) / w;
      let fx = eye.x + dist * lx;
      let fy = eye.y + dist * ly;
      const base = floorTex;
      // Texels per pixel: across the row, or along it in depth (the next row is dist / p further), whichever is more.
      const t = mip(base, Math.max(Math.hypot(stepX, stepY), dist / p) * base.w);
      // The tile under the ray only changes now and then, so its tint is looked up per cell, not per pixel.
      let lastX = NaN;
      let lastY = NaN;
      let lr = light;
      let lg = light;
      let lb = light;
      const row = y * w;
      for (let x = 0; x < w; x++, fx += stepX, fy += stepY) {
        if (y >= wallTop[x] && y < wallEnd[x]) continue;
        const cx = Math.floor(fx);
        const cy = Math.floor(fy);
        if (cx !== lastX || cy !== lastY) {
          lastX = cx;
          lastY = cy;
          const tile = tileAt(level, cx, cy);
          const tint = tile === Tile.ForceField ? (fieldOn ? FIELD_ON : null) : FLOOR_TINT[tile];
          lr = tint ? light * tint[0] : light;
          lg = tint ? light * tint[1] : light;
          lb = tint ? light * tint[2] : light;
        }
        out32[row + x] = shadePixel(t.px[(((fy - cy) * t.h) | 0) * t.w + (((fx - cx) * t.w) | 0)], lr, lg, lb);
      }
    }

    // Billboards, far to near. Behind a wall only the part above its top shows: the eye is below the wall tops, so a
    // ray that clears the nearest wall clears every wall behind it too.
    const invDet = 1 / (planeX * dirY - dirX * planeY);
    const placed = billboards
      .map((b) => ({ b, depth: invDet * (-planeY * b.dx + planeX * b.dy), side: invDet * (dirY * b.dx - dirX * b.dy) }))
      .filter((s) => s.depth > 0.12)
      .sort((a, b) => b.depth - a.depth);
    for (const { b, depth, side } of placed) {
      const base = this.texture(b.img, '#ffffff');
      if (base.w === 1) continue;
      const size = (b.size * h) / depth;
      const t = mip(base, base.w / size);
      const centreX = (w / 2) * (1 + side / depth);
      const bottom = horizon + (0.5 * h) / depth - (b.lift * h) / depth;
      const left = centreX - size / 2;
      const top = bottom - size;
      const x0 = Math.max(0, Math.ceil(left));
      const x1 = Math.min(w, Math.ceil(left + size));
      const y0 = Math.max(0, Math.ceil(top));
      const y1 = Math.min(h, Math.ceil(bottom));
      const light = b.bright ? 1 : shade(depth);
      for (let x = x0; x < x1; x++) {
        const end = zbuf[x] < depth ? Math.min(y1, wallTop[x]) : y1;
        if (end <= y0) continue;
        let texX = Math.min(t.w - 1, (((x - left) / size) * t.w) | 0);
        if (b.flip) texX = t.w - 1 - texX;
        for (let y = y0; y < end; y++) {
          const texY = Math.min(t.h - 1, (((y - top) / size) * t.h) | 0);
          const ti = (texY * t.w + texX) * 4;
          const a = (t.data[ti + 3] / 255) * b.alpha;
          if (a < 0.05) continue;
          if (a > 0.98) {
            out32[y * w + x] = shadePixel(t.px[ti >> 2], light, light, light);
            continue;
          }
          const o = (y * w + x) * 4;
          out[o] = out[o] * (1 - a) + t.data[ti] * light * a;
          out[o + 1] = out[o + 1] * (1 - a) + t.data[ti + 1] * light * a;
          out[o + 2] = out[o + 2] * (1 - a) + t.data[ti + 2] * light * a;
        }
      }
    }

    this.ctx.putImageData(this.image!, 0, 0);
  }

  /** Static, for when the hero we're watching is dead. */
  noise(w: number, h: number): void {
    this.resize(w, h);
    const out = this.image!.data;
    for (let i = 0; i < out.length; i += 4) {
      const v = Math.random() * 200;
      out[i] = out[i + 1] = out[i + 2] = v;
      out[i + 3] = 255;
    }
    this.ctx.putImageData(this.image!, 0, 0);
  }
}

const FIELD_ON: [number, number, number] = [2, 0.8, 0.5];

/** An opaque pixel (0xAABBGGRR) with each channel scaled, clamped to 255. */
function shadePixel(c: number, r: number, g: number, b: number): number {
  const cr = Math.min(255, (c & 255) * r) | 0;
  const cg = Math.min(255, ((c >>> 8) & 255) * g) | 0;
  const cb = Math.min(255, ((c >>> 16) & 255) * b) | 0;
  return (0xff000000 | (cb << 16) | (cg << 8) | cr) >>> 0;
}

/** Torchlight: bright nearby, fading into the dark. */
function shade(dist: number): number {
  return Math.max(0.1, 1 / (1 + dist * dist * 0.035));
}
