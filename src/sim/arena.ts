/**
 * Active-play arena simulation, in three dimensions.
 *
 * Deterministic, fixed-step (40Hz), and completely headless: nothing in this
 * file knows a renderer exists. It consumes an `InputFrame` per tick and emits
 * `ArenaEvent`s that presentation turns into hitstop, shake, numbers and sound.
 * That separation is what lets the same encounter run under the 3D renderer,
 * under the widget's static frame, or under nothing at all in the headless CLI.
 *
 * Space: y is up and positive, ground at y = 0, x/z is the ground plane, and
 * `yaw` is a heading measured with `atan2(dz, dx)`. Bodies are upright
 * cylinders. The arena is a disc, which removes the "both actors crab-walk into
 * a corner" failure that a bounded corridor invites.
 *
 * Note on scope: converting this file from a side-on slice to a full 3D arena
 * did not require a single change to combat.ts, loot.ts, route.ts, offline.ts or
 * any of the economy. Geometry lives here; the economy is dimensionless. That
 * was the point of locking the architecture first.
 */
import {
  TICK_HZ,
  applyDamage,
  applyStatus,
  makeDefences,
  regenShield,
  tickStatuses,
} from './combat.js';
import type { ResolvedWeapon } from './derive.js';
import { PATTERNS, getBoss } from './content/bosses.js';
import type { BossPhaseDef } from './types.js';
import { getEnemy } from './content/enemies.js';
import { WEAPON_ARCHETYPES } from './content/weapons.js';
import { getZone } from './content/zones.js';
import { chance, makeRng, nextInt, nextRange, pick, type Rng } from './rng.js';
import { PI, TAU, angleDelta, atan2, clamp, cos, sin } from './trig.js';
import type {
  DamageType,
  Defences,
  Entity,
  EnemyDef,
  StatusKind,
  Telegraph,
  WeakPoint,
} from './types.js';

/** The terrace the fight happens on. A disc, so there are no corners to hide in. */
export const ARENA_RADIUS = 620;
const GRAVITY = 0.62;
const JUMP_V = 11.2;
const DODGE_TICKS = 13;
const DODGE_IFRAMES = 12;
const DODGE_COOLDOWN = 34;
const DODGE_SPEED = 9.5;
const MAX_ADDS = 14;
/** Close enough that a drop starts flying to you rather than waiting. */
const DROP_MAGNET = 190;
/** Close enough to have it. */
const DROP_PICKUP = 34;
const DROP_GRAVITY = 0.55;
/** Two seconds of grace after standing up. */
const REVIVE_IFRAMES = 80;
/** Nothing hostile stands closer than this to a player getting up. */
const REVIVE_CLEARANCE = 190;
/** The Warden holds its terrace rather than chasing the player to the rim. */
const BOSS_LEASH = 430;

export type ArenaEventType =
  | 'shot'
  | 'hit'
  | 'weak'
  | 'kill'
  | 'player-hit'
  | 'player-down'
  | 'reload'
  | 'dodge'
  | 'telegraph'
  | 'resolve'
  | 'phase'
  | 'vent'
  | 'warded'
  | 'chain'
  | 'boss-ready'
  | 'boss-down'
  | 'mined'
  | 'scanned'
  | 'drop'
  | 'pickup'
  | 'revive'
  | 'gate';

export interface ArenaEvent {
  type: ArenaEventType;
  x: number;
  y: number;
  z: number;
  amount: number;
  text: string;
  damageType: DamageType;
  crit: boolean;
  id: number;
}

export interface Deposit {
  id: number;
  x: number;
  z: number;
  tier: number;
  progress: number;
  required: number;
  depleted: boolean;
  yield: number;
}

export interface ScanSite {
  id: number;
  x: number;
  z: number;
  progress: number;
  required: number;
  done: boolean;
  yield: number;
}

export interface PlayerRuntime {
  entityId: number;
  ammo: number;
  reloadLeft: number;
  fireCooldown: number;
  dodgeLeft: number;
  dodgeCooldown: number;
  dodgeYaw: number;
  /** Solar lance ramp: rises while a beam stays on target, decays otherwise. */
  beamRamp: number;
  interactProgress: number;
  interactTargetId: number;
  aimYaw: number;
  aimPitch: number;
  /** Accumulated recoil, in radians of pitch. Presentation reads it too. */
  recoil: number;
  /** Ticks of charge held, for charge weapons. 0 for everything else. */
  charge: number;
  /** The charge ceiling for the equipped weapon; 0 if it does not charge. */
  chargeMax: number;
  /**
   * The distance at which the equipped weapon still does most of its damage.
   *
   * Falloff makes "range" a lie: a scattergun reaches 190 units and is doing a
   * fifth of its damage at 150. Anything deciding how to space a fight — the
   * HUD, the reference policy — needs the useful number, not the maximum one.
   */
  effectiveRange: number;
  /** Last tick's fire input, so a charge weapon can fire on release. */
  wasFiring: boolean;
}

/**
 * A weapon lying where its owner fell.
 *
 * The arena knows a drop's position, its rarity and nothing else — not what
 * the weapon is, not what it rolls for, not whether the hold has room. That
 * stays in `sim.ts`, so the arena remains an encounter sim with no opinion
 * about inventories.
 *
 * Ownership is not in question at any point: `sim.ts` banks the item the
 * instant the kill lands, exactly as it always did. This is the part you can
 * see. Walking over it is how the game tells you what you got and when, not a
 * condition for getting it — a run that ends with drops still on the sand
 * collects them anyway. Loot you have to scramble for before a timer is a
 * different game, and a worse one.
 */
export interface ArenaDrop {
  /** Matches the banked item's uid, so `sim.ts` can name it on pickup. */
  uid: number;
  x: number;
  y: number;
  z: number;
  vy: number;
  /** Colour only. The arena does not know what rarity means. */
  rarity: string;
  /** Ticks since it landed, for the glint. */
  age: number;
  taken: boolean;
}

export interface ArenaState {
  zoneId: string;
  tick: number;
  rng: Rng;
  entities: Entity[];
  projectiles: import('./types.js').Projectile[];
  telegraphs: Telegraph[];
  hazards: import('./types.js').Hazard[];
  deposits: Deposit[];
  scans: ScanSite[];
  drops: ArenaDrop[];
  player: PlayerRuntime;
  nextId: number;
  waveTimer: number;
  wavesSpawned: number;
  kills: number;
  minedCount: number;
  scannedCount: number;
  matBanked: number;
  dataBanked: number;
  gateMet: boolean;
  bossSpawned: boolean;
  bossEntityId: number;
  bossPhase: number;
  patternCooldowns: Record<string, number>;
  outcome: 'running' | 'cleared' | 'down';
  events: ArenaEvent[];
  /** Set by the active boss phase; 1 unless something has gone wrong with it. */
  gravityMult: number;
  /** Presentation-only; the sim writes these, never reads them. */
  shake: number;
  hitstop: number;
  armorRegen: number;
  killRecovery: number;
}

export interface InputFrame {
  /** Camera-relative movement: +moveZ is "away from camera". */
  moveX: number;
  moveZ: number;
  /** The camera's heading, so the sim can resolve camera-relative movement. */
  camYaw: number;
  jump: boolean;
  dodge: boolean;
  fire: boolean;
  reload: boolean;
  interact: boolean;
  /** Where the player is aiming, in world space. */
  aimYaw: number;
  aimPitch: number;
  /** -1 for "no change". */
  swapSlot: number;
  summonBoss: boolean;
}

export const NEUTRAL_INPUT: InputFrame = {
  moveX: 0,
  moveZ: 0,
  camYaw: 0,
  jump: false,
  dodge: false,
  fire: false,
  reload: false,
  interact: false,
  aimYaw: 0,
  aimPitch: 0,
  swapSlot: -1,
  summonBoss: false,
};

/* ------------------------------ geometry --------------------------------- */

export function horizDist(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dz * dz);
}

/** World position of a weak point, with its local offset rotated by body yaw. */
export function weakPointPos(e: Entity, w: { ox: number; oy: number; oz: number }): { x: number; y: number; z: number } {
  const c = cos(e.yaw);
  const s = sin(e.yaw);
  return {
    x: e.x + w.ox * c - w.oz * s,
    y: e.y + w.oy,
    z: e.z + w.ox * s + w.oz * c,
  };
}

/** Upright-cylinder containment. */
function inBody(e: Entity, x: number, y: number, z: number): boolean {
  if (y < e.y || y > e.y + e.height) return false;
  return horizDist(x, z, e.x, e.z) <= e.radius;
}

