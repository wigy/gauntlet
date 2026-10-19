// Static tuning data for heroes, monsters and items. Units: tiles, seconds, health points.

export type HeroClass = 'warrior' | 'valkyrie' | 'wizard' | 'elf';

export interface HeroDef {
  name: string;
  title: string;
  color: string;
  speed: number;
  /** Fraction of incoming damage absorbed. */
  armor: number;
  shotDamage: number;
  shotSpeed: number;
  meleeDamage: number;
  /** Multiplier for potion damage. */
  magic: number;
}

export const HEROES: Record<HeroClass, HeroDef> = {
  warrior: { name: 'Thor', title: 'Warrior', color: '#e03030', speed: 3.2, armor: 0.2, shotDamage: 3, shotSpeed: 11, meleeDamage: 3, magic: 0.5 },
  valkyrie: { name: 'Thyra', title: 'Valkyrie', color: '#3a6df0', speed: 3.4, armor: 0.4, shotDamage: 2, shotSpeed: 11, meleeDamage: 2, magic: 0.75 },
  wizard: { name: 'Merlin', title: 'Wizard', color: '#e8d020', speed: 3.4, armor: 0, shotDamage: 2, shotSpeed: 12, meleeDamage: 1, magic: 1.5 },
  elf: { name: 'Questor', title: 'Elf', color: '#30c040', speed: 4.4, armor: 0.1, shotDamage: 1.5, shotSpeed: 14, meleeDamage: 1, magic: 1 },
};

export const HERO_ORDER: readonly HeroClass[] = ['warrior', 'valkyrie', 'wizard', 'elf'];

export type MonsterKind = 'ghost' | 'grunt' | 'demon' | 'lobber' | 'sorcerer' | 'death';

export interface MonsterDef {
  speed: number;
  /** Hit points per rank (ranks 1..3). */
  hpPerRank: number;
  /** Damage per hit, per rank. */
  damagePerRank: number;
  pointsPerRank: number;
  /** Ghosts explode on contact; the others keep hitting. */
  kamikaze: boolean;
  shoots: 'none' | 'fireball' | 'rock';
  shotImmune: boolean;
  color: string;
}

export const MONSTERS: Record<MonsterKind, MonsterDef> = {
  ghost: { speed: 2.6, hpPerRank: 1, damagePerRank: 10, pointsPerRank: 10, kamikaze: true, shoots: 'none', shotImmune: false, color: '#c8c8d8' },
  grunt: { speed: 2.2, hpPerRank: 2, damagePerRank: 5, pointsPerRank: 5, kamikaze: false, shoots: 'none', shotImmune: false, color: '#b07030' },
  demon: { speed: 2.4, hpPerRank: 2, damagePerRank: 6, pointsPerRank: 10, kamikaze: false, shoots: 'fireball', shotImmune: false, color: '#d04020' },
  lobber: { speed: 2.0, hpPerRank: 1, damagePerRank: 4, pointsPerRank: 10, kamikaze: false, shoots: 'rock', shotImmune: false, color: '#909090' },
  sorcerer: { speed: 2.6, hpPerRank: 2, damagePerRank: 8, pointsPerRank: 10, kamikaze: false, shoots: 'none', shotImmune: false, color: '#a040c0' },
  death: { speed: 2.8, hpPerRank: 0, damagePerRank: 10, pointsPerRank: 0, kamikaze: false, shoots: 'none', shotImmune: true, color: '#202020' },
};

/** Generator kinds = monster kinds that can be spawned from a generator (Death has its own generator in the original). */
export type ItemKind = 'food' | 'cider' | 'potion' | 'key' | 'treasure';

export const FOOD_HEALTH = 100;
export const CIDER_HEALTH = 50;
export const TREASURE_POINTS = 100;
export const JOIN_HEALTH = 2000;
export const HEALTH_DRAIN_PER_SEC = 1;
export const DEATH_DRAIN_CAP = 200;
export const LOW_HEALTH_WARNING = 200;
export const MAX_MONSTERS = 220;
export const MAX_SHOTS_PER_PLAYER = 2;
export const SHOT_COOLDOWN = 0.22;
export const MELEE_COOLDOWN = 0.25;
export const MONSTER_HIT_COOLDOWN = 0.6;
export const GENERATOR_HP_PER_RANK = 3;
export const ENTITY_RADIUS = 0.38;
export const SHOT_RADIUS = 0.2;
/** Monsters further than this (in tiles) from every player stay idle. */
export const ACTIVE_RANGE = 18;
