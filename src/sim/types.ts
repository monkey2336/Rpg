/** Shared sim vocabulary. No platform types appear anywhere in src/sim. */

export type DamageType = 'percussive' | 'solar' | 'caustic' | 'arc';
export type DefenceLayer = 'shield' | 'armor' | 'health';
export type Rarity = 'common' | 'refined' | 'marked' | 'relic' | 'sovereign';
export type MaterialTier = 1 | 2 | 3 | 4 | 5;
export type StatusKind = 'corrosion' | 'ignite' | 'disrupt' | 'stagger';

/** Telegraph vocabulary — deliberately tiny, so players learn to read it once. */
export type TelegraphShape = 'ring' | 'line' | 'cone' | 'pulse' | 'column';

export interface Defences {
  shield: number;
  shieldMax: number;
  /** Points per second once the delay has elapsed. */
  shieldRegen: number;
  /** Ticks without damage before regen resumes. */
  shieldDelay: number;
  shieldCooldown: number;
  armor: number;
  armorMax: number;
  health: number;
  healthMax: number;
}

export interface Status {
  kind: StatusKind;
  stacks: number;
  ticksLeft: number;
  /** Per-stack per-second effect: damage for DoTs, multiplier for debuffs. */
  magnitude: number;
  damageType: DamageType;
}

export type WeaponBehavior = 'hitscan' | 'projectile' | 'beam' | 'lob';

export interface WeaponArchetype {
  id: string;
  name: string;
  /** Player-facing family label; two archetypes in a family share a silhouette. */
  family: string;
  damageType: DamageType;
  behavior: WeaponBehavior;
  /** Damage per pellet before rarity/affix scaling. */
  baseDamage: number;
  pellets: number;
  /** Ticks between shots at 40Hz. */
  fireInterval: number;
  magazine: number;
  reloadTicks: number;
  /** Radians of cone at the muzzle. */
  spread: number;
  /** Units per tick; ignored for hitscan/beam. */
  projectileSpeed: number;
  range: number;
  critChance: number;
  critMult: number;
  /** Screen-space kick, in units. Presentation reads this; sim does not. */
  recoil: number;
  /** Frames of hitstop on a solid connect. Feel knob, tuned before content. */
  hitstop: number;
  /** Movement speed multiplier while wielded. Heavy guns are heavy. */
  handling: number;
  status?: { kind: StatusKind; chance: number; magnitude: number; durationTicks: number };

  /* --- the mechanics that make an archetype an archetype ------------------
   * The brief's bar is "genuinely different feel, not stat reskins". A gun that
   * differs only in its numbers is a reskin however carefully the numbers are
   * chosen, so each of these exists to give one family a verb the others do not
   * have. All are optional and all are generic: a future archetype composes
   * them rather than getting its own branch in the arena.
   */

  /** Hold to charge, release to fire. Damage scales; a full charge pierces. */
  charge?: { ticks: number; minMult: number; maxMult: number; pierceAtFull: number };
  /** Projectiles steer toward the nearest hostile. */
  homing?: { strength: number; range: number };
  /** On a connect, arc to nearby hostiles for reduced damage. */
  chain?: { jumps: number; range: number; falloff: number };
  /** Damage decays with distance: full to `start`, down to `min` by `end`. */
  falloff?: { start: number; end: number; min: number };
  /** Shots pass through this many bodies beyond the first. */
  pierce?: number;
  /** Leaves a burning patch where it lands. */
  lingers?: { radius: number; dps: number; durationTicks: number };

  /** Included in the starting kit. Everything else is found. */
  prototype: boolean;
  flavor: string;
}

export interface Affix {
  id: string;
  label: string;
  /** Multiplicative on the named derived stat unless `flat` is set. */
  stat: 'damage' | 'fireRate' | 'magazine' | 'reload' | 'crit' | 'critMult' | 'handling' | 'statusChance';
  value: number;
  flat?: boolean;
}

export interface WeaponInstance {
  uid: number;
  archetypeId: string;
  rarity: Rarity;
  /** Item level: scales base damage against zone tiers. */
  ilvl: number;
  affixes: Affix[];
  /** Set for hand-authored boss drops; suppresses procedural naming. */
  signature?: string;
  name: string;
  locked: boolean;
}

export interface MaterialStack {
  tier: MaterialTier;
  amount: number;
}