/** Keeps an entity inside the terrace. */
function clampToArena(e: Entity): void {
  const d = horizDist(0, 0, e.x, e.z);
  const limit = ARENA_RADIUS - e.radius;
  if (d > limit && d > 0) {
    const k = limit / d;
    e.x *= k;
    e.z *= k;
  }
}

function emit(a: ArenaState, e: Partial<ArenaEvent> & { type: ArenaEventType }): void {
  a.events.push({
    x: 0,
    y: 0,
    z: 0,
    amount: 0,
    text: '',
    damageType: 'percussive',
    crit: false,
    id: 0,
    ...e,
  });
}

/* ------------------------------ construction ------------------------------ */

function makeEntity(a: ArenaState, def: EnemyDef, x: number, z: number, scale: number): Entity {
  return {
    id: a.nextId++,
    kind: def.kind,
    faction: 'hostile',
    defId: def.id,
    x,
    y: 0,
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    radius: def.radius,
    height: def.height,
    yaw: 0,
    def: makeDefences(def.defences, scale),
    statuses: [],
    ai: { cd: 0, state: 0, timer: 0 },
    weakPoints: [],
    phase: 0,
    grounded: true,
    iframes: 0,
    stunned: 0,
    dead: false,
    hitFlash: 0,
    gait: 0,
  };
}

export function createArena(zoneId: string, seed: number, playerDefences: Defences, scanSpeed: number): ArenaState {
  const zone = getZone(zoneId);
  const rng = makeRng(seed);
  const a: ArenaState = {
    zoneId,
    tick: 0,
    rng,
    entities: [],
    projectiles: [],
    telegraphs: [],
    hazards: [],
    deposits: [],
    scans: [],
    drops: [],
    player: {
      entityId: 0,
      ammo: 0,
      reloadLeft: 0,
      fireCooldown: 0,
      dodgeLeft: 0,
      dodgeCooldown: 0,
      dodgeYaw: 0,
      beamRamp: 0,
      interactProgress: 0,
      interactTargetId: -1,
      aimYaw: 0,
      aimPitch: 0,
      recoil: 0,
      charge: 0,
      chargeMax: 0,
      effectiveRange: 0,
      wasFiring: false,
    },
    nextId: 1,
    waveTimer: 90,
    wavesSpawned: 0,
    kills: 0,
    minedCount: 0,
    scannedCount: 0,
    matBanked: 0,
    dataBanked: 0,
    gateMet: false,
    bossSpawned: false,
    bossEntityId: -1,
    bossPhase: 0,
    patternCooldowns: {},
    outcome: 'running',
    events: [],
    gravityMult: 1,
    shake: 0,
    hitstop: 0,
    armorRegen: 0,
    killRecovery: 0,
  };

  const player: Entity = {
    id: a.nextId++,
    kind: 'player',
    faction: 'player',
    defId: 'player',
    x: 0,
    y: 0,
    z: 260,
    vx: 0,
    vy: 0,
    vz: 0,
    radius: 11,
    height: 42,
    yaw: -PI / 2,
    def: { ...playerDefences },
    statuses: [],
    ai: {},
    weakPoints: [],
    phase: 0,
    grounded: true,
    iframes: 0,
    stunned: 0,
    dead: false,
    hitFlash: 0,
    gait: 0,
  };
  a.entities.push(player);
  a.player.entityId = player.id;

  // Deposits and scan sites are scattered deterministically from the seed, so a
  // given zone and seed is the same terrace every time you land on it. They are
  // pushed out toward the rim so that gathering means crossing open ground.
  const depositCount = zone.gate.deposits + 3;
  for (let i = 0; i < depositCount; i++) {
    const ang = (i / depositCount) * TAU + nextRange(rng, -0.35, 0.35);
    const r = nextRange(rng, ARENA_RADIUS * 0.35, ARENA_RADIUS * 0.86);
    a.deposits.push({
      id: a.nextId++,
      x: cos(ang) * r,
      z: sin(ang) * r,
      tier: zone.depositTier,
      progress: 0,
      required: 150,
      depleted: false,
      yield: 18 + nextInt(rng, 0, 10),
    });
  }
  const scanCount = zone.gate.scans + 3;
  for (let i = 0; i < scanCount; i++) {
    const ang = (i / scanCount) * TAU + nextRange(rng, -0.4, 0.4) + 0.6;
    const r = nextRange(rng, ARENA_RADIUS * 0.3, ARENA_RADIUS * 0.8);
    a.scans.push({
      id: a.nextId++,
      x: cos(ang) * r,
      z: sin(ang) * r,
      progress: 0,
      required: Math.max(40, Math.round(240 / scanSpeed)),
      done: false,
      yield: 12 + nextInt(rng, 0, 8),
    });
  }
  return a;
}

export function playerEntity(a: ArenaState): Entity {
  return a.entities.find((e) => e.id === a.player.entityId)!;
}

export function bossEntity(a: ArenaState): Entity | null {
  if (a.bossEntityId < 0) return null;
  return a.entities.find((e) => e.id === a.bossEntityId) ?? null;
}

/* ------------------------------- spawning --------------------------------- */

function spawnWave(a: ArenaState): void {
  const zone = getZone(a.zoneId);
  const living = a.entities.filter((e) => e.faction === 'hostile' && !e.dead).length;
  if (living >= MAX_ADDS) return;
  const count = 2 + Math.min(3, Math.floor(a.wavesSpawned / 3));
  const p = playerEntity(a);
  for (let i = 0; i < count; i++) {
    const id = pick(a.rng, zone.enemyPool);
    const ang = nextRange(a.rng, 0, TAU);
    const dist = nextRange(a.rng, 380, 560);
    const x = clamp(p.x + cos(ang) * dist, -ARENA_RADIUS, ARENA_RADIUS);
    const z = clamp(p.z + sin(ang) * dist, -ARENA_RADIUS, ARENA_RADIUS);
    const e = makeEntity(a, getEnemy(id), x, z, 1);
    clampToArena(e);
    a.entities.push(e);
  }
  // Every fourth wave brings the zone elite. It is a difficulty spike on
  // purpose: the elite is the rehearsal for reading the boss.
  if (a.wavesSpawned > 0 && a.wavesSpawned % 4 === 0) {
    const ang = nextRange(a.rng, 0, TAU);
    const e = makeEntity(a, getEnemy(zone.elite), p.x + cos(ang) * 500, p.z + sin(ang) * 500, 1);
    clampToArena(e);
    a.entities.push(e);
  }
  a.wavesSpawned += 1;
}

/**
 * Calls the boss.
 *
 * The terrace goes quiet first: remaining adds withdraw, live ordnance clears,
 * and the player is restored. A set-piece should start from a known state — if
 * the fight's difficulty depends on how chewed up the approach left you, nobody
 * can learn it, and learning it is the whole point.
 */
/**
 * Puts a downed player back on their feet without discarding the approach.
 *
 * Landing again used to be the only option, and it built a fresh arena: kills,
 * deposits and scans all back to zero, and another crossing's fuel charged for
 * the privilege. Dying at 20 of 24 kills meant redoing the whole ninety
 * seconds, which is not difficulty, it is a tax on having been nearly there.
 *
 * A boss on the field is the one exception, and for the reason `summonBoss`
 * already gives: a set-piece has to start from a known state or nobody can
 * learn it. So the boss withdraws and the approach stays cleared — you replay
 * the fight, not the grind that unlocked it.
 */
export function revivePlayer(a: ArenaState, def: Defences): boolean {
  const p = playerEntity(a);
  if (a.outcome !== 'down') return false;

  if (a.bossSpawned) {
    for (const e of a.entities) {
      if (e.faction === 'hostile') e.dead = true;
    }
    a.bossSpawned = false;
    a.bossEntityId = -1;
    a.wavesSpawned = 0;
  }

  p.dead = false;
  p.def = { ...def };
  // Long enough to get oriented, and to stop a revive landing straight back
  // in the attack that did it.
  p.iframes = REVIVE_IFRAMES;
  p.stunned = 0;
  p.statuses.length = 0;
  a.outcome = 'running';
  a.hitstop = 0;

  // Nothing already in the air may land on a player who has just stood up.
  a.projectiles = a.projectiles.filter((pr) => pr.faction !== 'hostile');
  a.telegraphs.length = 0;

  // Shove anything standing over the body back to arm's length.
  for (const e of a.entities) {
    if (e.faction !== 'hostile' || e.dead) continue;
    const dx = e.x - p.x;
    const dz = e.z - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d >= REVIVE_CLEARANCE) continue;
    const ang = d > 0.01 ? atan2(dz, dx) : nextRange(a.rng, 0, TAU);
    e.x = p.x + cos(ang) * REVIVE_CLEARANCE;
    e.z = p.z + sin(ang) * REVIVE_CLEARANCE;
    clampToArena(e);
  }

  a.waveTimer = Math.max(a.waveTimer, 120);
  emit(a, { type: 'revive', x: p.x, y: p.y, z: p.z, id: p.id });
  return true;
}

