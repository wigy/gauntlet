import { describe, expect, it } from 'vitest';
import { Tile, bfsDistances, isEmptyLevel, parseLevel, populate } from '../src/core/level';
import { BUILTIN_LEVELS } from '../src/levels/builtin';

const OPEN_MAP = `name: Open
---
##########
#........#
#..####..#
#..#..#..#
#........#
#.......E#
##########
`;

describe('parseLevel', () => {
  it('reads header, tiles and entities', () => {
    const lvl = parseLevel(`name: T\nwrap: x\nrank: 2\n---\n#####\n#SFg#\n#GDE#\n#####\n`);
    expect(lvl.name).toBe('T');
    expect(lvl.wrapX).toBe(true);
    expect(lvl.wrapY).toBe(false);
    expect([lvl.width, lvl.height]).toEqual([5, 4]);
    expect(lvl.starts).toEqual([{ x: 1, y: 1 }]);
    expect(lvl.items).toEqual([{ kind: 'food', x: 2, y: 1 }]);
    expect(lvl.generators).toEqual([{ kind: 'ghost', rank: 2, x: 3, y: 1 }]);
    expect(lvl.monsters).toEqual([{ kind: 'ghost', rank: 2, x: 1, y: 2 }]);
    expect(lvl.tiles[2 * 5 + 2]).toBe(Tile.Door);
    expect(lvl.tiles[2 * 5 + 3]).toBe(Tile.Exit);
  });

  it('rejects unknown characters', () => {
    expect(() => parseLevel('#?#')).toThrow(/unknown level char/);
  });
});

describe('built-in levels', () => {
  BUILTIN_LEVELS.forEach((text, i) => {
    it(`level ${i + 1} is rectangular and its exit is reachable from the start`, () => {
      const rows = text.split('---\n')[1].split('\n').filter(Boolean);
      expect(new Set(rows.map((r) => r.length)).size).toBe(1);
      const lvl = parseLevel(text);
      expect(lvl.starts.length).toBeGreaterThan(0);
      const dist = bfsDistances(lvl, lvl.starts);
      const exits = [...lvl.tiles.keys()].filter((k) => lvl.tiles[k] === Tile.Exit);
      expect(exits.length).toBeGreaterThan(0);
      expect(exits.some((k) => dist[k] >= 0)).toBe(true);
    });
  });
});

describe('populate', () => {
  it('fills an empty map deterministically with a reachable start', () => {
    const a = parseLevel(OPEN_MAP);
    const b = parseLevel(OPEN_MAP);
    expect(isEmptyLevel(a)).toBe(true);
    populate(a, 42, 5);
    populate(b, 42, 5);
    expect(a).toEqual(b);
    expect(a.starts).toHaveLength(1);
    const s = a.starts[0];
    expect(a.tiles[s.y * a.width + s.x]).toBe(Tile.Floor);
    expect(bfsDistances(a, a.starts)[5 * a.width + 8]).toBeGreaterThan(0);
  });
});
