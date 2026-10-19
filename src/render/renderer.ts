import { HERO_ORDER, HEROES, JOIN_HEALTH, LOW_HEALTH_WARNING, MONSTERS } from '../core/defs';
import type { ItemKind } from '../core/defs';
import { Tile, tileAt } from '../core/level';
import type { Game, Generator, Monster, Player, Shot } from '../core/game';
import { Particles, edgeShades, glow, shadowBlob, vignette } from './fx';
import { Sprites, silhouette } from './sprites';
import type { SpriteName } from './sprites';

const WALL_COLORS = ['#c0602a', '#3a8a8a', '#7a4ac0', '#a03030', '#4a8a3a', '#b08a2a', '#4a5ab0'];
const FLOOR_COLORS = ['#26243a', '#2a2018', '#1c2a2a', '#2a1c26', '#1a2230'];
const HUD_W = 240;
const TITLE_FONT = `'Cinzel', 'Trajan Pro', Georgia, serif`;
const UI_FONT = `'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif`;
const ITEM_SPRITES: Record<ItemKind, SpriteName> = { food: 'food', cider: 'cider', potion: 'potion', key: 'key', treasure: 'treasure-gold' };
const ITEM_GLOW: Record<ItemKind, string> = { food: '#ffb070', cider: '#ffd070', potion: '#70a8ff', key: '#ffe060', treasure: '#ffd040' };
/** Light a hero carries, in tiles. Everything further away fades towards AMBIENT. */
const HERO_LIGHT = 8;
const AMBIENT = '#5a566e';
const HIT_FLASH = 0.14;

interface Pos {
  x: number;
  y: number;
}

/** A light source: lights the floor in the light map and, if `ga` > 0, draws an additive glow on top. In screen px. */
interface Light {
  x: number;
  y: number;
  r: number;
  color: string;
  /** Glow radius and alpha for the emissive pass. */
  gr: number;
  ga: number;
}

interface Tracked {
  x: number;
  y: number;
  color: string;
  kind: string;
}

interface PlayerTrack {
  p: Player | null;
  alive: boolean;
  health: number;
  score: number;
  pending: number;
  pendingAt: number;
}