export function summonBoss(a: ArenaState): boolean {
  const zone = getZone(a.zoneId);
  if (!zone.bossId || a.bossSpawned || !a.gateMet) return false;
  const def = getBoss(zone.bossId);

  for (const e of a.entities) {
    if (e.faction === 'hostile') e.dead = true;
  }
  a.projectiles.length = 0;
  a.telegraphs.length = 0;
  const player = a.entities.find((e) => e.id === a.player.entityId);
  if (player) {
    player.def.health = player.def.healthMax;
    player.def.shield = player.def.shieldMax;
    player.def.armor = player.def.armorMax;
    player.statuses.length = 0;
  }

  const e: Entity = {
    id: a.nextId++,
    kind: 'boss',
    faction: 'hostile',
    defId: def.id,
    x: 0,
    y: 0,
    z: -240,
    vx: 0,
    vy: 0,
    vz: 0,
    radius: def.radius,
    height: def.height,
    yaw: PI / 2,
    def: makeDefences(def.defences, 1),
    statuses: [],
    ai: { cd: 60, vent: 0, ventCd: 200, patternCd: 90 },
    weakPoints: def.weakPoints.map<WeakPoint>((w) => ({
      ...w,
      exposed: false,
      health: w.healthMax,
      broken: false,
    })),
    phase: 0,
    grounded: true,
    iframes: 40,
    stunned: 0,
    dead: false,
    hitFlash: 0,
    gait: 0,
  };
  a.entities.push(e);
  a.bossEntityId = e.id;
  a.bossSpawned = true;
  a.bossPhase = 0;
  applyPhase(a, e, 0);
  emit(a, { type: 'phase', x: e.x, y: e.y, z: e.z, text: def.phases[0]!.name, id: 0 });
  return true;
}

function applyPhase(a: ArenaState, e: Entity, phase: number): void {
  const def = getBoss(e.defId);
  const p = def.phases[phase];
  if (!p) return;
  e.phase = phase;
  a.bossPhase = phase;
  e.def.armorMax = def.defences.armorMax * p.armorMult;
  e.def.armor = Math.min(e.def.armor, e.def.armorMax);
  e.def.shieldMax = def.defences.shieldMax * p.shieldMult;
  e.def.shield = Math.min(e.def.shield, e.def.shieldMax);
  for (const w of e.weakPoints) w.exposed = p.exposes.includes(w.id);
  // A window starts closed and on a full period, so entering a phase never
  // hands the player a free opening they did not earn.
  e.ai.winOpen = 0;
  e.ai.winCd = p.window ? p.window.periodTicks : 0;
  e.ai.respawnCd = p.respawnTicks ?? 0;
  spawnEscort(a, e, p);
  e.iframes = Math.max(e.iframes, 34);
  a.shake = Math.max(a.shake, 14);
}

function spawnEscort(a: ArenaState, e: Entity, p: BossPhaseDef): void {
  for (const s of p.spawns) {
    for (let i = 0; i < s.count; i++) {
      const ang = nextRange(a.rng, 0, TAU);
      const d = nextRange(a.rng, 200, 420);
      const add = makeEntity(a, getEnemy(s.defId), e.x + cos(ang) * d, e.z + sin(ang) * d, 1);
      clampToArena(add);
      a.entities.push(add);
    }
  }
}

/* -------------------------------- damage ---------------------------------- */

function hitWeakPoint(e: Entity, x: number, y: number, z: number): WeakPoint | null {
  for (const w of e.weakPoints) {
    if (!w.exposed || w.broken) continue;
    const p = weakPointPos(e, w);
    const dx = x - p.x;
    const dy = y - p.y;
    const dz = z - p.z;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= w.radius) return w;
  }
  return null;
}

/**
 * Killing something patches you up a little. Shields knit on their own and
 * plate self-repairs, but health only comes back by staying on the offensive —
 * which is the behaviour the fight wants to reward anyway.
 */
function grantKillRecovery(a: ArenaState): void {
  const p = a.entities.find((e) => e.id === a.player.entityId);
  if (!p || p.dead || a.killRecovery <= 0) return;
  p.def.health = Math.min(p.def.healthMax, p.def.health + p.def.healthMax * a.killRecovery);
}

export interface HitResult {
  dealt: number;
  weak: boolean;
  killed: boolean;
}

const NO_HIT: HitResult = { dealt: 0, weak: false, killed: false };

/**
 * The one place something dies.
 *
 * There are three ways to kill a hostile — a shot, a damage-over-time tick, and
 * standing in fire — and until this existed each one had its own copy of the
 * bookkeeping. They had already drifted: the status path forgot to grant kill
 * recovery, and the hazard path reported a dead boss as an ordinary kill, which
 * crashed the moment a flamethrower finished the Kiln Warden.
 */
function killEntity(a: ArenaState, e: Entity): void {
  if (e.dead) return;
  e.dead = true;
  const isBoss = e.kind === 'boss';
  if (!isBoss) a.kills += 1;
  grantKillRecovery(a);
  emit(a, { type: isBoss ? 'boss-down' : 'kill', x: e.x, y: e.y, z: e.z, id: e.id, text: e.defId });
  if (isBoss) {
    a.outcome = 'cleared';
    a.shake = 30;
  }
}

function damageEntity(
  a: ArenaState,
  e: Entity,
  amount: number,
  type: DamageType,
  hx: number,
  hy: number,
  hz: number,
  crit: boolean,
  critMult: number,
): HitResult {
  if (e.dead || e.iframes > 0) return NO_HIT;
  if (e.kind === 'boss' && bossIsWarded(a, e)) {
    // Warded rather than immune-and-silent: the player gets a distinct cue and
    // a number-free spark, so "shoot the escort" is learnable from one attempt.
    emit(a, { type: 'warded', x: hx, y: hy, z: hz, damageType: type, id: e.id });
    return NO_HIT;
  }
  const wp = hitWeakPoint(e, hx, hy, hz);
  const weakMult = wp ? wp.multiplier : 1;
  const res = applyDamage(e.def, amount, type, { crit, critMult, weakMult });
  e.hitFlash = 4;
  if (wp) {
    wp.health -= res.dealt;
    if (wp.health <= 0) {
      wp.broken = true;
      wp.exposed = false;
      a.shake = Math.max(a.shake, 10);
      emit(a, { type: 'weak', x: hx, y: hy, z: hz, amount: res.dealt, text: `${wp.label} broken`, damageType: type, crit, id: e.id });
    } else {
      emit(a, { type: 'weak', x: hx, y: hy, z: hz, amount: res.dealt, text: wp.label, damageType: type, crit, id: e.id });
    }
  } else {
    emit(a, { type: 'hit', x: hx, y: hy, z: hz, amount: res.dealt, damageType: type, crit, id: e.id });
  }

  if (res.killed) {
    killEntity(a, e);
  } else if (e.kind === 'boss') {
    const def = getBoss(e.defId);
    const frac = e.def.health / e.def.healthMax;
    for (let p = def.phases.length - 1; p > e.phase; p--) {
      if (frac <= def.phases[p]!.atHealthFraction) {
        applyPhase(a, e, p);
        emit(a, { type: 'phase', x: e.x, y: e.y, z: e.z, text: def.phases[p]!.name, id: p });
        break;
      }
    }
  }
  return { dealt: res.dealt, weak: !!wp, killed: res.killed };
}

/**
 * Hitstop: the frame-freeze on a solid connect.
 *
 * This is most of what separates a weapon that feels like it hit something from
 * one that feels like it emitted a particle, so it is sim state rather than a
 * renderer flourish — it is deterministic, it is recorded, and a replay of the
 * same seed stutters in the same places.
 *
 * Two rules keep it from becoming a stutter:
 *  - Beams never freeze. A twenty-shots-a-second weapon that hitches on every
 *    tick reads as a dropped frame, not as impact.
 *  - Fast weapons only freeze on something worth freezing for — a weak point, a
 *    crit, or a kill. Slow, committed weapons freeze on every connect, because
 *    that is the entire promise of firing one.
 */
