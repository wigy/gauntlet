import { HERO_ORDER, HEROES } from '../core/defs';
import type { HeroClass } from '../core/defs';
import type { LobbyGame, PlayerInfo, RoomInfo } from '../net/protocol';
import { MAX_NAME_LENGTH } from '../net/protocol';
import './menu.css';

export interface MenuActions {
  setName(name: string): void;
  create(): void;
  join(gameId: string): void;
  start(): void;
  pickHero(hero: HeroClass): void;
  leave(): void;
  resume(): void;
}

type Screen = 'connecting' | 'name' | 'lobby' | 'room' | 'pause' | 'none';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The DOM screens drawn over the canvas: connecting, name entry, lobby, waiting room and the in-game pause menu. */
export class Menu {
  private screen: Screen = 'none';
  private name: string | null = null;
  private games: LobbyGame[] = [];
  private room: RoomInfo | null = null;
  private toastTimer = 0;
  private panel: HTMLElement;
  private toastEl: HTMLElement;

  constructor(root: HTMLElement, private actions: MenuActions, private controls: string) {
    root.innerHTML = '<div class="ui-panel"></div><div class="ui-toast"></div>';
    this.panel = root.querySelector('.ui-panel')!;
    this.toastEl = root.querySelector('.ui-toast')!;
    root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (el && !(el as HTMLButtonElement).disabled) this.act(el.dataset.action!, el.dataset.id);
    });
    root.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = this.panel.querySelector<HTMLInputElement>('input[name=name]');
      if (input) this.actions.setName(input.value);
    });
  }

  get current(): Screen {
    return this.screen;
  }

  connecting(lost: boolean): void {
    this.show('connecting');
    this.panel.innerHTML = `
      <div class="card narrow">
        ${this.title()}
        <p class="muted">${lost ? 'Lost connection to the server. Reconnecting…' : 'Connecting to the server…'}</p>
        <div class="spinner"></div>
      </div>`;
  }

  askName(current: string | null): void {
    this.show('name');
    this.panel.innerHTML = `
      <form class="card narrow">
        ${this.title()}
        <label class="label" for="name">What should we call you, adventurer?</label>
        <input id="name" name="name" maxlength="${MAX_NAME_LENGTH}" autocomplete="nickname" spellcheck="false"
          placeholder="Your name" value="${esc(current ?? '')}" />
        <div class="row">
          ${current ? '<button type="button" class="btn ghost" data-action="cancel-name">Cancel</button>' : ''}
          <button type="submit" class="btn primary">Enter the dungeon</button>
        </div>
      </form>`;
    const input = this.panel.querySelector<HTMLInputElement>('input')!;
    input.focus();
    input.select();
  }

  setName(name: string | null): void {
    this.name = name;
  }

  setGames(games: LobbyGame[]): void {
    this.games = games;
    if (this.screen === 'lobby') this.lobby();
  }

  setRoom(room: RoomInfo | null): void {
    this.room = room;
    if (this.screen === 'room') this.showRoom();
  }

  lobby(): void {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.id : undefined;
    this.show('lobby');
    const rows = this.games.map((g) => `
      <li class="game">
        <div class="game-main">
          <div class="game-name">${esc(g.name)}</div>
          <div class="game-players">${g.players.map((p) => this.playerChip(p)).join('')}</div>
        </div>
        <span class="badge ${g.state}">${g.state === 'waiting' ? 'Waiting' : `Level ${g.level}`}</span>
        <button class="btn small" data-action="join" data-id="${esc(g.id)}" ${g.open ? '' : 'disabled'}>
          ${g.open ? (g.state === 'waiting' ? 'Join' : 'Jump in') : 'Full'}
        </button>
      </li>`).join('');
    this.panel.innerHTML = `
      <div class="card">
        ${this.title()}
        <div class="who">Playing as <strong>${esc(this.name ?? '')}</strong>
          <button class="link" data-action="change-name">change</button></div>
        <button class="btn primary wide" data-action="create">Start a new game</button>
        <h2>Open games</h2>
        ${rows ? `<ul class="games">${rows}</ul>` : '<p class="empty">No games right now. Start one and others can join you.</p>'}
        <p class="hint">${esc(this.controls)}</p>
      </div>`;
    if (focused) this.panel.querySelector<HTMLElement>(`[data-id="${CSS.escape(focused)}"]`)?.focus();
  }

  showRoom(): void {
    const room = this.room;
    if (!room) return this.lobby();
    this.show('room');
    const slots = HERO_ORDER.map((hero) => {
      const player = room.players.find((p) => p.hero === hero);
      const def = HEROES[hero];
      const mine = hero === room.you;
      const inner = `
          <img src="sprites/${hero}.png" alt="" />
          <div class="slot-text">
            <div class="slot-name">${player ? esc(player.name) : 'Free'}</div>
            <div class="slot-hero">${def.title}${mine ? ' · you' : ''}</div>
          </div>
          ${player ? '' : '<span class="slot-pick">Pick</span>'}`;
      // Free heroes are buttons: click one to switch to it.
      return player
        ? `<li class="slot ${mine ? 'mine' : ''}" style="--hero:${def.color}">${inner}</li>`
        : `<li><button class="slot free" style="--hero:${def.color}" data-action="pick" data-id="${hero}" title="Play as the ${def.title}">${inner}</button></li>`;
    }).join('');
    this.panel.innerHTML = `
      <div class="card">
        ${this.title()}
        <h2>${esc(room.name)}</h2>
        <p class="muted">Waiting for adventurers. Anyone in the lobby can join until you start. Click a free hero to switch.</p>
        <ul class="slots">${slots}</ul>
        <div class="row">
          <button class="btn ghost" data-action="leave">Leave</button>
          <button class="btn primary" data-action="start">Start game</button>
        </div>
        <p class="hint">${esc(this.controls)}</p>
      </div>`;
    this.panel.querySelector<HTMLElement>('[data-action=start]')?.focus();
  }

  pause(): void {
    this.show('pause');
    this.panel.innerHTML = `
      <div class="card narrow">
        <h2>Paused</h2>
        <p class="muted">The game keeps running for everyone else.</p>
        <div class="row">
          <button class="btn ghost" data-action="leave">Leave game</button>
          <button class="btn primary" data-action="resume">Resume</button>
        </div>
      </div>`;
    this.panel.querySelector<HTMLElement>('[data-action=resume]')?.focus();
  }

  hide(): void {
    this.show('none');
    this.panel.innerHTML = '';
  }

  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 3000);
  }

  private show(screen: Screen): void {
    this.screen = screen;
    this.panel.parentElement!.classList.toggle('hidden', screen === 'none');
  }

  private act(action: string, id: string | undefined): void {
    switch (action) {
      case 'create':
        return this.actions.create();
      case 'join':
        if (id) this.actions.join(id);
        return;
      case 'start':
        return this.actions.start();
      case 'pick':
        if (id && (HERO_ORDER as readonly string[]).includes(id)) this.actions.pickHero(id as HeroClass);
        return;
      case 'leave':
        return this.actions.leave();
      case 'resume':
        return this.actions.resume();
      case 'change-name':
        return this.askName(this.name);
      case 'cancel-name':
        return this.lobby();
    }
  }

  private title(): string {
    return '<h1>Gauntlet</h1>';
  }

  private playerChip(p: PlayerInfo): string {
    return `<span class="chip" style="--hero:${HEROES[p.hero].color}" title="${HEROES[p.hero].title}">${esc(p.name)}</span>`;
  }
}
