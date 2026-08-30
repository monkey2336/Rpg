/**
 * Damage types and the layered-defence interaction matrix.
 *
 * The four types are renamed to fit the setting but map to the classic roles:
 *   percussive — kinetic. Reliable, armour-shy, punishes flesh.
 *   solar      — thermal. Ablates armour plate, ignites. Poor against shields.
 *   caustic    — corrosive. Rots health, stacks, bounces off shields.
 *   arc        — ion. Shreds shields, suppresses regen, weak to plate.
 *
 * Every multiplier here is a balance lever the designers own. Nothing else in
 * the sim hardcodes a type interaction.
 */
import type { DamageType, DefenceLayer, StatusKind } from '../types.js';

export const DAMAGE_TYPES: readonly DamageType[] = ['percussive', 'solar', 'caustic', 'arc'];

export const DAMAGE_LABEL: Record<DamageType, string> = {
  percussive: 'Percussive',
  solar: 'Solar',
  caustic: 'Caustic',
  arc: 'Arc',
};

/** One accent per type, reused for telegraphs so the language stays consistent. */
export const DAMAGE_COLOR: Record<DamageType, string> = {
  percussive: '#d9c7a3',
  solar: '#e8853a',
  caustic: '#8fae4b',
  arc: '#6fa9c9',
};

/**
 * Every type must be weak somewhere and strong somewhere — a type with no
 * downside is not a choice, it is the correct answer. `combat.test.ts` asserts
 * that property, so this table cannot quietly drift into having a best pick.
 */
const MATRIX: Record<DamageType, Record<DefenceLayer, number>> = {
  percussive: { shield: 0.70, armor: 0.85, health: 1.15 },
  solar: { shield: 0.85, armor: 1.40, health: 1.05 },
  caustic: { shield: 0.50, armor: 1.10, health: 1.45 },
  arc: { shield: 1.75, armor: 0.70, health: 0.85 },
};

export function typeMultiplier(type: DamageType, layer: DefenceLayer): number {
  return MATRIX[type][layer];
}

export interface StatusDef {
  kind: StatusKind;
  label: string;
  damageType: DamageType;
  maxStacks: number;
  /** DoTs tick damage; debuffs apply their effect in combat.ts. */
  dot: boolean;
  description: string;
}

export const STATUS_DEFS: Record<StatusKind, StatusDef> = {
  corrosion: {
    kind: 'corrosion',
    label: 'Corrosion',
    damageType: 'caustic',
    maxStacks: 10,
    dot: true,
    description: 'Stacking damage over time. Bypasses shields entirely.',
  },
  ignite: {
    kind: 'ignite',
    label: 'Ignition',
    damageType: 'solar',
    maxStacks: 3,
    dot: true,
    description: 'Burns armour. Spreads to adjacent hostiles on death.',
  },
  disrupt: {
    kind: 'disrupt',
    label: 'Disruption',
    damageType: 'arc',
    maxStacks: 1,
    dot: false,
    description: 'Shield regeneration suppressed for the duration.',
  },
  stagger: {
    kind: 'stagger',
    label: 'Stagger',
    damageType: 'percussive',
    maxStacks: 1,
    dot: false,
    description: 'Target cannot act. Heavy weapons build it fastest.',
  },
};

/** Corrosion ignores shields; everything else eats the top surviving layer. */
export function bypassesShield(type: DamageType): boolean {
  return type === 'caustic';
}
