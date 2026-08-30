/**
 * Ship upgrades — the materials sink, mirroring the tech tree's data sink.
 *
 * Costs are authored per rank across material tiers so that a late-game rank
 * still wants tier-1 Slag. That is the mechanism that keeps early zones alive
 * for a player who has long outlevelled them.
 */
export interface ShipUpgradeDef {
  id: string;
  name: string;
  maxRank: number;
  /** Cost of rank n is base * growth^(n-1), per tier, floored. */
  cost: { tier: number; base: number }[];
  growth: number;
  effect: { stat: string; perRank: number; multiplicative?: boolean };
  description: string;
}

export const SHIP_UPGRADES: readonly ShipUpgradeDef[] = [
  {
    id: 'hold',
    name: 'Cargo Hold',
    maxRank: 8,
    cost: [{ tier: 1, base: 120 }],
    growth: 1.55,
    effect: { stat: 'inventorySlots', perRank: 6 },
    description: '+6 inventory slots per rank.',
  },
  {
    id: 'drills',
    name: 'Core Drills',
    maxRank: 10,
    cost: [
      { tier: 1, base: 90 },
      { tier: 2, base: 20 },
    ],
    growth: 1.48,
    effect: { stat: 'miningYield', perRank: 0.12, multiplicative: true },
    description: '+12% deposit yield per rank.',
  },
  {
    id: 'reactor',
    name: 'Reactor Trim',
    maxRank: 6,
    cost: [
      { tier: 1, base: 150 },
      { tier: 2, base: 40 },
    ],
    growth: 1.7,
    effect: { stat: 'fuelMax', perRank: 25 },
    description: '+25 fuel capacity per rank.',
  },
  {
    id: 'plating',
    name: 'Ablative Plate',
    maxRank: 12,
    cost: [
      { tier: 1, base: 110 },
      { tier: 2, base: 25 },
    ],
    growth: 1.42,
    effect: { stat: 'playerArmor', perRank: 22 },
    description: '+22 armour per rank.',
  },
  {
    id: 'veil',
    name: 'Shield Veil',
    maxRank: 12,
    cost: [
      { tier: 1, base: 130 },
      { tier: 2, base: 30 },
    ],
    growth: 1.44,
    effect: { stat: 'playerShield', perRank: 26 },
    description: '+26 shield capacity per rank.',
  },
  {
    id: 'augur',
    name: 'Augur Array',
    maxRank: 8,
    cost: [
      { tier: 1, base: 200 },
      { tier: 2, base: 60 },
      { tier: 3, base: 10 },
    ],
    growth: 1.62,
    effect: { stat: 'luck', perRank: 0.06 },
    description: '+6% loot rarity weighting per rank.',
  },
  {
    id: 'tender',
    name: 'Route Tender',
    maxRank: 10,
    cost: [
      { tier: 1, base: 180 },
      { tier: 2, base: 55 },
    ],
    growth: 1.5,
    effect: { stat: 'idleRate', perRank: 0.1, multiplicative: true },
    description: '+10% idle route yield per rank.',
  },
];

const BY_ID = new Map(SHIP_UPGRADES.map((u) => [u.id, u]));

export function getShipUpgrade(id: string): ShipUpgradeDef {
  const u = BY_ID.get(id);
  if (!u) throw new Error(`unknown ship upgrade: ${id}`);
  return u;
}

/** Cost of taking `id` from `rank` to `rank + 1`. Empty when maxed. */
export function upgradeCost(id: string, rank: number): { tier: number; amount: number }[] {
  const def = getShipUpgrade(id);
  if (rank >= def.maxRank) return [];
  const scale = Math.pow(def.growth, rank);
  return def.cost.map((c) => ({ tier: c.tier, amount: Math.floor(c.base * scale) }));
}