const HITSTOP_TICKS_PER_FRAME = 40 / 60;
const SLOW_WEAPON_INTERVAL = 20;

function registerHit(a: ArenaState, w: ResolvedWeapon, res: HitResult, crit: boolean): void {
  if (res.dealt <= 0 || w.behavior === 'beam') return;
  const notable = res.weak || res.killed || crit;
  if (!notable && w.fireInterval < SLOW_WEAPON_INTERVAL) return;
  const scale = res.weak ? 1.7 : res.killed ? 1.35 : crit ? 1.2 : 1;
  const ticks = Math.round(w.hitstop * HITSTOP_TICKS_PER_FRAME * scale);
  a.hitstop = Math.max(a.hitstop, Math.min(9, ticks));
}

/** True while a phase's escort is alive and that phase wards the boss. */
export function bossIsWarded(a: ArenaState, e: Entity): boolean {
  const phase = getBoss(e.defId).phases[e.phase];
  if (!phase?.invulnerableWhileAdds) return false;
  return a.entities.some((o) => o.faction === 'hostile' && !o.dead && o.kind !== 'boss');
}

function damagePlayer(a: ArenaState, amount: number, type: DamageType): void {
  const p = playerEntity(a);
  if (p.dead || p.iframes > 0) return;
  const res = applyDamage(p.def, amount, type, {});
  if (res.dealt > 0) {
    a.shake = Math.max(a.shake, Math.min(12, amount * 0.2));
    emit(a, { type: 'player-hit', x: p.x, y: p.y + p.height, z: p.z, amount: res.dealt, damageType: type, id: p.id });
  }
  if (res.killed) {
    p.dead = true;
    a.outcome = 'down';
    emit(a, { type: 'player-down', x: p.x, y: p.y, z: p.z, id: p.id });
  }
}

/* -------------------------------- firing ---------------------------------- */

interface TraceHit {
  e: Entity;
  x: number;
  y: number;
  z: number;
}

/**
 * Traces a shot and reports where it lands.
 *
 * The subtlety is weak points: a body hit resolves where the ray enters the
 * cylinder, which is almost never inside a weak-point sphere sitting deeper in
 * the model. So once the first body is found the trace keeps walking *through
 * that same entity* looking for a weak point, and prefers it. Without this,
 * weak points are effectively unhittable and the whole knowledge-reward layer
 * of the boss design is decorative.
 */
/**
 * Distance falloff. Full damage out to `start`, decaying linearly to `min` by
 * `end`. This is what makes a scattergun a scattergun: without it, range is a
 * hard cutoff and the weapon reads as a rifle that stops working.
 */
function falloffAt(f: { start: number; end: number; min: number } | undefined, distance: number): number {
  if (!f || distance <= f.start) return 1;
  if (distance >= f.end) return f.min;
  const t = (distance - f.start) / Math.max(1, f.end - f.start);
  return 1 + (f.min - 1) * t;
}

/**
 * Collects up to `maxTargets` distinct bodies along the ray, nearest first.
 *
 * One target is the ordinary case; more is what a rail's pierce buys. The
 * weak-point preference below applies to each body independently, so a piercing
 * shot can crit a weak point on the second target it passes through.
 */
function traceHitscanAll(
  a: ArenaState,
  ox: number,
  oy: number,
  oz: number,
  yaw: number,
  pitch: number,
  range: number,
  maxTargets: number,
): TraceHit[] {
  const hits: TraceHit[] = [];
  const seen = new Set<number>();
  const cp = cos(pitch);
  const dx = cp * cos(yaw);
  const dy = sin(pitch);
  const dz = cp * sin(yaw);
  const step = 4;
  let inside: { e: Entity; enteredAt: number; best: TraceHit | null } | null = null;

  const commit = () => {
    if (!inside) return;
    hits.push(inside.best ?? { e: inside.e, x: ox + dx * inside.enteredAt, y: oy + dy * inside.enteredAt, z: oz + dz * inside.enteredAt });
    seen.add(inside.e.id);
    inside = null;
  };

  for (let t = 6; t <= range && hits.length < maxTargets; t += step) {
    const x = ox + dx * t;
    const y = oy + dy * t;
    const z = oz + dz * t;
    if (y < 0) break;

    if (inside) {
      const wp = hitWeakPoint(inside.e, x, y, z);
      if (wp) {
        inside.best = { e: inside.e, x, y, z };
        commit();
        continue;
      }
      if (t > inside.enteredAt + inside.e.radius * 2 + inside.e.height) commit();
      continue;
    }
    for (const e of a.entities) {
      if (e.faction !== 'hostile' || e.dead || seen.has(e.id)) continue;
      if (hitWeakPoint(e, x, y, z)) {
        hits.push({ e, x, y, z });
        seen.add(e.id);
        break;
      }
      if (inBody(e, x, y, z)) {
        inside = { e, enteredAt: t, best: null };
        break;
      }
    }
  }
  commit();
  return hits.slice(0, maxTargets);
}

type StatusApplication = { kind: StatusKind; chance: number; magnitude: number; durationTicks: number };

/** Built once from the archetype table; keyed by archetype id. */
const ARCH_STATUS: Record<string, StatusApplication> = (() => {
  const out: Record<string, StatusApplication> = {};
  for (const w of WEAPON_ARCHETYPES) if (w.status) out[w.id] = w.status;
  return out;
})();

function statusFor(w: ResolvedWeapon): StatusApplication | null {
  // Pulled from the archetype rather than the instance: affixes scale the
  // chance (statusChanceMult), they do not change which status a gun applies.
  return ARCH_STATUS[w.archetypeId] ?? null;
}

/**
 * Arcs from a connect to nearby hostiles, for reduced damage each jump.
 *
 * Emits its own hit events so the tracer and the sound follow the arc — a chain
 * the player cannot see is a damage buff, not a mechanic.
 */
function chainFrom(
  a: ArenaState,
  origin: Entity,
  x: number,
  y: number,
  z: number,
  damage: number,
  type: DamageType,
  chain: { jumps: number; range: number; falloff: number },
): void {
  let fromX = x;
  let fromZ = z;
  const struck = new Set<number>([origin.id]);
  let power = damage;

  for (let j = 0; j < chain.jumps; j++) {
    let target: Entity | null = null;
    let bestD = chain.range;
    for (const e of a.entities) {
      if (e.faction !== 'hostile' || e.dead || struck.has(e.id) || e.iframes > 0) continue;
      const d = horizDist(e.x, e.z, fromX, fromZ);
      if (d < bestD) {
        bestD = d;
        target = e;
      }
    }
    if (!target) return;
    power *= chain.falloff;
    struck.add(target.id);
    const ty = target.y + target.height * 0.5;
    emit(a, { type: 'chain', x: fromX, y, z: fromZ, amount: bestD, text: String(target.id), damageType: type, id: target.id });
    damageEntity(a, target, power, type, target.x, ty, target.z, false, 1);
    fromX = target.x;
    fromZ = target.z;
  }
}

function maybeStatus(a: ArenaState, e: Entity, w: ResolvedWeapon, statusMult: number): void {
  const status = statusFor(w);
  if (!status) return;
  if (chance(a.rng, Math.min(0.95, status.chance * statusMult))) {
    applyStatus(e.statuses, status.kind, status.magnitude, status.durationTicks, w.damageType);
  }
}

/**
 * Fires one shot.
 *
 * `chargeMult` is 1 for everything except a rail, which pays for its damage by
 * making you commit to holding the trigger.
 */