/* ------------------------------- arena ---------------------------------- */

/**
 * Arena space is genuinely three-dimensional.
 *
 * Convention, and it is worth stating once: **y is up and positive**, the ground
 * is y = 0, and x/z is the ground plane. `yaw` is the heading in that plane,
 * measured with `atan2(dz, dx)`, so yaw 0 faces +x. This matches the renderer's
 * convention exactly, which removes a whole class of sign-flip bugs at the
 * sim/presentation boundary.
 *
 * Bodies are upright cylinders: `radius` in the ground plane, `height` up from
 * the entity's feet. Cheap to test, and correct enough that a shot which looks
 * like it should connect does.
 */
export type Faction = 'player' | 'hostile';
export type EntityKind = 'player' | 'grunt' | 'skirmisher' | 'burrower' | 'artillery' | 'elite' | 'boss';

export interface Telegraph {
  shape: TelegraphShape;
  damageType: DamageType;
  /** Ground-plane origin. */
  x: number;
  z: number;
  radius: number;
  /** Heading for directional shapes (line, cone). */
  yaw: number;
  /** Ticks until it resolves. Counts down; presentation fills from it. */
  ticksLeft: number;
  totalTicks: number;
  damage: number;
  id: number;
}

export interface WeakPoint {
  id: string;
  label: string;
  /** Local-space offset: ox forward along the body's yaw, oz to its left, oy up. */
  ox: number;
  oy: number;
  oz: number;
  radius: number;
  /** Damage multiplier when struck. */
  multiplier: number;
  /** Weak points can be shuttered between phases. */
  exposed: boolean;
  /** Some weak points have their own health and break off. */
  health: number;
  healthMax: number;
  broken: boolean;
}

export interface Entity {
  id: number;
  kind: EntityKind;
  faction: Faction;
  defId: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  radius: number;
  height: number;
  yaw: number;
  def: Defences;
  statuses: Status[];
  /** AI blackboard. Contents are per-kind; always plain data so it serialises. */
  ai: Record<string, number>;
  weakPoints: WeakPoint[];
  phase: number;
  grounded: boolean;
  /** Ticks of invulnerability remaining (dodge i-frames, phase transitions). */
  iframes: number;
  /** Ticks of stagger; entity cannot act. */
  stunned: number;
  dead: boolean;
  /** Presentation-only cue counters; never read by sim logic. */
  hitFlash: number;
  /** Distance travelled on the ground, for driving walk cycles in the renderer. */
  gait: number;
}

export interface Projectile {
  id: number;
  ownerId: number;
  faction: Faction;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  damage: number;
  damageType: DamageType;
  radius: number;
  ticksLeft: number;
  /** Lobbed projectiles arc; hitscan traces resolve instantly and never appear here. */
  gravity: number;
  pierce: number;
  /** Steering toward the nearest hostile, for swarm munitions. */
  homing?: { strength: number; range: number };
  /** Distance travelled so far, for falloff. */
  travelled: number;
  falloff?: { start: number; end: number; min: number };
  chain?: { jumps: number; range: number; falloff: number };
  lingers?: { radius: number; dps: number; durationTicks: number };
  status?: { kind: StatusKind; chance: number; magnitude: number; durationTicks: number };
  crit: boolean;
}

/**
 * A patch of ground that keeps hurting whatever stands in it.
 *
 * Generic on purpose: it is a flamethrower's identity today and it is what a
 * future boss's caustic pool will be built from.
 */
export interface Hazard {
  id: number;
  x: number;
  z: number;
  radius: number;
  dps: number;
  damageType: DamageType;
  ticksLeft: number;
  totalTicks: number;
  /** Who laid it. A player hazard hurts hostiles and vice versa. */
  faction: Faction;
}

export interface DamageEvent {
  targetId: number;
  amount: number;
  layer: DefenceLayer;
  damageType: DamageType;
  crit: boolean;
  weak: boolean;
  x: number;
  y: number;
  z: number;
  tick: number;
}

/* ------------------------------ content --------------------------------- */

