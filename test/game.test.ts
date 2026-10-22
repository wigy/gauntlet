import { describe, expect, it } from 'vitest';
import { Game, TICK } from '../src/core/game';
import type { PlayerInput } from '../src/core/game';
import { FOOD_HEALTH, JOIN_HEALTH, TURN_TIME } from '../src/core/defs';

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

const CORRIDOR = `name: Corridor
---
############
#S.F.....E.#
############
`;

describe('Game', () => {
  it('joins a player on FIRE and starts play', () => {
    const game = joined(CORRIDOR);
    expect(game.state).toBe('playing');
    const p = game.players[0]!;
    expect(p.hero).toBe('warrior');
    expect(p.alive).toBe(true);
    expect(p.x).toBeCloseTo(1.5);
  });

  it('drains health over time', () => {
    const game = joined(CORRIDOR);
    run(game, {}, Math.round(3 / TICK));
    expect(game.players[0]!.health).toBeLessThanOrEqual(JOIN_HEALTH - 3);
  });

  it('eats food and exits to the next level', () => {
    const game = joined(CORRIDOR);
    const before = game.players[0]!.health;
    run(game, { dx: 1 }, Math.round(1 / TICK));
    expect(game.players[0]!.health).toBeGreaterThan(before + FOOD_HEALTH - 5);
    run(game, { dx: 1 }, Math.round(3 / TICK));
    run(game, {}, Math.round(2 / TICK));
    expect(game.levelNumber).toBe(2);
  });

  it('stops at walls', () => {
    const game = joined(CORRIDOR);
    run(game, { dy: -1 }, 60);
    expect(game.players[0]!.y).toBeGreaterThanOrEqual(1.379);
  });

  it('shoots a ghost dead instead of moving while FIRE is held', () => {
    const game = joined(`---\n##########\n#S.....G.#\n##########\n`);
    const ghost = game.monsters[0];
    run(game, { dx: 1, fire: true }, 60);
    expect(game.players[0]!.x).toBeCloseTo(1.5);
    expect(ghost.dead).toBe(true);
    expect(game.players[0]!.score).toBeGreaterThan(0);
  });

  it('opens doors with a key', () => {
    const game = joined(`---\n########\n#SK.D.E#\n########\n`);
    run(game, { dx: 1 }, Math.round(2 / TICK));
    expect(game.players[0]!.keys).toBe(0);
    expect(game.level.tiles[1 * game.level.width + 4]).toBe(0);
  });

  it('turns to face a new direction before walking that way', () => {
    const game = joined(CORRIDOR);
    const p = game.players[0]!;
    const turnTicks = Math.round(TURN_TIME / TICK);
    run(game, { dx: 1 }, turnTicks);
    expect(p.fx).toBe(1);
    expect(p.fy).toBe(0);
    expect(p.x).toBeCloseTo(1.5);
    run(game, { dx: 1 }, 10);
    expect(p.x).toBeGreaterThan(1.6);
    // Same direction again after stopping: no turn.
    run(game, {}, 5);
    const x = p.x;
    run(game, { dx: 1 }, 1);
    expect(p.x).toBeGreaterThan(x);
    // A tap turns the hero without moving it.
    run(game, { dx: -1 }, 2);
    expect(p.fx).toBe(-1);
    expect(p.x).toBeGreaterThan(x);
  });

  it('turns monsters before they walk', () => {
    const game = joined(`---
##########
#S......G#
##########
`);
    const ghost = game.monsters[0];
    const x = ghost.x;
    run(game, {}, Math.round(TURN_TIME / TICK) - 1);
    expect(ghost.fx).toBe(-1);
    expect(ghost.x).toBe(x);
    run(game, {}, 10);
    expect(ghost.x).toBeLessThan(x);
  });

  it('wraps around the maze edge', () => {
    const game = joined(`wrap: x\n---\n#####\nS....\n#####\n`);
    run(game, { dx: -1 }, 30);
    expect(game.players[0]!.x).toBeGreaterThan(3);
  });
});