function fireWeapon(a: ArenaState, w: ResolvedWeapon, statusMult: number, chargeMult = 1, extraPierce = 0): void {
  const p = playerEntity(a);
  const pr = a.player;
  const ox = p.x;
  const oy = p.y + p.height * 0.72;
  const oz = p.z;
  emit(a, {
    type: 'shot',
    x: ox,
    y: oy,
    z: oz,
    amount: w.recoil * chargeMult,
    text: w.archetypeId,
    damageType: w.damageType,
    id: p.id,
  });

  const pierce = (w.pierce ?? 0) + extraPierce;

  for (let i = 0; i < w.pellets; i++) {
    const yaw = pr.aimYaw + nextRange(a.rng, -w.spread, w.spread);
    const pitch = pr.aimPitch + nextRange(a.rng, -w.spread, w.spread);
    const crit = chance(a.rng, w.critChance);

    if (w.behavior === 'hitscan' || w.behavior === 'beam') {
      const ramp = w.behavior === 'beam' ? 1 + pr.beamRamp * 0.9 : 1;
      const hits = traceHitscanAll(a, ox, oy, oz, yaw, pitch, w.range, 1 + pierce);
      for (let h = 0; h < hits.length; h++) {
        const hit = hits[h]!;
        const travelled = Math.sqrt(
          (hit.x - ox) * (hit.x - ox) + (hit.y - oy) * (hit.y - oy) + (hit.z - oz) * (hit.z - oz),
        );
        // Each body past the first costs the shot something, so pierce is a
        // reward for lining targets up rather than a flat multiplier.
        const pierceDecay = Math.pow(0.82, h);
        const dmg = w.damage * ramp * chargeMult * falloffAt(w.falloff, travelled) * pierceDecay;
        const res = damageEntity(a, hit.e, dmg, w.damageType, hit.x, hit.y, hit.z, crit, w.critMult);
        if (h === 0) registerHit(a, w, res, crit);
        maybeStatus(a, hit.e, w, statusMult);
        if (w.chain) chainFrom(a, hit.e, hit.x, hit.y, hit.z, dmg * w.chain.falloff, w.damageType, w.chain);
        if (w.behavior === 'beam') pr.beamRamp = Math.min(1, pr.beamRamp + 0.012);
      }
      if (hits.length === 0 && w.behavior === 'beam') pr.beamRamp = Math.max(0, pr.beamRamp - 0.03);
    } else {
      const speed = w.projectileSpeed;
      // A lob is aimed above the line of sight so the arc lands where you look.
      const p2 = w.behavior === 'lob' ? pitch + 0.28 : pitch;
      const cp = cos(p2);
      a.projectiles.push({
        id: a.nextId++,
        ownerId: p.id,
        faction: 'player',
        x: ox,
        y: oy,
        z: oz,
        vx: cp * cos(yaw) * speed,
        vy: sin(p2) * speed,
        vz: cp * sin(yaw) * speed,
        damage: w.damage * chargeMult,
        damageType: w.damageType,
        radius: 6,
        ticksLeft: Math.round(w.range / Math.max(1, speed)) + 20,
        gravity: w.behavior === 'lob' ? 0.24 : 0,
        pierce,
        travelled: 0,
        ...(w.lingers ? { lingers: w.lingers } : {}),
        ...(w.homing ? { homing: w.homing } : {}),
        ...(w.falloff ? { falloff: w.falloff } : {}),
        ...(w.chain ? { chain: w.chain } : {}),
        crit,
      });
    }
  }
  pr.recoil = Math.min(0.16, pr.recoil + w.recoil * 0.004 * chargeMult);
}

/**
 * The trigger, including the charge weapons' hold-and-release.
 *
 * Kept apart from `fireWeapon` because "when does a shot happen" and "what does
 * a shot do" are different questions, and a rail only differs in the first.
 */
function stepTrigger(a: ArenaState, w: ResolvedWeapon, firing: boolean): void {
  const pr = a.player;
  const p = playerEntity(a);
  const ready = pr.fireCooldown <= 0 && pr.ammo > 0 && pr.reloadLeft <= 0 && p.stunned <= 0;
  pr.chargeMax = w.charge?.ticks ?? 0;
  // Where the weapon still does at least 60% of its damage.
  pr.effectiveRange = w.falloff
    ? w.falloff.start + (w.falloff.end - w.falloff.start) * Math.max(0, (1 - 0.6) / (1 - w.falloff.min))
    : w.range;

  if (w.charge) {
    // Hold to charge, release to fire. Holding at full is a real choice: it
    // costs you mobility and reaction time, and the shot is worth it.
    if (firing && ready) {
      pr.charge = Math.min(w.charge.ticks, pr.charge + 1);
    } else if (!firing && pr.wasFiring && pr.charge > 0 && ready) {
      const t = pr.charge / w.charge.ticks;
      const mult = w.charge.minMult + (w.charge.maxMult - w.charge.minMult) * t;
      const extraPierce = t >= 0.999 ? w.charge.pierceAtFull : 0;
      fireWeapon(a, w, w.statusChanceMult, mult, extraPierce);
      pr.ammo -= 1;
      pr.fireCooldown = w.fireInterval;
      pr.charge = 0;
    } else if (!firing) {
      pr.charge = 0;
    }
    pr.wasFiring = firing;
    return;
  }

  pr.charge = 0;
  pr.wasFiring = firing;
  if (firing && ready) {
    fireWeapon(a, w, w.statusChanceMult);
    pr.ammo -= 1;
    pr.fireCooldown = w.fireInterval;
  }
}

/* ---------------------------------- AI ------------------------------------ */

function stepHostile(a: ArenaState, e: Entity, p: Entity): void {
  // The boss runs its own phase machine and has no EnemyDef to look up.
  if (e.kind === 'boss') return stepBoss(a, e, p);
  const def = getEnemy(e.defId);

  const dx = p.x - e.x;
  const dz = p.z - e.z;
  const distance = Math.sqrt(dx * dx + dz * dz);
  const toPlayer = atan2(dz, dx);
  e.yaw = toPlayer;
  e.ai.cd = (e.ai.cd ?? 0) - 1;

  const advance = (speed: number) => {
    e.vx = cos(toPlayer) * speed;
    e.vz = sin(toPlayer) * speed;
  };
  const retreat = (speed: number) => {
    e.vx = -cos(toPlayer) * speed;
    e.vz = -sin(toPlayer) * speed;
  };
  const strafe = (speed: number) => {
    e.vx = cos(toPlayer + PI / 2) * speed;
    e.vz = sin(toPlayer + PI / 2) * speed;
  };

  switch (e.kind) {
    case 'grunt': {
      advance(def.speed);
      if (distance < def.attackRange + e.radius + p.radius && (e.ai.cd ?? 0) <= 0) {
        damagePlayer(a, def.contactDamage, def.contactType);
        e.ai.cd = def.attackInterval;
      }
      break;
    }
    case 'skirmisher': {
      // Holds a band and circles: closes when far, backs off when crowded.
      const want = def.attackRange * 0.9;
      if (distance > want + 40) advance(def.speed);
      else if (distance < want - 50) retreat(def.speed * 0.8);
      else strafe(def.speed * 0.7);
      if (distance < def.attackRange * 1.2 && (e.ai.cd ?? 0) <= 0) {
        shootAtPlayer(a, e, p, def, 12);
        e.ai.cd = def.attackInterval;
      }
      break;
    }
    case 'artillery': {
      if (distance < 280) retreat(def.speed);
      else e.vx = e.vz = 0;
      if (distance < def.attackRange && (e.ai.cd ?? 0) <= 0) {
        lobAtPlayer(a, e, p, def);
        e.ai.cd = def.attackInterval;
      }
      break;
    }
    case 'burrower': {
      // state 0 = surfaced, 1 = submerged (invulnerable, repositioning)
      e.ai.timer = (e.ai.timer ?? 0) - 1;
      if ((e.ai.state ?? 0) === 0) {
        advance(def.speed);
        if (distance < def.attackRange + e.radius + p.radius && (e.ai.cd ?? 0) <= 0) {
          damagePlayer(a, def.attackDamage, def.attackType);
          e.ai.cd = def.attackInterval;
        }
        if ((e.ai.timer ?? 0) <= 0) {
          e.ai.state = 1;
          e.ai.timer = 60;
          e.iframes = 62;
        }
      } else {
        e.vx = e.vz = 0;
        if ((e.ai.timer ?? 0) === 12) {
          // Surfaces beneath you, with a column marker to read.
          const ang = nextRange(a.rng, 0, TAU);
          const d = nextRange(a.rng, 0, 60);
          e.x = p.x + cos(ang) * d;
          e.z = p.z + sin(ang) * d;
          clampToArena(e);
          pushTelegraph(a, 'burrow-column', e.x, e.z, 0, 26);
        }
        if ((e.ai.timer ?? 0) <= 0) {
          e.ai.state = 0;
          e.ai.timer = 200;
          e.iframes = 0;
        }
      }
      break;
    }
    case 'elite': {
      const want = def.attackRange * 0.7;
      if (distance > want) advance(def.speed);
      else strafe(def.speed * 0.6);
      if ((e.ai.cd ?? 0) <= 0 && distance < def.attackRange) {
        shootAtPlayer(a, e, p, def, 14);
        e.ai.cd = def.attackInterval;
      }
      break;
    }
    default:
      advance(def.speed);
  }
}

