/**
 * Active-play arena simulation.
 *
 * Deterministic, fixed-step (40Hz), and completely headless: nothing in this
 * file knows a renderer exists. It consumes an `InputFrame` per tick and emits
 * a list of `ArenaEvent`s that presentation drains and turns into hitstop,
 * shake, numbers and sound. That separation is what lets the same encounter run
 * under the full renderer, under the widget's static frame, or under nothing at
 * all in the headless CLI.
 *
 * Geometry is a 2.5D side-on slice: x runs along the terrace, y is height. It
 * keeps boss silhouettes readable (the brief wants them legible at 200px),
 * keeps telegraph shapes unambiguous, and keeps the sim cheap enough that a
 * six-hour fast-forward is a few seconds of CPU.
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
import { getEnemy } from './content/enemies.js';
import { WEAPON_ARCHETYPES } from './content/weapons.js';
import { getZone } from './content/zones.js';
import { chance, makeRng, nextFloat, nextInt, nextRange, pick, type Rng } from './rng.js';
import { atan2, clamp, cos, dist, sin, toward } from './trig.js';
import type {
  DamageType,
  Defences,
  Entity,
  EnemyDef,
  Projectile,
  StatusKind,
  Telegraph,
  WeakPoint,
} from './types.js';

export const GROUND_Y = 0;
export const ARENA_HALF_WIDTH = 1200;
const GRAVITY = 0.62;
const JUMP_V = 11.2;
const DODGE_TICKS = 13;
const DODGE_IFRAMES = 12;
const DODGE_COOLDOWN = 34;
const DODGE_SPEED = 9.5;
const MAX_ADDS = 14;
/** The boss holds its terrace rather than chasing the player to the map edge. */
const BOSS_LEASH = 700;

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
  | 'boss-ready'
  | 'boss-down'
  | 'mined'
  | 'scanned'
  | 'gate';

export interface ArenaEvent {
  type: ArenaEventType;
  x: number;
  y: number;
  amount: number;
  text: string;
  damageType: DamageType;
  crit: boolean;
  id: number;
}

export interface Deposit {
  id: number;
  x: number;
  tier: number;
  progress: number;
  required: number;
  depleted: boolean;
  yield: number;
}

export interface ScanSite {
  id: number;
  x: number;
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
  dodgeDir: number;
  /** Solar lance ramp: rises while a beam stays on target, decays otherwise. */
  beamRamp: number;
  interactProgress: number;
  interactTargetId: number;
  aimAngle: number;
}

export interface ArenaState {
  zoneId: string;
  tick: number;
  rng: Rng;
  entities: Entity[];
  projectiles: Projectile[];
  telegraphs: Telegraph[];
  deposits: Deposit[];
  scans: ScanSite[];
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
  /** Presentation-only; the sim writes it, never reads it. */
  shake: number;
  hitstop: number;
  /** Mirrored from StepContext each tick so kill handlers can reach them. */
  armorRegen: number;
  killRecovery: number;
}

export interface InputFrame {
  moveX: number;
  jump: boolean;
  dodge: boolean;
  fire: boolean;
  reload: boolean;
  interact: boolean;
  aimX: number;
  aimY: number;
  /** -1 for "no change". */
  swapSlot: number;
  summonBoss: boolean;
}

export const NEUTRAL_INPUT: InputFrame = {
  moveX: 0,
  jump: false,
  dodge: false,
  fire: false,
  reload: false,
  interact: false,
  aimX: 200,
  aimY: -40,
  swapSlot: -1,
  summonBoss: false,
};

function emit(a: ArenaState, e: Partial<ArenaEvent> & { type: ArenaEventType }): void {
  a.events.push({
    x: 0,
    y: 0,
    amount: 0,
    text: '',
    damageType: 'percussive',
    crit: false,
    id: 0,
    ...e,
  });
}