export interface EnemyDef {
  id: string;
  name: string;
  kind: EntityKind;
  radius: number;
  height: number;
  speed: number;
  defences: Omit<Defences, 'shieldCooldown'>;
  contactDamage: number;
  contactType: DamageType;
  /** Ticks between attacks. */
  attackInterval: number;
  attackDamage: number;
  attackType: DamageType;
  attackRange: number;
  /** Expected effective HP contribution for route maths; derived, not authored. */
  xp: number;
  matDrop: number;
  dataDrop: number;
}

/**
 * A timed exposure window — a phase's knowledge check.
 *
 * The Kiln Warden venting to cool itself and the Bellows drawing breath are the
 * same mechanic with different numbers and a different name, which is exactly
 * why this is data. A window opens a named weak point on a cycle, optionally
 * suppresses the boss's shield while open, and optionally drags the player in.
 */
export interface PhaseWindow {
  weakPointId: string;
  openTicks: number;
  periodTicks: number;
  /** Shield knitting is suppressed while the window is open. */
  suppressShield?: boolean;
  /** Ground-plane pull toward the boss while open, in units per tick. */
  pull?: number;
  /** Surfaced on the boss bar and used as the audio cue while open. */
  label: string;
}

export interface BossPhaseDef {
  /** Phase begins when health fraction drops at or below this. */
  atHealthFraction: number;
  name: string;
  /** What mechanically changes. Kept as data so the sim stays generic. */
  speedMult: number;
  attackIntervalMult: number;
  armorMult: number;
  shieldMult: number;
  /** Weak points exposed for the whole phase. */
  exposes: string[];
  /** A weak point exposed only on a cycle. See PhaseWindow. */
  window?: PhaseWindow;
  /** Adds spawned on entry. */
  spawns: { defId: string; count: number }[];
  /**
   * Ticks after the escort is *fully* cleared before it returns.
   *
   * Measured from the last one dying, not on a free-running timer: that is the
   * difference between "kill them fast and you get a window" and "the boss is
   * permanently invulnerable", which is what a free-running timer produced.
   */
  respawnTicks?: number;
  /**
   * The boss takes no damage while any non-boss hostile is alive. Turns its
   * escort into the actual fight, which is a different problem to solve than
   * "wait for the window".
   */
  invulnerableWhileAdds?: boolean;
  /** Arena gravity multiplier — failing grav plating, and similar. */
  gravityMult?: number;
  /** Arena-wide damage over time, e.g. rising kiln heat. */
  arenaDps: number;
  arenaDamageType: DamageType;
  /** Telegraph patterns available this phase. */
  patterns: string[];
  briefing: string;
}

export interface BossDef {
  id: string;
  name: string;
  epithet: string;
  zoneId: string;
  radius: number;
  height: number;
  speed: number;
  defences: Omit<Defences, 'shieldCooldown'>;
  weakPoints: Omit<WeakPoint, 'exposed' | 'broken' | 'health'>[];
  phases: BossPhaseDef[];
  /** Hand-authored guaranteed drop. */
  signatureDrop: string;
  codexId: string;
  matDrop: number;
  dataDrop: number;
}

export interface ZoneDef {
  id: string;
  planetId: string;
  name: string;
  subtitle: string;
  /** Orbital/derelict zones read differently and gate different materials. */
  kind: 'surface' | 'orbital';
  tier: MaterialTier;
  recommendedPower: number;
  enemyPool: string[];
  elite: string;
  bossId: string | null;
  /** Boss gate: all conditions must be met before the boss can be engaged. */
  gate: { kills: number; deposits: number; scans: number };
  /** Per-cycle idle yields at 1x. Integers by construction — see route.ts. */
  idle: { matPerCycle: number; dataPerCycle: number; cycleTicks: number; dropChance: number };
  depositTier: MaterialTier;
  accent: string;
  flavor: string;
}

export interface PlanetDef {
  id: string;
  name: string;
  epithet: string;
  /** One saturated accent per planet, per the art direction. */
  accent: string;
  /** Fuel cost to reach from the previous node. */
  fuel: number;
  zones: string[];
  flavor: string;
}

export interface TechNode {
  id: string;
  name: string;
  cost: number;
  requires: string[];
  /** Applied in derive.ts. Kept declarative so the tree is data, not code. */
  effect: { stat: string; value: number };
  description: string;
}

export interface ItemBase {
  id: string;
  name: string;
  archetypeId: string;
  /** Rarity floor for this base. Sovereign bases only drop from bosses. */
  minRarity: Rarity;
  flavor: string;
}
