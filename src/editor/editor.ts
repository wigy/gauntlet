import { MONSTERS } from '../core/defs';
import type { MonsterKind } from '../core/defs';
import { LEGEND, MAX_LEVEL_SIZE, Tile, bfsDistances, parseLevel } from '../core/level';
import type { LevelSetId, LevelSetInfo } from '../net/protocol';
import { Sprites } from '../render/sprites';
import { confirmDialog } from '../ui/dialog';
import type { SpriteName } from '../render/sprites';
import './editor.css';

export interface EditorActions {
  list(): void;
  load(set: LevelSetId, id: string): void;
  save(id: string | null, text: string): void;
  remove(id: string): void;
  move(id: string, delta: -1 | 1): void;
  /** Play the custom level at this 1-based position in the custom set. */
  playTest(level: number): void;
  close(): void;
}

type Wrap = 'none' | 'x' | 'y' | 'both';
type Mode = 'pen' | 'rect' | 'fill';

interface Doc {
  /** Custom level id once saved; null for a new level or a copy. */
  id: string | null;
  name: string;
  wrap: Wrap;
  rank: number;
  grid: string[][];
}

interface ToolDef {
  ch: string;
  label: string;
}

const { ITEM_CHARS, GENERATOR_CHARS, MONSTER_CHARS } = LEGEND;
const ITEM_SPRITES: Record<string, SpriteName> = { F: 'food', C: 'cider', P: 'potion', K: 'key', T: 'treasure-gold' };
const title = (s: string) => s[0].toUpperCase() + s.slice(1);

const GROUPS: { label: string; tools: ToolDef[] }[] = [
  {
    label: 'Terrain',
    tools: [
      { ch: '#', label: 'Wall' },
      { ch: '.', label: 'Floor' },
      { ch: 'D', label: 'Door (opened with a key)' },
      { ch: 'E', label: 'Exit' },
      { ch: 'S', label: 'Start (heroes appear here)' },
    ],
  },
  { label: 'Items', tools: Object.entries(ITEM_CHARS).map(([ch, kind]) => ({ ch, label: title(kind) })) },
  { label: 'Generators', tools: Object.entries(GENERATOR_CHARS).map(([ch, kind]) => ({ ch, label: `${title(kind)} generator` })) },
  { label: 'Monsters', tools: Object.entries(MONSTER_CHARS).map(([ch, kind]) => ({ ch, label: title(kind) })) },
];
const TOOL_BY_CHAR = new Map(GROUPS.flatMap((g) => g.tools).map((t) => [t.ch, t]));
const UNDO_LIMIT = 200;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A fresh level: walled room with a start in one corner and the exit in the other. */
function blankDoc(w = 32, h = 24): Doc {
  const grid: string[][] = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => (x === 0 || y === 0 || x === w - 1 || y === h - 1 ? '#' : '.')));
  grid[2][2] = 'S';
  grid[h - 3][w - 3] = 'E';
  return { id: null, name: 'New level', wrap: 'none', rank: 2, grid };
}

function docToText(doc: Doc): string {
  const name = doc.name.replace(/[\r\n]+/g, ' ').trim() || 'Untitled';
  return `name: ${name}\nwrap: ${doc.wrap}\nrank: ${doc.rank}\n---\n${doc.grid.map((r) => r.join('')).join('\n')}\n`;
}

function textToDoc(text: string, id: string | null): Doc {
  const lines = text.replace(/\r/g, '').split('\n');
  const sep = lines.indexOf('---');
  const meta: Record<string, string> = {};
  for (const l of sep >= 0 ? lines.slice(0, sep) : []) {
    const m = /^\s*(\w+)\s*:\s*(.*?)\s*$/.exec(l);
    if (m) meta[m[1].toLowerCase()] = m[2];
  }
  const rows = (sep >= 0 ? lines.slice(sep + 1) : lines).filter((l) => l.length > 0);
  const w = Math.max(1, ...rows.map((r) => r.length));
  const grid = rows.map((r) => Array.from({ length: w }, (_, x) => (r[x] === ' ' ? '.' : (r[x] ?? '#'))));
  const wrap = (['none', 'x', 'y', 'both'] as const).find((v) => v === meta.wrap) ?? 'none';
  const rank = Math.max(1, Math.min(3, Number(meta.rank) || 3));
  return { id, name: meta.name ?? 'Untitled', wrap, rank, grid: grid.length ? grid : blankDoc().grid };
}

