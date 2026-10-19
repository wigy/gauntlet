/**
 * Purely cosmetic effects: particles and small pre-rendered textures (glows, soft shadows, edge gradients).
 * Nothing here touches game state, so it may use Math.random freely.
 */

export interface Particle {
  /** World position in tiles (unwrapped is fine: the renderer maps it with dxw/dyw). */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Height above the floor in tiles, for sparks that bounce. */
  z: number;
  vz: number;
  life: number;
  max: number;
  size: number;
  color: string;
  kind: 'spark' | 'smoke' | 'text' | 'ring' | 'glint';
  text?: string;
}

const MAX_PARTICLES = 900;

export class Particles {
  list: Particle[] = [];

  clear(): void {
    this.list.length = 0;
  }

  add(p: Partial<Particle> & Pick<Particle, 'x' | 'y' | 'kind' | 'color'>): void {
    if (this.list.length >= MAX_PARTICLES) this.list.shift();
    const life = p.life ?? 0.6;
    this.list.push({ vx: 0, vy: 0, z: 0, vz: 0, size: 0.1, max: life, life, ...p });
  }

  /** Sparks flying out of a point, plus an optional puff of smoke. */
  burst(x: number, y: number, color: string, count: number, speed = 3, smoke = 0): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.3 + Math.random() * 0.7);
      this.add({
        x, y, kind: 'spark', color,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        z: 0.2, vz: 1 + Math.random() * 3,
        size: 0.05 + Math.random() * 0.07,
        life: 0.35 + Math.random() * 0.45,
      });
    }
    for (let i = 0; i < smoke; i++) {
      const a = Math.random() * Math.PI * 2;
      this.add({
        x: x + Math.cos(a) * 0.15, y: y + Math.sin(a) * 0.15, kind: 'smoke', color: 'rgba(40,36,48,1)',
        vx: Math.cos(a) * 0.6, vy: Math.sin(a) * 0.6 - 0.3,
        size: 0.25 + Math.random() * 0.2,
        life: 0.5 + Math.random() * 0.4,
      });
    }
  }

  update(dt: number): void {
    const drag = Math.exp(-3 * dt);
    for (const p of this.list) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === 'spark') {
        p.vx *= drag;
        p.vy *= drag;
        p.vz -= 12 * dt;
        p.z += p.vz * dt;
        if (p.z < 0) {
          p.z = 0;
          p.vz *= -0.4;
        }
      } else if (p.kind === 'smoke') {
        p.vx *= drag;
        p.vy *= drag;
      }
    }
    this.list = this.list.filter((p) => p.life > 0);
  }
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

const glows = new Map<string, HTMLCanvasElement>();

/** A soft round glow of the given colour, fading to transparent; draw it with 'lighter' compositing. */
export function glow(color: string): HTMLCanvasElement {
  const cached = glows.get(color);
  if (cached) return cached;
  const [cv, g] = canvas(128, 128);
  g.fillStyle = color;
  g.fillRect(0, 0, 128, 128);
  // Fade the colour's alpha (not towards black) so the falloff stays clean under additive blending.
  g.globalCompositeOperation = 'destination-in';
  const fade = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  fade.addColorStop(0, 'rgba(0,0,0,1)');
  fade.addColorStop(0.2, 'rgba(0,0,0,0.65)');
  fade.addColorStop(0.5, 'rgba(0,0,0,0.22)');
  fade.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = fade;
  g.fillRect(0, 0, 128, 128);
  glows.set(color, cv);
  return cv;
}

let blob: HTMLCanvasElement | undefined;

/** Soft elliptical contact shadow for standing entities. */
export function shadowBlob(): HTMLCanvasElement {
  if (blob) return blob;
  const [cv, g] = canvas(64, 64);
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(0.6, 'rgba(0,0,0,0.3)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  blob = cv;
  return cv;
}

export interface EdgeShades {
  /** Shadow a wall casts onto the floor tile below it (darkest at the top edge). */
  top: HTMLCanvasElement;
  /** Shadow a wall casts onto the floor tile to its right (darkest at the left edge). */
  left: HTMLCanvasElement;
  /** Corner shadow when only the diagonal up-left neighbour is a wall. */
  corner: HTMLCanvasElement;
}

let edges: EdgeShades | undefined;

export function edgeShades(): EdgeShades {
  if (edges) return edges;
  const [top, tg] = canvas(64, 64);
  let grad = tg.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.7)');
  grad.addColorStop(0.45, 'rgba(0,0,0,0.18)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  tg.fillStyle = grad;
  tg.fillRect(0, 0, 64, 64);

  const [left, lg] = canvas(64, 64);
  grad = lg.createLinearGradient(0, 0, 64, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0.5)');
  grad.addColorStop(0.35, 'rgba(0,0,0,0.1)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  lg.fillStyle = grad;
  lg.fillRect(0, 0, 64, 64);

  const [corner, cg] = canvas(64, 64);
  const rg = cg.createRadialGradient(0, 0, 0, 0, 0, 30);
  rg.addColorStop(0, 'rgba(0,0,0,0.5)');
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  cg.fillStyle = rg;
  cg.fillRect(0, 0, 64, 64);

  edges = { top, left, corner };
  return edges;
}

/** Full-viewport vignette, cached per size. */
let vignetteCache: { w: number; h: number; c: HTMLCanvasElement } | undefined;

export function vignette(w: number, h: number): HTMLCanvasElement {
  if (vignetteCache && vignetteCache.w === w && vignetteCache.h === h) return vignetteCache.c;
  const [cv, g] = canvas(Math.max(1, Math.ceil(w / 2)), Math.max(1, Math.ceil(h / 2)));
  const cw = cv.width;
  const ch = cv.height;
  const r = Math.hypot(cw, ch) / 2;
  const grad = g.createRadialGradient(cw / 2, ch / 2, r * 0.45, cw / 2, ch / 2, r);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.6)');
  g.fillStyle = grad;
  g.fillRect(0, 0, cw, ch);
  vignetteCache = { w, h, c: cv };
  return cv;
}
