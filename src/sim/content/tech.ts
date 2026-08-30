/**
 * Data-funded tech tree.
 *
 * Data is deliberately scarce in idle and generous in active play — this tree
 * is the lever that keeps active sessions worth showing up for. Nothing here
 * can be bought with materials.
 */
import type { TechNode } from '../types.js';

export const TECH_NODES: readonly TechNode[] = [
  {
    id: 'survey-optics',
    name: 'Survey Optics',
    cost: 40,
    requires: [],
    effect: { stat: 'scanSpeed', value: 1.35 },
    description: 'Scan sites resolve 35% faster.',
  },
  {
    id: 'core-sampling',
    name: 'Core Sampling',
    cost: 60,
    requires: [],
    effect: { stat: 'miningYield', value: 1.4 },
    description: 'Deposits give 40% more material.',
  },
  {
    id: 'route-discipline',
    name: 'Route Discipline',
    cost: 110,
    requires: ['core-sampling'],
    effect: { stat: 'idleRate', value: 1.25 },
    description: 'Idle routes run 25% richer.',
  },
  {
    id: 'long-watch',
    name: 'The Long Watch',
    cost: 180,
    requires: ['route-discipline'],
    effect: { stat: 'offlineCapHours', value: 24 },
    description: 'Offline accrual cap raised by 24 hours, to 72.',
  },
  {
    id: 'sealed-hold',
    name: 'Sealed Hold',
    cost: 90,
    requires: [],
    effect: { stat: 'inventorySlots', value: 12 },
    description: 'Twelve more inventory slots.',
  },
  {
    id: 'reclamation',
    name: 'Reclamation',
    cost: 140,
    requires: ['sealed-hold'],
    effect: { stat: 'breakdownYield', value: 1.5 },
    description: 'Breaking gear down returns 50% more.',
  },
  {
    id: 'ablative-weave',
    name: 'Ablative Weave',
    cost: 120,
    requires: [],
    effect: { stat: 'playerArmor', value: 60 },
    description: '+60 armour.',
  },
  {
    id: 'shield-lattice',
    name: 'Shield Lattice',
    cost: 150,
    requires: ['ablative-weave'],
    effect: { stat: 'playerShield', value: 90 },
    description: '+90 shield capacity.',
  },
  {
    id: 'ordnance-doctrine',
    name: 'Ordnance Doctrine',
    cost: 200,
    requires: [],
    effect: { stat: 'weaponDamage', value: 1.18 },
    description: 'All weapons deal 18% more damage.',
  },
  {
    id: 'translation-rites',
    name: 'Translation Rites',
    cost: 260,
    requires: ['survey-optics'],
    effect: { stat: 'dataYield', value: 1.45 },
    description: 'All data income increased 45%.',
  },
];

const BY_ID = new Map(TECH_NODES.map((t) => [t.id, t]));

export function getTech(id: string): TechNode {
  const t = BY_ID.get(id);
  if (!t) throw new Error(`unknown tech node: ${id}`);
  return t;
}

export function techAvailable(id: string, unlocked: readonly string[]): boolean {
  const node = getTech(id);
  return !unlocked.includes(id) && node.requires.every((r) => unlocked.includes(r));
}
