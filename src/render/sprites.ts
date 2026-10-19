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

/** Wall looks per level: [texture, hue rotation in degrees]. */
const WALL_VARIANTS: [SpriteName, number][] = [['wall-orange', 0], ['wall-teal', 0], ['wall-orange', 230], ['wall-orange', -25], ['wall-teal', 90], ['wall-orange', 60]];

export class Sprites {
  private images = new Map<SpriteName, HTMLImageElement>();
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