function makeEntity(a: ArenaState, def: EnemyDef, x: number, scale: number): Entity {
  return {
    id: a.nextId++,
    kind: def.kind,
    faction: 'hostile',
    defId: def.id,
    x,
    y: GROUND_Y,
    vx: 0,
    vy: 0,
    w: def.w,
    h: def.h,
    facing: -1,
    def: makeDefences(def.defences, scale),
    statuses: [],
    ai: { cd: 0, state: 0, timer: 0, anchor: x },
    weakPoints: [],
    phase: 0,
    grounded: true,
    iframes: 0,
    stunned: 0,
    dead: false,
    hitFlash: 0,
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
    deposits: [],
    scans: [],
    player: {
      entityId: 0,
      ammo: 0,
      reloadLeft: 0,
      fireCooldown: 0,
      dodgeLeft: 0,
      dodgeCooldown: 0,
      dodgeDir: 1,
      beamRamp: 0,
      interactProgress: 0,
      interactTargetId: -1,
      aimAngle: 0,
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
    x: -400,
    y: GROUND_Y,
    vx: 0,
    vy: 0,
    w: 20,
    h: 42,
    facing: 1,
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
  };
  a.entities.push(player);
  a.player.entityId = player.id;

  // Deposits and scan sites are laid out deterministically from the seed, so a
  // given zone+seed is the same terrace every time you land on it.
  const depositCount = zone.gate.deposits + 2;
  for (let i = 0; i < depositCount; i++) {
    a.deposits.push({
      id: a.nextId++,
      x: -900 + ((i + 1) * 1800) / (depositCount + 1) + nextRange(rng, -60, 60),
      tier: zone.depositTier,
      progress: 0,
      required: 150,
      depleted: false,
      yield: 18 + nextInt(rng, 0, 10),
    });
  }
  const scanCount = zone.gate.scans + 2;
  for (let i = 0; i < scanCount; i++) {
    a.scans.push({
      id: a.nextId++,
      x: -850 + ((i + 1) * 1700) / (scanCount + 1) + nextRange(rng, -80, 80),
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

/* ------------------------------ spawning --------------------------------- */

function spawnWave(a: ArenaState): void {
  const zone = getZone(a.zoneId);
  const living = a.entities.filter((e) => e.faction === 'hostile' && !e.dead).length;
  if (living >= MAX_ADDS) return;
  const count = 2 + Math.min(3, Math.floor(a.wavesSpawned / 3));
  const p = playerEntity(a);
  for (let i = 0; i < count; i++) {
    const id = pick(a.rng, zone.enemyPool);
    const side = chance(a.rng, 0.5) ? 1 : -1;
    const x = clamp(p.x + side * nextRange(a.rng, 420, 760), -ARENA_HALF_WIDTH, ARENA_HALF_WIDTH);
    a.entities.push(makeEntity(a, getEnemy(id), x, 1));
  }
  // Every fourth wave brings the zone elite. It is a difficulty spike on
  // purpose: the elite is the rehearsal for reading the boss.
  if (a.wavesSpawned > 0 && a.wavesSpawned % 4 === 0) {
    const side = chance(a.rng, 0.5) ? 1 : -1;
    a.entities.push(makeEntity(a, getEnemy(zone.elite), clamp(p.x + side * 600, -ARENA_HALF_WIDTH, ARENA_HALF_WIDTH), 1));
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
    x: 520,
    y: GROUND_Y,
    vx: 0,
    vy: 0,
    w: def.w,
    h: def.h,
    facing: -1,
    def: makeDefences(def.defences, 1),
    statuses: [],
    ai: { cd: 60, vent: 0, ventCd: 200, burrow: 0, patternCd: 90 },
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
  };
  a.entities.push(e);
  a.bossEntityId = e.id;
  a.bossSpawned = true;
  a.bossPhase = 0;
  applyPhase(a, e, 0);
  emit(a, { type: 'phase', x: e.x, y: e.y, text: def.phases[0]!.name, id: 0 });
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
  for (const s of p.spawns) {
    for (let i = 0; i < s.count; i++) {
      const side = chance(a.rng, 0.5) ? 1 : -1;
      a.entities.push(makeEntity(a, getEnemy(s.defId), clamp(e.x + side * nextRange(a.rng, 200, 500), -ARENA_HALF_WIDTH, ARENA_HALF_WIDTH), 1));
    }
  }
  e.iframes = Math.max(e.iframes, 34);
  a.shake = Math.max(a.shake, 14);
}

/* ------------------------------- damage ---------------------------------- */

/**
 * Weak-point offsets are measured from the entity's centre: `ox` along its
 * facing, `oy` up from the middle of its body. Authoring them relative to the
 * top invites exactly the bug this replaced, where a negative `oy` put the
 * hitbox in the air above the model.
 */
export function weakPointPos(e: Entity, w: { ox: number; oy: number }): { x: number; y: number } {
  return { x: e.x + w.ox * e.facing, y: e.y - e.h / 2 + w.oy };
}

function hitWeakPoint(e: Entity, x: number, y: number): WeakPoint | null {
  for (const w of e.weakPoints) {
    if (!w.exposed || w.broken) continue;
    const { x: wx, y: wy } = weakPointPos(e, w);
    if (dist(x, y, wx, wy) <= w.radius) return w;
  }
  return null;
}

function damageEntity(
  a: ArenaState,
  e: Entity,
  amount: number,
  type: DamageType,
  hx: number,
  hy: number,
  crit: boolean,
  critMult: number,
): number {
  if (e.dead || e.iframes > 0) return 0;
  const wp = hitWeakPoint(e, hx, hy);
  const weakMult = wp ? wp.multiplier : 1;
  const res = applyDamage(e.def, amount, type, { crit, critMult, weakMult });
  e.hitFlash = 4;
  if (wp) {
    wp.health -= res.dealt;
    if (wp.health <= 0) {
      wp.broken = true;
      wp.exposed = false;
      a.shake = Math.max(a.shake, 10);
      emit(a, { type: 'weak', x: hx, y: hy, amount: res.dealt, text: `${wp.label} broken`, damageType: type, crit, id: e.id });
    } else {
      emit(a, { type: 'weak', x: hx, y: hy, amount: res.dealt, text: wp.label, damageType: type, crit, id: e.id });
    }
  } else {
    emit(a, { type: 'hit', x: hx, y: hy, amount: res.dealt, damageType: type, crit, id: e.id });
  }

  if (res.killed) {
    e.dead = true;
    a.kills += 1;
    grantKillRecovery(a);
    const isBoss = e.kind === 'boss';
    emit(a, { type: isBoss ? 'boss-down' : 'kill', x: e.x, y: e.y, id: e.id, text: e.defId });
    if (isBoss) {
      a.outcome = 'cleared';
      a.shake = 30;
    }
  } else if (e.kind === 'boss') {
    const def = getBoss(e.defId);
    const frac = e.def.health / e.def.healthMax;
    for (let p = def.phases.length - 1; p > e.phase; p--) {
      if (frac <= def.phases[p]!.atHealthFraction) {
        applyPhase(a, e, p);
        emit(a, { type: 'phase', x: e.x, y: e.y, text: def.phases[p]!.name, id: p });
        break;
      }
    }
  }
  return res.dealt;
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

function damagePlayer(a: ArenaState, amount: number, type: DamageType): void {
  const p = playerEntity(a);
  if (p.dead || p.iframes > 0) return;
  const res = applyDamage(p.def, amount, type, {});
  if (res.dealt > 0) {
    a.shake = Math.max(a.shake, Math.min(12, amount * 0.2));
    emit(a, { type: 'player-hit', x: p.x, y: p.y - p.h, amount: res.dealt, damageType: type, id: p.id });
  }
  if (res.killed) {
    p.dead = true;
    a.outcome = 'down';
    emit(a, { type: 'player-down', x: p.x, y: p.y, id: p.id });
  }
}

/* -------------------------------- firing --------------------------------- */

function entityHit(e: Entity, x: number, y: number): boolean {
  return x >= e.x - e.w / 2 && x <= e.x + e.w / 2 && y <= e.y && y >= e.y - e.h;
}

function traceHitscan(a: ArenaState, ox: number, oy: number, angle: number, range: number): { e: Entity; x: number; y: number } | null {
  const dx = cos(angle);
  const dy = sin(angle);
  const step = 5;
  for (let t = 8; t <= range; t += step) {
    const x = ox + dx * t;
    const y = oy + dy * t;
    if (y > GROUND_Y + 4) return null;
    for (const e of a.entities) {
      if (e.faction !== 'hostile' || e.dead) continue;
      if (entityHit(e, x, y)) return { e, x, y };
    }
  }
  return null;
}

function fireWeapon(a: ArenaState, w: ResolvedWeapon, statusMult: number): void {
  const p = playerEntity(a);
  const pr = a.player;
  const ox = p.x;
  const oy = p.y - p.h * 0.62;
  emit(a, { type: 'shot', x: ox, y: oy, amount: w.recoil, text: w.archetypeId, damageType: w.damageType, id: p.id });

  for (let i = 0; i < w.pellets; i++) {
    const angle = pr.aimAngle + nextRange(a.rng, -w.spread, w.spread);
    const crit = chance(a.rng, w.critChance);
    if (w.behavior === 'hitscan' || w.behavior === 'beam') {
      const ramp = w.behavior === 'beam' ? 1 + pr.beamRamp * 0.9 : 1;
      const hit = traceHitscan(a, ox, oy, angle, w.range);
      if (hit) {
        damageEntity(a, hit.e, w.damage * ramp, w.damageType, hit.x, hit.y, crit, w.critMult);
        maybeStatus(a, hit.e, w, statusMult);
        if (w.behavior === 'beam') pr.beamRamp = Math.min(1, pr.beamRamp + 0.012);
      } else if (w.behavior === 'beam') {
        pr.beamRamp = Math.max(0, pr.beamRamp - 0.03);
      }
    } else {
      const speed = w.projectileSpeed;
      a.projectiles.push({
        id: a.nextId++,
        ownerId: p.id,
        faction: 'player',
        x: ox,
        y: oy,
        vx: cos(angle) * speed,
        vy: sin(angle) * speed,
        damage: w.damage,
        damageType: w.damageType,
        radius: 6,
        ticksLeft: Math.round(w.range / Math.max(1, speed)) + 20,
        gravity: w.behavior === 'lob' ? 0.24 : 0,
        pierce: 0,
        crit,
      });
    }
  }
}

function maybeStatus(a: ArenaState, e: Entity, w: ResolvedWeapon, statusMult: number): void {
  const status = statusFor(w);
  if (!status) return;
  if (chance(a.rng, Math.min(0.95, status.chance * statusMult))) {
    applyStatus(e.statuses, status.kind, status.magnitude, status.durationTicks, w.damageType);
  }
}

function statusFor(w: ResolvedWeapon): StatusApplication | null {
  // Pulled from the archetype rather than the instance: affixes scale the
  // chance (statusChanceMult), they do not change which status a gun applies.
  const arch = ARCH_STATUS[w.archetypeId];
  return arch ?? null;
}

type StatusApplication = { kind: StatusKind; chance: number; magnitude: number; durationTicks: number };

/** Built once from the archetype table; keyed by archetype id. */
const ARCH_STATUS: Record<string, StatusApplication> = (() => {
  const out: Record<string, StatusApplication> = {};
  for (const w of WEAPON_ARCHETYPES) if (w.status) out[w.id] = w.status;
  return out;
})();

/* ---------------------------------- AI ----------------------------------- */

function stepHostile(a: ArenaState, e: Entity, p: Entity): void {
  // The boss runs its own phase machine and has no EnemyDef to look up.
  if (e.kind === 'boss') return stepBoss(a, e, p);
  const def = getEnemy(e.defId);

  const toPlayer = p.x - e.x;
  const distance = Math.abs(toPlayer);
  const dir = toPlayer >= 0 ? 1 : -1;
  e.facing = dir >= 0 ? 1 : -1;
  e.ai.cd = (e.ai.cd ?? 0) - 1;

  switch (e.kind) {
    case 'grunt': {
      e.vx = dir * def.speed;
      if (distance < def.attackRange && (e.ai.cd ?? 0) <= 0) {
        damagePlayer(a, def.contactDamage, def.contactType);
        e.ai.cd = def.attackInterval;
      }
      break;
    }
    case 'skirmisher': {
      // Holds a band: closes when far, backs off when crowded.
      const want = def.attackRange * 0.9;
      e.vx = distance > want + 30 ? dir * def.speed : distance < want - 40 ? -dir * def.speed * 0.8 : 0;
      if (distance < def.attackRange * 1.2 && (e.ai.cd ?? 0) <= 0) {
        shootAtPlayer(a, e, p, def, 12);
        e.ai.cd = def.attackInterval;
      }
      break;
    }
    case 'artillery': {
      e.vx = distance < 260 ? -dir * def.speed : 0;
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
        e.vx = dir * def.speed;
        if (distance < def.attackRange && (e.ai.cd ?? 0) <= 0) {
          damagePlayer(a, def.attackDamage, def.attackType);
          e.ai.cd = def.attackInterval;
        }
        if ((e.ai.timer ?? 0) <= 0) {
          e.ai.state = 1;
          e.ai.timer = 60;
          e.iframes = 62;
        }
      } else {
        e.vx = 0;
        if ((e.ai.timer ?? 0) <= 12 && (e.ai.timer ?? 0) > 11) {
          e.x = clamp(p.x + nextRange(a.rng, -70, 70), -ARENA_HALF_WIDTH, ARENA_HALF_WIDTH);
          pushTelegraph(a, 'burrow-column', e.x, GROUND_Y, 0, 26);
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
      const want = def.attackRange * 0.75;
      e.vx = distance > want ? dir * def.speed : -dir * def.speed * 0.4;
      if ((e.ai.cd ?? 0) <= 0 && distance < def.attackRange) {
        shootAtPlayer(a, e, p, def, 14);
        e.ai.cd = def.attackInterval;
      }
      break;
    }
    default:
      e.vx = dir * def.speed;
  }
}

function shootAtPlayer(a: ArenaState, e: Entity, p: Entity, def: EnemyDef, speed: number): void {
  const ox = e.x;
  const oy = e.y - e.h * 0.6;
  const angle = atan2(p.y - p.h * 0.5 - oy, p.x - ox);
  a.projectiles.push({
    id: a.nextId++,
    ownerId: e.id,
    faction: 'hostile',
    x: ox,
    y: oy,
    vx: cos(angle) * speed,
    vy: sin(angle) * speed,
    damage: def.attackDamage,
    damageType: def.attackType,
    radius: 5,
    ticksLeft: 140,
    gravity: 0,
    pierce: 0,
    crit: false,
  });
}

function lobAtPlayer(a: ArenaState, e: Entity, p: Entity, def: EnemyDef): void {
  const ox = e.x;
  const oy = e.y - e.h * 0.7;
  const dx = p.x - ox;
  const speed = 11;
  const angle = atan2(-Math.abs(dx) * 0.22 - 40, dx);
  a.projectiles.push({
    id: a.nextId++,
    ownerId: e.id,
    faction: 'hostile',
    x: ox,
    y: oy,
    vx: cos(angle) * speed,
    vy: sin(angle) * speed,
    damage: def.attackDamage,
    damageType: def.attackType,
    radius: 8,
    ticksLeft: 220,
    gravity: 0.26,
    pierce: 0,
    crit: false,
  });
}

/* -------------------------------- the boss -------------------------------- */

function stepBoss(a: ArenaState, e: Entity, p: Entity): void {
  const def = getBoss(e.defId);
  const phase = def.phases[e.phase]!;
  const toPlayer = p.x - e.x;
  const dir = toPlayer >= 0 ? 1 : -1;
  e.facing = dir >= 0 ? 1 : -1;

  // Keeps a working distance rather than body-blocking the player.
  // It closes; the player owns the spacing. A boss that also tries to hold a
  // range just crab-walks the fight into a wall.
  const speed = def.speed * phase.speedMult;
  e.vx = Math.abs(toPlayer) > 240 ? dir * speed : Math.abs(toPlayer) < 120 ? -dir * speed : 0;
  const nextX = e.x + e.vx;
  if (nextX > BOSS_LEASH || nextX < -BOSS_LEASH) e.vx = 0;

  // Phase 1's knowledge check: it vents to cool, dropping the shield and
  // exposing the vents for a short, readable window. Learn it and the fight
  // halves; ignore it and the plate never lets you through.
  if (e.phase === 0) {
    e.ai.ventCd = (e.ai.ventCd ?? 0) - 1;
    if ((e.ai.vent ?? 0) > 0) {
      e.ai.vent = (e.ai.vent ?? 0) - 1;
      e.def.shieldCooldown = 40;
      if ((e.ai.vent ?? 0) === 0) {
        for (const w of e.weakPoints) if (w.id === 'vents') w.exposed = false;
      }
    } else if ((e.ai.ventCd ?? 0) <= 0) {
      e.ai.vent = 92;
      e.ai.ventCd = 300;
      for (const w of e.weakPoints) if (w.id === 'vents' && !w.broken) w.exposed = true;
      emit(a, { type: 'telegraph', x: e.x, y: e.y - e.h, text: 'venting', id: e.id });
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
      // Base gap between set-piece patterns. Each one is a large, readable
      // AoE, so the rhythm has to leave room to read it; phases tighten it.
      e.ai.patternCd = Math.round(165 * phase.attackIntervalMult);
      const tx = pat.shape === 'column' || pat.shape === 'ring' ? p.x : e.x;
      const angle = pat.shape === 'line' || pat.shape === 'cone' ? atan2(p.y - p.h * 0.5 - (e.y - e.h * 0.5), p.x - e.x) : 0;
      pushTelegraph(a, id, tx, pat.shape === 'ring' || pat.shape === 'column' ? GROUND_Y : e.y - e.h * 0.5, angle, Math.round(pat.windup * phase.attackIntervalMult));
    } else {
      e.ai.patternCd = 40;
    }
  }

  if (phase.arenaDps > 0) {
    // Rising kiln heat: an arena-wide pressure that makes phase 3 a timer.
    damagePlayer(a, phase.arenaDps / TICK_HZ, phase.arenaDamageType);
  }
}

function pushTelegraph(a: ArenaState, patternId: string, x: number, y: number, angle: number, windup: number): void {
  const pat = PATTERNS[patternId];
  if (!pat) return;
  const t: Telegraph = {
    id: a.nextId++,
    shape: pat.shape,
    damageType: pat.damageType,
    x,
    y,
    radius: pat.radius,
    angle,
    ticksLeft: Math.max(12, windup),
    totalTicks: Math.max(12, windup),
    damage: pat.damage,
  };
  a.telegraphs.push(t);
  emit(a, { type: 'telegraph', x, y, amount: t.totalTicks, text: patternId, damageType: pat.damageType, id: t.id });
}

function resolveTelegraph(a: ArenaState, t: Telegraph): void {
  const p = playerEntity(a);
  const px = p.x;
  const py = p.y - p.h * 0.5;
  let caught = false;
  switch (t.shape) {
    case 'ring':
      caught = dist(px, GROUND_Y, t.x, t.y) <= t.radius;
      break;
    case 'column':
      caught = Math.abs(px - t.x) <= t.radius;
      break;
    case 'pulse':
      // Inverse of a ring: safe *inside*, caught in the expanding band.
      caught = Math.abs(dist(px, GROUND_Y, t.x, t.y) - t.radius * 0.7) <= 70;
      break;
    case 'line': {
      const dx = cos(t.angle);
      const dy = sin(t.angle);
      const rx = px - t.x;
      const ry = py - t.y;
      const proj = rx * dx + ry * dy;
      const perp = Math.abs(rx * dy - ry * dx);
      caught = proj > 0 && proj < 900 && perp <= t.radius;
      break;
    }
    case 'cone': {
      const d = dist(px, py, t.x, t.y);
      const ang = atan2(py - t.y, px - t.x);
      let delta = ang - t.angle;
      while (delta > 3.14159) delta -= 6.28318;
      while (delta < -3.14159) delta += 6.28318;
      caught = d <= t.radius && Math.abs(delta) < 0.55;
      break;
    }
  }
  emit(a, { type: 'resolve', x: t.x, y: t.y, amount: t.radius, text: t.shape, damageType: t.damageType, id: t.id });
  a.shake = Math.max(a.shake, 8);
  if (caught) damagePlayer(a, t.damage, t.damageType);
}

/* --------------------------------- step ---------------------------------- */

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

export function stepArena(a: ArenaState, input: InputFrame, ctx: StepContext): ArenaEvent[] {
  a.events = [];
  if (a.outcome !== 'running') return a.events;
  a.tick += 1;
  a.armorRegen = ctx.armorRegen;
  a.killRecovery = ctx.killRecovery;

  const p = playerEntity(a);
  const pr = a.player;

  pr.aimAngle = atan2(input.aimY - (p.y - p.h * 0.62), input.aimX - p.x);

  // --- player movement ---
  if (p.iframes > 0) p.iframes -= 1;
  if (p.stunned > 0) p.stunned -= 1;
  if (pr.dodgeCooldown > 0) pr.dodgeCooldown -= 1;

  if (pr.dodgeLeft > 0) {
    pr.dodgeLeft -= 1;
    p.vx = pr.dodgeDir * DODGE_SPEED;
  } else if (p.stunned <= 0) {
    if (input.dodge && pr.dodgeCooldown <= 0) {
      pr.dodgeLeft = DODGE_TICKS;
      pr.dodgeCooldown = DODGE_COOLDOWN;
      pr.dodgeDir = input.moveX !== 0 ? Math.sign(input.moveX) : p.facing;
      p.iframes = Math.max(p.iframes, DODGE_IFRAMES);
      emit(a, { type: 'dodge', x: p.x, y: p.y, id: p.id });
    } else {
      p.vx = input.moveX * ctx.moveSpeed;
    }
    if (input.jump && p.grounded) {
      p.vy = -JUMP_V;
      p.grounded = false;
    }
  }
  if (input.moveX !== 0) p.facing = input.moveX > 0 ? 1 : -1;

  // --- weapon ---
  const w = ctx.weapon;
  if (w) {
    if (pr.ammo <= 0 && pr.reloadLeft <= 0) {
      pr.reloadLeft = w.reloadTicks;
      emit(a, { type: 'reload', x: p.x, y: p.y, amount: w.reloadTicks, id: p.id });
    }
    if (input.reload && pr.reloadLeft <= 0 && pr.ammo < w.magazine) {
      pr.reloadLeft = w.reloadTicks;
      emit(a, { type: 'reload', x: p.x, y: p.y, amount: w.reloadTicks, id: p.id });
    }
    if (pr.reloadLeft > 0) {
      pr.reloadLeft -= 1;
      if (pr.reloadLeft === 0) pr.ammo = w.magazine;
    }
    if (pr.fireCooldown > 0) pr.fireCooldown -= 1;
    if (input.fire && pr.fireCooldown <= 0 && pr.ammo > 0 && pr.reloadLeft <= 0 && p.stunned <= 0) {
      fireWeapon(a, w, w.statusChanceMult);
      pr.ammo -= 1;
      pr.fireCooldown = w.fireInterval;
      a.hitstop = Math.max(a.hitstop, w.hitstop);
    }
    if (!input.fire) pr.beamRamp = Math.max(0, pr.beamRamp - 0.02);
  }

  // --- interact: mining and scanning share one hold-to-channel verb ---
  pr.interactTargetId = -1;
  if (input.interact && p.grounded) {
    const dep = a.deposits.find((d) => !d.depleted && Math.abs(d.x - p.x) < 46);
    const scn = a.scans.find((s) => !s.done && Math.abs(s.x - p.x) < 46);
    if (dep) {
      pr.interactTargetId = dep.id;
      dep.progress += 1;
      if (dep.progress >= dep.required) {
        dep.depleted = true;
        a.minedCount += 1;
        const amount = Math.floor(dep.yield * ctx.miningYield);
        a.matBanked += amount;
        emit(a, { type: 'mined', x: dep.x, y: GROUND_Y, amount, text: String(dep.tier), id: dep.id });
      }
    } else if (scn) {
      pr.interactTargetId = scn.id;
      scn.progress += 1;
      if (scn.progress >= scn.required) {
        scn.done = true;
        a.scannedCount += 1;
        a.dataBanked += scn.yield;
        emit(a, { type: 'scanned', x: scn.x, y: GROUND_Y, amount: scn.yield, id: scn.id });
      }
    }
  }

  // --- physics ---
  for (const e of a.entities) {
    if (e.dead) continue;
    e.vy += GRAVITY;
    e.x = clamp(e.x + e.vx, -ARENA_HALF_WIDTH, ARENA_HALF_WIDTH);
    e.y += e.vy;
    if (e.y >= GROUND_Y) {
      e.y = GROUND_Y;
      e.vy = 0;
      e.grounded = true;
    }
    if (e.hitFlash > 0) e.hitFlash -= 1;
    if (e.iframes > 0 && e.kind !== 'player') e.iframes -= 1;
    if (e.stunned > 0 && e.kind !== 'player') e.stunned -= 1;

    const st = tickStatuses(e.statuses, e.def);
    if (st.damage > 0 && e.def.health <= 0 && !e.dead) {
      e.dead = true;
      if (e.kind === 'boss') a.outcome = 'cleared';
      else a.kills += 1;
      emit(a, { type: e.kind === 'boss' ? 'boss-down' : 'kill', x: e.x, y: e.y, id: e.id, text: e.defId });
    }
    if (e.kind === 'player' && e.def.health <= 0 && !e.dead) {
      e.dead = true;
      a.outcome = 'down';
      emit(a, { type: 'player-down', x: e.x, y: e.y, id: e.id });
    }
    regenShield(e.def, st.disrupted);
    if (e.kind === 'player' && ctx.armorRegen > 0 && e.def.armor < e.def.armorMax) {
      e.def.armor = Math.min(e.def.armorMax, e.def.armor + ctx.armorRegen / TICK_HZ);
    }
    if (st.stunned) e.stunned = Math.max(e.stunned, 2);
  }

  // --- hostile AI ---
  for (const e of a.entities) {
    if (e.dead || e.faction !== 'hostile' || e.stunned > 0) continue;
    stepHostile(a, e, p);
  }

  // --- projectiles ---
  for (let i = a.projectiles.length - 1; i >= 0; i--) {
    const pj = a.projectiles[i]!;
    pj.vy += pj.gravity;
    pj.x += pj.vx;
    pj.y += pj.vy;
    pj.ticksLeft -= 1;
    let consumed = pj.ticksLeft <= 0 || pj.y > GROUND_Y + 2 || Math.abs(pj.x) > ARENA_HALF_WIDTH + 60;
    if (!consumed) {
      if (pj.faction === 'player') {
        for (const e of a.entities) {
          if (e.faction !== 'hostile' || e.dead) continue;
          if (entityHit(e, pj.x, pj.y)) {
            damageEntity(a, e, pj.damage, pj.damageType, pj.x, pj.y, pj.crit, 2);
            if (ctx.weapon) maybeStatus(a, e, ctx.weapon, ctx.weapon.statusChanceMult);
            consumed = pj.pierce <= 0;
            pj.pierce -= 1;
            break;
          }
        }
      } else if (entityHit(p, pj.x, pj.y)) {
        damagePlayer(a, pj.damage, pj.damageType);
        consumed = true;
      }
    }
    if (consumed) a.projectiles.splice(i, 1);
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
    emit(a, { type: 'gate', x: p.x, y: p.y, text: 'gate open' });
    emit(a, { type: 'boss-ready', x: 520, y: GROUND_Y, text: getZone(a.zoneId).bossId ?? '' });
  }
  if (input.summonBoss && a.gateMet && !a.bossSpawned) summonBoss(a);

  // Reap the dead once per tick so ids stay stable within a tick.
  if (a.tick % 20 === 0) {
    a.entities = a.entities.filter((e) => !e.dead || e.kind === 'player');
  }

  if (a.shake > 0) a.shake = Math.max(0, a.shake - 0.8);
  if (a.hitstop > 0) a.hitstop -= 1;
  return a.events;
}
