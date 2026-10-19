import { describe, expect, it } from 'vitest';
import { Game, TICK } from '../src/core/game';
import type { ServerMessage, Snapshot } from '../src/net/protocol';
import { Lobby } from '../server/lobby';
import type { Client } from '../server/lobby';
import { PlayerStore } from '../server/store';

const LEVEL = `name: Hall
---
##############
#S..........E#
#............#
#.....F......#
##############
`;

function setup() {
  let time = 0;
  const store = new PlayerStore(null);
  const lobby = new Lobby([LEVEL, LEVEL], store, () => time);
  const join = (name: string | null, id: string | null = null) => {
    const inbox: ServerMessage[] = [];
    const client = lobby.connect({ send: (m) => inbox.push(m) });
    lobby.message(client, { t: 'hello', id });
    if (name) lobby.message(client, { t: 'setName', name });
    return { client, inbox, last: <T extends ServerMessage['t']>(t: T) => inbox.filter((m) => m.t === t).at(-1) as Extract<ServerMessage, { t: T }> | undefined };
  };
  const ticks = (n: number) => {
    for (let i = 0; i < n; i++) {
      time += TICK;
      lobby.tick(time);
    }
  };
  return { lobby, store, join, ticks };
}

const gameOf = (c: Client): Game => (c.room as unknown as { game: Game }).game;

describe('Game (online mode)', () => {
  it('adds players at the start, ignores FIRE joins and removes players', () => {
    const game = new Game([LEVEL], 1, 1, { online: true });
    game.addPlayer('a', 'Alice');
    game.start();
    game.step(new Map([['b', { dx: 0, dy: 0, fire: true, magic: false }]]));
    expect(game.players.filter(Boolean)).toHaveLength(1);
    expect(game.players[0]!.name).toBe('Alice');
    expect(game.players[0]!.x).toBeCloseTo(1.5);

    // Walk away, then someone joins mid-game: they appear at the level start, not next to Alice.
    for (let i = 0; i < 60; i++) game.step(new Map([['a', { dx: 1, dy: 0, fire: false, magic: false }]]));
    const bob = game.addPlayer('b', 'Bob')!;
    expect(bob.alive).toBe(true);
    expect(bob.x).toBeLessThan(3);
    expect(game.events.some((e) => e.type === 'say' && e.text === 'Bob joins')).toBe(true);

    game.removePlayer('a');
    expect(game.players[0]).toBeNull();
    expect(game.players[1]).toBe(bob);
  });
});

