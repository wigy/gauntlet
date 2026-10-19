import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_LEVEL_SIZE, isEmptyLevel, levelToText, parseLevel, populate } from '../src/core/level';
import { BUILTIN_LEVELS } from '../src/levels/builtin';
import type { LevelSetId, LevelSetInfo, LevelSetSummary } from '../src/net/protocol';

const LABELS: Record<LevelSetId, string> = { arcade: 'Arcade', builtin: 'Built-in', custom: 'Custom' };
const MAX_LEVEL_TEXT = 40_000;
const MAX_NAME = 40;

export interface LevelLibraryOptions {
  /** Where custom levels are saved (<dir>/index.json + <id>.txt); null keeps them in memory (tests). */
  customDir: string | null;
  /** Imported arcade levels (public/levels/gauntlet1); null or missing = no arcade set. */
  arcadeDir?: string | null;
  builtin?: readonly string[];
  /** Set used when a game doesn't ask for one (LEVELS env: builtin / arcade). */
  preferred?: string;
}

/**
 * The level sets games can be played from: built-in, the imported arcade levels (if present) and the custom levels
 * made in the editor. Custom levels are kept in memory and written through to disk on every change.
 */
export class LevelLibrary {
  private builtin: string[];
  private arcade: string[] = [];
  private custom: { id: string; text: string; name: string }[] = [];
  private preferred: string;

  constructor(private readonly options: LevelLibraryOptions) {
    this.builtin = [...(options.builtin ?? BUILTIN_LEVELS)];
    this.preferred = options.preferred ?? 'arcade';
    if (options.arcadeDir) this.arcade = this.readSet(options.arcadeDir);
    if (options.customDir) this.loadCustom(options.customDir);
  }

  /** Default set for new games. */
  get defaultSet(): LevelSetId {
    if (this.preferred === 'builtin' || this.preferred === 'custom') return this.texts(this.preferred).length ? this.preferred : 'builtin';
    return this.arcade.length ? 'arcade' : 'builtin';
  }

  summary(): LevelSetSummary[] {
    return this.ids().map((id) => ({ id, label: LABELS[id], count: this.texts(id).length }));
  }

  sets(): LevelSetInfo[] {
    return this.ids().map((id) => ({
      id,
      label: LABELS[id],
      levels: id === 'custom' ? this.custom.map((c) => ({ id: c.id, name: c.name })) : this.texts(id).map((t, i) => ({ id: String(i), name: nameOf(t) })),
    }));
  }

  isSet(id: unknown): id is LevelSetId {
    return id === 'arcade' || id === 'builtin' || id === 'custom';
  }

  label(id: LevelSetId): string {
    return LABELS[id];
  }

  /** Level texts of a set, in play order (a snapshot: later edits don't affect games already running). */
  texts(set: LevelSetId): string[] {
    if (set === 'custom') return this.custom.map((c) => c.text);
    return set === 'arcade' ? [...this.arcade] : [...this.builtin];
  }

  /**
   * One level as editable text. Wall-only levels (the arcade imports) are populated first, the same way a game
   * would, so the copy shows its monsters and items.
   */
  get(set: LevelSetId, id: string): string | null {
    if (set === 'custom') return this.custom.find((c) => c.id === id)?.text ?? null;
    const index = Number(id);
    const text = this.texts(set)[index];
    if (text === undefined) return null;
    const level = parseLevel(text);
    if (isEmptyLevel(level)) populate(level, 7919 + index + 1, index + 1);
    return levelToText(level);
  }

  /** Position (0-based) of a custom level in play order, or -1. */
  customIndex(id: string): number {
    return this.custom.findIndex((c) => c.id === id);
  }

  /** Create (id null) or overwrite a custom level. Returns its id, or an error message. */
  save(id: string | null, text: string): { id: string } | { error: string } {
    if (typeof text !== 'string' || text.length > MAX_LEVEL_TEXT) return { error: 'Level is too large.' };
    let name: string;
    try {
      const level = parseLevel(text);
      if (level.width > MAX_LEVEL_SIZE || level.height > MAX_LEVEL_SIZE) return { error: `Levels can be at most ${MAX_LEVEL_SIZE}x${MAX_LEVEL_SIZE}.` };
      name = level.name.trim().slice(0, MAX_NAME) || 'Untitled';
    } catch (err) {
      return { error: `Not a valid level: ${(err as Error).message}` };
    }
    text = text.replace(/\r/g, '');
    let entry = id ? this.custom.find((c) => c.id === id) : undefined;
    if (!entry) {
      entry = { id: this.newId(), text, name };
      this.custom.push(entry);
    } else {
      entry.text = text;
      entry.name = name;
    }
    this.writeCustom(entry.id);
    return { id: entry.id };
  }

  remove(id: string): void {
    const i = this.customIndex(id);
    if (i < 0) return;
    this.custom.splice(i, 1);
    const dir = this.options.customDir;
    if (dir && existsSync(join(dir, `${id}.txt`))) unlinkSync(join(dir, `${id}.txt`));
    this.writeCustom(null);
  }

  /** Move a custom level earlier (-1) or later (+1) in play order. */
  move(id: string, delta: number): void {
    const i = this.customIndex(id);
    const j = i + Math.sign(delta);
    if (i < 0 || j < 0 || j >= this.custom.length) return;
    [this.custom[i], this.custom[j]] = [this.custom[j], this.custom[i]];
    this.writeCustom(null);
  }

  // ---------------------------------------------------------------- files

  private ids(): LevelSetId[] {
    return this.arcade.length ? ['arcade', 'builtin', 'custom'] : ['builtin', 'custom'];
  }

  private readSet(dir: string): string[] {
    const index = join(dir, 'index.json');
    if (!existsSync(index)) return [];
    try {
      const files = JSON.parse(readFileSync(index, 'utf8')) as string[];
      return files.map((f) => readFileSync(join(dir, f), 'utf8'));
    } catch (err) {
      console.error(`Could not load levels from ${dir}:`, err);
      return [];
    }
  }

  private loadCustom(dir: string): void {
    const index = join(dir, 'index.json');
    if (!existsSync(index)) return;
    try {
      const ids = JSON.parse(readFileSync(index, 'utf8')) as string[];
      for (const id of ids) {
        if (!/^[a-z0-9]+$/.test(id) || !existsSync(join(dir, `${id}.txt`))) continue;
        const text = readFileSync(join(dir, `${id}.txt`), 'utf8');
        this.custom.push({ id, text, name: nameOf(text) });
      }
    } catch (err) {
      console.error(`Could not load custom levels from ${dir}:`, err);
    }
  }

  /** Write one level's file (if `id`) and the index, each atomically. */
  private writeCustom(id: string | null): void {
    const dir = this.options.customDir;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    const write = (file: string, data: string) => {
      writeFileSync(`${file}.tmp`, data);
      renameSync(`${file}.tmp`, file);
    };
    if (id) write(join(dir, `${id}.txt`), this.custom.find((c) => c.id === id)!.text);
    write(join(dir, 'index.json'), JSON.stringify(this.custom.map((c) => c.id), null, 2));
  }

  private newId(): string {
    let id: string;
    do id = randomBytes(5).toString('hex');
    while (this.custom.some((c) => c.id === id));
    return id;
  }
}

function nameOf(text: string): string {
  return /^\s*name\s*:\s*(.*?)\s*$/m.exec(text.split('---')[0])?.[1] || 'Untitled';
}
