import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface PlayerRecord {
  name: string;
  createdAt: string;
  lastSeen: string;
}

/**
 * Saved player profiles, keyed by an id the browser keeps in localStorage. A small JSON file is plenty for now;
 * writes are batched and done atomically (write to a temp file, then rename).
 */
export class PlayerStore {
  private players: Record<string, PlayerRecord> = {};
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** `file` null keeps everything in memory (tests). */
  constructor(private readonly file: string | null) {
    if (file && existsSync(file)) {
      try {
        this.players = JSON.parse(readFileSync(file, 'utf8')) as Record<string, PlayerRecord>;
      } catch (err) {
        console.error(`Could not read ${file}, starting with no saved players:`, err);
      }
    }
  }

  get(id: string | null): PlayerRecord | undefined {
    return id && Object.hasOwn(this.players, id) ? this.players[id] : undefined;
  }

  /** A fresh id; nothing is stored until the player picks a name. */
  newId(): string {
    return randomUUID();
  }

  setName(id: string, name: string): void {
    const now = new Date().toISOString();
    const rec = this.players[id];
    this.players[id] = rec ? { ...rec, name, lastSeen: now } : { name, createdAt: now, lastSeen: now };
    this.changed();
  }

  touch(id: string): void {
    const rec = this.players[id];
    if (!rec) return;
    rec.lastSeen = new Date().toISOString();
    this.changed();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty || !this.file) return;
    this.dirty = false;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.players, null, 2));
    renameSync(tmp, this.file);
  }

  private changed(): void {
    this.dirty = true;
    if (this.file && !this.timer) this.timer = setTimeout(() => this.flush(), 1000);
  }
}
