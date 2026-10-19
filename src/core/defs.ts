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

export type MonsterKind = 'ghost' | 'grunt' | 'demon' | 'lobber' | 'sorcerer' | 'death' | 'supersorcerer' | 'dragon' | 'thief' | 'acid';

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
  /** Collision half-size in tiles (default ENTITY_RADIUS). */
  radius?: number;
  /** Fixed hit points, regardless of rank. */
  hp?: number;
  /** Gauntlet II: fighting (walking into it) does nothing, and a potion only stuns it. */
  tough?: boolean;
}

export const MONSTERS: Record<MonsterKind, MonsterDef> = {
  ghost: { speed: 2.6, hpPerRank: 1, damagePerRank: 10, pointsPerRank: 10, kamikaze: true, shoots: 'none', shotImmune: false, color: '#c8c8d8' },
  grunt: { speed: 2.2, hpPerRank: 2, damagePerRank: 5, pointsPerRank: 5, kamikaze: false, shoots: 'none', shotImmune: false, color: '#b07030' },
  demon: { speed: 2.4, hpPerRank: 2, damagePerRank: 6, pointsPerRank: 10, kamikaze: false, shoots: 'fireball', shotImmune: false, color: '#d04020' },
  lobber: { speed: 2.0, hpPerRank: 1, damagePerRank: 4, pointsPerRank: 10, kamikaze: false, shoots: 'rock', shotImmune: false, color: '#909090' },
  sorcerer: { speed: 2.6, hpPerRank: 2, damagePerRank: 8, pointsPerRank: 10, kamikaze: false, shoots: 'none', shotImmune: false, color: '#a040c0' },
  death: { speed: 2.8, hpPerRank: 0, damagePerRank: 10, pointsPerRank: 0, kamikaze: false, shoots: 'none', shotImmune: true, color: '#202020' },
  // Gauntlet II
  supersorcerer: { speed: 2.4, hpPerRank: 3, damagePerRank: 8, pointsPerRank: 20, kamikaze: false, shoots: 'fireball', shotImmune: false, color: '#e050f0', tough: true },
  dragon: { speed: 0.9, hpPerRank: 0, hp: 60, damagePerRank: 20, pointsPerRank: 0, kamikaze: false, shoots: 'fireball', shotImmune: false, color: '#40a040', radius: 0.9, tough: true },
  thief: { speed: 4.6, hpPerRank: 1, damagePerRank: 0, pointsPerRank: 50, kamikaze: false, shoots: 'none', shotImmune: false, color: '#c09060' },
  acid: { speed: 1.2, hpPerRank: 0, damagePerRank: 15, pointsPerRank: 0, kamikaze: false, shoots: 'none', shotImmune: true, color: '#90e030', tough: true },
};

/** Points for killing a dragon. */
export const DRAGON_POINTS = 1000;

/** Generator kinds = monster kinds that can be spawned from a generator (Death has its own generator in the original). */
export type ItemKind = 'food' | 'cider' | 'potion' | 'key' | 'treasure' | 'amulet' | 'poison' | 'it';

/** Gauntlet II amulets: one at a time, for AMULET_TIME seconds. */
export type AmuletKind = 'invisibility' | 'invulnerability' | 'repulsive' | 'reflect' | 'supershot' | 'transport';
export const AMULETS: readonly AmuletKind[] = ['invisibility', 'invulnerability', 'repulsive', 'reflect', 'supershot', 'transport'];
export const AMULET_NAMES: Record<AmuletKind, string> = {
  invisibility: 'Invisibility', invulnerability: 'Invulnerability', repulsive: 'Repulsiveness',
  reflect: 'Reflective shots', supershot: 'Super shots', transport: 'Transportability',
};
export const AMULET_TIME = 20;
/** The super shots amulet is a number of shots rather than a time. */
export const SUPER_SHOTS = 10;
/** Seconds a potion stuns the monsters it can't kill. */
export const MAGIC_STUN = 4;

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
// Gauntlet II tiles and hazards.
/** Shots it takes to break a breakable wall. */
export const BREAKABLE_HITS = 3;
export const STUN_TIME = 1.2;
/** After a stun wears off, the same tile can't stun again for this long (time to step off). */
export const STUN_GRACE = 0.8;
/** Force fields are on for half of every period. */
export const FORCE_FIELD_PERIOD = 3;
export const FORCE_FIELD_DPS = 40;
export const POISON_HEALTH = 50;
export const DIZZY_TIME = 10;
export const ACID_HIT_COOLDOWN = 0.4;
/** Seconds between thieves on levels that have them (randomised up to twice this). */
export const THIEF_INTERVAL = 40;
export const THIEF_STEAL_POINTS = 500;
/** As in the arcade: stay on a level this long and every wall turns into an exit. */
export const WALLS_TO_EXITS_TIME = 150;
/** Monsters further than this (in tiles) from every player stay idle. */
export const ACTIVE_RANGE = 18;
