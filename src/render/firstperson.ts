import { Tile, isSolid, isWallLike, tileAt } from '../core/level';
import type { LevelData } from '../core/level';

/**
 * A small first-person view of the maze from one hero's eyes, raycast like Wolfenstein 3D into a low-resolution
 * buffer: textured walls, floor and ceiling, and everything else as billboards (sprites that always face the camera).
 * Walls are one tile high and the eye is half a tile above the floor. Coordinates are tiles, as in the game.
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
  ceiling?: CanvasImageSource;
}

interface Texture {
  w: number;
  h: number;
  data: Uint8ClampedArray;
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
    this.zbuf = new Float32Array(w);
  }

  /** Pixel data of an image, read once and cached; a flat colour stands in for one that hasn't loaded. */
  private texture(img: CanvasImageSource | undefined, color: string): Texture {
    if (img) {
      const cached = this.textures.get(img);
      if (cached) return cached;
      const w = (img as HTMLImageElement).width;
      const h = (img as HTMLImageElement).height;
      if (w && h) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const g = c.getContext('2d')!;
        g.drawImage(img, 0, 0);
        const tex = { w, h, data: g.getImageData(0, 0, w, h).data };
        this.textures.set(img, tex);
        return tex;
      }
    }
    let tex = this.fallback.get(color);
    if (!tex) {
      const n = parseInt(color.slice(1), 16);
      tex = { w: 1, h: 1, data: new Uint8ClampedArray([(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]) };
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
    const ceilTex = this.texture(tex.ceiling, '#1c1a20');

    const dirX = Math.cos(eye.angle);
    const dirY = Math.sin(eye.angle);
    // y grows downwards, so the camera's right-hand side is the direction turned +90 degrees.
    const planeX = -dirY * PLANE;
    const planeY = dirX * PLANE;
    const horizon = Math.round(h / 2 + eye.bob);

    // Floor and ceiling, a row at a time: every pixel on one row is the same distance away.
    const lx = dirX - planeX;
    const ly = dirY - planeY;
    const rx = dirX + planeX;
    const ry = dirY + planeY;
    for (let y = 0; y < h; y++) {
      const floor = y > horizon;
      const p = Math.max(0.5, floor ? y - horizon : horizon - y);
      const dist = (0.5 * h) / p;
      const light = shade(dist) * (floor ? 1 : 0.75);
      const stepX = (dist * (rx - lx)) / w;
      const stepY = (dist * (ry - ly)) / w;
      let fx = eye.x + dist * lx;
      let fy = eye.y + dist * ly;
      const t = floor ? floorTex : ceilTex;
      for (let x = 0; x < w; x++, fx += stepX, fy += stepY) {
        const cx = Math.floor(fx);
        const cy = Math.floor(fy);
        const ti = ((((fy - cy) * t.h) | 0) * t.w + (((fx - cx) * t.w) | 0)) * 4;
        let r = t.data[ti] * light;
        let g = t.data[ti + 1] * light;
        let b = t.data[ti + 2] * light;
        if (floor) {
          const tile = tileAt(level, cx, cy);
          const tint = tile === Tile.ForceField ? (fieldOn ? FIELD_ON : null) : FLOOR_TINT[tile];
          if (tint) {
            r *= tint[0];
            g *= tint[1];
            b *= tint[2];
          }
        }
        const o = (y * w + x) * 4;
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = 255;
      }
    }

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
        continue;
      }
      const dist = Math.max(0.05, ySide ? sideY - ddy : sideX - ddx);
      zbuf[x] = dist;
      const t = isWallLike(tile) ? wallTex : doorTex;
      let wallX = ySide ? eye.x + dist * rayX : eye.y + dist * rayY;
      wallX -= Math.floor(wallX);
      let texX = (wallX * t.w) | 0;
      if ((!ySide && rayX < 0) || (ySide && rayY > 0)) texX = t.w - 1 - texX;
      const lineH = h / dist;
      const top = horizon - lineH / 2;
      const y0 = Math.max(0, Math.ceil(top));
      const y1 = Math.min(h, Math.ceil(top + lineH));
      const light = shade(dist) * (ySide ? 0.72 : 1);
      // Breakable walls look a little paler, so you can spot them.
      const lr = tile === Tile.Breakable ? light * 1.25 : light;
      const lb = tile === Tile.Breakable ? light * 0.95 : light;
      for (let y = y0; y < y1; y++) {
        const texY = Math.min(t.h - 1, (((y - top) / lineH) * t.h) | 0);
        const ti = (texY * t.w + texX) * 4;
        const o = (y * w + x) * 4;
        out[o] = t.data[ti] * lr;
        out[o + 1] = t.data[ti + 1] * light;
        out[o + 2] = t.data[ti + 2] * lb;
      }
    }

    // Billboards, far to near, clipped against the walls column by column.
    const invDet = 1 / (planeX * dirY - dirX * planeY);
    const placed = billboards
      .map((b) => ({ b, depth: invDet * (-planeY * b.dx + planeX * b.dy), side: invDet * (dirY * b.dx - dirX * b.dy) }))
      .filter((s) => s.depth > 0.12)
      .sort((a, b) => b.depth - a.depth);
    for (const { b, depth, side } of placed) {
      const t = this.texture(b.img, '#ffffff');
      if (t.w === 1) continue;
      const size = (b.size * h) / depth;
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
        if (zbuf[x] < depth) continue;
        let texX = Math.min(t.w - 1, (((x - left) / size) * t.w) | 0);
        if (b.flip) texX = t.w - 1 - texX;
        for (let y = y0; y < y1; y++) {
          const texY = Math.min(t.h - 1, (((y - top) / size) * t.h) | 0);
          const ti = (texY * t.w + texX) * 4;
          const a = (t.data[ti + 3] / 255) * b.alpha;
          if (a < 0.05) continue;
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

/** Torchlight: bright nearby, fading into the dark. */
function shade(dist: number): number {
  return Math.max(0.1, 1 / (1 + dist * dist * 0.035));
}