function shootAtPlayer(a: ArenaState, e: Entity, p: Entity, def: EnemyDef, speed: number): void {
  const ox = e.x;
  const oy = e.y + e.height * 0.7;
  const oz = e.z;
  const tx = p.x;
  const ty = p.y + p.height * 0.5;
  const tz = p.z;
  const yaw = atan2(tz - oz, tx - ox);
  const flat = horizDist(ox, oz, tx, tz);
  const pitch = atan2(ty - oy, flat);
  const cp = cos(pitch);
  a.projectiles.push({
    id: a.nextId++,
    ownerId: e.id,
    faction: 'hostile',
    x: ox,
    y: oy,
    z: oz,
    vx: cp * cos(yaw) * speed,
    vy: sin(pitch) * speed,
    vz: cp * sin(yaw) * speed,
    damage: def.attackDamage,
    damageType: def.attackType,
    radius: 5,
    ticksLeft: 140,
    gravity: 0,
    pierce: 0,
    travelled: 0,
    crit: false,
  });
}

function lobAtPlayer(a: ArenaState, e: Entity, p: Entity, def: EnemyDef): void {
  const ox = e.x;
  const oy = e.y + e.height * 0.8;
  const oz = e.z;
  const yaw = atan2(p.z - oz, p.x - ox);
  const flat = horizDist(ox, oz, p.x, p.z);
  const speed = 11;
  // Lofted so it arcs over cover and gives the player time to move.
  const pitch = 0.42 + Math.min(0.5, flat / 1600);
  const cp = cos(pitch);
  a.projectiles.push({
    id: a.nextId++,
    ownerId: e.id,
    faction: 'hostile',
    x: ox,
    y: oy,
    z: oz,
    vx: cp * cos(yaw) * speed,
    vy: sin(pitch) * speed,
    vz: cp * sin(yaw) * speed,
    damage: def.attackDamage,
    damageType: def.attackType,
    radius: 8,
    ticksLeft: 220,
    gravity: 0.26,
    pierce: 0,
    travelled: 0,
    crit: false,
  });
}

/* -------------------------------- the boss -------------------------------- */

function stepBoss(a: ArenaState, e: Entity, p: Entity): void {
  const def = getBoss(e.defId);
  const phase = def.phases[e.phase]!;
  const dx = p.x - e.x;
  const dz = p.z - e.z;
  const distance = Math.sqrt(dx * dx + dz * dz);
  const toPlayer = atan2(dz, dx);
  // Turns to face rather than snapping, so its flanks and back stay reachable —
  // which is the whole reason the weak points are spread around the body.
  e.yaw += clamp(angleDelta(e.yaw, toPlayer), -0.022 * phase.speedMult, 0.022 * phase.speedMult);

  // It closes; the player owns the spacing.
  const speed = def.speed * phase.speedMult;
  if (distance > 260) {
    e.vx = cos(e.yaw) * speed;
    e.vz = sin(e.yaw) * speed;
  } else if (distance < 150) {
    e.vx = -cos(e.yaw) * speed * 0.7;
    e.vz = -sin(e.yaw) * speed * 0.7;
  } else {
    e.vx = e.vz = 0;
  }
  const nx = e.x + e.vx;
  const nz = e.z + e.vz;
  if (horizDist(0, 0, nx, nz) > BOSS_LEASH) {
    e.vx = e.vz = 0;
  }

  // The phase's knowledge check, if it has one. A window opens a named weak
  // point on a cycle; whether that reads as venting heat or drawing breath is
  // a matter of naming, so the mechanic lives in data rather than in here.
  const win = phase.window;
  if (win) {
    e.ai.winCd = (e.ai.winCd ?? win.periodTicks) - 1;
    if ((e.ai.winOpen ?? 0) > 0) {
      e.ai.winOpen = (e.ai.winOpen ?? 0) - 1;
      if (win.suppressShield) e.def.shieldCooldown = 40;
      if (win.pull) {
        // Dragged toward it. The moment it is open is the moment it is pulling
        // you into everything else it does, which is the trade.
        const dir = atan2(e.z - p.z, e.x - p.x);
        p.x += cos(dir) * win.pull;
        p.z += sin(dir) * win.pull;
        clampToArena(p);
      }
      if ((e.ai.winOpen ?? 0) === 0) {
        for (const w of e.weakPoints) if (w.id === win.weakPointId) w.exposed = false;
      }
    } else if ((e.ai.winCd ?? 0) <= 0) {
      e.ai.winOpen = win.openTicks;
      e.ai.winCd = win.periodTicks;
      for (const w of e.weakPoints) if (w.id === win.weakPointId && !w.broken) w.exposed = true;
      emit(a, { type: 'vent', x: e.x, y: e.y + e.height, z: e.z, text: win.label, id: e.id });
    }
  }

  // Escort respawn. The countdown only runs once the escort is entirely gone,
  // so clearing it always buys a window of exactly `respawnTicks` — which is
  // the whole fight when the phase also wards the boss.
  if (phase.respawnTicks && phase.spawns.length > 0) {
    const alive = a.entities.some((o) => o.faction === 'hostile' && !o.dead && o.kind !== 'boss');
    if (alive) {
      e.ai.respawnCd = phase.respawnTicks;
    } else {
      e.ai.respawnCd = (e.ai.respawnCd ?? phase.respawnTicks) - 1;
      if ((e.ai.respawnCd ?? 0) <= 0) {
        e.ai.respawnCd = phase.respawnTicks;
        spawnEscort(a, e, phase);
      }
    }
  }

  for (const k of Object.keys(a.patternCooldowns)) {
    a.patternCooldowns[k] = Math.max(0, (a.patternCooldowns[k] ?? 0) - 1);
  }

  e.ai.patternCd = (e.ai.patternCd ?? 0) - 1;
  if ((e.ai.patternCd ?? 0) <= 0) {
    const ready = phase.patterns.filter((id) => (a.patternCooldowns[id] ?? 0) <= 0);
    if (ready.length > 0) {
      const id = pick(a.rng, ready);
      const pat = PATTERNS[id]!;
      a.patternCooldowns[id] = pat.cooldown;
      // Base gap between set-piece patterns. Each one is a large, readable AoE,
      // so the rhythm has to leave room to read it; phases tighten it.
      e.ai.patternCd = Math.round(165 * phase.attackIntervalMult);
      const centred = pat.shape === 'column' || pat.shape === 'ring';
      pushTelegraph(
        a,
        id,
        centred ? p.x : e.x,
        centred ? p.z : e.z,
        toPlayer,
        Math.round(pat.windup * phase.attackIntervalMult),
      );
    } else {
      e.ai.patternCd = 40;
    }
  }

  a.gravityMult = phase.gravityMult ?? 1;

  if (phase.arenaDps > 0) {
    // Rising kiln heat: an arena-wide pressure that makes phase 3 a timer.
    damagePlayer(a, phase.arenaDps / TICK_HZ, phase.arenaDamageType);
  }
}

function pushTelegraph(a: ArenaState, patternId: string, x: number, z: number, yaw: number, windup: number): void {
  const pat = PATTERNS[patternId];
  if (!pat) return;
  const t: Telegraph = {
    id: a.nextId++,
    shape: pat.shape,
    damageType: pat.damageType,
    x,
    z,
    radius: pat.radius,
    yaw,
    ticksLeft: Math.max(12, windup),
    totalTicks: Math.max(12, windup),
    damage: pat.damage,
  };
  a.telegraphs.push(t);
  emit(a, {
    type: 'telegraph',
    x,
    y: 0,
    z,
    amount: t.totalTicks,
    text: patternId,
    damageType: pat.damageType,
    id: t.id,
  });
}

const LINE_LENGTH = 900;
const CONE_HALF_ANGLE = 0.55;
const PULSE_BAND = 70;

function resolveTelegraph(a: ArenaState, t: Telegraph): void {
  const p = playerEntity(a);
  const px = p.x;
  const pz = p.z;
  let caught = false;

  switch (t.shape) {
    case 'ring':
    case 'column':
      caught = horizDist(px, pz, t.x, t.z) <= t.radius + p.radius;
      break;
    case 'pulse': {
      // Inverse of a ring: safe near the middle, caught in the expanding band.
      const d = horizDist(px, pz, t.x, t.z);
      caught = Math.abs(d - t.radius * 0.7) <= PULSE_BAND;
      break;
    }
    case 'line': {
      const dx = cos(t.yaw);
      const dz = sin(t.yaw);
      const rx = px - t.x;
      const rz = pz - t.z;
      const along = rx * dx + rz * dz;
      const perp = Math.abs(rx * dz - rz * dx);
      caught = along > 0 && along < LINE_LENGTH && perp <= t.radius + p.radius;
      break;
    }
    case 'cone': {
      const d = horizDist(px, pz, t.x, t.z);
      const bearing = atan2(pz - t.z, px - t.x);
      caught = d <= t.radius && Math.abs(angleDelta(t.yaw, bearing)) < CONE_HALF_ANGLE;
      break;
    }
  }
  emit(a, { type: 'resolve', x: t.x, y: 0, z: t.z, amount: t.radius, text: t.shape, damageType: t.damageType, id: t.id });
  a.shake = Math.max(a.shake, 8);
  if (caught) damagePlayer(a, t.damage, t.damageType);
}

