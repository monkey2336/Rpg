/**
 * Damage resolution.
 *
 * This is the *only* place damage is computed. Active play and idle routes both
 * call through here, which is what makes "offline and online provably match"
 * a structural property rather than a balancing exercise.
 *
 * Layering: shield -> armour -> health, with spill-over converted back to raw
 * damage between layers so a big hit that pops a shield carries its remainder
 * into armour at armour's multiplier rather than the shield's.
 */
import type { DamageType, DefenceLayer, Defences, Status, StatusKind } from './types.js';
import { STATUS_DEFS, bypassesShield, typeMultiplier } from './content/damage.js';

export const TICK_HZ = 40;
/** Exact in binary, so tick accounting never drifts. */
export const TICK_MS = 25;

export interface DamageResult {
  /** Raw damage actually consumed by the target (i.e. not wasted on overkill). */
  dealt: number;
  /** Where the first point landed — used for hit feedback and crit numbers. */
  layer: DefenceLayer;
  killed: boolean;
  /** Raw damage left over after the target died. */
  overkill: number;
  shieldBroken: boolean;
}

export interface DamageOptions {
  crit?: boolean;
  critMult?: number;
  /** Weak-point multiplier, already resolved by the caller. */
  weakMult?: number;
  /** Armour-piercing fraction: 0 = normal, 1 = ignores the armour layer. */
  pierce?: number;
}

const ORDER: DefenceLayer[] = ['shield', 'armor', 'health'];

function layerValue(d: Defences, l: DefenceLayer): number {
  return l === 'shield' ? d.shield : l === 'armor' ? d.armor : d.health;
}

function setLayer(d: Defences, l: DefenceLayer, v: number): void {
  if (l === 'shield') d.shield = v;
  else if (l === 'armor') d.armor = v;
  else d.health = v;
}

export function applyDamage(
  d: Defences,
  amount: number,
  type: DamageType,
  opts: DamageOptions = {},
): DamageResult {
  const { crit = false, critMult = 2, weakMult = 1, pierce = 0 } = opts;
  let raw = amount * weakMult * (crit ? critMult : 1);
  if (raw <= 0) return { dealt: 0, layer: 'health', killed: false, overkill: 0, shieldBroken: false };

  const startShield = d.shield;
  let dealt = 0;
  let firstLayer: DefenceLayer | null = null;

  for (const layer of ORDER) {
    if (raw <= 0) break;
    if (layer === 'shield' && bypassesShield(type)) continue;
    if (layer === 'armor' && pierce >= 1) continue;
    const have = layerValue(d, layer);
    if (have <= 0) continue;

    let mult = typeMultiplier(type, layer);
    if (layer === 'armor' && pierce > 0) mult = mult + (1 - mult) * pierce;

    if (firstLayer === null) firstLayer = layer;
    const effective = raw * mult;
    if (effective <= have) {
      setLayer(d, layer, have - effective);
      dealt += raw;
      raw = 0;
    } else {
      // Spend exactly enough raw damage to strip this layer, carry the rest on.
      const consumed = have / mult;
      setLayer(d, layer, 0);
      dealt += consumed;
      raw -= consumed;
    }
  }

  // Any damage taken interrupts shield knitting.
  if (dealt > 0) d.shieldCooldown = d.shieldDelay;

  return {
    dealt,
    layer: firstLayer ?? 'health',
    killed: d.health <= 0,
    overkill: raw,
    shieldBroken: startShield > 0 && d.shield <= 0,
  };
}

/** Shield regeneration and cooldown. Call once per tick per entity. */
export function regenShield(d: Defences, disrupted: boolean): void {
  if (d.health <= 0 || d.shieldMax <= 0) return;
  if (d.shieldCooldown > 0) {
    d.shieldCooldown -= 1;
    return;
  }
  if (disrupted) return;
  if (d.shield < d.shieldMax) {
    d.shield = Math.min(d.shieldMax, d.shield + d.shieldRegen / TICK_HZ);
  }
}

export function applyStatus(
  statuses: Status[],
  kind: StatusKind,
  magnitude: number,
  durationTicks: number,
  damageType: DamageType,
): void {
  const sdef = STATUS_DEFS[kind];
  const existing = statuses.find((s) => s.kind === kind);
  if (existing) {
    existing.stacks = Math.min(sdef.maxStacks, existing.stacks + 1);
    existing.ticksLeft = Math.max(existing.ticksLeft, durationTicks);
    existing.magnitude = magnitude;
    return;
  }
  statuses.push({ kind, stacks: 1, ticksLeft: durationTicks, magnitude, damageType });
}

export interface StatusTickResult {
  damage: number;
  disrupted: boolean;
  stunned: boolean;
}

/** Advances statuses one tick and reports the aggregate effect. Mutates in place. */
export function tickStatuses(statuses: Status[], d: Defences): StatusTickResult {
  let damage = 0;
  let disrupted = false;
  let stunned = false;
  for (let i = statuses.length - 1; i >= 0; i--) {
    const s = statuses[i]!;
    const sdef = STATUS_DEFS[s.kind];
    if (sdef.dot) {
      const perTick = (s.magnitude * s.stacks) / TICK_HZ;
      const res = applyDamage(d, perTick, s.damageType, {});
      damage += res.dealt;
    } else if (s.kind === 'disrupt') {
      disrupted = true;
    } else if (s.kind === 'stagger') {
      stunned = true;
    }
    s.ticksLeft -= 1;
    if (s.ticksLeft <= 0) statuses.splice(i, 1);
  }
  return { damage, disrupted, stunned };
}

export function totalEffectiveHp(d: Defences): number {
  return d.shield + d.armor + d.health;
}

export function makeDefences(
  base: Omit<Defences, 'shieldCooldown'>,
  scale = 1,
): Defences {
  return {
    shield: base.shieldMax * scale,
    shieldMax: base.shieldMax * scale,
    shieldRegen: base.shieldRegen * scale,
    shieldDelay: base.shieldDelay,
    shieldCooldown: 0,
    armor: base.armorMax * scale,
    armorMax: base.armorMax * scale,
    health: base.healthMax * scale,
    healthMax: base.healthMax * scale,
  };
}

/**
 * Closed-form time-to-kill against a static defence profile, in ticks.
 *
 * Used by the idle route to price an encounter without stepping the arena.
 * It intentionally shares `applyDamage` rather than approximating it: the
 * numbers idle produces are the numbers the shooter produces.
 */
export function ticksToKill(
  target: Defences,
  damagePerShot: number,
  type: DamageType,
  ticksPerShot: number,
  maxTicks = 40 * 600,
): number {
  const d: Defences = { ...target };
  let ticks = 0;
  let guard = 0;
  while (d.health > 0 && ticks < maxTicks && guard++ < 200000) {
    applyDamage(d, damagePerShot, type, {});
    ticks += ticksPerShot;
  }
  return Math.min(ticks, maxTicks);
}
