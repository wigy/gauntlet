import { HERO_ORDER } from '../src/core/defs';
import type { HeroClass } from '../src/core/defs';
import { Game, MAX_PLAYERS, TICK } from '../src/core/game';
import type { GameEvent, PlayerInput } from '../src/core/game';
import type { ClientMessage, ItemRow, LevelSetId, LobbyGame, RoomInfo, ServerMessage, Snapshot } from '../src/net/protocol';
import { cleanName } from '../src/net/protocol';
import type { LevelLibrary } from './levels';
import type { PlayerStore } from './store';

/** Snapshots go out every this many ticks (60 / 2 = 30 per second). */
const SNAPSHOT_EVERY = 2;
/** Area of interest around a client's hero, in tiles: entities further away aren't sent. */
const AOI_X = 22;
const AOI_Y = 16;
/** Seconds the GAME OVER screen stays up before everyone goes back to the lobby. */
const GAME_OVER_DELAY = 5;
/** View size used for potions (they hit what's on the drinker's screen). */
const VIEW_W = 19;
const VIEW_H = 14;

export interface Conn {
  send(msg: ServerMessage): void;
}

export interface Client {
  /** Connection id; doubles as the controller id inside a Game. */
  id: string;
  conn: Conn;
  playerId: string | null;
  name: string | null;
  room: Room | null;
  /** Hero in the current room (chosen in the waiting room, or the first free one). */
  hero: HeroClass;
  input: PlayerInput;
  /** Level number this client last received in full (-1: none). */
  levelSent: number;
  itemsSent: number;
}

interface Room {
  id: string;
  name: string;
  state: 'waiting' | 'playing' | 'over';
  members: Client[];
  game: Game | null;
  set: LevelSetId;
  /** The set's level texts when the room was opened. */
  levels: string[];
  startLevel: number;
  overAt: number;
  events: GameEvent[];
  /** Copy of the level tiles as last sent, to find doors that opened. */
  tiles: Uint8Array;
  levelSeen: number;
  itemsCount: number;
  itemsVersion: number;
  ids: WeakMap<object, number>;
  nextId: number;
}

const IDLE: PlayerInput = { dx: 0, dy: 0, fire: false, magic: false };
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Lobby, game rooms and the simulation loop. Transport-agnostic: the WebSocket layer (attach.ts) calls connect(),
 * message() and disconnect(), and update() on a timer.
 */
export class Lobby {
  private clients = new Set<Client>();
  private rooms = new Map<string, Room>();
  private nextConn = 1;
  private acc = 0;
  private last: number;
  private ticks = 0;

  constructor(
    private readonly levels: LevelLibrary,
    private readonly store: PlayerStore,
    private readonly clock: () => number = () => performance.now() / 1000,
  ) {
    this.last = clock();
  }

  connect(conn: Conn): Client {
    const client: Client = { id: `c${this.nextConn++}`, conn, playerId: null, name: null, room: null, hero: 'warrior', input: { ...IDLE }, levelSent: -1, itemsSent: -1 };
    this.clients.add(client);
    return client;
  }

  disconnect(client: Client): void {
    this.leaveRoom(client);
    this.clients.delete(client);
    if (client.playerId) this.store.touch(client.playerId);
  }

