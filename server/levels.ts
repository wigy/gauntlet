import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_LEVEL_SIZE, isEmptyLevel, levelToText, parseLevel, populate } from '../src/core/level';
import { BUILTIN_LEVELS } from '../src/levels/builtin';
import type { LevelSetId, LevelSetInfo, LevelSetSummary } from '../src/net/protocol';

const LABELS: Record<LevelSetId, string> = { arcade: 'Arcade levels', arcade2: 'Gauntlet II levels', builtin: 'Built-in levels', custom: 'My levels' };
const MAX_LEVEL_TEXT = 40_000;
const MAX_NAME = 40;

export interface LevelLibraryOptions {
  /** Where custom levels are saved (<dir>/<owner>/index.json + <id>.txt); null keeps them in memory (tests). */
  customDir: string | null;
  /** Imported arcade levels (public/levels/gauntlet1); null or missing = no arcade set. */
  arcadeDir?: string | null;
  /** Imported Gauntlet II levels (public/levels/gauntlet2); null or missing = no such set. */
  arcade2Dir?: string | null;
  builtin?: readonly string[];
  /** Set used when a game doesn't ask for one (LEVELS env: builtin / arcade / arcade2 / custom). */
  preferred?: string;
}

interface CustomLevel {
  id: string;
  text: string;
  name: string;
}

/**
 * The level sets games can be played from: built-in, the imported arcade levels (if present) and each player's own
 * levels made in the editor (the `custom` set, keyed by owner = saved player id). Custom levels are loaded per owner
 * on first use and written through to disk on every change.
 */
export class LevelLibrary {
  private builtin: string[];
  private arcade: string[] = [];
  private arcade2: string[] = [];
  private custom = new Map<string, CustomLevel[]>();
  private preferred: string;

  constructor(private readonly options: LevelLibraryOptions) {
    this.builtin = [...(options.builtin ?? BUILTIN_LEVELS)];
    this.preferred = options.preferred ?? 'arcade';
    if (options.arcadeDir) this.arcade = this.readSet(options.arcadeDir);
    if (options.arcade2Dir) this.arcade2 = this.readSet(options.arcade2Dir);
  }

  /** Default set for new games. */
  defaultSet(owner: string | null): LevelSetId {
    if (this.preferred === 'builtin') return 'builtin';
    if (this.preferred === 'custom' && this.texts('custom', owner).length) return 'custom';
    if (this.preferred === 'arcade2' && this.arcade2.length) return 'arcade2';
    return this.arcade.length ? 'arcade' : 'builtin';
  }

  summary(owner: string | null): LevelSetSummary[] {
    return this.ids().map((id) => ({ id, label: LABELS[id], count: this.texts(id, owner).length }));
  }

  /** All sets with their level names; `custom` is the owner's own levels. */
  sets(owner: string | null): LevelSetInfo[] {
    return this.ids().map((id) => ({
      id,
      label: LABELS[id],
      levels: id === 'custom' ? this.mine(owner).map((c) => ({ id: c.id, name: c.name })) : this.texts(id, owner).map((t, i) => ({ id: String(i), name: nameOf(t) })),
    }));
  }

  isSet(id: unknown): id is LevelSetId {
    return id === 'arcade' || id === 'arcade2' || id === 'builtin' || id === 'custom';
  }

  label(id: LevelSetId): string {
    return LABELS[id];
  }

  /** Level texts of a set (custom: the owner's), in play order. A snapshot: later edits don't affect running games. */
  texts(set: LevelSetId, owner: string | null): string[] {
    if (set === 'custom') return this.mine(owner).map((c) => c.text);
    return set === 'arcade' ? [...this.arcade] : set === 'arcade2' ? [...this.arcade2] : [...this.builtin];
  }

  /**
   * One level as editable text. Wall-only levels (the arcade imports) are populated first, the same way a game
   * would, so the copy shows its monsters and items.
   */
  get(set: LevelSetId, id: string, owner: string | null): string | null {
    if (set === 'custom') return this.mine(owner).find((c) => c.id === id)?.text ?? null;
    const index = Number(id);
    const text = this.texts(set, owner)[index];
    if (text === undefined) return null;
    const level = parseLevel(text);
    if (isEmptyLevel(level)) populate(level, 7919 + index + 1, index + 1);
    return levelToText(level);
  }