/**
 * Full-screen level editor: a list of custom levels (plus copies of built-in and arcade ones), a palette of
 * everything in the level legend, and a zoomable, pannable map to paint on. Saves go to the server as text.
 */
export class Editor {
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private sprites = new Sprites();
  private sets: LevelSetInfo[] = [];
  private doc: Doc = blankDoc();
  private savedText = '';
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private tool = '#';
  private mode: Mode = 'pen';
  private cell = 24;
  private ox = 0;
  private oy = 0;
  private hover: { x: number; y: number } | null = null;
  private drag: { kind: 'paint' | 'pan' | 'rect'; sx: number; sy: number; lx: number; ly: number; ox: number; oy: number } | null = null;
  private spaceDown = false;
  private pendingCopyName: string | null = null;
  private testAfterSave = false;
  private waitingSave = false;
  private needsDraw = true;
  private visible = false;

  constructor(host: HTMLElement, private actions: EditorActions) {
    this.root = host;
    this.root.innerHTML = this.shell();
    this.canvas = this.root.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.sprites.onload = () => {
      this.needsDraw = true;
      this.renderPalette();
    };
    this.renderPalette();
    this.bind();
    this.setDoc(blankDoc(), false);
    const loop = () => {
      if (this.visible && this.needsDraw) this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  get isOpen(): boolean {
    return this.visible;
  }

  open(): void {
    this.visible = true;
    this.root.classList.add('open');
    this.actions.list();
    this.resize();
    this.fit();
    this.renderAll();
  }

  /** Hide without asking (e.g. while play-testing; the level stays loaded). */
  hide(): void {
    this.visible = false;
    this.root.classList.remove('open');
  }

  // ---------------------------------------------------------------- server messages

  setSets(sets: LevelSetInfo[]): void {
    this.sets = sets;
    // Our level may have been deleted elsewhere.
    if (this.doc.id && !this.customLevels().some((l) => l.id === this.doc.id)) this.doc.id = null;
    this.renderSidebar();
    this.renderHeader();
  }

  levelText(set: LevelSetId, id: string, text: string): void {
    const doc = textToDoc(text, set === 'custom' ? id : null);
    if (this.pendingCopyName !== null) {
      doc.name = this.pendingCopyName;
      this.pendingCopyName = null;
      this.setDoc(doc, true);
    } else {
      this.setDoc(doc, false);
    }
    this.toast(set === 'custom' ? `Opened “${doc.name}”` : 'Copied. Save it to add it to your custom levels.');
  }

  saved(id: string): void {
    if (!this.waitingSave) return;
    this.waitingSave = false;
    this.doc.id = id;
    this.savedText = docToText(this.doc);
    this.renderHeader();
    this.renderSidebar();
    this.toast('Saved');
    if (this.testAfterSave) {
      this.testAfterSave = false;
      this.startTest();
    }
  }

  error(message: string): void {
    this.waitingSave = false;
    this.testAfterSave = false;
    this.toast(message);
  }

  // ---------------------------------------------------------------- document

  private get dirty(): boolean {
    return docToText(this.doc) !== this.savedText;
  }

  private setDoc(doc: Doc, dirty: boolean): void {
    this.doc = doc;
    this.savedText = dirty ? '' : docToText(doc);
    this.undoStack = [];
    this.redoStack = [];
    this.fit();
    this.renderAll();
  }

  private async confirmDiscard(): Promise<boolean> {
    if (!this.dirty) return true;
    return confirmDialog({
      title: 'Discard unsaved changes?',
      message: `“${this.doc.name.trim() || 'Untitled'}” has changes that haven’t been saved.`,
      confirm: 'Discard',
      cancel: 'Keep editing',
      danger: true,
    });
  }

  private checkpoint(): void {
    this.undoStack.push(docToText(this.doc));
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.redoStack.push(docToText(this.doc));
    this.restore(prev);
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(docToText(this.doc));
    this.restore(next);
  }

  private restore(text: string): void {
    const id = this.doc.id;
    const w = this.width;
    const h = this.height;
    this.doc = textToDoc(text, id);
    if (w !== this.width || h !== this.height) this.fit();
    this.renderHeader();
    this.renderStatus();
    this.needsDraw = true;
  }

  private get width(): number {
    return this.doc.grid[0]?.length ?? 0;
  }

  private get height(): number {
    return this.doc.grid.length;
  }

  private customLevels(): { id: string; name: string }[] {
    return this.sets.find((s) => s.id === 'custom')?.levels ?? [];
  }

  private save(): void {
    if (this.waitingSave) return;
    this.waitingSave = true;
    this.actions.save(this.doc.id, docToText(this.doc));
  }

  private playTest(): void {
    if (!this.doc.grid.some((r) => r.includes('S')) || !this.doc.grid.some((r) => r.includes('E'))) {
      this.toast('Add a start (S) and an exit (E) first.');
      return;
    }
    if (this.dirty || !this.doc.id) {
      this.testAfterSave = true;
      this.save();
    } else {
      this.startTest();
    }
  }

  private startTest(): void {
    const index = this.customLevels().findIndex((l) => l.id === this.doc.id);
    if (index >= 0) this.actions.playTest(index + 1);
  }

  private resizeLevel(w: number, h: number): void {
    w = Math.max(4, Math.min(MAX_LEVEL_SIZE, Math.round(w) || 4));
    h = Math.max(4, Math.min(MAX_LEVEL_SIZE, Math.round(h) || 4));
    if (w === this.width && h === this.height) return;
    this.checkpoint();
    // Keep the top-left corner; new space starts as wall.
    this.doc.grid = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => this.doc.grid[y]?.[x] ?? '#'));
    this.fit();
    this.renderAll();
  }

