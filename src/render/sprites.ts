import { mod } from '../core/level';

/**
 * Optional sprite images from public/sprites/<name>.png (see tools/slice-sprites.ts). Loading is fire-and-forget:
 * `get()` returns undefined until an image has loaded (or if it's missing), and the renderer falls back to shapes.
 */
export const SPRITE_NAMES = [
  'warrior', 'valkyrie', 'wizard', 'elf',
  'ghost', 'grunt', 'demon', 'lobber', 'sorcerer', 'death',
  'food', 'cider', 'potion', 'key', 'treasure-gold', 'generator',
  'wall-orange', 'wall-teal', 'floor', 'door',
  // Gauntlet II
  'supersorcerer', 'dragon', 'thief', 'acid', 'amulet', 'poison', 'it',
] as const;

export type SpriteName = (typeof SPRITE_NAMES)[number];

/** Characters with walk frames, <name>-<dir>-<frame>.png: five directions (the other three are mirrors), three frames. */
export const WALKERS = [
  'warrior', 'valkyrie', 'wizard', 'elf',
  'ghost', 'grunt', 'demon', 'lobber', 'sorcerer', 'death', 'supersorcerer', 'dragon', 'thief',
] as const;
export const WALK_DIRS = ['s', 'se', 'e', 'ne', 'n'] as const;
export const WALK_FRAMES = 3;

export type Walker = (typeof WALKERS)[number];
export type WalkDir = (typeof WALK_DIRS)[number];

export function isWalker(name: string): name is Walker {
  return (WALKERS as readonly string[]).includes(name);
}

/** Sheet direction and mirroring for a facing (fx, fy in -1..1, y down). */
export function walkDir(fx: number, fy: number): { dir: WalkDir; flip: boolean } {
  const x = Math.abs(fx);
  const dir: WalkDir = fy > 0 ? (x ? 'se' : 's') : fy < 0 ? (x ? 'ne' : 'n') : x ? 'e' : 's';
  return { dir, flip: fx < 0 };
}

/** Wall looks per level: [texture, hue rotation in degrees]. */
const WALL_VARIANTS: [SpriteName, number][] = [['wall-orange', 0], ['wall-teal', 0], ['wall-orange', 230], ['wall-orange', -25], ['wall-teal', 90], ['wall-orange', 60]];

export class Sprites {
  private images = new Map<SpriteName, HTMLImageElement>();
  private frames = new Map<string, HTMLImageElement>();
  private walls = new Map<number, CanvasImageSource>();
  /** Called whenever another image finishes loading (the editor redraws then; the game redraws every frame anyway). */
  onload: (() => void) | null = null;

  constructor(base = 'sprites/') {
    for (const name of SPRITE_NAMES) {
      const img = new Image();
      img.onload = () => {
        this.images.set(name, img);
        this.onload?.();
      };
      img.src = `${base}${name}.png`;
    }
    for (const name of WALKERS) {
      for (const dir of WALK_DIRS) {
        for (let f = 0; f < WALK_FRAMES; f++) {
          const key = `${name}-${dir}-${f}`;
          const img = new Image();
          img.onload = () => {
            this.frames.set(key, img);
            this.onload?.();
          };
          img.src = `${base}${key}.png`;
        }
      }
    }
  }

  /** One walk frame (0..2, 1 = standing), or undefined if it hasn't loaded. */
  walk(name: Walker, dir: WalkDir, frame: number): HTMLImageElement | undefined {
    return this.frames.get(`${name}-${dir}-${frame}`);
  }

  get(name: SpriteName): HTMLImageElement | undefined {
    return this.images.get(name);
  }

  /** Wall texture for a level, recoloured with a cached hue-rotated copy so levels don't all look alike. */
  wall(levelNumber: number): CanvasImageSource | undefined {
    const v = mod(levelNumber - 1, WALL_VARIANTS.length);
    const cached = this.walls.get(v);
    if (cached) return cached;
    const [name, hue] = WALL_VARIANTS[v];
    const img = this.get(name);
    if (!img) return undefined;
    if (hue === 0) return img;
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.filter = `hue-rotate(${hue}deg)`;
    ctx.drawImage(img, 0, 0);
    this.walls.set(v, canvas);
    return canvas;
  }
}

const silhouettes = new WeakMap<CanvasImageSource, Map<string, HTMLCanvasElement>>();

/** The sprite's shape filled with one colour, for hit flashes. Cached per image and colour. */
export function silhouette(img: HTMLImageElement, color: string): HTMLCanvasElement {
  let byColor = silhouettes.get(img);
  if (!byColor) silhouettes.set(img, (byColor = new Map()));
  const cached = byColor.get(color);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  byColor.set(color, canvas);
  return canvas;
}
