import { describe, expect, it } from 'vitest';
import { Game, TICK, forceFieldOn } from '../src/core/game';
import type { PlayerInput } from '../src/core/game';
import { BREAKABLE_HITS, FORCE_FIELD_PERIOD, JOIN_HEALTH, STUN_TIME, WALLS_TO_EXITS_TIME } from '../src/core/defs';
import { Tile, bfsDistances, levelToText, parseLevel, populate } from '../src/core/level';

const idle: PlayerInput = { dx: 0, dy: 0, fire: false, magic: false };

function run(game: Game, input: Partial<PlayerInput>, ticks: number, controller = 'kb1'): void {
  for (let i = 0; i < ticks; i++) game.step(new Map([[controller, { ...idle, ...input }]]));
}

function joined(level: string): Game {
  const game = new Game([level, level]);
  run(game, { fire: true }, 1);
  run(game, {}, 1);
  return game;
}

const tileAt = (game: Game, x: number, y: number) => game.level.tiles[y * game.level.width + x];

describe('Gauntlet II levels', () => {
  it('reads and writes the new tiles and headers', () => {
    const text = `name: T\nwrap: none\nrank: 2\nstyle: g2\nthief: yes\n---\n#########\n#S^%*~@=#\n#ABIUZHYu\n#########\n`;
    const lvl = parseLevel(text);
    expect(lvl.style).toBe('g2');
    expect(lvl.thief).toBe(true);
    expect([...lvl.tiles.slice(11, 17)]).toEqual([Tile.Trap, Tile.TrapWall, Tile.Breakable, Tile.Stun, Tile.Transporter, Tile.ForceField]);
    expect(lvl.items.map((i) => i.kind)).toEqual(['amulet', 'poison', 'it']);
    expect(lvl.monsters.map((m) => m.kind)).toEqual(['supersorcerer', 'dragon', 'thief', 'acid']);
    expect(levelToText(lvl)).toBe(text);
  });

  it('counts transporters, trap walls and breakable walls as ways through', () => {
    const lvl = parseLevel(`---\n#######\n#S@#@E#\n#######\n#%#*#.#\n`);
    const dist = bfsDistances(lvl, lvl.starts);
    expect(dist[1 * 7 + 5]).toBeGreaterThan(0);
    expect(bfsDistances(lvl, lvl.starts, false)[1 * 7 + 5]).toBeGreaterThan(0);
  });

  it('populates Gauntlet II levels deterministically, with its extras', () => {
    const map = `style: g2\n---\n${'#'.repeat(30)}\n${Array.from({ length: 20 }, () => `#${'.'.repeat(28)}#`).join('\n')}\n#${'.'.repeat(27)}E#\n${'#'.repeat(30)}\n`;
    const a = parseLevel(map);
    const b = parseLevel(map);
    populate(a, 3, 12);
    populate(b, 3, 12);
    expect(a).toEqual(b);
    // Over many seeds, the Gauntlet II extras turn up.
    const kinds = new Set<string>();
    for (let seed = 1; seed < 40; seed++) {
      const l = parseLevel(map);
      populate(l, seed, 12);
      for (const m of l.monsters) kinds.add(m.kind);
      for (const i of l.items) kinds.add(i.kind);
    }
    for (const k of ['acid', 'dragon', 'amulet', 'poison', 'it']) expect(kinds).toContain(k);
  });
});