export interface Hint {
  join: string;
  label: string;
}

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * Draws the game onto a canvas. Owns the mapping from tile coordinates to screen pixels; never mutates game logic.
 * Positions are interpolated between the last two simulation ticks so motion stays smooth at any refresh rate.
 * Particles, hit flashes and score pop-ups are derived by diffing game state between frames.
 * Uses sprite images when they've loaded and falls back to canvas shapes otherwise.
 */
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private tile = 32;
  private playW = 0;
  private viewH = 0;
  private dpr = 1;
  private message = '';
  private messageAt = -10;
  private messageUntil = 0;
  private flashAt = -10;
  private sprites = new Sprites();
  private particles = new Particles();
  private light: HTMLCanvasElement;
  private lctx: CanvasRenderingContext2D;
  private lights: Light[] = [];

  // Interpolation: positions before the most recent tick.
  private prev = new WeakMap<object, Pos>();
  private prevCam: Pos | null = null;
  private alpha = 1;
  private cam: Pos = { x: 0, y: 0 };
  private offX = 0;
  private offY = 0;

  // State diffing for effects.
  private lastNow = 0;
  private levelSeen = -1;
  private levelAt = 0;
  private stateSeen = '';
  private stateAt = 0;
  private lastMonsters = new Map<Monster, Tracked>();
  private lastGenerators = new Map<Generator, Tracked>();
  private lastShots = new Map<Shot, Tracked>();
  private lastItems = new Map<number, Tracked>();
  private hp = new WeakMap<object, number>();
  private hitAt = new WeakMap<object, number>();
  private seeds = new WeakMap<object, number>();
  private tracks: PlayerTrack[] = [0, 1, 2, 3].map(() => ({ p: null, alive: false, health: 0, score: 0, pending: 0, pendingAt: 0 }));

  constructor(private canvas: HTMLCanvasElement, private hints: readonly Hint[]) {
    this.ctx = canvas.getContext('2d')!;
    this.light = document.createElement('canvas');
    this.lctx = this.light.getContext('2d')!;
  }

  resize(game: Game): void {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.dpr = dpr;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    this.playW = Math.max(200, w - HUD_W);
    this.viewH = h;
    this.tile = Math.max(16, Math.floor(Math.min(this.playW / 18, h / 13)));
    // The light map is low resolution; smoothing when it's stretched gives soft edges for free.
    this.light.width = Math.ceil(this.playW / 4);
    this.light.height = Math.ceil(h / 4);
    game.viewW = this.playW / this.tile;
    game.viewH = h / this.tile;
  }

  /** Remember where everything is before a simulation tick, so draw() can interpolate towards the new state. */
  snapshot(game: Game): void {
    for (const p of game.players) if (p) this.prev.set(p, { x: p.x, y: p.y });
    for (const m of game.monsters) this.prev.set(m, { x: m.x, y: m.y });
    for (const s of game.shots) this.prev.set(s, { x: s.x, y: s.y });
    this.prevCam = { x: game.camera.x, y: game.camera.y };
  }

  showMessage(text: string, now: number): void {
    this.message = text;
    this.messageAt = now;
    this.messageUntil = now + 2.5;
  }

  flash(now: number): void {
    this.flashAt = now;
  }

  /** `alpha` is how far (0..1) we are between the previous tick and the current one. */
  draw(game: Game, now: number, alpha = 1): void {
    const { ctx } = this;
    const h = this.viewH;
    const dt = Math.min(0.1, Math.max(0, now - this.lastNow));
    this.lastNow = now;
    this.alpha = Math.min(1, Math.max(0, alpha));

    this.trackChanges(game, now);
    this.particles.update(dt);

    // Camera, with a short shake after a potion blast.
    const c = this.lerp(game, game.camera, this.prevCam, 4);
    this.cam = c;
    let shakeX = 0;
    let shakeY = 0;
    const shake = 1 - (now - this.flashAt) / 0.4;
    if (shake > 0) {
      shakeX = (Math.random() - 0.5) * this.tile * 0.3 * shake;
      shakeY = (Math.random() - 0.5) * this.tile * 0.3 * shake;
    }
    this.offX = this.snap(this.playW / 2 + shakeX);
    this.offY = this.snap(h / 2 + shakeY);

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.playW + HUD_W, h);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.playW, h);
    ctx.clip();
    this.lights.length = 0;
    this.drawMaze(game, h, now);
    this.drawEntities(game, now);
    this.drawSmoke(game);
    if (this.livingCount(game) > 0) this.drawLighting(h);
    this.drawEmissive(game);
    ctx.drawImage(vignette(this.playW, h), 0, 0, this.playW, h);
    this.drawScreenEffects(game, h, now);
    this.drawOverlay(game, h, now);
    ctx.restore();

    this.drawHud(game, h, now);
  }

  // ---------------------------------------------------------------- coordinates

  private snap(v: number): number {
    return Math.round(v * this.dpr) / this.dpr;
  }

  private sx(game: Game, x: number): number {
    return game.dxw(this.cam.x, x) * this.tile + this.offX;
  }

  private sy(game: Game, y: number): number {
    return game.dyw(this.cam.y, y) * this.tile + this.offY;
  }

  private lerp(game: Game, cur: Pos, prev: Pos | null | undefined, maxJump = 2): Pos {
    if (!prev) return cur;
    const dx = game.dxw(prev.x, cur.x);
    const dy = game.dyw(prev.y, cur.y);
    if (Math.abs(dx) > maxJump || Math.abs(dy) > maxJump) return cur;
    return { x: prev.x + dx * this.alpha, y: prev.y + dy * this.alpha };
  }

  private pos(game: Game, e: Pos): Pos {
    return this.lerp(game, e, this.prev.get(e));
  }

  /** Distance moved during the last tick, for walk animations. */
  private moving(game: Game, e: Pos): boolean {
    const p = this.prev.get(e);
    return !!p && Math.hypot(game.dxw(p.x, e.x), game.dyw(p.y, e.y)) > 0.004;
  }

  private visible(game: Game, x: number, y: number): boolean {
    return Math.abs(game.dxw(this.cam.x, x)) <= game.viewW / 2 + 1.2 && Math.abs(game.dyw(this.cam.y, y)) <= game.viewH / 2 + 1.2;
  }

  private seed(o: object): number {
    let s = this.seeds.get(o);
    if (s === undefined) this.seeds.set(o, (s = Math.random() * 100));
    return s;
  }

  private livingCount(game: Game): number {
    return game.players.reduce((n, p) => n + (p && p.alive ? 1 : 0), 0);
  }

  // ---------------------------------------------------------------- effects from state changes

  private trackChanges(game: Game, now: number): void {
    const fx = this.particles;
    if (game.levelNumber !== this.levelSeen) {
      this.levelSeen = game.levelNumber;
      this.levelAt = now;
      this.resetTracking();
    }
    if (game.state !== this.stateSeen) {
      if (game.state === 'playing' && this.stateSeen !== 'levelEnd') this.resetTracking();
      this.stateSeen = game.state;
      this.stateAt = now;
    }

    const monsters = new Map<Monster, Tracked>();
    for (const m of game.monsters) {
      monsters.set(m, { x: m.x, y: m.y, color: m.def.color, kind: m.kind });
      const old = this.hp.get(m);
      if (old !== undefined && m.hp < old) {
        this.hitAt.set(m, now);
        fx.burst(m.x, m.y, '#ffffff', 3, 2);
      }
      this.hp.set(m, m.hp);
    }
    for (const [m, t] of this.lastMonsters) {
      if (monsters.has(m) || !this.visible(game, t.x, t.y)) continue;
      if (t.kind === 'ghost') {
        fx.burst(t.x, t.y, '#d8e0ff', 10, 3, 4);
        fx.add({ x: t.x, y: t.y, kind: 'ring', color: '#c8d0ff', size: 0.9, life: 0.35 });
      } else {
        fx.burst(t.x, t.y, t.color === '#202020' ? '#a0a0a0' : t.color, 12, 3.5, 3);
      }
    }
    this.lastMonsters = monsters;

    const generators = new Map<Generator, Tracked>();
    for (const g of game.generators) {
      generators.set(g, { x: g.x, y: g.y, color: MONSTERS[g.kind].color, kind: g.kind });
      const old = this.hp.get(g);
      if (old !== undefined && g.hp < old) {
        this.hitAt.set(g, now);
        fx.burst(g.x, g.y, '#e0b070', 6, 2.5);
      }
      this.hp.set(g, g.hp);
    }
    for (const [g, t] of this.lastGenerators) {
      if (generators.has(g) || !this.visible(game, t.x, t.y)) continue;
      fx.burst(t.x, t.y, '#ffb050', 24, 4.5, 7);
      fx.add({ x: t.x, y: t.y, kind: 'ring', color: '#ffd080', size: 1.6, life: 0.45 });
    }
    this.lastGenerators = generators;

    const shots = new Map<Shot, Tracked>();
    for (const s of game.shots) {
      const color = s.kind === 'arrow' ? (game.players[s.owner]?.def.color ?? '#ffffff') : s.kind === 'fireball' ? '#ff8030' : '#b0a8a0';
      shots.set(s, { x: s.x, y: s.y, color, kind: s.kind });
      if (s.kind === 'fireball' && Math.random() < 0.35) {
        fx.add({ x: s.x, y: s.y, kind: 'spark', color: '#ff9030', vx: (Math.random() - 0.5) * 0.8, vy: (Math.random() - 0.5) * 0.8, z: 0.3, vz: 0.5, size: 0.05, life: 0.3 });
      }
    }
    for (const [s, t] of this.lastShots) {
      if (shots.has(s) || !this.visible(game, t.x, t.y)) continue;
      fx.burst(t.x, t.y, t.color, t.kind === 'fireball' ? 10 : 5, 2.2, t.kind === 'rock' ? 2 : 0);
    }
    this.lastShots = shots;

    const items = new Map<number, Tracked>();
    for (const [key, it] of game.items) items.set(key, { x: it.x + 0.5, y: it.y + 0.5, color: ITEM_GLOW[it.kind], kind: it.kind });
    for (const [key, t] of this.lastItems) {
      if (items.has(key) || !this.visible(game, t.x, t.y)) continue;
      fx.add({ x: t.x, y: t.y, kind: 'ring', color: t.color, size: 0.8, life: 0.4 });
      for (let i = 0; i < 7; i++) {
        fx.add({ x: t.x + (Math.random() - 0.5) * 0.6, y: t.y + (Math.random() - 0.5) * 0.4, kind: 'glint', color: t.color, vy: -0.8 - Math.random() * 0.8, size: 0.1 + Math.random() * 0.08, life: 0.5 + Math.random() * 0.4 });
      }
    }
    this.lastItems = items;

    game.players.forEach((p, slot) => {
      const t = this.tracks[slot];
      if (!p) {
        t.p = null;
        return;
      }
      if (t.p !== p || (p.alive && !t.alive)) {
        // Joined or revived.
        fx.add({ x: p.x, y: p.y, kind: 'ring', color: p.def.color, size: 1.4, life: 0.5 });
        for (let i = 0; i < 12; i++) fx.add({ x: p.x + (Math.random() - 0.5) * 0.8, y: p.y + (Math.random() - 0.5) * 0.5, kind: 'glint', color: p.def.color, vy: -1 - Math.random(), size: 0.12, life: 0.7 });
        Object.assign(t, { p, alive: p.alive, health: p.health, score: p.score, pending: 0, pendingAt: now });
        return;
      }
      if (t.alive && !p.alive) fx.burst(p.x, p.y, p.def.color, 30, 4, 8);
      if (p.alive && p.health < t.health - 3) {
        this.hitAt.set(p, now);
        fx.burst(p.x, p.y, '#ff4040', 4, 2);
      }
      if (p.score > t.score) {
        if (t.pending === 0) t.pendingAt = now;
        t.pending += p.score - t.score;
      }
      if (t.pending > 0 && now - t.pendingAt > 0.3) {
        fx.add({ x: p.x, y: p.y - 0.6, kind: 'text', text: `+${t.pending}`, color: '#ffe080', vy: -0.9, life: 1.1, size: t.pending >= 100 ? 0.42 : 0.32 });
        t.pending = 0;
      }
      t.alive = p.alive;
      t.health = p.health;
      t.score = p.score;
    });
  }

  private resetTracking(): void {
    this.particles.clear();
    this.lastMonsters.clear();
    this.lastGenerators.clear();
    this.lastShots.clear();
    this.lastItems.clear();
    this.prevCam = null;
  }

  // ---------------------------------------------------------------- maze

  private drawMaze(game: Game, h: number, now: number): void {
    const { ctx, tile } = this;
    const lvl = game.level;
    const wall = WALL_COLORS[(game.levelNumber - 1) % WALL_COLORS.length];
    const floor = FLOOR_COLORS[(game.levelNumber - 1) % FLOOR_COLORS.length];
    const wallTex = this.sprites.wall(game.levelNumber);
    const floorTex = this.sprites.get('floor');
    const doorTex = this.sprites.get('door');
    const shades = edgeShades();
    const halfW = this.playW / tile / 2 + 1;
    const halfH = h / tile / 2 + 1;
    const x0 = Math.floor(this.cam.x - halfW);
    const y0 = Math.floor(this.cam.y - halfH);
    const ox = (x0 - this.cam.x) * tile + this.offX;
    const oy = (y0 - this.cam.y) * tile + this.offY;
    const isWall = (x: number, y: number) => tileAt(lvl, x, y) === Tile.Wall;

    for (let j = 0; j <= halfH * 2 + 1; j++) {
      const py = this.snap(oy + j * tile);
      const th = this.snap(oy + (j + 1) * tile) - py;
      for (let i = 0; i <= halfW * 2 + 1; i++) {
        const tx = x0 + i;
        const ty = y0 + j;
        const outside = (!lvl.wrapX && (tx < 0 || tx >= lvl.width)) || (!lvl.wrapY && (ty < 0 || ty >= lvl.height));
        if (outside) continue;
        const px = this.snap(ox + i * tile);
        const tw = this.snap(ox + (i + 1) * tile) - px;
        const t = tileAt(lvl, tx, ty);

        if (t === Tile.Wall) {
          if (wallTex) {
            ctx.drawImage(wallTex, px, py, tw, th);
          } else {
            ctx.fillStyle = wall;
            ctx.fillRect(px, py, tw, th);
          }
          // Bevel only on edges facing open floor, so runs of wall read as solid blocks.
          const edge = Math.max(1, tile * 0.07);
          if (!isWall(tx, ty - 1)) {
            ctx.fillStyle = 'rgba(255,240,215,0.28)';
            ctx.fillRect(px, py, tw, edge);
          }
          if (!isWall(tx - 1, ty)) {
            ctx.fillStyle = 'rgba(255,240,215,0.14)';
            ctx.fillRect(px, py, edge, th);
          }
          if (!isWall(tx + 1, ty)) {
            ctx.fillStyle = 'rgba(0,0,0,0.3)';
            ctx.fillRect(px + tw - edge, py, edge, th);
          }
          if (!isWall(tx, ty + 1)) {
            // A darker front face, as if the wall had some height.
            ctx.fillStyle = 'rgba(10,6,16,0.5)';
            ctx.fillRect(px, py + th * 0.78, tw, th * 0.22);
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            ctx.fillRect(px, py + th - edge * 0.6, tw, edge * 0.6);
          }
          continue;
        }

        if (floorTex) {
          ctx.drawImage(floorTex, px, py, tw, th);
          ctx.fillStyle = 'rgba(8,6,14,0.38)';
          ctx.fillRect(px, py, tw, th);
        } else {
          ctx.fillStyle = floor;
          ctx.fillRect(px, py, tw, th);
          if ((tx + ty) % 2 === 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.025)';
            ctx.fillRect(px, py, tw, th);
          }
        }
        // Walls cast soft shadows down and to the right.
        const n = isWall(tx, ty - 1);
        const w = isWall(tx - 1, ty);
        if (n) ctx.drawImage(shades.top, px, py, tw, th);
        if (w) ctx.drawImage(shades.left, px, py, tw, th);
        if (!n && !w && isWall(tx - 1, ty - 1)) ctx.drawImage(shades.corner, px, py, tw, th);

        if (t === Tile.Door) {
          if (doorTex) {
            ctx.drawImage(doorTex, px, py, tw, th);
          } else {
            ctx.fillStyle = '#5a3a10';
            ctx.fillRect(px + 1, py + 1, tw - 2, th - 2);
            ctx.fillStyle = '#e0b030';
            for (let k = 0; k < 3; k++) ctx.fillRect(px + 2, py + th * (0.2 + k * 0.28), tw - 4, th * 0.1);
          }
        } else if (t === Tile.Exit) {
          this.drawExit(px + tw / 2, py + th / 2, now);
        }
      }
    }
  }

  /** A swirling portal. */
  private drawExit(cx: number, cy: number, now: number): void {
    const { ctx, tile } = this;
    const r = tile * 0.44;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, '#000004');
    g.addColorStop(0.55, '#06243a');
    g.addColorStop(0.85, '#1aa8d8');
    g.addColorStop(1, 'rgba(120,230,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineCap = 'round';
    for (let k = 0; k < 3; k++) {
      const a = now * (1.6 + k * 0.7) * (k % 2 ? -1 : 1) + k * 2;
      ctx.strokeStyle = `rgba(150,235,255,${0.75 - k * 0.18})`;
      ctx.lineWidth = Math.max(1.5, tile * 0.05);
      ctx.beginPath();
      ctx.arc(cx, cy, r * (0.35 + k * 0.2), a, a + Math.PI * 1.1);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    const pulse = 0.8 + Math.sin(now * 3) * 0.2;
    this.lights.push({ x: cx, y: cy, r: tile * 3, color: '#50d0ff', gr: tile * 1.1 * pulse, ga: 0.45 });
  }

  // ---------------------------------------------------------------- entities

  private drawEntities(game: Game, now: number): void {
    const { ctx, tile } = this;
    const blob = shadowBlob();
    type Drawable = { y: number; draw: () => void };
    const list: Drawable[] = [];

    for (const [key, it] of game.items) {
      const cx = it.x + 0.5;
      const cy = it.y + 0.5;
      if (!this.visible(game, cx, cy)) continue;
      const px = this.sx(game, cx);
      const py = this.sy(game, cy);
      const bob = Math.sin(now * 2.6 + key * 0.7) * tile * 0.05;
      const sw = tile * (0.62 - bob / tile);
      ctx.drawImage(blob, px - sw / 2, py + tile * 0.22 - sw * 0.17, sw, sw * 0.34);
      list.push({ y: cy, draw: () => this.drawItem(it.kind, px, py - tile * 0.05 + bob) });
      if (it.kind === 'potion' || it.kind === 'treasure' || it.kind === 'key') {
        this.lights.push({ x: px, y: py, r: tile * 1.2, color: ITEM_GLOW[it.kind], gr: tile * 0.55, ga: 0.18 + 0.1 * Math.sin(now * 3 + key) });
      }
    }

    for (const g of game.generators) {
      if (!this.visible(game, g.x, g.y)) continue;
      const px = this.sx(game, g.x);
      const py = this.sy(game, g.y);
      const color = MONSTERS[g.kind].color;
      const pulse = 0.5 + 0.5 * Math.sin(now * 4 + this.seed(g));
      this.lights.push({ x: px, y: py, r: tile * 1.8, color, gr: tile * (0.7 + 0.15 * pulse), ga: 0.25 + 0.2 * pulse });
      list.push({ y: g.y - 0.3, draw: () => this.drawGenerator(g, px, py, now) });
    }

    for (const m of game.monsters) {
      const p = this.pos(game, m);
      if (!this.visible(game, p.x, p.y)) continue;
      const px = this.sx(game, p.x);
      const py = this.sy(game, p.y);
      const ghostly = m.kind === 'ghost' || (m.kind === 'sorcerer' && m.invisible > 0);
      const sw = tile * (0.6 + 0.06 * m.rank);
      ctx.globalAlpha = ghostly ? 0.4 : 1;
      ctx.drawImage(blob, px - sw / 2, py + tile * 0.3 - sw * 0.17, sw, sw * 0.34);
      ctx.globalAlpha = 1;
      list.push({ y: p.y, draw: () => this.drawMonster(game, m, px, py, now) });
    }

    for (const pl of game.players) {
      if (!pl || !pl.alive) continue;
      const p = this.pos(game, pl);
      const px = this.sx(game, p.x);
      const py = this.sy(game, p.y);
      this.lights.push({ x: px, y: py, r: tile * HERO_LIGHT, color: '#fff2dc', gr: 0, ga: 0 });
      list.push({ y: p.y, draw: () => this.drawHero(game, pl, px, py, now) });
    }

    list.sort((a, b) => a.y - b.y);
    for (const d of list) d.draw();

    for (const s of game.shots) this.drawShot(game, s);
  }

  private drawItem(kind: ItemKind, px: number, py: number): void {
    const { ctx, tile } = this;
    const img = this.sprites.get(ITEM_SPRITES[kind]);
    if (img) {
      this.drawSprite(img, px, py, tile * 0.9, false);
      return;
    }
    const r = tile * 0.3;
    switch (kind) {
      case 'food':
        this.circle(px - r * 0.2, py, r * 0.8, '#b06020');
        ctx.fillStyle = '#f0f0e0';
        ctx.fillRect(px + r * 0.3, py - r * 0.15, r * 0.8, r * 0.3);
        break;
      case 'cider':
        ctx.fillStyle = '#d0a040';
        ctx.fillRect(px - r * 0.5, py - r * 0.7, r, r * 1.4);
        ctx.fillStyle = '#fff';
        ctx.fillRect(px - r * 0.5, py - r * 0.8, r, r * 0.3);
        break;
      case 'potion':
        this.circle(px, py + r * 0.2, r * 0.7, '#3a7ae0');
        ctx.fillStyle = '#c0d0ff';
        ctx.fillRect(px - r * 0.2, py - r * 0.9, r * 0.4, r * 0.6);
        break;
      case 'key':
        ctx.strokeStyle = '#f0d040';
        ctx.lineWidth = Math.max(2, tile / 10);
        ctx.beginPath();
        ctx.arc(px - r * 0.5, py, r * 0.35, 0, Math.PI * 2);
        ctx.moveTo(px - r * 0.15, py);
        ctx.lineTo(px + r * 0.9, py);
        ctx.lineTo(px + r * 0.9, py + r * 0.4);
        ctx.stroke();
        break;
      case 'treasure':
        ctx.fillStyle = '#8a5a20';
        ctx.fillRect(px - r, py - r * 0.6, r * 2, r * 1.3);
        ctx.fillStyle = '#f0d040';
        ctx.fillRect(px - r, py - r * 0.15, r * 2, r * 0.25);
        ctx.fillRect(px - r * 0.15, py - r * 0.6, r * 0.3, r * 1.3);
        break;
    }
  }

  private drawGenerator(g: Generator, px: number, py: number, now: number): void {
    const { ctx, tile } = this;
    const s = tile * (0.55 + 0.12 * Math.min(3, Math.ceil(g.hp / 3)));
    const img = this.sprites.get('generator');
    if (img) {
      const throb = 1 + 0.03 * Math.sin(now * 4 + this.seed(g));
      this.drawSprite(img, px, py, s * 1.15 * throb, false);
      this.drawHitFlash(g, img, px, py, s * 1.15 * throb, false, now);
      return;
    }
    ctx.fillStyle = '#3a2a1a';
    ctx.fillRect(px - s / 2, py - s / 2, s, s);
    ctx.strokeStyle = MONSTERS[g.kind].color;
    ctx.lineWidth = Math.max(2, tile / 10);
    ctx.strokeRect(px - s / 2, py - s / 2, s, s);
    ctx.beginPath();
    ctx.moveTo(px - s / 3, py - s / 3);
    ctx.lineTo(px + s / 3, py + s / 3);
    ctx.moveTo(px + s / 3, py - s / 3);
    ctx.lineTo(px - s / 3, py + s / 3);
    ctx.stroke();
  }

  private drawMonster(game: Game, m: Monster, px: number, py: number, now: number): void {
    const { ctx, tile } = this;
    const r = tile * (0.28 + 0.04 * m.rank);
    const seed = this.seed(m);
    ctx.save();
    if (m.kind === 'sorcerer' && m.invisible > 0) ctx.globalAlpha = 0.2;
    const img = this.sprites.get(m.kind);
    if (img) {
      const size = tile * (0.95 + 0.1 * m.rank);
      let lift = 0;
      let sy = 1;
      if (m.kind === 'ghost') {
        lift = (0.5 + 0.5 * Math.sin(now * 4 + seed)) * tile * 0.08;
        ctx.globalAlpha *= 0.88;
      } else if (this.moving(game, m)) {
        lift = Math.abs(Math.sin(now * 11 + seed)) * tile * 0.05;
        sy = 1 + Math.sin(now * 22 + seed) * 0.03;
      } else {
        sy = 1 + Math.sin(now * 3 + seed) * 0.02;
      }
      this.drawSprite(img, px, py - lift, size, m.fx < 0, sy);
      this.drawHitFlash(m, img, px, py - lift, size, m.fx < 0, now, sy);
      ctx.restore();
      return;
    }
    const color = m.def.color;
    switch (m.kind) {
      case 'ghost': {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px, py - r * 0.2, r, Math.PI, 0);
        const wobble = Math.sin(now * 10 + px) * r * 0.15;
        ctx.lineTo(px + r, py + r * 0.8 + wobble);
        ctx.lineTo(px + r / 3, py + r * 0.5);
        ctx.lineTo(px - r / 3, py + r * 0.8 - wobble);
        ctx.lineTo(px - r, py + r * 0.5);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'death':
        ctx.fillStyle = '#111';
        ctx.beginPath();
        ctx.moveTo(px, py - r * 1.1);
        ctx.lineTo(px + r, py + r);
        ctx.lineTo(px - r, py + r);
        ctx.closePath();
        ctx.fill();
        this.circle(px, py - r * 0.3, r * 0.4, '#e8e8e8');
        break;
      case 'demon':
        this.circle(px, py, r, color);
        ctx.fillStyle = '#ffd040';
        ctx.beginPath();
        ctx.moveTo(px - r * 0.8, py - r * 0.5);
        ctx.lineTo(px - r * 0.5, py - r * 1.3);
        ctx.lineTo(px - r * 0.2, py - r * 0.7);
        ctx.moveTo(px + r * 0.8, py - r * 0.5);
        ctx.lineTo(px + r * 0.5, py - r * 1.3);
        ctx.lineTo(px + r * 0.2, py - r * 0.7);
        ctx.fill();
        break;
      case 'sorcerer':
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(px, py - r * 1.2);
        ctx.lineTo(px + r * 0.9, py + r);
        ctx.lineTo(px - r * 0.9, py + r);
        ctx.closePath();
        ctx.fill();
        break;
      case 'lobber':
        this.circle(px, py, r * 0.75, color);
        break;
      default:
        ctx.fillStyle = color;
        ctx.fillRect(px - r, py - r, r * 2, r * 2);
    }
    if (m.kind !== 'death' && m.kind !== 'ghost') {
      this.circle(px - r * 0.35, py - r * 0.2, Math.max(1.5, r * 0.15), '#ff3');
      this.circle(px + r * 0.35, py - r * 0.2, Math.max(1.5, r * 0.15), '#ff3');
    } else if (m.kind === 'ghost') {
      this.circle(px - r * 0.35, py - r * 0.3, Math.max(1.5, r * 0.15), '#000');
      this.circle(px + r * 0.35, py - r * 0.3, Math.max(1.5, r * 0.15), '#000');
    }
    ctx.restore();
  }

  private drawHero(game: Game, p: Player, px: number, py: number, now: number): void {
    const { ctx, tile } = this;
    const r = tile * 0.4;
    const seed = p.slot * 1.7;

    // Glowing base ring in the hero's colour, so players can tell each other apart in a crowd.
    const ringY = py + r * 0.9;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.55;
    ctx.drawImage(glow(p.def.color), px - r * 1.5, ringY - r * 0.6, r * 3, r * 1.2);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = p.def.color;
    ctx.lineWidth = Math.max(1.5, tile / 18);
    ctx.beginPath();
    ctx.ellipse(px, ringY, r * 0.9, r * 0.32, 0, 0, Math.PI * 2);
    ctx.stroke();

    const img = this.sprites.get(p.hero);
    if (img) {
      const moving = this.moving(game, p);
      const lift = moving ? Math.abs(Math.sin(now * 13 + seed)) * tile * 0.07 : 0;
      const sy = moving ? 1 + Math.sin(now * 26 + seed) * 0.035 : 1 + Math.sin(now * 3 + seed) * 0.015;
      const size = tile * 1.3;
      const shadow = shadowBlob();
      const sw = tile * (0.75 - lift / tile);
      ctx.drawImage(shadow, px - sw / 2, py + tile * 0.38 - sw * 0.17, sw, sw * 0.34);
      this.drawSprite(img, px, py - lift, size, p.fx < 0, sy);
      this.drawHitFlash(p, img, px, py - lift, size, p.fx < 0, now, sy, '#ff3030');
      if (this.livingCount(game) > 1) this.drawTag(`P${p.slot + 1}`, p.def.color, px, py - lift - size * 0.55);
      return;
    }
    this.circle(px, py, r, p.def.color);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(2, tile / 12);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.stroke();
    const len = Math.hypot(p.fx, p.fy) || 1;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + (p.fx / len) * r * 1.4, py + (p.fy / len) * r * 1.4);
    ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.font = `bold ${Math.floor(tile * 0.4)}px ${UI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.def.title[0], px, py + 1);
  }

  /** Small player label floating above a hero. */
  private drawTag(text: string, color: string, px: number, py: number): void {
    const { ctx, tile } = this;
    const fs = Math.max(9, Math.round(tile * 0.24));
    ctx.font = `700 ${fs}px ${UI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + fs * 0.9;
    const hgt = fs * 1.35;
    ctx.fillStyle = 'rgba(10,8,16,0.7)';
    ctx.beginPath();
    ctx.roundRect(px - w / 2, py - hgt / 2, w, hgt, hgt / 2);
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.8);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(text, px, py + 0.5);
  }

  private drawHitFlash(o: object, img: HTMLImageElement, px: number, py: number, size: number, flip: boolean, now: number, sy = 1, color = '#ffffff'): void {
    const at = this.hitAt.get(o);
    if (at === undefined) return;
    const k = 1 - (now - at) / HIT_FLASH;
    if (k <= 0) return;
    const { ctx } = this;
    const a = ctx.globalAlpha;
    ctx.globalAlpha = a * k * 0.85;
    this.drawSprite(silhouette(img, color), px, py, size, flip, sy);
    ctx.globalAlpha = a;
  }

  private drawShot(game: Game, s: Shot): void {
    const { ctx, tile } = this;
    const p = this.pos(game, s);
    if (!this.visible(game, p.x, p.y)) return;
    const px = this.sx(game, p.x);
    const py = this.sy(game, p.y);
    if (s.kind === 'arrow') {
      const color = game.players[s.owner]?.def.color ?? '#ffffff';
      const len = Math.hypot(s.vx, s.vy) || 1;
      const ux = s.vx / len;
      const uy = s.vy / len;
      const tail = tile * 0.9;
      const grad = ctx.createLinearGradient(px - ux * tail, py - uy * tail, px, py);
      grad.addColorStop(0, rgba(color, 0));
      grad.addColorStop(1, rgba(color, 0.9));
      ctx.lineCap = 'round';
      ctx.strokeStyle = grad;
      ctx.lineWidth = Math.max(2, tile / 7);
      ctx.beginPath();
      ctx.moveTo(px - ux * tail, py - uy * tail);
      ctx.lineTo(px + ux * tile * 0.2, py + uy * tile * 0.2);
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1, tile / 18);
      ctx.beginPath();
      ctx.moveTo(px - ux * tile * 0.25, py - uy * tile * 0.25);
      ctx.lineTo(px + ux * tile * 0.22, py + uy * tile * 0.22);
      ctx.stroke();
      ctx.lineCap = 'butt';
      this.lights.push({ x: px, y: py, r: tile * 1.4, color, gr: tile * 0.45, ga: 0.6 });
    } else if (s.kind === 'fireball') {
      const flicker = 0.85 + Math.random() * 0.3;
      this.circle(px, py, tile * 0.17, '#ff6a10');
      this.circle(px, py, tile * 0.1, '#fff0a0');
      this.lights.push({ x: px, y: py, r: tile * 2.6 * flicker, color: '#ff8020', gr: tile * 0.6 * flicker, ga: 0.9 });
    } else {
      // Rocks arc: fake height from remaining flight time.
      const lift = Math.sin(Math.min(1, s.ttl) * Math.PI) * tile * 0.6;
      const sw = tile * 0.35 * (1 - lift / tile * 0.5);
      ctx.drawImage(shadowBlob(), px - sw / 2, py - sw * 0.25, sw, sw * 0.5);
      const r = tile * 0.16;
      const g = ctx.createRadialGradient(px - r * 0.4, py - lift - r * 0.4, r * 0.1, px, py - lift, r);
      g.addColorStop(0, '#e0dcd4');
      g.addColorStop(1, '#5a5650');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py - lift, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---------------------------------------------------------------- lighting and particles

  private drawSmoke(game: Game): void {
    const { ctx, tile } = this;
    for (const p of this.particles.list) {
      if (p.kind !== 'smoke') continue;
      const k = p.life / p.max;
      ctx.globalAlpha = 0.45 * k;
      this.circle(this.sx(game, p.x), this.sy(game, p.y), tile * p.size * (1.6 - k * 0.6), p.color);
    }
    ctx.globalAlpha = 1;
  }

  /** Multiply the scene by a light map: dim ambient everywhere, warm light around heroes, coloured glows elsewhere. */
  private drawLighting(h: number): void {
    const { lctx, light } = this;
    const s = light.width / this.playW;
    lctx.globalCompositeOperation = 'source-over';
    lctx.fillStyle = AMBIENT;
    lctx.fillRect(0, 0, light.width, light.height);
    lctx.globalCompositeOperation = 'lighter';
    for (const l of this.lights) {
      const r = l.r * s;
      lctx.drawImage(glow(l.color), l.x * s - r, l.y * s - r, r * 2, r * 2);
    }
    const { ctx } = this;
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(light, 0, 0, this.playW, h);
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Additive glows and particles drawn after lighting, so they read as light sources. */
  private drawEmissive(game: Game): void {
    const { ctx, tile } = this;
    ctx.globalCompositeOperation = 'lighter';
    for (const l of this.lights) {
      if (l.ga <= 0) continue;
      ctx.globalAlpha = Math.min(1, l.ga);
      ctx.drawImage(glow(l.color), l.x - l.gr, l.y - l.gr, l.gr * 2, l.gr * 2);
    }
    for (const p of this.particles.list) {
      const k = p.life / p.max;
      const px = this.sx(game, p.x);
      const py = this.sy(game, p.y);
      if (p.kind === 'spark') {
        const r = tile * p.size * 3;
        ctx.globalAlpha = k;
        ctx.drawImage(glow(p.color), px - r, py - p.z * tile - r, r * 2, r * 2);
      } else if (p.kind === 'glint') {
        const r = tile * p.size * (0.6 + 0.4 * Math.sin(k * Math.PI));
        ctx.globalAlpha = Math.min(1, k * 1.5);
        this.star(px, py, r, p.color);
      } else if (p.kind === 'ring') {
        const r = tile * p.size * (1 - k * k) + tile * 0.1;
        ctx.globalAlpha = k;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(1.5, tile * 0.08 * k);
        ctx.beginPath();
        ctx.ellipse(px, py, r, r * 0.75, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // Score pop-ups on top of everything in the world.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of this.particles.list) {
      if (p.kind !== 'text' || !p.text) continue;
      const k = p.life / p.max;
      const pop = k > 0.85 ? 1 + (k - 0.85) * 3 : 1;
      ctx.globalAlpha = Math.min(1, k * 2.5);
      ctx.font = `800 ${Math.round(tile * p.size * pop)}px ${UI_FONT}`;
      ctx.lineWidth = Math.max(2, tile * 0.08);
      ctx.strokeStyle = 'rgba(20,10,0,0.85)';
      const x = this.sx(game, p.x);
      const y = this.sy(game, p.y);
      ctx.strokeText(p.text, x, y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, x, y);
    }
    ctx.globalAlpha = 1;
  }

  private drawScreenEffects(game: Game, h: number, now: number): void {
    const { ctx } = this;
    const w = this.playW;

    // Pulsing red edges when someone is about to starve.
    if (game.state === 'playing' && game.players.some((p) => p && p.alive && p.health < LOW_HEALTH_WARNING)) {
      const k = 0.5 + 0.5 * Math.sin(now * 6);
      const r = Math.hypot(w, h) / 2;
      const g = ctx.createRadialGradient(w / 2, h / 2, r * 0.55, w / 2, h / 2, r);
      g.addColorStop(0, 'rgba(255,0,0,0)');
      g.addColorStop(1, `rgba(200,0,0,${0.15 + 0.2 * k})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    // Potion blast: a bright bloom that fades out.
    const f = 1 - (now - this.flashAt) / 0.55;
    if (f > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255,245,225,${0.75 * f * f})`;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    }

    // Fade in from black at each new level.
    const fade = 1 - (now - this.levelAt) / 0.7;
    if (fade > 0) {
      ctx.fillStyle = `rgba(0,0,0,${fade})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  // ---------------------------------------------------------------- overlays and HUD

  private drawOverlay(game: Game, h: number, now: number): void {
    const { ctx } = this;
    const w = this.playW;
    const cx = w / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (game.state === 'attract' || game.state === 'gameover') {
      const bg = ctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, 'rgba(6,4,12,0.92)');
      bg.addColorStop(0.5, 'rgba(6,4,12,0.72)');
      bg.addColorStop(1, 'rgba(6,4,12,0.94)');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      const over = game.state === 'gameover';
      const size = Math.floor(Math.min(w / 7, h / 7, 110));
      const ty = h * 0.2;
      ctx.font = `900 ${size}px ${TITLE_FONT}`;
      const grad = ctx.createLinearGradient(0, ty - size / 2, 0, ty + size / 2);
      if (over) {
        grad.addColorStop(0, '#ffd0c0');
        grad.addColorStop(0.5, '#e04020');
        grad.addColorStop(1, '#701008');
      } else {
        grad.addColorStop(0, '#fff6d0');
        grad.addColorStop(0.5, '#f0b030');
        grad.addColorStop(1, '#8a4a08');
      }
      ctx.save();
      ctx.shadowColor = over ? 'rgba(255,60,20,0.55)' : 'rgba(255,170,40,0.5)';
      ctx.shadowBlur = size * 0.4;
      ctx.fillStyle = grad;
      ctx.fillText(over ? 'GAME OVER' : 'GAUNTLET', cx, ty);
      ctx.restore();
      ctx.lineWidth = Math.max(1, size / 50);
      ctx.strokeStyle = 'rgba(40,20,0,0.6)';
      ctx.strokeText(over ? 'GAME OVER' : 'GAUNTLET', cx, ty);

      ctx.font = `600 ${Math.max(12, Math.round(size * 0.16))}px ${UI_FONT}`;
      ctx.fillStyle = 'rgba(230,210,170,0.7)';
      ctx.fillText(over ? 'Your quest has ended' : 'Four heroes. One dungeon. No way back.', cx, ty + size * 0.72);

      // The four heroes, bobbing gently.
      const spacing = Math.min(w / 5, 150);
      const hy = h * 0.47;
      const hs = Math.min(spacing * 0.75, h * 0.14);
      HERO_ORDER.forEach((hero, i) => {
        const hx = cx + (i - 1.5) * spacing;
        const def = HEROES[hero];
        const bob = Math.sin(now * 2.2 + i * 1.3) * hs * 0.04;
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.6;
        ctx.drawImage(glow(def.color), hx - hs * 0.8, hy + hs * 0.38 - hs * 0.25, hs * 1.6, hs * 0.5);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        const img = this.sprites.get(hero);
        if (img) this.drawSprite(img, hx, hy + bob, hs, false);
        else this.circle(hx, hy + bob, hs * 0.35, def.color);
        ctx.font = `700 ${Math.max(11, Math.round(hs * 0.17))}px ${TITLE_FONT}`;
        ctx.fillStyle = def.color;
        ctx.fillText(def.title.toUpperCase(), hx, hy + hs * 0.72);
      });

      const pulse = 0.55 + 0.45 * Math.sin(now * 4);
      ctx.font = `800 ${Math.max(14, Math.round(size * 0.22))}px ${UI_FONT}`;
      ctx.fillStyle = `rgba(255,230,160,${pulse})`;
      ctx.fillText('PRESS FIRE TO JOIN', cx, h * 0.66);

      const lineH = 24;
      const cardW = Math.min(w - 40, 520);
      const cardH = this.hints.length * lineH + 52;
      const cardY = h * 0.71;
      ctx.fillStyle = 'rgba(255,255,255,0.045)';
      ctx.strokeStyle = 'rgba(255,220,150,0.16)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(cx - cardW / 2, cardY, cardW, cardH, 12);
      ctx.fill();
      ctx.stroke();
      ctx.font = `500 14px ${UI_FONT}`;
      this.hints.forEach((hint, i) => {
        const y = cardY + 22 + i * lineH;
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(240,200,120,0.9)';
        ctx.fillText(hint.label, cx - 10, y);
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(235,235,245,0.85)';
        ctx.fillText(hint.join, cx + 10, y);
      });
      ctx.textAlign = 'center';
      ctx.font = `400 13px ${UI_FONT}`;
      ctx.fillStyle = 'rgba(200,200,215,0.55)';
      ctx.fillText('Up to 4 players · hold FIRE to stand and shoot · don’t shoot the food', cx, cardY + cardH - 16);
    }

    if (game.state === 'levelEnd') {
      const t = Math.min(1, (now - this.stateAt) / 0.35);
      const scale = 0.6 + 0.4 * (1 - Math.pow(1 - t, 3));
      const size = Math.round(Math.min(w / 10, 64) * scale);
      ctx.fillStyle = `rgba(0,0,0,${0.35 * t})`;
      ctx.fillRect(0, 0, w, h);
      ctx.save();
      ctx.globalAlpha = t;
      ctx.font = `900 ${size}px ${TITLE_FONT}`;
      ctx.shadowColor = 'rgba(80,210,255,0.8)';
      ctx.shadowBlur = size * 0.5;
      ctx.fillStyle = '#e8fbff';
      ctx.fillText('LEVEL COMPLETE', cx, h / 2);
      ctx.restore();
    }

    if (now < this.messageUntil && game.state !== 'attract') {
      const a = Math.min(1, (now - this.messageAt) / 0.15, (this.messageUntil - now) / 0.4);
      const rise = (1 - Math.min(1, (now - this.messageAt) / 0.2)) * 12;
      ctx.globalAlpha = a;
      ctx.font = `700 20px ${UI_FONT}`;
      const tw = ctx.measureText(this.message).width + 44;
      const y = h - 64 + rise;
      ctx.fillStyle = 'rgba(12,8,20,0.78)';
      ctx.strokeStyle = 'rgba(240,190,90,0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(cx - tw / 2, y - 21, tw, 42, 21);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffe2a0';
      ctx.fillText(this.message, cx, y + 1);
      ctx.globalAlpha = 1;
    }
  }

  private drawHud(game: Game, h: number, now: number): void {
    const { ctx } = this;
    const x = this.playW;
    const bg = ctx.createLinearGradient(x, 0, x + HUD_W, h);
    bg.addColorStop(0, '#191522');
    bg.addColorStop(1, '#0b0910');
    ctx.fillStyle = bg;
    ctx.fillRect(x, 0, HUD_W, h);
    // Soft shadow the panel casts over the play area, and a thin gold edge.
    const edge = ctx.createLinearGradient(x - 18, 0, x, 0);
    edge.addColorStop(0, 'rgba(0,0,0,0)');
    edge.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = edge;
    ctx.fillRect(x - 18, 0, 18, h);
    ctx.fillStyle = 'rgba(240,180,70,0.35)';
    ctx.fillRect(x, 0, 1, h);

    const cx = x + HUD_W / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 26px ${TITLE_FONT}`;
    const tg = ctx.createLinearGradient(0, 14, 0, 40);
    tg.addColorStop(0, '#fff3c8');
    tg.addColorStop(1, '#c07a18');
    ctx.fillStyle = tg;
    ctx.fillText('GAUNTLET', cx, 28);
    ctx.font = `700 11px ${UI_FONT}`;
    ctx.fillStyle = 'rgba(240,200,120,0.85)';
    ctx.fillText(`LEVEL ${game.levelNumber}`, cx, 52);
    ctx.font = `400 11px ${UI_FONT}`;
    ctx.fillStyle = 'rgba(210,205,225,0.55)';
    ctx.fillText(this.ellipsize(game.level.name, HUD_W - 30), cx, 67);
    const sep = ctx.createLinearGradient(x + 20, 0, x + HUD_W - 20, 0);
    sep.addColorStop(0, 'rgba(240,180,70,0)');
    sep.addColorStop(0.5, 'rgba(240,180,70,0.5)');
    sep.addColorStop(1, 'rgba(240,180,70,0)');
    ctx.fillStyle = sep;
    ctx.fillRect(x + 20, 82, HUD_W - 40, 1);

    const top = 94;
    const panelH = Math.max(100, Math.min(150, (h - top - 6) / 4));
    for (let slot = 0; slot < 4; slot++) this.drawPlayerCard(game, slot, x + 10, top + slot * panelH, HUD_W - 20, panelH - 10, now);
  }

  private drawPlayerCard(game: Game, slot: number, x: number, y: number, w: number, h: number, now: number): void {
    const { ctx } = this;
    const p = game.players[slot];
    const hero = p ? p.def : HEROES[HERO_ORDER[slot]];
    const heroClass = p ? p.hero : HERO_ORDER[slot];

    const bg = ctx.createLinearGradient(x, y, x + w, y + h);
    bg.addColorStop(0, rgba(hero.color, p ? 0.2 : 0.06));
    bg.addColorStop(1, 'rgba(255,255,255,0.02)');
    ctx.fillStyle = bg;
    ctx.strokeStyle = p ? rgba(hero.color, 0.55) : 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 10);
    ctx.fill();
    ctx.stroke();

    // Portrait.
    const pr = 21;
    const pcx = x + 12 + pr;
    const pcy = y + 12 + pr;
    ctx.save();
    ctx.beginPath();
    ctx.arc(pcx, pcy, pr, 0, Math.PI * 2);
    const pg = ctx.createRadialGradient(pcx, pcy - 6, 2, pcx, pcy, pr);
    pg.addColorStop(0, rgba(hero.color, p ? 0.55 : 0.15));
    pg.addColorStop(1, 'rgba(8,6,12,0.95)');
    ctx.fillStyle = pg;
    ctx.fill();
    ctx.clip();
    const img = this.sprites.get(heroClass);
    if (img) {
      ctx.globalAlpha = p && p.alive ? 1 : 0.3;
      ctx.drawImage(img, pcx - pr * 1.25, pcy - pr * 1.05, pr * 2.5, pr * 2.5);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    ctx.strokeStyle = p ? hero.color : 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pcx, pcy, pr, 0, Math.PI * 2);
    ctx.stroke();

    const tx = pcx + pr + 12;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `700 15px ${TITLE_FONT}`;
    ctx.fillStyle = p ? hero.color : 'rgba(220,215,235,0.5)';
    ctx.fillText(p ? hero.title.toUpperCase() : `PLAYER ${slot + 1}`, tx, y + 27);

    if (!p) {
      ctx.font = `500 12px ${UI_FONT}`;
      ctx.fillStyle = `rgba(220,215,235,${0.35 + 0.25 * Math.sin(now * 3 + slot)})`;
      ctx.fillText('Press FIRE to join', tx, y + 46);
      return;
    }

    ctx.font = `600 13px ${UI_FONT}`;
    ctx.fillStyle = '#f2d890';
    ctx.fillText(p.score.toLocaleString('en-US'), tx, y + 46);

    const barX = x + 12;
    const barY = y + 66;
    const barW = w - 24;
    if (!p.alive) {
      ctx.font = `700 12px ${UI_FONT}`;
      ctx.fillStyle = `rgba(255,110,100,${0.6 + 0.4 * Math.sin(now * 4)})`;
      ctx.fillText('DEAD · FIRE to continue', barX, barY + 8);
    } else {
      const low = p.health < LOW_HEALTH_WARNING;
      const frac = Math.min(1, p.health / JOIN_HEALTH);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      ctx.roundRect(barX, barY, barW, 8, 4);
      ctx.fill();
      if (frac > 0) {
        const fg = ctx.createLinearGradient(barX, 0, barX + barW, 0);
        const c = low ? '#ff3020' : hero.color;
        fg.addColorStop(0, rgba(c, 0.85));
        fg.addColorStop(1, low ? '#ff9070' : '#ffffff');
        ctx.globalAlpha = low ? 0.6 + 0.4 * Math.sin(now * 8) : 1;
        ctx.fillStyle = fg;
        ctx.beginPath();
        ctx.roundRect(barX, barY, Math.max(8, barW * frac), 8, 4);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.textAlign = 'right';
      ctx.font = `700 12px ${UI_FONT}`;
      ctx.fillStyle = low ? '#ff8070' : 'rgba(240,240,250,0.9)';
      ctx.fillText(`${Math.ceil(p.health)}`, x + w - 12, y + 27);
      ctx.font = `500 9px ${UI_FONT}`;
      ctx.fillStyle = 'rgba(220,215,235,0.45)';
      ctx.fillText('HEALTH', x + w - 12, y + 40);
    }

    // Inventory: keys and potions as little icons.
    const iy = y + h - 16;
    if (h < 92) return;
    let ix = barX;
    const icon = 18;
    const drawIcons = (name: SpriteName, count: number, fallback: string) => {
      const im = this.sprites.get(name);
      const shown = Math.min(count, 4);
      for (let i = 0; i < shown; i++) {
        if (im) ctx.drawImage(im, ix + i * 11, iy - icon / 2, icon, icon);
        else this.circle(ix + i * 11 + icon / 2, iy, 5, fallback);
      }
      ix += shown * 11 + (shown ? 10 : 0);
      if (count > 4) {
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = `600 11px ${UI_FONT}`;
        ctx.fillStyle = 'rgba(240,240,250,0.75)';
        ctx.fillText(`×${count}`, ix - 4, iy);
        ix += 22;
      }
    };
    drawIcons('key', p.keys, '#f0d040');
    drawIcons('potion', p.potions, '#3a7ae0');
    if (p.keys === 0 && p.potions === 0) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = `400 11px ${UI_FONT}`;
      ctx.fillStyle = 'rgba(220,215,235,0.3)';
      ctx.fillText('No keys or potions', barX, iy);
    }
  }

  private ellipsize(text: string, maxW: number): string {
    const { ctx } = this;
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
    return `${t}…`;
  }

  // ---------------------------------------------------------------- primitives

  /**
   * Draw an image centred on (px, py), `size` pixels square, optionally mirrored to face left.
   * `sy` stretches it vertically about its feet, for a little squash-and-stretch.
   */
  private drawSprite(img: CanvasImageSource, px: number, py: number, size: number, flip: boolean, sy = 1): void {
    const { ctx } = this;
    if (!flip && sy === 1) {
      ctx.drawImage(img, px - size / 2, py - size / 2, size, size);
      return;
    }
    ctx.save();
    ctx.translate(px, py + size / 2);
    ctx.scale(flip ? -1 / sy : 1 / sy, sy);
    ctx.drawImage(img, -size / 2, -size, size, size);
    ctx.restore();
  }

  private star(x: number, y: number, r: number, color: string): void {
    const { ctx } = this;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.quadraticCurveTo(x, y, x, y + r);
    ctx.quadraticCurveTo(x, y, x - r, y);
    ctx.quadraticCurveTo(x, y, x, y - r);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, r * 0.22, 0, Math.PI * 2);
    ctx.fill();
  }

  private circle(x: number, y: number, r: number, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, Math.PI * 2);
    this.ctx.fill();
  }
}
