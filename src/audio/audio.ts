import type { Sfx } from '../core/game';

type Tone = { freq: number; to?: number; dur: number; type: OscillatorType; vol: number };

const SOUNDS: Record<Sfx, Tone> = {
  shoot: { freq: 880, to: 440, dur: 0.06, type: 'square', vol: 0.05 },
  hit: { freq: 200, to: 120, dur: 0.05, type: 'square', vol: 0.05 },
  kill: { freq: 300, to: 60, dur: 0.12, type: 'sawtooth', vol: 0.06 },
  hurt: { freq: 140, to: 90, dur: 0.08, type: 'sawtooth', vol: 0.06 },
  pickup: { freq: 660, to: 1320, dur: 0.12, type: 'triangle', vol: 0.1 },
  food: { freq: 440, to: 880, dur: 0.2, type: 'triangle', vol: 0.1 },
  potion: { freq: 520, to: 1040, dur: 0.25, type: 'sine', vol: 0.12 },
  door: { freq: 120, to: 240, dur: 0.3, type: 'square', vol: 0.06 },
  exit: { freq: 300, to: 1200, dur: 0.6, type: 'sine', vol: 0.12 },
  die: { freq: 400, to: 40, dur: 0.9, type: 'sawtooth', vol: 0.1 },
  magic: { freq: 60, to: 30, dur: 0.6, type: 'sawtooth', vol: 0.15 },
  join: { freq: 523, to: 784, dur: 0.3, type: 'square', vol: 0.06 },
};

/** Synthesised sound effects plus speech-synthesis announcements ("Elf needs food, badly!"). */
export class Audio {
  private ctx: AudioContext | null = null;
  private lastPlayed = new Map<Sfx, number>();

  /** Browsers only allow audio after a user gesture; call from a key/button handler. */
  unlock(): void {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  play(name: Sfx): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (now - (this.lastPlayed.get(name) ?? -1) < 0.04) return;
    this.lastPlayed.set(name, now);
    const t = SOUNDS[name];
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = t.type;
    osc.frequency.setValueAtTime(t.freq, now);
    if (t.to) osc.frequency.exponentialRampToValueAtTime(t.to, now + t.dur);
    gain.gain.setValueAtTime(t.vol, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + t.dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + t.dur);
  }

  say(text: string): void {
    if (typeof speechSynthesis === 'undefined') return;
    const u = new SpeechSynthesisUtterance(text);
    u.pitch = 0.4;
    u.rate = 0.9;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }
}
