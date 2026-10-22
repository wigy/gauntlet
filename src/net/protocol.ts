/**
 * Messages between the browser and the game server (JSON over a WebSocket at /ws).
 *
 * The server is authoritative: it runs src/core/Game for every game in progress and sends each client a snapshot of
 * what's around its hero ~30 times a second. Clients only send their controller state.
 */
import type { GameEvent, GameState, Shot } from '../core/game';
import type { AmuletKind, HeroClass, ItemKind, MonsterKind } from '../core/defs';

export const WS_PATH = '/ws';
export const MAX_NAME_LENGTH = 16;

export type ClientMessage =
  /** First message. `id` is the saved player id from a previous visit, if any. */
  | { t: 'hello'; id: string | null }
  | { t: 'setName'; name: string }
  /**
   * Open a new game from a level set (default: the server's), starting at `level` (1-based, default 1).
   * `start` skips the waiting room (the editor's play test).
   */
  | { t: 'create'; set?: LevelSetId; level?: number; start?: boolean }
  | { t: 'join'; game: string }
  /** Start a waiting game. Any player in it may do this. */
  | { t: 'start' }
  /** Switch to another hero while the game is waiting, if nobody else has it. */
  | { t: 'pickHero'; hero: HeroClass }
  | { t: 'leave' }
  | { t: 'input'; dx: number; dy: number; fire: boolean; magic: boolean }
  // Level editor. Built-in and arcade levels are read-only; custom levels can be saved, deleted and reordered.
  | { t: 'levelList' }
  | { t: 'levelGet'; set: LevelSetId; id: string }
  /** `id` null creates a new custom level. */
  | { t: 'levelSave'; id: string | null; text: string }
  | { t: 'levelDelete'; id: string }
  | { t: 'levelMove'; id: string; delta: -1 | 1 };

export type LevelSetId = 'arcade' | 'arcade2' | 'builtin' | 'custom';

export interface LevelSetSummary {
  id: LevelSetId;
  label: string;
  count: number;
}

export interface LevelSetInfo {
  id: LevelSetId;
  label: string;
  /** Built-in and arcade ids are indexes; custom ids are stable file ids. */
  levels: { id: string; name: string }[];
}

export interface PlayerInfo {
  name: string;
  hero: HeroClass;
}

export interface LobbyGame {
  id: string;
  name: string;
  state: 'waiting' | 'playing';
  players: PlayerInfo[];
  /** Level set label, e.g. "Arcade". */
  set: string;
  level: number;
  /** False when the game already has four players. */
  open: boolean;
}

export interface RoomInfo {
  id: string;
  name: string;
  state: 'waiting' | 'playing' | 'over';
  players: PlayerInfo[];
  /** The receiving client's hero. */
  you: HeroClass;
}

export interface LevelInfo {
  number: number;
  name: string;
  width: number;
  height: number;
  wrapX: boolean;
  wrapY: boolean;
  /** One digit per tile (see Tile in core/level.ts), row by row. */
  tiles: string;
}

/** [slot, controller, name, hero, x, y, fx, fy, health, score, keys, potions, alive, stunned, dizzy, amulet, amulet seconds, it] */
export type PlayerRow = [
  number, string, string, HeroClass, number, number, number, number, number, number, number, number, 0 | 1,
  0 | 1, 0 | 1, AmuletKind | '', number, 0 | 1,
];
/** [id, kind, rank, hp (-1 = immortal), x, y, fx, fy, invisible 0/1, stunned 0/1] */
export type MonsterRow = [number, MonsterKind, number, number, number, number, number, number, 0 | 1, 0 | 1];
/** [id, kind, hp, x, y] */
export type GeneratorRow = [number, MonsterKind, number, number, number];
/** [id, kind, owner, x, y, vx, vy, ttl] */
export type ShotRow = [number, Shot['kind'], number, number, number, number, number, number];
/** [tile index, kind] */
export type ItemRow = [number, ItemKind];

export interface Snapshot {
  t: 'state';
  state: GameState;
  /** Our own controller id, so the client knows which hero is "me". */
  you: string;
  /** Game time in seconds (force fields switch on and off with it). */
  time: number;
  players: PlayerRow[];
  monsters: MonsterRow[];
  generators: GeneratorRow[];
  shots: ShotRow[];
  /** Only sent when the set of items changed (or on a new level). */
  items?: ItemRow[];
  /** Tiles that changed since the last snapshot (doors opening): [index, tile]. */
  tiles?: [number, number][];
  events: GameEvent[];
}

export type ServerMessage =
  | { t: 'welcome'; id: string; name: string | null }
  | { t: 'lobby'; games: LobbyGame[]; sets: LevelSetSummary[]; defaultSet: LevelSetId }
  | { t: 'room'; room: RoomInfo | null }
  | { t: 'level'; level: LevelInfo }
  | Snapshot
  | { t: 'error'; message: string }
  | { t: 'levelList'; sets: LevelSetInfo[] }
  | { t: 'levelText'; set: LevelSetId; id: string; text: string }
  | { t: 'levelSaved'; id: string };

export function cleanName(name: unknown): string {
  return String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}
