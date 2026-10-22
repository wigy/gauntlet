import type { PlayerInput } from '../core/game';

/** The eight directions, clockwise from east (y grows downwards, so +1 turns right). */
const DIRS: readonly [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
/** Seconds before a held turn repeats, and between repeats. */
const REPEAT_DELAY = 0.35;
const REPEAT_EVERY = 0.2;

/**
 * Controls for the 3D view, relative to where the hero faces: left/right turn 45 degrees (repeating while held), up
 * walks forward, down turns round, and fire shoots straight ahead. Turns into ordinary game input, with fx/fy so the
 * hero turns on the spot even when it isn't walking.
 */
export class TankControls {
  /** Index into DIRS. */
  private heading = 2;
  private prevTurn = 0;
  private prevBack = false;
  private repeatAt = 0;

  /** Start from the hero's current facing. */
  reset(fx: number, fy: number): void {
    const i = DIRS.findIndex(([x, y]) => x === Math.sign(fx) && y === Math.sign(fy));
    this.heading = i < 0 ? 2 : i;
    this.prevTurn = 0;
    this.prevBack = false;
  }

  /** The direction we face, in radians (0 = east). */
  get angle(): number {
    return (this.heading * Math.PI) / 4;
  }

  translate(input: PlayerInput, now: number): PlayerInput {
    const turn = Math.sign(Math.round(input.dx * 1.4));
    if (turn && (turn !== this.prevTurn || now >= this.repeatAt)) {
      this.heading = (this.heading + turn + 8) % 8;
      this.repeatAt = now + (turn !== this.prevTurn ? REPEAT_DELAY : REPEAT_EVERY);
    }
    this.prevTurn = turn;
    const back = Math.round(input.dy * 1.4) > 0;
    if (back && !this.prevBack) this.heading = (this.heading + 4) % 8;
    this.prevBack = back;

    const [hx, hy] = DIRS[this.heading];
    const forward = Math.round(input.dy * 1.4) < 0;
    return { dx: forward ? hx : 0, dy: forward ? hy : 0, fire: input.fire, magic: input.magic, fx: hx, fy: hy };
  }
}