/* ---------------------------------- step ---------------------------------- */

export interface StepContext {
  weapon: ResolvedWeapon | null;
  moveSpeed: number;
  miningYield: number;
  scanSpeed: number;
  /** Plate self-repairs between contacts. Health does not. */
  armorRegen: number;
  /** Fraction of max health returned per kill — sustain is tied to aggression. */
  killRecovery: number;
  gate: { kills: number; deposits: number; scans: number };
}

const INTERACT_RANGE = 46;

/**
 * Spawns the visible half of a drop. `sim.ts` has already banked the item.
 *
 * The toss is deterministic — it draws from the arena's own rng like every
 * other scatter — so a replayed seed throws the same loot to the same patch
 * of sand.
 */
export function spawnDrop(a: ArenaState, uid: number, rarity: string, x: number, y: number, z: number): void {
  const ang = nextRange(a.rng, 0, TAU);
  const spread = nextRange(a.rng, 6, 26);
  a.drops.push({
    uid,
    x: x + cos(ang) * spread,
    y: Math.max(y, 12),
    z: z + sin(ang) * spread,
    vy: nextRange(a.rng, 1.4, 3.2),
    rarity,
    age: 0,
    taken: false,
  });
  a.drops.length = Math.min(a.drops.length, 64);
}

/** Falls, then comes to you. Emits `pickup` carrying the uid as its text. */
function stepDrops(a: ArenaState, p: Entity): void {
  for (let i = a.drops.length - 1; i >= 0; i--) {
    const d = a.drops[i]!;
    d.age += 1;

    const dx = p.x - d.x;
    const dz = p.z - d.z;
    const flat = Math.sqrt(dx * dx + dz * dz);

    if (flat < DROP_MAGNET && !p.dead) {
      // Accelerates as it closes, so the last stretch snaps rather than
      // drifting. The pull beats the player's own top speed, so backing away
      // from your own loot is not a way to lose it.
      const pull = 2.2 + (1 - flat / DROP_MAGNET) * 9;
      d.x += (dx / Math.max(flat, 0.001)) * pull;
      d.z += (dz / Math.max(flat, 0.001)) * pull;
      d.y += (p.y + p.height * 0.45 - d.y) * 0.18;
    } else {
      d.vy -= DROP_GRAVITY;
      d.y = Math.max(8, d.y + d.vy);
      if (d.y <= 8) d.vy = 0;
    }

    if (flat < DROP_PICKUP && !p.dead) {
      d.taken = true;
      emit(a, { type: 'pickup', x: d.x, y: d.y, z: d.z, id: d.uid, text: String(d.uid) });
      a.drops.splice(i, 1);
    }
  }
}

