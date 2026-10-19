import { Tile } from '../core/level';

/** A light the game renderer adds for a glowing tile (in tile units relative to its size). */
export interface TileGlow {
  color: string;
  /** Light radius in tiles. */
  r: number;
  /** Strength of the additive glow, 0 to 1. */
  a: number;
}

export interface TileLook {
  now: number;
  /** Force fields are on (the game switches them all together). */
  fieldOn: boolean;
  /** A stable per-tile number, so tiles don't all animate in step. */
  seed: number;
  /** Editor: show hidden things (stun tiles) plainly. */
  reveal?: boolean;
  /** A force field runs left-right (otherwise up-down). */
  horizontal?: boolean;
}

/**
 * Draws what sits on top of a Gauntlet II tile: the floor (or wall) underneath is already drawn. Returns the glow the
 * game should add for it, if any. Shared by the game renderer and the level editor.
 */
export function drawTileOverlay(ctx: CanvasRenderingContext2D, t: Tile, px: number, py: number, s: number, look: TileLook): TileGlow | null {
  const cx = px + s / 2;
  const cy = py + s / 2;
  const { now, seed } = look;
  switch (t) {
    case Tile.Trap: {
      const pulse = 0.55 + 0.45 * Math.sin(now * 3 + seed);
      ctx.strokeStyle = `rgba(255,200,80,${0.35 + 0.4 * pulse})`;
      ctx.lineWidth = Math.max(1, s * 0.05);
      ctx.beginPath();
      ctx.moveTo(cx, py + s * 0.18);
      ctx.lineTo(px + s * 0.82, cy);
      ctx.lineTo(cx, py + s * 0.82);
      ctx.lineTo(px + s * 0.18, cy);
      ctx.closePath();
      ctx.moveTo(cx, py + s * 0.32);
      ctx.lineTo(cx, py + s * 0.68);
      ctx.moveTo(px + s * 0.32, cy);
      ctx.lineTo(px + s * 0.68, cy);
      ctx.stroke();
      return { color: '#ffb040', r: 1.2, a: 0.12 * pulse };
    }
    case Tile.TrapWall: {
      // Looks almost like any wall; a faint shimmer gives it away to those who look.
      const k = 0.06 + 0.06 * Math.sin(now * 2 + seed);
      ctx.fillStyle = `rgba(200,150,255,${k})`;
      ctx.fillRect(px, py, s, s);
      return null;
    }
    case Tile.Breakable: {
      ctx.fillStyle = 'rgba(255,230,190,0.12)';
      ctx.fillRect(px, py, s, s);
      ctx.strokeStyle = 'rgba(20,10,5,0.7)';
      ctx.lineWidth = Math.max(1, s * 0.045);
      ctx.beginPath();
      ctx.moveTo(px + s * 0.2, py + s * 0.1);
      ctx.lineTo(px + s * 0.42, py + s * 0.45);
      ctx.lineTo(px + s * 0.3, py + s * 0.85);
      ctx.moveTo(px + s * 0.42, py + s * 0.45);
      ctx.lineTo(px + s * 0.78, py + s * 0.38);
      ctx.lineTo(px + s * 0.9, py + s * 0.7);
      ctx.moveTo(px + s * 0.62, py + s * 0.4);
      ctx.lineTo(px + s * 0.66, py + s * 0.12);
      ctx.stroke();
      return null;
    }
    case Tile.Stun: {
      if (look.reveal) {
        ctx.strokeStyle = 'rgba(150,200,255,0.75)';
        ctx.lineWidth = Math.max(1, s * 0.05);
        ctx.beginPath();
        for (let k = 0; k < 3; k++) ctx.arc(cx, cy, s * (0.12 + k * 0.12), k, k + Math.PI * 1.3);
        ctx.stroke();
        return null;
      }
      // Hidden, except for a twinkle now and then.
      const phase = (now * 0.7 + seed * 0.37) % 3;
      if (phase > 0.35) return null;
      const k = Math.sin((phase / 0.35) * Math.PI);
      const r = s * 0.3 * k;
      const sx = px + s * (0.3 + ((seed * 7) % 5) * 0.1);
      const sy = py + s * (0.3 + ((seed * 3) % 5) * 0.1);
      ctx.strokeStyle = `rgba(220,240,255,${k})`;
      ctx.lineWidth = Math.max(1, s * 0.04);
      ctx.beginPath();
      ctx.moveTo(sx - r, sy);
      ctx.lineTo(sx + r, sy);
      ctx.moveTo(sx, sy - r);
      ctx.lineTo(sx, sy + r);
      ctx.stroke();
      return { color: '#c0e0ff', r: 0.8, a: 0.25 * k };
    }
    case Tile.Transporter: {
      const r = s * 0.42;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, '#ffe0d0');
      g.addColorStop(0.35, '#ff4020');
      g.addColorStop(0.8, '#800808');
      g.addColorStop(1, 'rgba(120,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,200,170,0.8)';
      ctx.lineWidth = Math.max(1, s * 0.05);
      const a = now * 2.5 + seed;
      for (let k = 0; k < 3; k++) {
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.7, a + (k * Math.PI * 2) / 3, a + (k * Math.PI * 2) / 3 + 1.1);
        ctx.stroke();
      }
      return { color: '#ff5030', r: 2, a: 0.35 };
    }
    case Tile.ForceField: {
      const horiz = look.horizontal ?? true;
      if (!look.fieldOn) {
        ctx.fillStyle = 'rgba(120,180,255,0.25)';
        for (let k = 0; k < 4; k++) {
          const d = s * (0.125 + k * 0.25);
          if (horiz) ctx.fillRect(px + d - 1, cy - 1, 2, 2);
          else ctx.fillRect(cx - 1, py + d - 1, 2, 2);
        }
        return null;
      }
      ctx.lineWidth = Math.max(1, s * 0.05);
      for (let line = 0; line < 2; line++) {
        ctx.strokeStyle = line ? 'rgba(255,255,255,0.9)' : 'rgba(110,170,255,0.85)';
        ctx.beginPath();
        for (let k = 0; k <= 6; k++) {
          const along = (k / 6) * s;
          const jitter = Math.sin(now * 40 + k * 2.3 + seed + line * 5) * s * (line ? 0.08 : 0.18);
          const x = horiz ? px + along : cx + jitter;
          const y = horiz ? cy + jitter : py + along;
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      return { color: '#70a8ff', r: 1.6, a: 0.5 };
    }
    default:
      return null;
  }
}