  // ---------------------------------------------------------------- painting

  private paintLine(x0: number, y0: number, x1: number, y1: number): void {
    // Bresenham, so fast strokes don't leave gaps.
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, this.tool);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  private set(x: number, y: number, ch: string): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.doc.grid[y][x] = ch;
  }

  private fillRect(x0: number, y0: number, x1: number, y1: number): void {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.set(x, y, this.tool);
  }

  private floodFill(x: number, y: number): void {
    const target = this.doc.grid[y]?.[x];
    if (target === undefined || target === this.tool) return;
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop()!;
      if (this.doc.grid[cy]?.[cx] !== target) continue;
      this.doc.grid[cy][cx] = this.tool;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }

  private changed(): void {
    this.needsDraw = true;
    this.renderStatus();
    this.renderHeader();
  }

  // ---------------------------------------------------------------- view

  private resize(): void {
    const box = this.canvas.parentElement!.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(box.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(box.height * dpr));
    this.canvas.style.width = `${box.width}px`;
    this.canvas.style.height = `${box.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.needsDraw = true;
  }

  private viewSize(): { w: number; h: number } {
    const dpr = window.devicePixelRatio || 1;
    return { w: this.canvas.width / dpr, h: this.canvas.height / dpr };
  }

  private fit(): void {
    const { w, h } = this.viewSize();
    this.cell = Math.max(6, Math.min(48, Math.floor(Math.min((w - 48) / this.width, (h - 48) / this.height))));
    this.ox = Math.round((w - this.cell * this.width) / 2);
    this.oy = Math.round((h - this.cell * this.height) / 2);
    this.needsDraw = true;
  }

  private zoomAt(px: number, py: number, factor: number): void {
    const cell = Math.max(4, Math.min(96, this.cell * factor));
    // Keep the point under the cursor fixed.
    this.ox = px - ((px - this.ox) * cell) / this.cell;
    this.oy = py - ((py - this.oy) * cell) / this.cell;
    this.cell = cell;
    this.needsDraw = true;
  }

  private cellAt(e: MouseEvent): { x: number; y: number; px: number; py: number } {
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    return { x: Math.floor((px - this.ox) / this.cell), y: Math.floor((py - this.oy) / this.cell), px, py };
  }

  private draw(): void {
    this.needsDraw = false;
    const { ctx, cell } = this;
    const { w, h } = this.viewSize();
    ctx.fillStyle = '#0c0a12';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const x0 = Math.max(0, Math.floor(-this.ox / cell));
    const y0 = Math.max(0, Math.floor(-this.oy / cell));
    const x1 = Math.min(this.width - 1, Math.ceil((w - this.ox) / cell));
    const y1 = Math.min(this.height - 1, Math.ceil((h - this.oy) / cell));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) this.drawCell(ctx, this.doc.grid[y][x], this.ox + x * cell, this.oy + y * cell, cell);
    }

    // Grid lines once cells are big enough to see them.
    if (cell >= 10) {
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = x0; x <= x1 + 1; x++) {
        ctx.moveTo(Math.round(this.ox + x * cell) + 0.5, this.oy + y0 * cell);
        ctx.lineTo(Math.round(this.ox + x * cell) + 0.5, this.oy + (y1 + 1) * cell);
      }
      for (let y = y0; y <= y1 + 1; y++) {
        ctx.moveTo(this.ox + x0 * cell, Math.round(this.oy + y * cell) + 0.5);
        ctx.lineTo(this.ox + (x1 + 1) * cell, Math.round(this.oy + y * cell) + 0.5);
      }
      ctx.stroke();
    }

    // Level border; wrapping edges are drawn as dashed cyan lines.
    const bw = this.width * cell;
    const bh = this.height * cell;
    const edge = (wraps: boolean, x0e: number, y0e: number, x1e: number, y1e: number) => {
      ctx.strokeStyle = wraps ? 'rgba(90,220,255,0.9)' : 'rgba(240,180,70,0.6)';
      ctx.setLineDash(wraps ? [6, 5] : []);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x0e, y0e);
      ctx.lineTo(x1e, y1e);
      ctx.stroke();
    };
    const wx = this.doc.wrap === 'x' || this.doc.wrap === 'both';
    const wy = this.doc.wrap === 'y' || this.doc.wrap === 'both';
    edge(wy, this.ox, this.oy, this.ox + bw, this.oy);
    edge(wy, this.ox, this.oy + bh, this.ox + bw, this.oy + bh);
    edge(wx, this.ox, this.oy, this.ox, this.oy + bh);
    edge(wx, this.ox + bw, this.oy, this.ox + bw, this.oy + bh);
    ctx.setLineDash([]);

    // Rectangle preview or hover outline.
    const d = this.drag;
    if (d?.kind === 'rect' && this.hover) {
      const rx = Math.min(d.sx, this.hover.x);
      const ry = Math.min(d.sy, this.hover.y);
      const rw = Math.abs(d.sx - this.hover.x) + 1;
      const rh = Math.abs(d.sy - this.hover.y) + 1;
      ctx.globalAlpha = 0.55;
      for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) if (this.inside(x, y)) this.drawCell(ctx, this.tool, this.ox + x * cell, this.oy + y * cell, cell);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#ffd877';
      ctx.lineWidth = 2;
      ctx.strokeRect(this.ox + rx * cell, this.oy + ry * cell, rw * cell, rh * cell);
    } else if (this.hover && this.inside(this.hover.x, this.hover.y) && !this.drag) {
      ctx.globalAlpha = 0.5;
      this.drawCell(ctx, this.tool, this.ox + this.hover.x * cell, this.oy + this.hover.y * cell, cell);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#ffd877';
      ctx.lineWidth = 2;
      ctx.strokeRect(this.ox + this.hover.x * cell + 1, this.oy + this.hover.y * cell + 1, cell - 2, cell - 2);
    }
  }

  private inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** One grid cell: floor or wall underneath, then whatever stands on it. Also used for the palette icons. */
  private drawCell(ctx: CanvasRenderingContext2D, ch: string, px: number, py: number, s: number): void {
    const sprite = (name: SpriteName, scale = 0.92, ox = 0, oy = 0) => {
      const img = this.sprites.get(name);
      const size = s * scale;
      if (img) ctx.drawImage(img, px + (s - size) / 2 + ox * s, py + (s - size) / 2 + oy * s, size, size);
      return !!img;
    };
    if (ch === '#') {
      if (!sprite('wall-orange', 1)) {
        ctx.fillStyle = '#b0602a';
        ctx.fillRect(px, py, s, s);
      }
      return;
    }
    if (!sprite('floor', 1)) {
      ctx.fillStyle = '#2a2838';
      ctx.fillRect(px, py, s, s);
    }
    ctx.fillStyle = 'rgba(8,6,14,0.35)';
    ctx.fillRect(px, py, s, s);

    const cx = px + s / 2;
    const cy = py + s / 2;
    if (ch === 'D') {
      if (!sprite('door', 1)) {
        ctx.fillStyle = '#7a5020';
        ctx.fillRect(px + 1, py + 1, s - 2, s - 2);
      }
    } else if (ch === 'E') {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, s * 0.45);
      g.addColorStop(0, '#000004');
      g.addColorStop(0.6, '#06304a');
      g.addColorStop(1, '#3ad0ff');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.42, 0, Math.PI * 2);
      ctx.fill();
      this.label(ctx, 'EXIT', cx, cy, s, '#d8f6ff');
    } else if (ch === 'S') {
      ctx.strokeStyle = '#ffd877';
      ctx.lineWidth = Math.max(1.5, s * 0.08);
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.38, 0, Math.PI * 2);
      ctx.stroke();
      if (!sprite('warrior', 0.8)) this.label(ctx, 'S', cx, cy, s, '#ffd877');
    } else if (ITEM_SPRITES[ch]) {
      sprite(ITEM_SPRITES[ch], 0.8);
    } else if (GENERATOR_CHARS[ch]) {
      const kind = GENERATOR_CHARS[ch];
      if (!sprite('generator', 0.95)) {
        ctx.fillStyle = '#4a3a2a';
        ctx.fillRect(px + s * 0.15, py + s * 0.15, s * 0.7, s * 0.7);
      }
      // Badge with the monster it spawns.
      const r = s * 0.24;
      ctx.fillStyle = 'rgba(10,8,16,0.85)';
      ctx.beginPath();
      ctx.arc(px + s - r, py + s - r, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = MONSTERS[kind].color;
      ctx.lineWidth = Math.max(1, s * 0.04);
      ctx.stroke();
      sprite(kind, 0.42, 0.26, 0.26);
    } else if (MONSTER_CHARS[ch]) {
      const kind: MonsterKind = MONSTER_CHARS[ch];
      if (!sprite(kind, 0.95)) {
        ctx.fillStyle = MONSTERS[kind].color;
        ctx.beginPath();
        ctx.arc(cx, cy, s * 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private label(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, s: number, color: string): void {
    if (s < 14) return;
    ctx.font = `800 ${Math.round(s * (text.length > 1 ? 0.24 : 0.45))}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, cx, cy + 0.5);
  }

  // ---------------------------------------------------------------- DOM

  private shell(): string {
    return `
      <header class="ed-bar">
        <button class="ed-btn ghost" data-act="close" title="Back to the lobby">← Lobby</button>
        <input class="ed-name" data-field="name" maxlength="40" spellcheck="false" aria-label="Level name" />
        <label class="ed-field">Wrap
          <select data-field="wrap">
            <option value="none">None</option><option value="x">Left↔right</option>
            <option value="y">Top↕bottom</option><option value="both">Both</option>
          </select>
        </label>
        <label class="ed-field" title="Strength of monsters and generators (1-3)">Rank
          <select data-field="rank"><option>1</option><option>2</option><option>3</option></select>
        </label>
        <label class="ed-field">Size
          <input type="number" data-field="w" min="4" max="${MAX_LEVEL_SIZE}" /> ×
          <input type="number" data-field="h" min="4" max="${MAX_LEVEL_SIZE}" />
          <button class="ed-btn small" data-act="resize">Apply</button>
        </label>
        <span class="ed-spacer"></span>
        <button class="ed-btn icon" data-act="undo" title="Undo (Ctrl+Z)">↶</button>
        <button class="ed-btn icon" data-act="redo" title="Redo (Ctrl+Shift+Z)">↷</button>
        <button class="ed-btn" data-act="save" title="Save (Ctrl+S)">Save</button>
        <button class="ed-btn primary" data-act="test" title="Save and play this level">▶ Play test</button>
      </header>
      <aside class="ed-side">
        <h3>Custom levels</h3>
        <p class="ed-note">Played in this order when a game uses the Custom set.</p>
        <ol class="ed-levels"></ol>
        <button class="ed-btn wide" data-act="new">+ New level</button>
        <h3>Start from a copy</h3>
        <select class="ed-copy" aria-label="Level to copy"></select>
        <button class="ed-btn wide" data-act="copy">Copy level</button>
      </aside>
      <main class="ed-map"><canvas></canvas></main>
      <aside class="ed-palette">
        <div class="ed-modes">
          <button data-mode="pen" title="Pen: click and drag (1)">✎ Pen</button>
          <button data-mode="rect" title="Rectangle: drag to fill (2)">▭ Rect</button>
          <button data-mode="fill" title="Fill an area (3)">◩ Fill</button>
        </div>
        <div class="ed-tools"></div>
        <p class="ed-note">Keys: the level-text letter of each tool (e.g. <b>#</b> wall, <b>g</b> ghost generator, <b>G</b> ghost).
          Right-click picks a tile. Wheel zooms, middle-drag or Space+drag pans, <b>0</b> fits.</p>
      </aside>
      <footer class="ed-status"></footer>
      <div class="ed-toast"></div>`;
  }

  private renderAll(): void {
    this.renderHeader();
    this.renderSidebar();
    this.renderPalette();
    this.renderStatus();
    this.needsDraw = true;
  }

  private field<T extends HTMLElement = HTMLInputElement>(name: string): T {
    return this.root.querySelector<T>(`[data-field="${name}"]`)!;
  }

  private renderHeader(): void {
    const name = this.field('name');
    if (document.activeElement !== name) name.value = this.doc.name;
    this.field<HTMLSelectElement>('wrap').value = this.doc.wrap;
    this.field<HTMLSelectElement>('rank').value = String(this.doc.rank);
    for (const [f, v] of [['w', this.width], ['h', this.height]] as const) {
      const el = this.field(f);
      if (document.activeElement !== el) el.value = String(v);
    }
    const save = this.root.querySelector<HTMLButtonElement>('[data-act=save]')!;
    save.textContent = this.dirty ? 'Save •' : 'Saved';
    save.classList.toggle('dirty', this.dirty);
    this.root.querySelector<HTMLButtonElement>('[data-act=undo]')!.disabled = !this.undoStack.length;
    this.root.querySelector<HTMLButtonElement>('[data-act=redo]')!.disabled = !this.redoStack.length;
  }

  private renderSidebar(): void {
    const custom = this.customLevels();
    const list = this.root.querySelector('.ed-levels')!;
    list.innerHTML = custom.length
      ? custom.map((l, i) => `
        <li class="${l.id === this.doc.id ? 'active' : ''}">
          <button class="ed-level" data-act="open" data-id="${esc(l.id)}"><span class="num">${i + 1}</span>${esc(l.name)}</button>
          <span class="ed-level-tools">
            <button data-act="up" data-id="${esc(l.id)}" title="Earlier" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button data-act="down" data-id="${esc(l.id)}" title="Later" ${i === custom.length - 1 ? 'disabled' : ''}>↓</button>
            <button data-act="delete" data-id="${esc(l.id)}" title="Delete">✕</button>
          </span>
        </li>`).join('')
      : '<li class="ed-empty">None yet. Make a new level or copy one.</li>';

    const copy = this.root.querySelector<HTMLSelectElement>('.ed-copy')!;
    const keep = copy.value;
    copy.innerHTML = this.sets
      .filter((s) => s.id !== 'custom' || s.levels.length)
      .map((s) => `<optgroup label="${esc(s.label)}">${s.levels.map((l, i) => `<option value="${s.id}:${esc(l.id)}">${i + 1}. ${esc(l.name)}</option>`).join('')}</optgroup>`)
      .join('');
    if (keep) copy.value = keep;
  }

  private renderPalette(): void {
    const tools = this.root.querySelector('.ed-tools')!;
    if (!tools.children.length) {
      tools.innerHTML = GROUPS.map((g) => `
        <h4>${g.label}</h4>
        <div class="ed-grid">${g.tools.map((t) => `
          <button class="ed-tool" data-tool="${esc(t.ch)}" title="${esc(t.label)} (${esc(t.ch)})">
            <canvas width="64" height="64"></canvas><kbd>${esc(t.ch)}</kbd>
          </button>`).join('')}</div>`).join('');
    }
    for (const btn of tools.querySelectorAll<HTMLButtonElement>('.ed-tool')) {
      const c = btn.querySelector('canvas')!.getContext('2d')!;
      c.clearRect(0, 0, 64, 64);
      this.drawCell(c, btn.dataset.tool!, 0, 0, 64);
      btn.classList.toggle('active', btn.dataset.tool === this.tool);
    }
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-mode]')) b.classList.toggle('active', b.dataset.mode === this.mode);
  }

  private renderStatus(): void {
    const counts = { starts: 0, exits: 0, items: 0, generators: 0, monsters: 0, doors: 0, keys: 0 };
    for (const row of this.doc.grid) {
      for (const ch of row) {
        if (ch === 'S') counts.starts++;
        else if (ch === 'E') counts.exits++;
        else if (ch === 'D') counts.doors++;
        else if (ch === 'K') {
          counts.items++;
          counts.keys++;
        }
        else if (ITEM_CHARS[ch]) counts.items++;
        else if (GENERATOR_CHARS[ch]) counts.generators++;
        else if (MONSTER_CHARS[ch]) counts.monsters++;
      }
    }
    const problems: [string, 'error' | 'warn'][] = [];
    if (!counts.starts) problems.push(['No start (S)', 'error']);
    if (!counts.exits) problems.push(['No exit (E)', 'error']);
    if (counts.starts && counts.exits) {
      try {
        const level = parseLevel(docToText(this.doc));
        const dist = bfsDistances(level, level.starts);
        const reachable = level.tiles.some((t, i) => t === Tile.Exit && dist[i] >= 0);
        if (!reachable) problems.push(['Exit can’t be reached from the start', 'error']);
        else if (!counts.keys) {
          const noDoors = bfsDistances(level, level.starts, false);
          if (!level.tiles.some((t, i) => t === Tile.Exit && noDoors[i] >= 0)) problems.push(['Exit is behind doors but there are no keys', 'error']);
        }
      } catch {
        problems.push(['Level can’t be read', 'error']);
      }
    }
    if (counts.doors && !counts.keys && !problems.length) problems.push(['Doors but no keys (K)', 'warn']);
    const hover = this.hover && this.inside(this.hover.x, this.hover.y)
      ? `<span>${this.hover.x}, ${this.hover.y} · ${esc(TOOL_BY_CHAR.get(this.doc.grid[this.hover.y][this.hover.x])?.label ?? '')}</span>`
      : '';
    this.root.querySelector('.ed-status')!.innerHTML = `
      <span>${this.width} × ${this.height}</span>
      <span>${counts.monsters} monsters · ${counts.generators} generators · ${counts.items} items · ${counts.doors} doors</span>
      ${hover}
      <span class="ed-spacer"></span>
      ${problems.length ? problems.map(([t, k]) => `<span class="ed-chip ${k}">${esc(t)}</span>`).join('') : '<span class="ed-chip ok">Ready to play</span>'}`;
  }

  private toast(text: string): void {
    const el = this.root.querySelector<HTMLElement>('.ed-toast')!;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(Number(el.dataset.timer));
    el.dataset.timer = String(window.setTimeout(() => el.classList.remove('show'), 2200));
  }

  private bind(): void {
    const root = this.root;
    root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const tool = t.closest<HTMLElement>('[data-tool]');
      if (tool) {
        this.tool = tool.dataset.tool!;
        this.renderPalette();
        return;
      }
      const mode = t.closest<HTMLElement>('[data-mode]');
      if (mode) {
        this.mode = mode.dataset.mode as Mode;
        this.renderPalette();
        return;
      }
      const act = t.closest<HTMLButtonElement>('[data-act]');
      if (act && !act.disabled) void this.act(act.dataset.act!, act.dataset.id);
    });
    root.addEventListener('change', (e) => {
      const el = e.target as HTMLInputElement;
      const f = el.dataset.field;
      if (f === 'wrap' || f === 'rank') {
        this.checkpoint();
        if (f === 'wrap') this.doc.wrap = el.value as Wrap;
        else this.doc.rank = Number(el.value);
        this.changed();
      } else if (f === 'w' || f === 'h') {
        this.resizeLevel(Number(this.field('w').value), Number(this.field('h').value));
      }
    });
    root.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement;
      if (el.dataset.field === 'name') {
        this.doc.name = el.value;
        this.renderHeader();
      }
    });

    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('mousedown', (e) => {
      const p = this.cellAt(e);
      if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
        this.drag = { kind: 'pan', sx: p.px, sy: p.py, lx: 0, ly: 0, ox: this.ox, oy: this.oy };
        e.preventDefault();
        return;
      }
      if (e.button === 2) {
        // Eyedropper.
        const ch = this.doc.grid[p.y]?.[p.x];
        if (ch !== undefined) {
          this.tool = ch;
          this.renderPalette();
        }
        return;
      }
      if (e.button !== 0 || !this.inside(p.x, p.y)) return;
      this.checkpoint();
      if (this.mode === 'fill') {
        this.floodFill(p.x, p.y);
        this.changed();
        return;
      }
      const kind = this.mode === 'rect' || e.shiftKey ? 'rect' : 'paint';
      this.drag = { kind, sx: p.x, sy: p.y, lx: p.x, ly: p.y, ox: 0, oy: 0 };
      if (kind === 'paint') {
        this.set(p.x, p.y, this.tool);
        this.changed();
      }
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.visible) return;
      const p = this.cellAt(e);
      const d = this.drag;
      if (d?.kind === 'pan') {
        this.ox = d.ox + p.px - d.sx;
        this.oy = d.oy + p.py - d.sy;
        this.needsDraw = true;
        return;
      }
      const over = e.target === c;
      const hover = over || d ? { x: p.x, y: p.y } : null;
      if (hover?.x !== this.hover?.x || hover?.y !== this.hover?.y) {
        this.hover = hover;
        this.needsDraw = true;
        this.renderStatus();
      }
      if (d?.kind === 'paint' && (p.x !== d.lx || p.y !== d.ly)) {
        this.paintLine(d.lx, d.ly, p.x, p.y);
        d.lx = p.x;
        d.ly = p.y;
        this.changed();
      }
    });
    window.addEventListener('mouseup', () => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      if (d.kind === 'rect' && this.hover) {
        this.fillRect(d.sx, d.sy, this.hover.x, this.hover.y);
        this.changed();
      }
      // Drop the checkpoint if the stroke didn't change anything.
      if (d.kind !== 'pan' && this.undoStack.at(-1) === docToText(this.doc)) this.undoStack.pop();
      this.renderHeader();
      this.needsDraw = true;
    });
    c.addEventListener('mouseleave', () => {
      if (this.drag) return;
      this.hover = null;
      this.needsDraw = true;
      this.renderStatus();
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = this.cellAt(e);
      this.zoomAt(p.px, p.py, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (!this.visible) return;
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this.save();
        return;
      }
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
        this.renderHeader();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.redo();
        this.renderHeader();
        return;
      }
      if (mod || e.altKey) return;
      if (e.code === 'Space') {
        this.spaceDown = true;
        e.preventDefault();
        return;
      }
      if (e.key === '0') return this.fit();
      if (e.key === '1' || e.key === '2' || e.key === '3') {
        this.mode = (['pen', 'rect', 'fill'] as const)[Number(e.key) - 1];
        this.renderPalette();
        return;
      }
      if (TOOL_BY_CHAR.has(e.key)) {
        this.tool = e.key;
        this.renderPalette();
        this.needsDraw = true;
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.spaceDown = false;
    });
    window.addEventListener('resize', () => {
      if (this.visible) this.resize();
    });
  }

  private async act(action: string, id: string | undefined): Promise<void> {
    switch (action) {
      case 'close':
        if (await this.confirmDiscard()) {
          this.hide();
          this.actions.close();
        }
        return;
      case 'save':
        return this.save();
      case 'test':
        return this.playTest();
      case 'undo':
        this.undo();
        return this.renderHeader();
      case 'redo':
        this.redo();
        return this.renderHeader();
      case 'resize':
        return this.resizeLevel(Number(this.field('w').value), Number(this.field('h').value));
      case 'new':
        if (await this.confirmDiscard()) this.setDoc(blankDoc(), true);
        return;
      case 'copy': {
        const value = this.root.querySelector<HTMLSelectElement>('.ed-copy')!.value;
        const [set, levelId] = value.split(':') as [LevelSetId, string];
        if (!levelId || !(await this.confirmDiscard())) return;
        const name = this.sets.find((s) => s.id === set)?.levels.find((l) => l.id === levelId)?.name ?? 'Level';
        this.pendingCopyName = `Copy of ${name}`;
        this.actions.load(set, levelId);
        return;
      }
      case 'open':
        if (id && id !== this.doc.id && (await this.confirmDiscard())) this.actions.load('custom', id);
        return;
      case 'up':
      case 'down':
        if (id) this.actions.move(id, action === 'up' ? -1 : 1);
        return;
      case 'delete': {
        const name = this.customLevels().find((l) => l.id === id)?.name ?? 'this level';
        if (!id) return;
        const yes = await confirmDialog({
          title: `Delete “${name}”?`,
          message: 'It’s removed from the Custom levels for everyone, and this can’t be undone.',
          confirm: 'Delete level',
          danger: true,
        });
        if (!yes) return;
        this.actions.remove(id);
        if (id === this.doc.id) {
          // Keep what's on screen as an unsaved level.
          this.doc.id = null;
          this.savedText = '';
          this.renderAll();
        }
        return;
      }
    }
  }
}