export function stepArena(a: ArenaState, input: InputFrame, ctx: StepContext): ArenaEvent[] {
  a.events = [];
  if (a.outcome !== 'running') return a.events;
  a.tick += 1;
  a.armorRegen = ctx.armorRegen;
  a.killRecovery = ctx.killRecovery;

  // Frozen on a connect. Nothing moves, nothing thinks, nothing resolves — the
  // whole world holds for a few hundredths of a second and then snaps back.
  if (a.hitstop > 0) {
    a.hitstop -= 1;
    return a.events;
  }

  const p = playerEntity(a);
  const pr = a.player;

  pr.aimYaw = input.aimYaw;
  pr.aimPitch = input.aimPitch;
  pr.recoil = Math.max(0, pr.recoil - 0.006);

  // --- player movement, resolved into world space from camera-relative input --
  if (p.iframes > 0) p.iframes -= 1;
  if (p.stunned > 0) p.stunned -= 1;
  if (pr.dodgeCooldown > 0) pr.dodgeCooldown -= 1;

  // Camera-relative: forward is the camera's heading, right is 90 degrees off it.
  const fx = cos(input.camYaw);
  const fz = sin(input.camYaw);
  const rx = cos(input.camYaw + PI / 2);
  const rz = sin(input.camYaw + PI / 2);
  let wishX = fx * input.moveZ + rx * input.moveX;
  let wishZ = fz * input.moveZ + rz * input.moveX;
  const wishLen = Math.sqrt(wishX * wishX + wishZ * wishZ);
  if (wishLen > 1) {
    // Normalised, so diagonal movement is not faster than cardinal movement.
    wishX /= wishLen;
    wishZ /= wishLen;
  }

  if (pr.dodgeLeft > 0) {
    pr.dodgeLeft -= 1;
    p.vx = cos(pr.dodgeYaw) * DODGE_SPEED;
    p.vz = sin(pr.dodgeYaw) * DODGE_SPEED;
  } else if (p.stunned <= 0) {
    if (input.dodge && pr.dodgeCooldown <= 0) {
      pr.dodgeLeft = DODGE_TICKS;
      pr.dodgeCooldown = DODGE_COOLDOWN;
      pr.dodgeYaw = wishLen > 0.01 ? atan2(wishZ, wishX) : pr.aimYaw;
      p.iframes = Math.max(p.iframes, DODGE_IFRAMES);
      emit(a, { type: 'dodge', x: p.x, y: p.y, z: p.z, id: p.id });
    } else {
      p.vx = wishX * ctx.moveSpeed;
      p.vz = wishZ * ctx.moveSpeed;
    }
    if (input.jump && p.grounded) {
      p.vy = JUMP_V;
      p.grounded = false;
    }
  }
  // The body faces where it is aiming; a third-person shooter reads wrong if the
  // character faces its movement instead.
  p.yaw = pr.aimYaw;

  // --- weapon ---
  const w = ctx.weapon;
  if (w) {
    if (pr.ammo <= 0 && pr.reloadLeft <= 0) {
      pr.reloadLeft = w.reloadTicks;
      emit(a, { type: 'reload', x: p.x, y: p.y, z: p.z, amount: w.reloadTicks, id: p.id });
    }
    if (input.reload && pr.reloadLeft <= 0 && pr.ammo < w.magazine) {
      pr.reloadLeft = w.reloadTicks;
      emit(a, { type: 'reload', x: p.x, y: p.y, z: p.z, amount: w.reloadTicks, id: p.id });
    }
    if (pr.reloadLeft > 0) {
      pr.reloadLeft -= 1;
      if (pr.reloadLeft === 0) pr.ammo = w.magazine;
    }
    if (pr.fireCooldown > 0) pr.fireCooldown -= 1;
    stepTrigger(a, w, input.fire);
    if (!input.fire) pr.beamRamp = Math.max(0, pr.beamRamp - 0.02);
  }

  // --- interact: mining and scanning share one hold-to-channel verb ---
  pr.interactTargetId = -1;
  if (input.interact && p.grounded) {
    const dep = a.deposits.find((d) => !d.depleted && horizDist(d.x, d.z, p.x, p.z) < INTERACT_RANGE);
    const scn = a.scans.find((s) => !s.done && horizDist(s.x, s.z, p.x, p.z) < INTERACT_RANGE);
    if (dep) {
      pr.interactTargetId = dep.id;
      dep.progress += 1;
      if (dep.progress >= dep.required) {
        dep.depleted = true;
        a.minedCount += 1;
        const amount = Math.floor(dep.yield * ctx.miningYield);
        a.matBanked += amount;
        emit(a, { type: 'mined', x: dep.x, y: 0, z: dep.z, amount, text: String(dep.tier), id: dep.id });
      }
    } else if (scn) {
      pr.interactTargetId = scn.id;
      scn.progress += 1;
      if (scn.progress >= scn.required) {
        scn.done = true;
        a.scannedCount += 1;
        a.dataBanked += scn.yield;
        emit(a, { type: 'scanned', x: scn.x, y: 0, z: scn.z, amount: scn.yield, id: scn.id });
      }
    }
  }

  // --- physics ---
  for (const e of a.entities) {
    if (e.dead) continue;
    e.vy -= GRAVITY * a.gravityMult;
    const moved = Math.sqrt(e.vx * e.vx + e.vz * e.vz);
    e.gait += moved;
    e.x += e.vx;
    e.z += e.vz;
    e.y += e.vy;
    if (e.y <= 0) {
      e.y = 0;
      e.vy = 0;
      e.grounded = true;
    }
    clampToArena(e);
    if (e.hitFlash > 0) e.hitFlash -= 1;
    if (e.iframes > 0 && e.kind !== 'player') e.iframes -= 1;
    if (e.stunned > 0 && e.kind !== 'player') e.stunned -= 1;

    const st = tickStatuses(e.statuses, e.def);
    if (st.damage > 0 && e.def.health <= 0 && !e.dead && e.faction === 'hostile') {
      killEntity(a, e);
    }
    if (e.kind === 'player' && e.def.health <= 0 && !e.dead) {
      e.dead = true;
      a.outcome = 'down';
      emit(a, { type: 'player-down', x: e.x, y: e.y, z: e.z, id: e.id });
    }
    regenShield(e.def, st.disrupted);
    if (e.kind === 'player' && ctx.armorRegen > 0 && e.def.armor < e.def.armorMax) {
      e.def.armor = Math.min(e.def.armorMax, e.def.armor + ctx.armorRegen / TICK_HZ);
    }
    if (st.stunned) e.stunned = Math.max(e.stunned, 2);
  }

  // --- hostile AI ---
  // Gravity is a boss-phase property, so it reverts the moment none is driving it.
  if (!a.bossSpawned) a.gravityMult = 1;
  for (const e of a.entities) {
    if (e.dead || e.faction !== 'hostile' || e.stunned > 0) continue;
    stepHostile(a, e, p);
  }

  // --- projectiles ---
  for (let i = a.projectiles.length - 1; i >= 0; i--) {
    const pj = a.projectiles[i]!;

    // Swarm munitions steer. The turn rate is deliberately modest: it should
    // read as "these find their way" rather than "these cannot be dodged".
    if (pj.homing && pj.faction === 'player') {
      let target: Entity | null = null;
      let bestD = pj.homing.range;
      for (const e of a.entities) {
        if (e.faction !== 'hostile' || e.dead) continue;
        const d = horizDist(e.x, e.z, pj.x, pj.z);
        if (d < bestD) {
          bestD = d;
          target = e;
        }
      }
      if (target) {
        const speed = Math.sqrt(pj.vx * pj.vx + pj.vy * pj.vy + pj.vz * pj.vz);
        const tx = target.x - pj.x;
        const ty = target.y + target.height * 0.5 - pj.y;
        const tz = target.z - pj.z;
        const len = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
        const k = pj.homing.strength;
        pj.vx += (tx / len) * speed * k;
        pj.vy += (ty / len) * speed * k;
        pj.vz += (tz / len) * speed * k;
        // Renormalise, or steering silently doubles as acceleration.
        const now = Math.sqrt(pj.vx * pj.vx + pj.vy * pj.vy + pj.vz * pj.vz) || 1;
        pj.vx = (pj.vx / now) * speed;
        pj.vy = (pj.vy / now) * speed;
        pj.vz = (pj.vz / now) * speed;
      }
    }

    pj.vy -= pj.gravity;
    pj.x += pj.vx;
    pj.y += pj.vy;
    pj.z += pj.vz;
    pj.travelled += Math.sqrt(pj.vx * pj.vx + pj.vy * pj.vy + pj.vz * pj.vz);
    pj.ticksLeft -= 1;
    let consumed = pj.ticksLeft <= 0 || pj.y < 0 || horizDist(0, 0, pj.x, pj.z) > ARENA_RADIUS + 80;
    if (!consumed) {
      if (pj.faction === 'player') {
        for (const e of a.entities) {
          if (e.faction !== 'hostile' || e.dead) continue;
          if (inBody(e, pj.x, pj.y, pj.z)) {
            const dmg = pj.damage * falloffAt(pj.falloff, pj.travelled);
            const res = damageEntity(a, e, dmg, pj.damageType, pj.x, pj.y, pj.z, pj.crit, 2);
            if (ctx.weapon) {
              registerHit(a, ctx.weapon, res, pj.crit);
              maybeStatus(a, e, ctx.weapon, ctx.weapon.statusChanceMult);
            }
            if (pj.chain) chainFrom(a, e, pj.x, pj.y, pj.z, dmg * pj.chain.falloff, pj.damageType, pj.chain);
            consumed = pj.pierce <= 0;
            pj.pierce -= 1;
            break;
          }
        }
      } else if (inBody(p, pj.x, pj.y, pj.z)) {
        damagePlayer(a, pj.damage, pj.damageType);
        consumed = true;
      }
    }
    if (consumed) {
      // Lingering munitions leave their patch wherever they stop, whether that
      // was a body or the floor.
      if (pj.lingers && pj.faction === 'player') {
        // Patches MERGE. A flamethrower firing twenty-six rounds a second lays
        // twenty-six overlapping patches, and if they stack the weapon does a
        // thousand damage a second through an effect the player cannot see.
        // Overlapping fire refreshes and grows the existing patch instead —
        // which is also what setting the floor on fire actually looks like.
        const near = a.hazards.find(
          (h) => h.faction === 'player' && horizDist(h.x, h.z, pj.x, pj.z) < h.radius * 0.75,
        );
        if (near) {
          near.ticksLeft = Math.max(near.ticksLeft, pj.lingers.durationTicks);
          near.radius = Math.min(pj.lingers.radius * 1.6, near.radius + 1.2);
          // Drift toward the new impact, so sweeping the stream moves the fire.
          near.x += (pj.x - near.x) * 0.12;
          near.z += (pj.z - near.z) * 0.12;
        } else if (a.hazards.length < 14) {
          a.hazards.push({
            id: a.nextId++,
            x: pj.x,
            z: pj.z,
            radius: pj.lingers.radius,
            dps: pj.lingers.dps,
            damageType: pj.damageType,
            ticksLeft: pj.lingers.durationTicks,
            totalTicks: pj.lingers.durationTicks,
            faction: 'player',
          });
        }
      }
      a.projectiles.splice(i, 1);
    }
  }

  // --- hazards: ground that keeps hurting whatever stands in it ------------
  for (let i = a.hazards.length - 1; i >= 0; i--) {
    const hz = a.hazards[i]!;
    hz.ticksLeft -= 1;
    if (hz.ticksLeft <= 0) {
      a.hazards.splice(i, 1);
      continue;
    }
    const perTick = hz.dps / TICK_HZ;
    if (hz.faction === 'player') {
      for (const e of a.entities) {
        if (e.faction !== 'hostile' || e.dead || e.iframes > 0) continue;
        if (horizDist(e.x, e.z, hz.x, hz.z) > hz.radius + e.radius) continue;
        const res = applyDamage(e.def, perTick, hz.damageType, {});
        if (res.killed) killEntity(a, e);
      }
    } else if (horizDist(p.x, p.z, hz.x, hz.z) <= hz.radius + p.radius) {
      damagePlayer(a, perTick, hz.damageType);
    }
  }

  // --- telegraphs ---
  for (let i = a.telegraphs.length - 1; i >= 0; i--) {
    const t = a.telegraphs[i]!;
    t.ticksLeft -= 1;
    if (t.ticksLeft <= 0) {
      resolveTelegraph(a, t);
      a.telegraphs.splice(i, 1);
    }
  }

  stepDrops(a, p);

  // --- waves and the boss gate ---
  if (!a.bossSpawned) {
    a.waveTimer -= 1;
    if (a.waveTimer <= 0) {
      spawnWave(a);
      a.waveTimer = 380;
    }
  }
  if (!a.gateMet && a.kills >= ctx.gate.kills && a.minedCount >= ctx.gate.deposits && a.scannedCount >= ctx.gate.scans) {
    a.gateMet = true;
    emit(a, { type: 'gate', x: p.x, y: p.y, z: p.z, text: 'gate open' });
    emit(a, { type: 'boss-ready', x: 0, y: 0, z: -240, text: getZone(a.zoneId).bossId ?? '' });
  }
  if (input.summonBoss && a.gateMet && !a.bossSpawned) summonBoss(a);

  // Reap the dead once per tick so ids stay stable within a tick.
  if (a.tick % 20 === 0) {
    a.entities = a.entities.filter((e) => !e.dead || e.kind === 'player');
  }

  if (a.shake > 0) a.shake = Math.max(0, a.shake - 0.8);
  return a.events;
}
