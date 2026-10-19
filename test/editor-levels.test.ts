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
  it('saves, reorders and deletes custom levels, and keeps them on disk', () => {
    const dir = tempDir();
    const lib = new LevelLibrary({ customDir: dir, builtin: [ROOM] });
    expect(lib.texts('custom')).toEqual([]);

    const a = lib.save(null, ROOM);
    const b = lib.save(null, ROOM.replace('name: Room', 'name: Second'));
    if ('error' in a || 'error' in b) throw new Error('save failed');
    expect(lib.sets().find((s) => s.id === 'custom')!.levels).toEqual([{ id: a.id, name: 'Room' }, { id: b.id, name: 'Second' }]);

    // Overwrite keeps the id; moving changes play order.
    lib.save(a.id, ROOM.replace('name: Room', 'name: First'));
    lib.move(b.id, -1);
    expect(lib.sets().find((s) => s.id === 'custom')!.levels.map((l) => l.name)).toEqual(['Second', 'First']);
    expect(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))).toEqual([b.id, a.id]);

    const reloaded = new LevelLibrary({ customDir: dir });
    expect(reloaded.texts('custom').map((t) => parseLevel(t).name)).toEqual(['Second', 'First']);

    reloaded.remove(b.id);
    expect(new LevelLibrary({ customDir: dir }).texts('custom')).toHaveLength(1);
  });

  it('rejects broken and oversized levels', () => {
    const lib = new LevelLibrary({ customDir: null });
    expect(lib.save(null, 'name: x\n---\n#?#\n')).toMatchObject({ error: expect.stringContaining('Not a valid level') });
    expect(lib.save(null, `name: big\n---\n${'#'.repeat(101)}\n`)).toMatchObject({ error: expect.stringContaining('at most') });
    expect(lib.texts('custom')).toHaveLength(0);
  });

  it('copies wall-only levels with their monsters and items filled in', () => {
    const lib = new LevelLibrary({ customDir: null, builtin: [WALLS_ONLY] });
    const level = parseLevel(lib.get('builtin', '0')!);
    expect(level.starts).toHaveLength(1);
    expect(level.items.length).toBeGreaterThan(0);
    // The same copy every time.
    expect(lib.get('builtin', '0')).toBe(lib.get('builtin', '0'));
  });
});

describe('Lobby with level sets', () => {
  it('play-tests a custom level straight away and reports the set in the lobby', () => {
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
    expect(lobbyMsg).toMatchObject({ sets: expect.arrayContaining([{ id: 'custom', label: 'Custom', count: 2 }]) });

    lobby.message(client, { t: 'create', set: 'custom', level: 2, start: true });
    expect(inbox.filter((m) => m.t === 'room').at(-1)).toMatchObject({ room: { state: 'playing' } });
    expect(lobby.lobbyGames()[0]).toMatchObject({ set: 'Custom', level: 2 });
    time += TICK;
    lobby.tick(time);
    lobby.tick((time += TICK));
    expect(inbox.filter((m) => m.t === 'level').at(-1)).toMatchObject({ level: { number: 2, name: 'Two', wrapX: true } });
  });
});
