/**
 * Loot content: rarity tiers, the hand-authored base pool, and the affix table.
 *
 * The rule the brief locks in and this file enforces: bases and signature drops
 * are hand-authored; only the *rolls* are procedural. Fully generative items
 * read as noise, so there is no code path that invents a base.
 */
import type { Affix, ItemBase, Rarity } from '../types.js';

export const RARITIES: readonly Rarity[] = ['common', 'refined', 'marked', 'relic', 'sovereign'];

export interface RarityDef {
  id: Rarity;
  label: string;
  color: string;
  /** Number of procedural affixes rolled. */
  affixes: number;
  /** Multiplier on base damage. */
  power: number;
  /** Materials returned when broken down, before ship bonuses. */
  breakdown: number;
  /** Idle routes cannot exceed this tier — see route.ts. */
  idleReachable: boolean;
}

export const RARITY_DEFS: Record<Rarity, RarityDef> = {
  common: { id: 'common', label: 'Common', color: '#8d8577', affixes: 0, power: 1.0, breakdown: 4, idleReachable: true },
  refined: { id: 'refined', label: 'Refined', color: '#c9b98f', affixes: 1, power: 1.22, breakdown: 11, idleReachable: true },
  marked: { id: 'marked', label: 'Marked', color: '#c98f4a', affixes: 2, power: 1.55, breakdown: 30, idleReachable: false },
  relic: { id: 'relic', label: 'Relic', color: '#9c5f7a', affixes: 3, power: 2.05, breakdown: 84, idleReachable: false },
  sovereign: { id: 'sovereign', label: 'Sovereign', color: '#d8d2c4', affixes: 4, power: 2.8, breakdown: 220, idleReachable: false },
};

/** Base drop weights for an ordinary hostile. Bosses override these. */
export const RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 660,
  refined: 250,
  marked: 72,
  relic: 16,
  sovereign: 2,
};

export const ITEM_BASES: readonly ItemBase[] = [
  { id: 'adze-field', name: 'Field Adze', archetypeId: 'adze', minRarity: 'common', flavor: 'Issue pattern. Stock worn to the grain by someone else.' },
  { id: 'adze-shelf', name: 'Shelf Adze', archetypeId: 'adze', minRarity: 'refined', flavor: 'Rechambered on Khadir for the long flats. Kicks like a debt.' },
  { id: 'thurible-votive', name: 'Votive Thurible', archetypeId: 'thurible', minRarity: 'common', flavor: 'A mining lance with the governor filed off.' },
  { id: 'thurible-long', name: 'Long Thurible', archetypeId: 'thurible', minRarity: 'marked', flavor: 'Extended focusing throat. Runs hot enough to blister the housing.' },
  { id: 'censer-clay', name: 'Clay Censer', archetypeId: 'censer', minRarity: 'common', flavor: 'Unglazed. Breaks on anything, which is the point.' },
  { id: 'censer-sealed', name: 'Sealed Censer', archetypeId: 'censer', minRarity: 'refined', flavor: 'Waxed shut. The rot inside has been fermenting for a while.' },
  { id: 'vespers-coil', name: 'Coil Vespers', archetypeId: 'vespers', minRarity: 'common', flavor: 'Surplus shield-breaker. Whines before it fires.' },
  { id: 'maw-short', name: 'Short Maw', archetypeId: 'maw', minRarity: 'common', flavor: 'Cut down twice. Once at the factory, once by someone in a hurry.' },
  { id: 'obelisk-mark', name: 'Marked Obelisk', archetypeId: 'obelisk', minRarity: 'marked', flavor: 'A rail with a name stamped on the receiver. Not yours.' },
  { id: 'reliquary-small', name: 'Small Reliquary', archetypeId: 'reliquary', minRarity: 'refined', flavor: 'Holds five. Releases five. Asks nothing.' },
  { id: 'pyre-hand', name: 'Hand Pyre', archetypeId: 'pyre', minRarity: 'common', flavor: 'Used for clearing spore growth. Also clears other things.' },
];

/** Hand-authored, fixed, and memorable. One per boss, guaranteed. */
export interface SignatureDef {
  id: string;
  name: string;
  archetypeId: string;
  rarity: Rarity;
  affixes: Affix[];
  flavor: string;
}

export const SIGNATURES: Record<string, SignatureDef> = {
  'wardens-tithe': {
    id: 'wardens-tithe',
    name: "Warden's Tithe",
    archetypeId: 'thurible',
    rarity: 'relic',
    affixes: [
      { id: 'sig-vent', label: 'Vent Discipline', stat: 'damage', value: 1.34 },
      { id: 'sig-throat', label: 'Open Throat', stat: 'fireRate', value: 1.18 },
      { id: 'sig-kiln', label: 'Kiln-Fed', stat: 'statusChance', value: 2.5 },
    ],
    flavor: 'Cut from the Warden\'s own vent assembly. It still runs hot when the sun is up.',
  },
};

export const AFFIX_POOL: readonly Affix[] = [
  { id: 'aff-bore', label: 'Wide Bore', stat: 'damage', value: 1.14 },
  { id: 'aff-heavy', label: 'Heavy Charge', stat: 'damage', value: 1.22 },
  { id: 'aff-tuned', label: 'Tuned Action', stat: 'fireRate', value: 1.15 },
  { id: 'aff-quick', label: 'Quick Cycle', stat: 'fireRate', value: 1.09 },
  { id: 'aff-deep', label: 'Deep Magazine', stat: 'magazine', value: 4, flat: true },
  { id: 'aff-drilled', label: 'Drilled Hands', stat: 'reload', value: 0.82 },
  { id: 'aff-honed', label: 'Honed Sight', stat: 'crit', value: 0.07, flat: true },
  { id: 'aff-cruel', label: 'Cruel Angle', stat: 'critMult', value: 0.45, flat: true },
  { id: 'aff-light', label: 'Lightened Frame', stat: 'handling', value: 1.12 },
  { id: 'aff-tainted', label: 'Tainted Load', stat: 'statusChance', value: 1.5 },
];

const BASES_BY_ID = new Map(ITEM_BASES.map((b) => [b.id, b]));
export function getBase(id: string): ItemBase {
  const b = BASES_BY_ID.get(id);
  if (!b) throw new Error(`unknown item base: ${id}`);
  return b;
}

/** Bases whose minimum rarity permits them to appear at the rolled tier. */
export function basesForRarity(rarity: Rarity): ItemBase[] {
  const idx = RARITIES.indexOf(rarity);
  return ITEM_BASES.filter((b) => RARITIES.indexOf(b.minRarity) <= idx);
}

/* Material tiers. Tier 1 stays a crafting input all game, so early zones keep
 * a reason to exist for a late-game player. */
export const MATERIAL_NAMES: Record<number, string> = {
  1: 'Slag',
  2: 'Ferrite',
  3: 'Bone-glass',
  4: 'Vitrine',
  5: 'Sovereign Ash',
};
