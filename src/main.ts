import { Audio } from './audio/audio';
import { Game } from './core/game';
import type { GameEvent, Player, PlayerInput } from './core/game';
import { InputManager } from './input/input';
import { TankControls } from './input/tank';
import { Editor } from './editor/editor';
import { BUILTIN_LEVELS } from './levels/builtin';
import { Connection } from './net/connection';
import { Mirror } from './net/mirror';
import type { RoomInfo, ServerMessage } from './net/protocol';
import { Renderer } from './render/renderer';
import { Menu } from './ui/menu';

/** localStorage key for the player id the server gave us, so our name is remembered. */
const ID_KEY = 'gauntlet.playerId';
/** localStorage key: '3d' while playing in the first-person view. */
const VIEW_KEY = 'gauntlet.view';
const CONTROLS = 'Arrow keys move · Z fire · X potion · V 3D view · gamepads work too · Esc for the menu';

function loadSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode etc.: we just won't be remembered.
  }
}

function main(): void {
  const params = new URLSearchParams(location.search);
  const startLevel = Number(params.get('level')) || 0;

  const canvas = document.getElementById('screen') as HTMLCanvasElement;
  const input = new InputManager(window);
  const renderer = new Renderer(canvas);
  renderer.view3d = loadSetting(VIEW_KEY) === '3d';
  const tank = new TankControls();
  let tankFor: Player | null = null;
  const audio = new Audio();
  const conn = new Connection();
  const mirror = new Mirror();
  // A level that is never simulated, drawn dimmed behind the lobby screens.
  const backdrop = new Game([...BUILTIN_LEVELS], 1, 1);

  let name: string | null = null;
  let room: RoomInfo | null = null;
  let paused = false;
  /** In the level editor (it's shown whenever we're not in a game, e.g. it comes back after a play test). */
  let editing = false;
  let lastSnapAt = 0;
  let snapGap = 1 / 30;
  let sentInput = '';

  const inGame = () => !!room && room.state !== 'waiting';

  const menu = new Menu(
    document.getElementById('ui')!,
    {
      setName: (n) => conn.send({ t: 'setName', name: n }),
      create: (set, level) => conn.send({ t: 'create', set, level }),
      openEditor: () => {
        editing = true;
        updateScreens();
      },
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
  // ?level=N preselects the start level (for testing).
  if (startLevel) menu.level = startLevel;

  const editor = new Editor(document.getElementById('editor')!, {
    list: () => conn.send({ t: 'levelList' }),
    load: (set, id) => conn.send({ t: 'levelGet', set, id }),
    save: (id, text) => conn.send({ t: 'levelSave', id, text }),
    remove: (id) => conn.send({ t: 'levelDelete', id }),
    move: (id, delta) => conn.send({ t: 'levelMove', id, delta }),
    playTest: (level) => conn.send({ t: 'create', set: 'custom', level, start: true }),
    close: () => {
      editing = false;
      updateScreens();
    },
  });

  const resize = () => {
    renderer.resize(mirror);
    backdrop.viewW = mirror.viewW;
    backdrop.viewH = mirror.viewH;
  };

  // During a play test (a game started from the editor), a button to get straight back to the editor.
  const testExit = document.createElement('button');
  testExit.className = 'test-exit';
  testExit.innerHTML = '<span aria-hidden="true">←</span> Back to editor';
  testExit.title = 'Stop the play test';
  testExit.addEventListener('mousedown', (e) => e.preventDefault()); // don't take keyboard focus from the game
  testExit.addEventListener('click', () => conn.send({ t: 'leave' }));
  document.body.append(testExit);

  /** Show whichever screen fits the current state: lobby, waiting room, pause menu or the game itself. */
  function updateScreens(): void {
    const playing = inGame();
    testExit.classList.toggle('show', playing && editing && !paused);
    if (renderer.menu === playing) {
      renderer.menu = !playing;
      resize();
    }
    input.enabled = playing && !paused;
    if (playing) editor.hide();
    if (playing) {
      if (paused) menu.pause();
      else menu.hide();
    } else if (!name) {
      if (menu.current !== 'name') menu.askName(null);
    } else if (editing) {
      menu.hide();
      if (!editor.isOpen) editor.open();
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
      conn.send({ t: 'hello', id: loadSetting(ID_KEY) });
      return;
    }
    // A new connection starts outside any game.
    room = null;
    paused = false;
    mirror.reset();
    renderer.menu = true;
    resize();
    input.enabled = false;
    editor.hide();
    menu.connecting(status === 'lost');
  };

  conn.onMessage = (msg: ServerMessage) => {
    const now = performance.now() / 1000;
    switch (msg.t) {
      case 'welcome':
        saveSetting(ID_KEY, msg.id);
        name = msg.name;
        menu.setName(name);
        if (!name) menu.askName(null);
        else if (menu.current === 'name' || menu.current === 'connecting') updateScreens();
        break;
      case 'lobby':
        menu.setGames(msg.games, msg.sets, msg.defaultSet);
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
        if (editor.isOpen) editor.error(msg.message);
        else menu.toast(msg.message);
        break;
      case 'levelList':
        editor.setSets(msg.sets);
        break;
      case 'levelText':
        editor.levelText(msg.set, msg.id, msg.text);
        break;
      case 'levelSaved':
        editor.saved(msg.id);
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
    if (e.code === 'KeyV' && inGame() && !paused && !e.repeat) {
      renderer.view3d = !renderer.view3d;
      tankFor = null;
      saveSetting(VIEW_KEY, renderer.view3d ? '3d' : '2d');
    }
  });
  window.addEventListener('pointerdown', () => audio.unlock());
  window.addEventListener('gamepadconnected', () => audio.unlock());

  const frame = (nowMs: number) => {
    const now = nowMs / 1000;
    if (inGame()) {
      // Inputs go to the server only when they change.
      let i: PlayerInput = paused ? { dx: 0, dy: 0, fire: false, magic: false } : input.combined();
      // In the 3D view the controls turn and walk relative to where the hero faces.
      const me = mirror.me;
      if (renderer.view3d && me?.alive) {
        if (tankFor !== me) tank.reset(me.fx, me.fy);
        tankFor = me;
        i = tank.translate(i, now);
        renderer.heading = tank.angle;
      } else {
        renderer.heading = null;
      }
      const key = `${i.dx},${i.dy},${+i.fire},${+i.magic},${i.fx ?? 0},${i.fy ?? 0}`;
      if (key !== sentInput) {
        sentInput = key;
        conn.send({ t: 'input', ...i });
      }
      renderer.draw(mirror, now, (now - lastSnapAt) / snapGap);
    } else if (!editor.isOpen) {
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
