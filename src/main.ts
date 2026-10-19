import { Audio } from './audio/audio';
import { Game, TICK } from './core/game';
import { InputManager } from './input/input';
import { BUILTIN_LEVELS } from './levels/builtin';
import { Renderer } from './render/renderer';

/** Level sets served from public/levels/<set>/index.json (a JSON array of level file names, in play order). */
async function loadLevelSet(set: string): Promise<string[] | null> {
  try {
    const res = await fetch(`levels/${set}/index.json`);
    if (!res.ok) return null;
    const files = (await res.json()) as string[];
    return await Promise.all(files.map(async (f) => (await fetch(`levels/${set}/${f}`)).text()));
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const wanted = params.get('levels') ?? 'gauntlet1';
  const seed = Number(params.get('seed') ?? Date.now() % 100000);
  const levels = (wanted !== 'builtin' && (await loadLevelSet(wanted))) || [...BUILTIN_LEVELS];
  const start = Math.max(1, Number(params.get('level') ?? 1));

  const canvas = document.getElementById('screen') as HTMLCanvasElement;
  const input = new InputManager(window);
  const game = new Game(levels, seed, start);
  const renderer = new Renderer(canvas, input.hints);
  const audio = new Audio();

  renderer.resize(game);
  window.addEventListener('resize', () => renderer.resize(game));
  window.addEventListener('keydown', () => audio.unlock());
  window.addEventListener('pointerdown', () => audio.unlock());
  window.addEventListener('gamepadconnected', () => audio.unlock());

  let acc = 0;
  let last = performance.now();
  const frame = (nowMs: number) => {
    acc = Math.min(acc + (nowMs - last) / 1000, 0.25);
    last = nowMs;
    while (acc >= TICK) {
      game.step(input.poll());
      acc -= TICK;
    }
    const now = nowMs / 1000;
    for (const e of game.events) {
      if (e.type === 'sfx') audio.play(e.name);
      else if (e.type === 'flash') renderer.flash(now);
      else {
        renderer.showMessage(e.text, now);
        audio.say(e.text);
      }
    }
    game.events.length = 0;
    renderer.draw(game, now);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void main();
