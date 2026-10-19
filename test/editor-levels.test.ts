import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TICK } from '../src/core/game';
import { levelToText, parseLevel } from '../src/core/level';
import type { ServerMessage } from '../src/net/protocol';
import { LevelLibrary } from '../server/levels';
import { Lobby } from '../server/lobby';
import { PlayerStore } from '../server/store';

const ROOM = `name: Room
wrap: x
rank: 2
---
########
#S.F.g.#
#..GD.E#
########
`;
const WALLS_ONLY = `name: Bare
---
############
#..........#
#..........#
#..........#
#..........#
#.........E#
############
`;

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'gauntlet-levels-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('levelToText', () => {
  it('round-trips a level', () => {
    expect(levelToText(parseLevel(ROOM))).toBe(ROOM);
  });
});

describe('LevelLibrary', () => {
  it('saves, reorders and deletes a player\'s levels, and keeps them on disk', () => {
    const dir = tempDir();
    const lib = new LevelLibrary({ customDir: dir, builtin: [ROOM] });
    expect(lib.texts('custom', ALICE)).toEqual([]);

    const a = lib.save(ALICE, null, ROOM);
    const b = lib.save(ALICE, null, ROOM.replace('name: Room', 'name: Second'));
    if ('error' in a || 'error' in b) throw new Error('save failed');
    expect(lib.sets(ALICE).find((s) => s.id === 'custom')!.levels).toEqual([{ id: a.id, name: 'Room' }, { id: b.id, name: 'Second' }]);

    // Overwrite keeps the id; moving changes play order.
    lib.save(ALICE, a.id, ROOM.replace('name: Room', 'name: First'));
    lib.move(ALICE, b.id, -1);
    expect(lib.sets(ALICE).find((s) => s.id === 'custom')!.levels.map((l) => l.name)).toEqual(['Second', 'First']);
    expect(JSON.parse(readFileSync(join(dir, ALICE, 'index.json'), 'utf8'))).toEqual([b.id, a.id]);

    const reloaded = new LevelLibrary({ customDir: dir });
    expect(reloaded.texts('custom', ALICE).map((t) => parseLevel(t).name)).toEqual(['Second', 'First']);

    reloaded.remove(ALICE, b.id);
    expect(new LevelLibrary({ customDir: dir }).texts('custom', ALICE)).toHaveLength(1);
  });

  it('keeps each player\'s levels to themselves', () => {
    const dir = tempDir();
    const lib = new LevelLibrary({ customDir: dir });
    const a = lib.save(ALICE, null, ROOM);
    if ('error' in a) throw new Error('save failed');
    expect(lib.texts('custom', BOB)).toEqual([]);
    expect(lib.get('custom', a.id, BOB)).toBeNull();
    // Bob can't overwrite, move or delete Alice's level by id: a save with her id makes a new level of his own.
    const b = lib.save(BOB, a.id, ROOM.replace('name: Room', 'name: Bob'));
    lib.remove(BOB, a.id);
    expect(lib.texts('custom', ALICE).map((t) => parseLevel(t).name)).toEqual(['Room']);
    expect(lib.sets(BOB).find((s) => s.id === 'custom')!.levels).toEqual([{ id: (b as { id: string }).id, name: 'Bob' }]);
    // Owners that aren't player ids never reach the file system.
    expect(lib.save('../evil', null, ROOM)).toMatchObject({ error: expect.any(String) });
    expect(lib.texts('custom', '../evil')).toEqual([]);
  });

  it('rejects broken and oversized levels', () => {
    const lib = new LevelLibrary({ customDir: null });
    expect(lib.save(ALICE, null, 'name: x\n---\n#?#\n')).toMatchObject({ error: expect.stringContaining('Not a valid level') });
    expect(lib.save(ALICE, null, `name: big\n---\n${'#'.repeat(101)}\n`)).toMatchObject({ error: expect.stringContaining('at most') });
    expect(lib.texts('custom', ALICE)).toHaveLength(0);
  });

  it('copies wall-only levels with their monsters and items filled in', () => {
    const lib = new LevelLibrary({ customDir: null, builtin: [WALLS_ONLY] });
    const level = parseLevel(lib.get('builtin', '0', null)!);
    expect(level.starts).toHaveLength(1);
    expect(level.items.length).toBeGreaterThan(0);
    // The same copy every time.
    expect(lib.get('builtin', '0', null)).toBe(lib.get('builtin', '0', ALICE));
  });
});

describe('Lobby with level sets', () => {
  it('play-tests your own level straight away; others see it as your levels', () => {
    let time = 0;
    const levels = new LevelLibrary({ customDir: null, builtin: [WALLS_ONLY] });
    const lobby = new Lobby(levels, new PlayerStore(null), () => time);
    const inbox: ServerMessage[] = [];
    const client = lobby.connect({ send: (m) => inbox.push(m) });
    lobby.message(client, { t: 'hello', id: null });
    lobby.message(client, { t: 'setName', name: 'Ed' });

    // No custom levels yet.
    lobby.message(client, { t: 'create', set: 'custom' });
    expect(inbox.at(-1)).toMatchObject({ t: 'error' });

    lobby.message(client, { t: 'levelSave', id: null, text: ROOM });
    lobby.message(client, { t: 'levelSave', id: null, text: ROOM.replace('name: Room', 'name: Two') });
    expect(inbox.some((m) => m.t === 'levelSaved')).toBe(true);
    const lobbyMsg = inbox.filter((m) => m.t === 'lobby').at(-1)!;
    expect(lobbyMsg).toMatchObject({ sets: expect.arrayContaining([{ id: 'custom', label: 'My levels', count: 2 }]) });

    // Another player has no levels of their own...
    const other: ServerMessage[] = [];
    const bob = lobby.connect({ send: (m) => other.push(m) });
    lobby.message(bob, { t: 'hello', id: null });
    lobby.message(bob, { t: 'setName', name: 'Bob' });
    expect(other.filter((m) => m.t === 'lobby').at(-1)).toMatchObject({ sets: expect.arrayContaining([{ id: 'custom', label: 'My levels', count: 0 }]) });

    lobby.message(client, { t: 'create', set: 'custom', level: 2, start: true });
    expect(inbox.filter((m) => m.t === 'room').at(-1)).toMatchObject({ room: { state: 'playing' } });
    expect(lobby.lobbyGames()[0]).toMatchObject({ set: "Ed's levels", level: 2 });
    // ...but can join Ed's game and play Ed's levels.
    lobby.message(bob, { t: 'join', game: lobby.lobbyGames()[0].id });
    expect(other.filter((m) => m.t === 'room').at(-1)).toMatchObject({ room: { state: 'playing' } });
    time += TICK;
    lobby.tick(time);
    lobby.tick((time += TICK));
    expect(inbox.filter((m) => m.t === 'level').at(-1)).toMatchObject({ level: { number: 2, name: 'Two', wrapX: true } });
  });
});
