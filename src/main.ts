import { Audio } from './audio/audio';
import { Game } from './core/game';
import type { GameEvent } from './core/game';
import { InputManager } from './input/input';
import { BUILTIN_LEVELS } from './levels/builtin';
import { Connection } from './net/connection';
import { Mirror } from './net/mirror';
import type { RoomInfo, ServerMessage } from './net/protocol';
import { Renderer } from './render/renderer';
import { Menu } from './ui/menu';

/** localStorage key for the player id the server gave us, so our name is remembered. */
const ID_KEY = 'gauntlet.playerId';
const CONTROLS = 'Arrow keys move · Z fire · X potion · gamepads work too · Esc for the menu';

function loadId(): string | null {
  try {
    return localStorage.getItem(ID_KEY);
  } catch {
    return null;
  }
}

function saveId(id: string): void {
  try {
    localStorage.setItem(ID_KEY, id);
  } catch {
    // Private mode etc.: we just won't be remembered.
  }
}

function main(): void {
  const params = new URLSearchParams(location.search);
  const startLevel = Number(params.get('level')) || undefined;

  const canvas = document.getElementById('screen') as HTMLCanvasElement;
  const input = new InputManager(window);
  const renderer = new Renderer(canvas);
  const audio = new Audio();
  const conn = new Connection();
  const mirror = new Mirror();
  // A level that is never simulated, drawn dimmed behind the lobby screens.
  const backdrop = new Game([...BUILTIN_LEVELS], 1, 1);

  let name: string | null = null;
  let room: RoomInfo | null = null;
  let paused = false;
  let lastSnapAt = 0;
  let snapGap = 1 / 30;
  let sentInput = '';

  const inGame = () => !!room && room.state !== 'waiting';

  const menu = new Menu(
    document.getElementById('ui')!,
    {
      setName: (n) => conn.send({ t: 'setName', name: n }),
      create: () => conn.send({ t: 'create', level: startLevel }),
      join: (id) => conn.send({ t: 'join', game: id }),
      start: () => conn.send({ t: 'start' }),
      pickHero: (hero) => conn.send({ t: 'pickHero', hero }),
      leave: () => conn.send({ t: 'leave' }),
      resume: () => {
        paused = false;
        updateScreens();
      },
    },
    CONTROLS,
  );

  const resize = () => {
    renderer.resize(mirror);
    backdrop.viewW = mirror.viewW;
    backdrop.viewH = mirror.viewH;
  };

  /** Show whichever screen fits the current state: lobby, waiting room, pause menu or the game itself. */
  function updateScreens(): void {
    const playing = inGame();
    if (renderer.menu === playing) {
      renderer.menu = !playing;
      resize();
    }
    input.enabled = playing && !paused;
    if (playing) {
      if (paused) menu.pause();
      else menu.hide();
    } else if (!name) {
      if (menu.current !== 'name') menu.askName(null);
    } else if (room) {
      menu.showRoom();
    } else {
      menu.lobby();
    }
  }

  function handleEvents(events: GameEvent[], now: number): void {
    for (const e of events) {
      if (e.type === 'sfx') audio.play(e.name);
      else if (e.type === 'flash') renderer.flash(now);
      else {
        renderer.showMessage(e.text, now);
        audio.say(e.text);
      }
    }
  }

  conn.onStatus = (status) => {
    if (status === 'open') {
      conn.send({ t: 'hello', id: loadId() });
      return;
    }
    // A new connection starts outside any game.
    room = null;
    paused = false;
    mirror.reset();
    renderer.menu = true;
    resize();
    input.enabled = false;
    menu.connecting(status === 'lost');
  };

  conn.onMessage = (msg: ServerMessage) => {
    const now = performance.now() / 1000;
    switch (msg.t) {
      case 'welcome':
        saveId(msg.id);
        name = msg.name;
        menu.setName(name);
        if (!name) menu.askName(null);
        else if (menu.current === 'name' || menu.current === 'connecting') updateScreens();
        break;
      case 'lobby':
        menu.setGames(msg.games);
        break;
      case 'room':
        room = msg.room;
        menu.setRoom(room);
        if (!room) {
          mirror.reset();
          paused = false;
        }
        updateScreens();
        break;
      case 'level':
        mirror.setLevel(msg.level);
        break;
      case 'state': {
        renderer.snapshot(mirror);
        mirror.apply(msg);
        renderer.me = mirror.you;
        if (lastSnapAt) snapGap = Math.min(0.2, Math.max(0.015, snapGap * 0.9 + (now - lastSnapAt) * 0.1));
        lastSnapAt = now;
        handleEvents(msg.events, now);
        break;
      }
      case 'error':
        menu.toast(msg.message);
        break;
    }
  };

  window.addEventListener('resize', resize);
  window.addEventListener('keydown', (e) => {
    audio.unlock();
    if (e.code === 'Escape' && inGame()) {
      paused = !paused;
      updateScreens();
    }
  });
  window.addEventListener('pointerdown', () => audio.unlock());
  window.addEventListener('gamepadconnected', () => audio.unlock());

  const frame = (nowMs: number) => {
    const now = nowMs / 1000;
    if (inGame()) {
      // Inputs go to the server only when they change.
      const i = paused ? { dx: 0, dy: 0, fire: false, magic: false } : input.combined();
      const key = `${i.dx},${i.dy},${+i.fire},${+i.magic}`;
      if (key !== sentInput) {
        sentInput = key;
        conn.send({ t: 'input', ...i });
      }
      renderer.draw(mirror, now, (now - lastSnapAt) / snapGap);
    } else {
      sentInput = '';
      // Drift slowly around the backdrop level.
      const s = backdrop.level.starts[0] ?? { x: 0, y: 0 };
      backdrop.camera = { x: s.x + 4 + Math.sin(now * 0.07) * 4, y: s.y + 3 + Math.cos(now * 0.05) * 3 };
      renderer.draw(backdrop, now);
    }
    requestAnimationFrame(frame);
  };

  renderer.menu = true;
  resize();
  menu.connecting(false);
  conn.connect();
  requestAnimationFrame(frame);
}

main();