describe('Gauntlet II tiles', () => {
  it('springs traps: every trap wall goes', () => {
    const game = joined(`---\n#######\n#S^..E#\n#%#%###\n`);
    run(game, { dx: 1 }, 20);
    expect(tileAt(game, 2, 1)).toBe(Tile.Floor);
    expect(tileAt(game, 1, 2)).toBe(Tile.Floor);
    expect(tileAt(game, 3, 2)).toBe(Tile.Floor);
  });

  it('breaks breakable walls after enough shots', () => {
    const game = joined(`---\n#######\n#S.*.E#\n#######\n`);
    run(game, { dx: 1, fire: true }, Math.round(BREAKABLE_HITS * 0.3 / TICK) + 30);
    expect(tileAt(game, 3, 1)).toBe(Tile.Floor);
  });

  it('stuns heroes on stun tiles', () => {
    const game = joined(`---\n#########\n#S~.....#\n#######E#\n`);
    run(game, { dx: 1 }, 20);
    const p = game.players[0]!;
    expect(p.stun).toBeGreaterThan(0);
    const x = p.x;
    run(game, { dx: 1 }, Math.round(STUN_TIME / 2 / TICK));
    expect(p.x).toBe(x);
    run(game, { dx: 1 }, Math.round(STUN_TIME / TICK) + 30);
    expect(p.x).toBeGreaterThan(x + 0.5);
  });

  it('transports heroes to the nearest other transporter', () => {
    const game = joined(`---\n##############\n#S@####@#.@..E#\n##############\n`);
    run(game, { dx: 1 }, 20);
    const p = game.players[0]!;
    expect(Math.floor(p.x)).toBe(7);
    // Standing on the arrival transporter doesn't send you straight back.
    run(game, {}, 30);
    expect(Math.floor(p.x)).toBe(7);
  });

  it('burns heroes in a force field only while it is on', () => {
    const game = joined(`---\n#####\n#S=E#\n#####\n`);
    const p = game.players[0]!;
    // Turn, step into the field and stand there for a whole on/off cycle.
    run(game, { dx: 1 }, 22);
    const x = p.x;
    expect(Math.floor(x)).toBe(2);
    let onHurt = 0;
    let offHurt = 0;
    for (let i = 0; i < Math.round(FORCE_FIELD_PERIOD / TICK); i++) {
      const before = p.health;
      const on = forceFieldOn(game.time + TICK);
      run(game, {}, 1);
      if (on) onHurt += before - p.health;
      else offHurt += before - p.health;
    }
    expect(onHurt).toBeGreaterThan(offHurt + 20);
  });
});

describe('Gauntlet II items and monsters', () => {
  it('gives an amulet for a while', () => {
    const game = joined(`---\n######\n#SA.E#\n######\n`);
    run(game, { dx: 1 }, 15);
    const p = game.players[0]!;
    expect(p.amulet).not.toBeNull();
  });

  it('poison hurts and reverses the controls', () => {
    const game = joined(`---\n#########\n#.SB....#\n#######E#\n`);
    run(game, { dx: 1 }, 12);
    const p = game.players[0]!;
    expect(p.dizzy).toBeGreaterThan(0);
    expect(p.health).toBeLessThan(JOIN_HEALTH - 40);
    const x = p.x;
    run(game, { dx: 1 }, 20);
    expect(p.x).toBeLessThan(x);
  });

  it('lets a thief steal a potion and drop it when shot', () => {
    const game = joined(`---\n##########\n#SP...H..#\n#######E##\n`);
    const p = game.players[0]!;
    run(game, { dx: 1 }, 10);
    expect(p.potions).toBe(1);
    run(game, {}, 60);
    expect(p.potions).toBe(0);
    const thief = game.monsters.find((m) => m.kind === 'thief')!;
    expect(thief.loot).toBe('potion');
    // Stop shooting once it's down, or the next arrow destroys the potion it drops.
    for (let i = 0; i < 120 && !thief.dead; i++) run(game, { dx: 1, fire: true }, 1);
    expect(thief.dead).toBe(true);
    expect([...game.items.values()].some((i) => i.kind === 'potion')).toBe(true);
  });

  it('makes the hero holding the It ball the target, and passes it on by touch', () => {
    const game = new Game([`---\n##########\n#S.I.....#\n#.......E#\n##########\n`], 1, 1, { online: true });
    game.addPlayer('a', 'A');
    game.addPlayer('b', 'B');
    game.start();
    const [a, b] = game.players;
    const step = (ia: Partial<PlayerInput>, ib: Partial<PlayerInput>, n: number) => {
      for (let i = 0; i < n; i++) game.step(new Map([['a', { ...idle, ...ia }], ['b', { ...idle, ...ib }]]));
    };
    step({ dx: 1 }, {}, 40);
    expect(a!.it).toBe(true);
    // B walks into A after the pass-on grace.
    step({}, {}, 90);
    step({}, { dx: 1 }, 60);
    expect(b!.it).toBe(true);
    expect(a!.it).toBe(false);
  });

  it('dragons take many shots', () => {
    const game = joined(`---\n############\n#S....Z....#\n#.........E#\n############\n`);
    const dragon = game.monsters[0];
    expect(dragon.kind).toBe('dragon');
    run(game, { dx: 1, fire: true }, 60);
    expect(dragon.dead).toBe(false);
    expect(dragon.hp).toBeLessThan(60);
  });
});

describe('stalling', () => {
  it('turns every wall into an exit after a while', () => {
    const game = joined(`---\n#####\n#S..#\n#####\n`);
    run(game, {}, Math.round(WALLS_TO_EXITS_TIME / TICK) + 5);
    expect(game.level.tiles.includes(Tile.Wall)).toBe(false);
    expect(tileAt(game, 0, 0)).toBe(Tile.Exit);
  });
});
