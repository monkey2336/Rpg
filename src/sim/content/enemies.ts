/**
 * Hostiles. Insectoid and industrial, never cute.
 *
 * Four base types plus one elite per zone, per the brief. Each base type owns a
 * different *pressure*: one closes distance, one flanks fast, one denies space
 * from range, one refuses to stay where you left it. If two of them read the
 * same in play, one of them is wrong.
 */
import type { EnemyDef } from '../types.js';

const def = (d: EnemyDef): EnemyDef => d;

export const ENEMY_DEFS: readonly EnemyDef[] = [
  def({
    id: 'shelf-tick',
    name: 'Shelf Tick',
    kind: 'grunt',
    radius: 13,
    height: 20,
    speed: 1.55,
    defences: { shield: 0, shieldMax: 0, shieldRegen: 0, shieldDelay: 0, armor: 0, armorMax: 0, health: 90, healthMax: 90 },
    contactDamage: 7,
    contactType: 'percussive',
    attackInterval: 40,
    attackDamage: 0,
    attackType: 'percussive',
    attackRange: 26,
    xp: 6,
    matDrop: 3,
    dataDrop: 0,
  }),
  def({
    id: 'flint-skirmisher',
    name: 'Flint Skirmisher',
    kind: 'skirmisher',
    radius: 14,
    height: 38,
    speed: 2.6,
    defences: { shield: 40, shieldMax: 40, shieldRegen: 9, shieldDelay: 90, armor: 0, armorMax: 0, health: 120, healthMax: 120 },
    contactDamage: 4,
    contactType: 'percussive',
    attackInterval: 52,
    attackDamage: 16,
    attackType: 'percussive',
    attackRange: 54,
    xp: 11,
    matDrop: 5,
    dataDrop: 1,
  }),
  def({
    id: 'duster-artillery',
    name: 'Duster',
    kind: 'artillery',
    radius: 17,
    height: 32,
    speed: 0.7,
    defences: { shield: 0, shieldMax: 0, shieldRegen: 0, shieldDelay: 0, armor: 60, armorMax: 60, health: 140, healthMax: 140 },
    contactDamage: 0,
    contactType: 'percussive',
    attackInterval: 96,
    attackDamage: 24,
    attackType: 'caustic',
    attackRange: 520,
    xp: 15,
    matDrop: 7,
    dataDrop: 2,
  }),
  def({
    id: 'hollow-drone',
    name: 'Hollow Drone',
    kind: 'burrower',
    radius: 15,
    height: 30,
    speed: 1.9,
    defences: { shield: 0, shieldMax: 0, shieldRegen: 0, shieldDelay: 0, armor: 35, armorMax: 35, health: 105, healthMax: 105 },
    contactDamage: 12,
    contactType: 'solar',
    attackInterval: 70,
    attackDamage: 18,
    attackType: 'solar',
    attackRange: 40,
    xp: 13,
    matDrop: 6,
    dataDrop: 2,
  }),
  def({
    id: 'chalk-praetor',
    name: 'Chalk Praetor',
    kind: 'elite',
    radius: 24,
    height: 64,
    speed: 1.15,
    defences: { shield: 260, shieldMax: 260, shieldRegen: 26, shieldDelay: 140, armor: 180, armorMax: 180, health: 480, healthMax: 480 },
    contactDamage: 16,
    contactType: 'percussive',
    attackInterval: 74,
    attackDamage: 38,
    attackType: 'arc',
    attackRange: 280,
    xp: 70,
    matDrop: 34,
    dataDrop: 12,
  }),
  def({
    id: 'vault-mite',
    name: 'Vault Mite',
    kind: 'grunt',
    radius: 11,
    height: 18,
    speed: 2.1,
    defences: { shield: 25, shieldMax: 25, shieldRegen: 14, shieldDelay: 70, armor: 0, armorMax: 0, health: 60, healthMax: 60 },
    contactDamage: 9,
    contactType: 'arc',
    attackInterval: 34,
    attackDamage: 0,
    attackType: 'arc',
    attackRange: 22,
    xp: 8,
    matDrop: 4,
    dataDrop: 1,
  }),
];

const BY_ID = new Map(ENEMY_DEFS.map((e) => [e.id, e]));

export function getEnemy(id: string): EnemyDef {
  const e = BY_ID.get(id);
  if (!e) throw new Error(`unknown enemy: ${id}`);
  return e;
}

/** Total effective HP against a neutral damage profile. Used by route maths. */
export function effectiveHp(d: EnemyDef): number {
  return d.defences.shieldMax + d.defences.armorMax + d.defences.healthMax;
}
