import type { PlayerInput } from '../core/game';

interface KeyScheme {
  id: string;
  label: string;
  up: string;
  down: string;
  left: string;
  right: string;
  fire: string;
  magic: string;
  hint: string;
}

// KeyboardEvent.code values, so the layout (QWERTY/AZERTY/...) doesn't matter.
const KEY_SCHEMES: KeyScheme[] = [
  { id: 'kb1', label: 'Keyboard 1', up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', fire: 'KeyF', magic: 'KeyG', hint: 'WASD move, F fire, G potion' },
  { id: 'kb2', label: 'Keyboard 2', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', fire: 'Slash', magic: 'Period', hint: 'Arrows move, / fire, . potion' },
];

const DEADZONE = 0.35;

/**
 * Turns keyboard and gamepads into one PlayerInput per controller id ("kb1", "kb2", "pad0".."pad3").
 * Every known controller is reported each poll, so the game can see FIRE presses from controllers that haven't joined yet.
 */
export class InputManager {
  private down = new Set<string>();

  constructor(target: Window) {
    target.addEventListener('keydown', (e) => {
      if (KEY_SCHEMES.some((s) => [s.up, s.down, s.left, s.right, s.fire, s.magic].includes(e.code))) e.preventDefault();
      this.down.add(e.code);
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    target.addEventListener('blur', () => this.down.clear());
  }

  get hints(): { label: string; join: string }[] {
    return [...KEY_SCHEMES.map((s) => ({ label: s.label, join: s.hint })), { label: 'Gamepads', join: 'stick/d-pad move, A fire, B potion' }];
  }

  poll(): Map<string, PlayerInput> {
    const out = new Map<string, PlayerInput>();
    const k = (code: string) => this.down.has(code);
    for (const s of KEY_SCHEMES) {
      out.set(s.id, {
        dx: (k(s.right) ? 1 : 0) - (k(s.left) ? 1 : 0),
        dy: (k(s.down) ? 1 : 0) - (k(s.up) ? 1 : 0),
        fire: k(s.fire),
        magic: k(s.magic),
      });
    }
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || pad.index > 3) continue;
      const b = (i: number) => !!pad.buttons[i]?.pressed;
      let dx = Math.abs(pad.axes[0] ?? 0) > DEADZONE ? Math.sign(pad.axes[0]) : 0;
      let dy = Math.abs(pad.axes[1] ?? 0) > DEADZONE ? Math.sign(pad.axes[1]) : 0;
      // Standard mapping d-pad: 12 up, 13 down, 14 left, 15 right.
      if (b(14)) dx = -1;
      if (b(15)) dx = 1;
      if (b(12)) dy = -1;
      if (b(13)) dy = 1;
      out.set(`pad${pad.index}`, { dx, dy, fire: b(0), magic: b(1) || b(2) });
    }
    return out;
  }
}