describe('Lobby', () => {
  it('asks for a name, then remembers it by player id', () => {
    const { join, lobby, store } = setup();
    const a = join(null);
    const welcome = a.last('welcome')!;
    expect(welcome.name).toBeNull();
    expect(a.last('lobby')).toBeUndefined();

    lobby.message(a.client, { t: 'setName', name: '  Alice   the   Bold  ' });
    expect(a.last('welcome')!.name).toBe('Alice the Bold');
    expect(a.last('lobby')).toBeDefined();
    expect(store.get(welcome.id)?.name).toBe('Alice the Bold');

    // Next visit with the same saved id: straight to the lobby.
    const again = join(null, welcome.id);
    expect(again.last('welcome')).toMatchObject({ id: welcome.id, name: 'Alice the Bold' });
    expect(again.last('lobby')).toBeDefined();

    // An unknown id gets a fresh one.
    expect(join(null, 'bogus').last('welcome')!.id).not.toBe('bogus');
  });

  it('rejects empty names', () => {
    const { join, lobby } = setup();
    const a = join(null);
    lobby.message(a.client, { t: 'setName', name: '   ' });
    expect(a.last('error')).toBeDefined();
    expect(a.client.name).toBeNull();
  });

  it('lists waiting games, lets others join and anyone start', () => {
    const { join, lobby, ticks } = setup();
    const a = join('Alice');
    const b = join('Bob');
    lobby.message(a.client, { t: 'create' });
    expect(a.last('room')!.room).toMatchObject({ state: 'waiting', players: [{ name: 'Alice', hero: 'warrior' }], you: 'warrior' });

    const listed = b.last('lobby')!.games;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ state: 'waiting', players: [{ name: 'Alice', hero: 'warrior' }], open: true });

    lobby.message(b.client, { t: 'join', game: listed[0].id });
    expect(a.last('room')!.room!.players.map((p) => p.name)).toEqual(['Alice', 'Bob']);

    lobby.message(b.client, { t: 'start' });
    expect(a.last('room')!.room!.state).toBe('playing');
    ticks(4);
    expect(a.last('level')!.level.number).toBe(1);
    const snap = a.last('state') as Snapshot;
    expect(snap.you).toBe(a.client.id);
    expect(snap.players.map((p) => p[2])).toEqual(['Alice', 'Bob']);
    // Items go out once, then only when they change.
    const withItems = a.inbox.filter((m): m is Snapshot => m.t === 'state' && !!m.items);
    expect(withItems).toHaveLength(1);
    expect(withItems[0].items).toEqual([[3 * 14 + 6, 'food']]);
  });

  it('lets players pick any free hero while waiting', () => {
    const { join, lobby } = setup();
    const a = join('Alice');
    const b = join('Bob');
    lobby.message(a.client, { t: 'create' });
    lobby.message(a.client, { t: 'pickHero', hero: 'elf' });
    expect(a.last('room')!.room!.you).toBe('elf');

    // Bob gets the first free hero, can't take Alice's, but can take another free one.
    lobby.message(b.client, { t: 'join', game: a.last('room')!.room!.id });
    expect(b.last('room')!.room!.you).toBe('warrior');
    lobby.message(b.client, { t: 'pickHero', hero: 'elf' });
    expect(b.last('error')).toBeDefined();
    expect(b.client.hero).toBe('warrior');
    lobby.message(b.client, { t: 'pickHero', hero: 'wizard' });
    expect(a.last('room')!.room!.players).toEqual([{ name: 'Alice', hero: 'elf' }, { name: 'Bob', hero: 'wizard' }]);
    expect(b.last('lobby')!.games[0].players[1].hero).toBe('wizard');

    lobby.message(a.client, { t: 'start' });
    const heroes = gameOf(a.client).players.filter(Boolean).map((p) => [p!.name, p!.hero]);
    expect(heroes).toEqual([['Alice', 'elf'], ['Bob', 'wizard']]);

    // No switching once the game is running.
    lobby.message(a.client, { t: 'pickHero', hero: 'warrior' });
    expect(gameOf(a.client).players[0]!.hero).toBe('elf');
  });

  it('lets a player jump into a running game at the start spot', () => {
    const { join, lobby, ticks } = setup();
    const a = join('Alice');
    lobby.message(a.client, { t: 'create' });
    lobby.message(a.client, { t: 'start' });
    lobby.message(a.client, { t: 'input', dx: 1, dy: 0, fire: false, magic: false });
    ticks(60);
    const alice = gameOf(a.client).players[0]!;
    expect(alice.x).toBeGreaterThan(3);

    const c = join('Carol');
    const game = c.last('lobby')!.games[0];
    expect(game).toMatchObject({ state: 'playing', level: 1, open: true });
    lobby.message(c.client, { t: 'join', game: game.id });
    const carol = gameOf(c.client).players[1]!;
    expect(carol.name).toBe('Carol');
    expect(carol.x).toBeLessThan(3); // start spot (slot 2 stands one tile to the right)
    ticks(2);
    expect(c.last('level')).toBeDefined();
    expect((c.last('state') as Snapshot).players).toHaveLength(2);
  });

  it('removes leavers and closes empty games', () => {
    const { join, lobby } = setup();
    const a = join('Alice');
    const b = join('Bob');
    lobby.message(a.client, { t: 'create' });
    const id = a.last('room')!.room!.id;
    lobby.message(b.client, { t: 'join', game: id });
    lobby.message(a.client, { t: 'start' });
    lobby.disconnect(a.client);
    expect(gameOf(b.client).players.filter(Boolean).map((p) => p!.name)).toEqual(['Bob']);
    lobby.message(b.client, { t: 'leave' });
    expect(b.last('room')!.room).toBeNull();
    expect(lobby.lobbyGames()).toHaveLength(0);
  });

  it('sends everyone back to the lobby a few seconds after game over', () => {
    const { join, lobby, ticks } = setup();
    const a = join('Alice');
    lobby.message(a.client, { t: 'create' });
    lobby.message(a.client, { t: 'start' });
    gameOf(a.client).players[0]!.health = 1;
    ticks(90);
    expect(a.last('room')!.room!.state).toBe('playing');
    expect(lobby.lobbyGames()).toHaveLength(0);
    ticks(Math.round(6 / TICK));
    expect(a.last('room')!.room).toBeNull();
    expect(a.client.room).toBeNull();
  });
});
