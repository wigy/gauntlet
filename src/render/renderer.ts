import { MONSTERS } from '../core/defs';
import { Tile, tileAt } from '../core/level';
import type { Game, Monster, Player } from '../core/game';
import { HERO_ORDER, HEROES } from '../core/defs';

const WALL_COLORS = ['#c0602a', '#3a8a8a', '#7a4ac0', '#a03030', '#4a8a3a', '#b08a2a', '#4a5ab0'];
const FLOOR_COLORS = ['#26243a', '#2a2018', '#1c2a2a', '#2a1c26', '#1a2230'];
const HUD_W = 230;

export interface Hint {
  join: string;
  label: string;
}

/** Draws the game onto a canvas. Owns the mapping from tile coordinates to screen pixels; never mutates game logic. */
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private tile = 32;
  private playW = 0;
  private message = '';
  private messageUntil = 0;
  private flashUntil = 0;

  constructor(private canvas: HTMLCanvasElement, private hints: readonly Hint[]) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(game: Game): void {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.playW = Math.max(200, w - HUD_W);
    this.tile = Math.max(16, Math.floor(Math.min(this.playW / 18, h / 13)));
    game.viewW = this.playW / this.tile;
    game.viewH = h / this.tile;
  }

  showMessage(text: string, now: number): void {
    this.message = text;
    this.messageUntil = now + 2.5;
  }

  flash(now: number): void {
    this.flashUntil = now + 0.25;
  }

  draw(game: Game, now: number): void {
    const { ctx } = this;
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.playW + HUD_W, h);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.playW, h);
    ctx.clip();
    this.drawMaze(game, h);
    this.drawEntities(game, h, now);
    if (now < this.flashUntil) {
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillRect(0, 0, this.playW, h);
    }
    this.drawOverlay(game, h, now);
    ctx.restore();

    this.drawHud(game, h);
  }

  private sx(game: Game, x: number): number {
    return game.dxw(game.camera.x, x) * this.tile + this.playW / 2;
  }

  private sy(game: Game, y: number, h: number): number {
    return game.dyw(game.camera.y, y) * this.tile + h / 2;
  }

  private drawMaze(game: Game, h: number): void {
    const { ctx, tile } = this;
    const lvl = game.level;
    const wall = WALL_COLORS[(game.levelNumber - 1) % WALL_COLORS.length];
    const floor = FLOOR_COLORS[(game.levelNumber - 1) % FLOOR_COLORS.length];
    const halfW = this.playW / tile / 2 + 1;
    const halfH = h / tile / 2 + 1;
    const x0 = Math.floor(game.camera.x - halfW);
    const y0 = Math.floor(game.camera.y - halfH);
    const ox = (x0 - game.camera.x) * tile + this.playW / 2;
    const oy = (y0 - game.camera.y) * tile + h / 2;

    for (let j = 0; j <= halfH * 2 + 1; j++) {
      for (let i = 0; i <= halfW * 2 + 1; i++) {
        const tx = x0 + i;
        const ty = y0 + j;
        const px = Math.round(ox + i * tile);
        const py = Math.round(oy + j * tile);
        const outside = (!lvl.wrapX && (tx < 0 || tx >= lvl.width)) || (!lvl.wrapY && (ty < 0 || ty >= lvl.height));
        if (outside) continue;
        const t = tileAt(lvl, tx, ty);
        if (t === Tile.Wall) {
          ctx.fillStyle = wall;
          ctx.fillRect(px, py, tile, tile);
          ctx.fillStyle = 'rgba(255,255,255,0.18)';
          ctx.fillRect(px, py, tile, tile * 0.15);
          ctx.fillRect(px, py, tile * 0.15, tile);
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.fillRect(px, py + tile * 0.85, tile, tile * 0.15);
          ctx.fillRect(px + tile * 0.85, py, tile * 0.15, tile);
          continue;
        }
        ctx.fillStyle = floor;
        ctx.fillRect(px, py, tile, tile);
        if ((tx + ty) % 2 === 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.025)';
          ctx.fillRect(px, py, tile, tile);
        }
        if (t === Tile.Door) {
          ctx.fillStyle = '#5a3a10';
          ctx.fillRect(px + 1, py + 1, tile - 2, tile - 2);
          ctx.fillStyle = '#e0b030';
          for (let k = 0; k < 3; k++) ctx.fillRect(px + 2, py + tile * (0.2 + k * 0.28), tile - 4, tile * 0.1);
        } else if (t === Tile.Exit) {
          ctx.fillStyle = '#000';
          ctx.fillRect(px + 1, py + 1, tile - 2, tile - 2);
          ctx.fillStyle = '#fff';
          ctx.font = `bold ${Math.floor(tile * 0.32)}px monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('EXIT', px + tile / 2, py + tile / 2);
        }
      }
    }
  }

  private drawEntities(game: Game, h: number, now: number): void {
    const { ctx, tile } = this;
    const visible = (x: number, y: number) => game.onScreen(x, y);

    for (const [, it] of game.items) {
      const cx = it.x + 0.5;
      const cy = it.y + 0.5;
      if (!visible(cx, cy)) continue;
      this.drawItem(it.kind, this.sx(game, cx), this.sy(game, cy, h));
    }

    for (const g of game.generators) {
      if (!visible(g.x, g.y)) continue;
      const px = this.sx(game, g.x);
      const py = this.sy(game, g.y, h);
      const s = tile * (0.55 + 0.12 * Math.min(3, Math.ceil(g.hp / 3)));
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

    for (const m of game.monsters) if (visible(m.x, m.y)) this.drawMonster(m, this.sx(game, m.x), this.sy(game, m.y, h), now);

    for (const p of game.players) if (p && p.alive) this.drawHero(p, this.sx(game, p.x), this.sy(game, p.y, h));

    for (const s of game.shots) {
      const px = this.sx(game, s.x);
      const py = this.sy(game, s.y, h);
      if (s.kind === 'arrow') {
        const p = game.players[s.owner];
        const len = Math.hypot(s.vx, s.vy) || 1;
        ctx.strokeStyle = p ? p.def.color : '#fff';
        ctx.lineWidth = Math.max(2, tile / 8);
        ctx.beginPath();
        ctx.moveTo(px - (s.vx / len) * tile * 0.3, py - (s.vy / len) * tile * 0.3);
        ctx.lineTo(px + (s.vx / len) * tile * 0.3, py + (s.vy / len) * tile * 0.3);
        ctx.stroke();
      } else if (s.kind === 'fireball') {
        this.circle(px, py, tile * 0.2, '#ff8020');
        this.circle(px, py, tile * 0.1, '#ffe060');
      } else {
        // Rocks arc: fake height from remaining flight time.
        const lift = Math.sin(Math.min(1, s.ttl) * Math.PI) * tile * 0.6;
        this.circle(px, py, tile * 0.12, 'rgba(0,0,0,0.4)');
        this.circle(px, py - lift, tile * 0.16, '#a0a0a0');
      }
    }
  }

  private drawItem(kind: string, px: number, py: number): void {
    const { ctx, tile } = this;
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

  private drawMonster(m: Monster, px: number, py: number, now: number): void {
    const { ctx, tile } = this;
    const r = tile * (0.28 + 0.04 * m.rank);
    ctx.save();
    if (m.kind === 'sorcerer' && m.invisible > 0) ctx.globalAlpha = 0.2;
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

  private drawHero(p: Player, px: number, py: number): void {
    const { ctx, tile } = this;
    const r = tile * 0.4;
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
    ctx.font = `bold ${Math.floor(tile * 0.4)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.def.title[0], px, py + 1);
  }

  private drawOverlay(game: Game, h: number, now: number): void {
    const { ctx } = this;
    const cx = this.playW / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (game.state === 'attract' || game.state === 'gameover') {
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(0, 0, this.playW, h);
      ctx.fillStyle = '#e0b030';
      ctx.font = `bold ${Math.floor(Math.min(this.playW / 8, 90))}px serif`;
      ctx.fillText(game.state === 'gameover' ? 'GAME OVER' : 'GAUNTLET', cx, h * 0.3);
      ctx.fillStyle = '#ddd';
      ctx.font = '18px monospace';
      ctx.fillText('Press FIRE on any controller to join (up to 4 players)', cx, h * 0.45);
      this.hints.forEach((hint, i) => ctx.fillText(`${hint.label}: ${hint.join}`, cx, h * 0.52 + i * 26));
      ctx.fillStyle = '#999';
      ctx.font = '14px monospace';
      ctx.fillText('Hold FIRE to stand and shoot. Don’t shoot the food.', cx, h * 0.52 + this.hints.length * 26 + 20);
    }
    if (game.state === 'levelEnd') {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 36px monospace';
      ctx.fillText('EXIT!', cx, h / 2);
    }
    if (now < this.messageUntil && game.state !== 'attract') {
      ctx.font = 'bold 22px monospace';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      const w = ctx.measureText(this.message).width + 30;
      ctx.fillRect(cx - w / 2, h - 70, w, 40);
      ctx.fillStyle = '#ffe080';
      ctx.fillText(this.message, cx, h - 50);
    }
  }

  private drawHud(game: Game, h: number): void {
    const { ctx } = this;
    const x = this.playW;
    ctx.fillStyle = '#111';
    ctx.fillRect(x, 0, HUD_W, h);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#e0b030';
    ctx.font = 'bold 20px serif';
    ctx.fillText('GAUNTLET', x + 14, 10);
    ctx.fillStyle = '#aaa';
    ctx.font = '13px monospace';
    ctx.fillText(`Level ${game.levelNumber}`, x + 14, 36);
    ctx.fillText(game.level.name.slice(0, 26), x + 14, 52);

    const panelH = Math.max(90, (h - 80) / 4);
    for (let slot = 0; slot < 4; slot++) {
      const py = 76 + slot * panelH;
      const p = game.players[slot];
      const hero = p ? p.def : HEROES[HERO_ORDER[slot]];
      ctx.fillStyle = hero.color;
      ctx.fillRect(x + 8, py, 4, panelH - 10);
      ctx.font = 'bold 16px monospace';
      ctx.fillText(p ? hero.title.toUpperCase() : `PLAYER ${slot + 1}`, x + 20, py);
      ctx.font = '13px monospace';
      ctx.fillStyle = '#ddd';
      if (!p) {
        ctx.fillStyle = '#777';
        ctx.fillText('Press FIRE to join', x + 20, py + 22);
        continue;
      }
      if (!p.alive) {
        ctx.fillStyle = '#c55';
        ctx.fillText('DEAD - FIRE to continue', x + 20, py + 22);
      } else {
        ctx.fillText(`Health ${Math.ceil(p.health)}`, x + 20, py + 22);
      }
      ctx.fillText(`Score  ${p.score}`, x + 20, py + 40);
      ctx.fillText(`Keys ${p.keys}  Potions ${p.potions}`, x + 20, py + 58);
    }
  }

  private circle(x: number, y: number, r: number, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, Math.PI * 2);
    this.ctx.fill();
  }
}