  message(client: Client, msg: ClientMessage): void {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello': {
        const saved = this.store.get(typeof msg.id === 'string' ? msg.id : null);
        client.playerId = saved ? (msg.id as string) : this.store.newId();
        client.name = saved?.name ?? null;
        if (saved) this.store.touch(client.playerId);
        client.conn.send({ t: 'welcome', id: client.playerId, name: client.name });
        if (client.name) client.conn.send(this.lobbyMessage());
        return;
      }
      case 'setName': {
        const name = cleanName(msg.name);
        if (!client.playerId) return;
        if (!name) return client.conn.send({ t: 'error', message: 'Please enter a name.' });
        client.name = name;
        this.store.setName(client.playerId, name);
        const p = client.room?.game?.players.find((pl) => pl?.controller === client.id);
        if (p) p.name = name;
        client.conn.send({ t: 'welcome', id: client.playerId, name });
        client.conn.send(this.lobbyMessage());
        if (client.room) this.roomChanged(client.room);
        return;
      }
      case 'create': {
        if (!client.name) return;
        let set = this.levels.isSet(msg.set) ? msg.set : this.levels.defaultSet;
        let levels = this.levels.texts(set);
        if (!levels.length) {
          if (msg.set) return client.conn.send({ t: 'error', message: `There are no ${this.levels.label(set).toLowerCase()} levels yet.` });
          set = 'builtin';
          levels = this.levels.texts(set);
        }
        this.leaveRoom(client);
        const level = Number(msg.level);
        const room: Room = {
          id: this.roomId(), name: `${client.name}'s game`, state: 'waiting', members: [], game: null, set, levels,
          startLevel: Number.isInteger(level) ? Math.max(1, Math.min(levels.length, level)) : 1,
          overAt: 0, events: [], tiles: new Uint8Array(0), levelSeen: -1, itemsCount: -1, itemsVersion: 0, ids: new WeakMap(), nextId: 1,
        };
        this.rooms.set(room.id, room);
        this.enterRoom(client, room);
        if (msg.start === true) this.startRoom(room);
        return;
      }
      case 'join': {
        if (!client.name) return;
        const room = this.rooms.get(String(msg.game));
        if (!room || room.state === 'over') return client.conn.send({ t: 'error', message: 'That game has ended.' });
        if (client.room === room) return;
        if (room.members.length >= MAX_PLAYERS) return client.conn.send({ t: 'error', message: 'That game is full.' });
        this.leaveRoom(client);
        this.enterRoom(client, room);
        return;
      }
      case 'start': {
        if (client.room?.state === 'waiting') this.startRoom(client.room);
        return;
      }
      case 'pickHero': {
        const room = client.room;
        if (!room || room.state !== 'waiting' || !HERO_ORDER.includes(msg.hero)) return;
        if (room.members.some((m) => m !== client && m.hero === msg.hero)) return client.conn.send({ t: 'error', message: 'Someone already picked that hero.' });
        client.hero = msg.hero;
        this.roomChanged(room);
        this.lobbyChanged();
        return;
      }
      case 'leave':
        this.leaveRoom(client);
        client.conn.send({ t: 'room', room: null });
        client.conn.send(this.lobbyMessage());
        return;
      case 'levelList':
        if (client.name) client.conn.send({ t: 'levelList', sets: this.levels.sets() });
        return;
      case 'levelGet': {
        if (!client.name || !this.levels.isSet(msg.set)) return;
        const text = this.levels.get(msg.set, String(msg.id));
        if (text === null) return client.conn.send({ t: 'error', message: 'That level no longer exists.' });
        client.conn.send({ t: 'levelText', set: msg.set, id: String(msg.id), text });
        return;
      }
      case 'levelSave': {
        if (!client.name) return;
        const result = this.levels.save(typeof msg.id === 'string' ? msg.id : null, msg.text);
        if ('error' in result) return client.conn.send({ t: 'error', message: result.error });
        client.conn.send({ t: 'levelSaved', id: result.id });
        this.levelsChanged();
        return;
      }
      case 'levelDelete':
        if (!client.name) return;
        this.levels.remove(String(msg.id));
        this.levelsChanged();
        return;
      case 'levelMove':
        if (!client.name) return;
        this.levels.move(String(msg.id), Number(msg.delta));
        this.levelsChanged();
        return;
      case 'input': {
        const axis = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
        client.input = { dx: axis(msg.dx), dy: axis(msg.dy), fire: msg.fire === true, magic: msg.magic === true };
        return;
      }
    }
  }

  /** Advance every running game by however much real time has passed. Call often (e.g. every 16 ms). */
  update(): void {
    const now = this.clock();
    this.acc = Math.min(this.acc + now - this.last, 0.25);
    this.last = now;
    while (this.acc >= TICK) {
      this.acc -= TICK;
      this.tick(now);
    }
  }

  /** One simulation tick for every running game; sends snapshots every SNAPSHOT_EVERY ticks. */
  tick(now = this.clock()): void {
    this.ticks++;
    for (const room of this.rooms.values()) {
      const game = room.game;
      if (!game || room.state === 'waiting') continue;
      const inputs = new Map<string, PlayerInput>();
      for (const m of room.members) inputs.set(m.id, m.input);
      game.step(inputs);
      room.events.push(...game.events);
      game.events.length = 0;
      if (room.state === 'playing' && game.state === 'gameover') {
        room.state = 'over';
        room.overAt = now;
        this.lobbyChanged();
      }
      if (this.ticks % SNAPSHOT_EVERY === 0) this.sendSnapshots(room);
      if (room.state === 'over' && now - room.overAt >= GAME_OVER_DELAY) this.closeRoom(room);
    }
  }

  // ---------------------------------------------------------------- rooms

  private startRoom(room: Room): void {
    const game = new Game(room.levels, Math.floor(Math.random() * 1e9), room.startLevel, { online: true });
    game.viewW = VIEW_W;
    game.viewH = VIEW_H;
    for (const m of room.members) game.addPlayer(m.id, m.name ?? '?', m.hero);
    game.start();
    room.game = game;
    room.state = 'playing';
    this.roomChanged(room);
    this.lobbyChanged();
  }

  /** Custom levels changed: refresh everyone's level lists and the lobby's set counts. */
  private levelsChanged(): void {
    const sets = this.levels.sets();
    for (const c of this.clients) if (c.name) c.conn.send({ t: 'levelList', sets });
    this.lobbyChanged();
  }

  private enterRoom(client: Client, room: Room): void {
    client.hero = HERO_ORDER.find((h) => !room.members.some((m) => m.hero === h)) ?? 'warrior';
    room.members.push(client);
    client.room = room;
    client.levelSent = -1;
    client.itemsSent = -1;
    client.input = { ...IDLE };
    if (room.game && room.state === 'playing') {
      const p = room.game.addPlayer(client.id, client.name ?? '?', client.hero);
      if (p) client.hero = p.hero;
    }
    this.roomChanged(room);
    this.lobbyChanged();
  }

  private leaveRoom(client: Client): void {
    const room = client.room;
    if (!room) return;
    client.room = null;
    room.members = room.members.filter((m) => m !== client);
    room.game?.removePlayer(client.id);
    if (room.members.length === 0) this.rooms.delete(room.id);
    else this.roomChanged(room);
    this.lobbyChanged();
  }

  private closeRoom(room: Room): void {
    this.rooms.delete(room.id);
    for (const m of room.members) {
      m.room = null;
      m.conn.send({ t: 'room', room: null });
    }
    room.members = [];
    this.lobbyChanged();
  }

  private roomChanged(room: Room): void {
    const players = this.playerInfo(room);
    for (const m of room.members) {
      const info: RoomInfo = { id: room.id, name: room.name, state: room.state, players, you: m.hero };
      m.conn.send({ t: 'room', room: info });
    }
  }

  private lobbyChanged(): void {
    const msg = this.lobbyMessage();
    for (const c of this.clients) {
      if (c.name && (!c.room || c.room.state === 'waiting')) c.conn.send(msg);
    }
  }

  private lobbyMessage(): ServerMessage {
    return { t: 'lobby', games: this.lobbyGames(), sets: this.levels.summary(), defaultSet: this.levels.defaultSet };
  }

  lobbyGames(): LobbyGame[] {
    const out: LobbyGame[] = [];
    for (const room of this.rooms.values()) {
      if (room.state === 'over') continue;
      out.push({
        id: room.id,
        name: room.name,
        state: room.state,
        players: this.playerInfo(room),
        set: this.levels.label(room.set),
        level: room.game?.levelNumber ?? 0,
        open: room.members.length < MAX_PLAYERS,
      });
    }
    return out;
  }

  private playerInfo(room: Room) {
    return room.members.map((m) => ({ name: m.name ?? '?', hero: m.hero }));
  }

  private roomId(): string {
    let id: string;
    do id = Math.random().toString(36).slice(2, 8);
    while (this.rooms.has(id));
    return id;
  }

  // ---------------------------------------------------------------- snapshots

  private sendSnapshots(room: Room): void {
    const game = room.game!;
    const lvl = game.level;
    let tiles: [number, number][] | undefined;
    if (room.levelSeen !== game.levelNumber) {
      room.levelSeen = game.levelNumber;
      room.tiles = lvl.tiles.slice();
      room.itemsCount = -1;
    } else {
      for (let i = 0; i < lvl.tiles.length; i++) {
        if (lvl.tiles[i] === room.tiles[i]) continue;
        (tiles ??= []).push([i, lvl.tiles[i]]);
        room.tiles[i] = lvl.tiles[i];
      }
    }
    if (game.items.size !== room.itemsCount) {
      room.itemsCount = game.items.size;
      room.itemsVersion++;
    }
    let items: ItemRow[] | undefined;
    const events = room.events;
    room.events = [];

    for (const client of room.members) {
      if (client.levelSent !== game.levelNumber) {
        client.levelSent = game.levelNumber;
        client.conn.send({
          t: 'level',
          level: { number: game.levelNumber, name: lvl.name, width: lvl.width, height: lvl.height, wrapX: lvl.wrapX, wrapY: lvl.wrapY, tiles: Array.from(lvl.tiles).join('') },
        });
      }
      const snap: Snapshot = { t: 'state', state: game.state, you: client.id, players: [], monsters: [], generators: [], shots: [], events };
      if (tiles) snap.tiles = tiles;
      if (client.itemsSent !== room.itemsVersion) {
        client.itemsSent = room.itemsVersion;
        snap.items = items ??= [...game.items].map(([key, it]) => [key, it.kind]);
      }

      const me = game.players.find((p) => p?.controller === client.id);
      const start = lvl.starts[0] ?? { x: 0, y: 0 };
      const cx = me ? me.x : start.x + 0.5;
      const cy = me ? me.y : start.y + 0.5;
      const near = (x: number, y: number) => Math.abs(game.dxw(cx, x)) <= AOI_X && Math.abs(game.dyw(cy, y)) <= AOI_Y;

      for (const p of game.players) {
        if (!p) continue;
        snap.players.push([p.slot, p.controller, p.name, p.hero, r3(p.x), r3(p.y), p.fx, p.fy, Math.ceil(p.health), p.score, p.keys, p.potions, p.alive ? 1 : 0]);
      }
      for (const m of game.monsters) {
        if (!near(m.x, m.y)) continue;
        snap.monsters.push([this.idOf(room, m), m.kind, m.rank, Number.isFinite(m.hp) ? r3(m.hp) : -1, r3(m.x), r3(m.y), m.fx, m.invisible > 0 ? 1 : 0]);
      }
      for (const g of game.generators) {
        if (near(g.x, g.y)) snap.generators.push([this.idOf(room, g), g.kind, r3(g.hp), g.x, g.y]);
      }
      for (const s of game.shots) {
        if (near(s.x, s.y)) snap.shots.push([this.idOf(room, s), s.kind, s.owner, r3(s.x), r3(s.y), r3(s.vx), r3(s.vy), r3(s.ttl)]);
      }
      client.conn.send(snap);
    }
  }

  private idOf(room: Room, o: object): number {
    let id = room.ids.get(o);
    if (id === undefined) room.ids.set(o, (id = room.nextId++));
    return id;
  }
}