  /** Create (id null) or overwrite one of the owner's levels. Returns its id, or an error message. */
  save(owner: string, id: string | null, text: string): { id: string } | { error: string } {
    if (!validOwner(owner)) return { error: 'Unknown player.' };
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
    const levels = this.mine(owner);
    let entry = id ? levels.find((c) => c.id === id) : undefined;
    if (!entry) {
      entry = { id: this.newId(levels), text, name };
      levels.push(entry);
    } else {
      entry.text = text;
      entry.name = name;
    }
    this.writeCustom(owner, entry);
    return { id: entry.id };
  }

  remove(owner: string, id: string): void {
    const levels = this.mine(owner);
    const i = levels.findIndex((c) => c.id === id);
    if (i < 0) return;
    levels.splice(i, 1);
    const dir = this.ownerDir(owner);
    if (dir && existsSync(join(dir, `${id}.txt`))) unlinkSync(join(dir, `${id}.txt`));
    this.writeCustom(owner, null);
  }

  /** Move one of the owner's levels earlier (-1) or later (+1) in play order. */
  move(owner: string, id: string, delta: number): void {
    const levels = this.mine(owner);
    const i = levels.findIndex((c) => c.id === id);
    const j = i + Math.sign(delta);
    if (i < 0 || j < 0 || j >= levels.length) return;
    [levels[i], levels[j]] = [levels[j], levels[i]];
    this.writeCustom(owner, null);
  }

  // ---------------------------------------------------------------- files

  private ids(): LevelSetId[] {
    const sets: LevelSetId[] = [];
    if (this.arcade.length) sets.push('arcade');
    if (this.arcade2.length) sets.push('arcade2');
    return [...sets, 'builtin', 'custom'];
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

  /** The owner's levels (loaded from disk on first use). No owner, or a malformed one, has none. */
  private mine(owner: string | null): CustomLevel[] {
    if (!owner || !validOwner(owner)) return [];
    let levels = this.custom.get(owner);
    if (!levels) this.custom.set(owner, (levels = this.loadCustom(owner)));
    return levels;
  }

  private ownerDir(owner: string): string | null {
    return this.options.customDir ? join(this.options.customDir, owner) : null;
  }

  private loadCustom(owner: string): CustomLevel[] {
    const dir = this.ownerDir(owner);
    const index = dir && join(dir, 'index.json');
    if (!dir || !index || !existsSync(index)) return [];
    const out: CustomLevel[] = [];
    try {
      const ids = JSON.parse(readFileSync(index, 'utf8')) as string[];
      for (const id of ids) {
        if (!/^[a-z0-9]+$/.test(id) || !existsSync(join(dir, `${id}.txt`))) continue;
        const text = readFileSync(join(dir, `${id}.txt`), 'utf8');
        out.push({ id, text, name: nameOf(text) });
      }
    } catch (err) {
      console.error(`Could not load levels from ${dir}:`, err);
    }
    return out;
  }

  /** Write one level's file (if given) and the owner's index, each atomically. */
  private writeCustom(owner: string, level: CustomLevel | null): void {
    const dir = this.ownerDir(owner);
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    const write = (file: string, data: string) => {
      writeFileSync(`${file}.tmp`, data);
      renameSync(`${file}.tmp`, file);
    };
    if (level) write(join(dir, `${level.id}.txt`), level.text);
    write(join(dir, 'index.json'), JSON.stringify(this.mine(owner).map((c) => c.id), null, 2));
  }

  private newId(levels: CustomLevel[]): string {
    let id: string;
    do id = randomBytes(5).toString('hex');
    while (levels.some((c) => c.id === id));
    return id;
  }
}

/** Owners are saved player ids (UUIDs); anything else must never become a path. */
function validOwner(owner: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(owner);
}

function nameOf(text: string): string {
  return /^\s*name\s*:\s*(.*?)\s*$/m.exec(text.split('---')[0])?.[1] || 'Untitled';
}
