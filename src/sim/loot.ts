/**
 * Loot rolling.
 *
 * Rolls are driven through a `RollSource` rather than a concrete generator so
 * that the same roll code can be fed by either the live stream RNG or a
 * counter-based source keyed on (seed, stream, cycleIndex). The idle path uses
 * the counter form, which is why offline drops can be resolved out of order and
 * still land on exactly the items live play would have produced.
 */
import { hash32, nextFloat, type Rng } from './rng.js';
import type { Affix, Rarity, WeaponInstance } from './types.js';
import {
  AFFIX_POOL,
  RARITIES,
  RARITY_DEFS,
  RARITY_WEIGHTS,
  SIGNATURES,
  basesForRarity,
  getBase,
} from './content/items.js';
import { getArchetype } from './content/weapons.js';

export interface RollSource {
  float(): number;
}

export function streamSource(rng: Rng): RollSource {
  return { float: () => nextFloat(rng) };
}

/** Order-independent across `index`; order-dependent within one roll, which is fine. */
export function counterSource(seed: number, stream: number, index: number): RollSource {
  let k = 0;
  return { float: () => hash32(seed, stream, index * 97 + k++) / 4294967296 };
}

function weightedRarity(src: RollSource, maxRarity: Rarity, luck: number): Rarity {
  const cap = RARITIES.indexOf(maxRarity);
  let total = 0;
  const weights: number[] = [];
  for (let i = 0; i <= cap; i++) {
    const r = RARITIES[i]!;
    // Luck tilts the curve toward the top tiers without ever zeroing commons.
    const w = RARITY_WEIGHTS[r] * (i === 0 ? 1 : Math.pow(luck, i));
    weights.push(w);
    total += w;
  }
  let roll = src.float() * total;
  for (let i = 0; i <= cap; i++) {
    roll -= weights[i]!;
    if (roll < 0) return RARITIES[i]!;
  }
  return RARITIES[cap]!;
}

const PREFIXES = ['Honed', 'Salt-Cut', 'Kiln-Fed', 'Bone-Set', 'Ochre', 'Pilgrim', 'Tithed', 'Rusted'];
const SUFFIXES = ['of the Shelf', 'of Long Afternoon', 'of the Third Kiln', 'of Dust', 'of Quiet Work', 'of the Terrace'];

function nameFor(src: RollSource, baseName: string, rarity: Rarity): string {
  if (rarity === 'common') return baseName;
  const p = PREFIXES[Math.floor(src.float() * PREFIXES.length) % PREFIXES.length]!;
  if (rarity === 'refined') return `${p} ${baseName}`;
  const s = SUFFIXES[Math.floor(src.float() * SUFFIXES.length) % SUFFIXES.length]!;
  return `${p} ${baseName} ${s}`;
}

function rollAffixes(src: RollSource, count: number): Affix[] {
  const chosen: Affix[] = [];
  const pool = [...AFFIX_POOL];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(src.float() * pool.length) % pool.length;
    const picked = pool.splice(idx, 1)[0]!;
    // Roll magnitude within +/-15% so two copies of the same affix differ.
    const jitter = 0.85 + src.float() * 0.3;
    chosen.push(
      picked.flat
        ? { ...picked, value: picked.value * jitter }
        : { ...picked, value: 1 + (picked.value - 1) * jitter },
    );
  }
  return chosen;
}

export interface RollOptions {
  ilvl: number;
  maxRarity?: Rarity;
  /** >1 biases toward higher tiers. Ship and tech feed this. */
  luck?: number;
  uid: number;
}

export function rollWeapon(src: RollSource, opts: RollOptions): WeaponInstance {
  const { ilvl, maxRarity = 'sovereign', luck = 1, uid } = opts;
  const rarity = weightedRarity(src, maxRarity, luck);
  const bases = basesForRarity(rarity);
  const base = bases[Math.floor(src.float() * bases.length) % bases.length]!;
  const affixes = rollAffixes(src, RARITY_DEFS[rarity].affixes);
  return {
    uid,
    archetypeId: base.archetypeId,
    rarity,
    ilvl,
    affixes,
    name: nameFor(src, base.name, rarity),
    locked: false,
  };
}

/** Hand-authored boss drop. No rolls at all — it is the same item every time. */
export function makeSignature(signatureId: string, ilvl: number, uid: number): WeaponInstance {
  const sig = SIGNATURES[signatureId];
  if (!sig) throw new Error(`unknown signature: ${signatureId}`);
  return {
    uid,
    archetypeId: sig.archetypeId,
    rarity: sig.rarity,
    ilvl,
    affixes: sig.affixes.map((a) => ({ ...a })),
    signature: sig.id,
    name: sig.name,
    locked: true,
  };
}

/** Materials returned by scrapping. */
export function breakdownValue(item: WeaponInstance, yieldMult: number): number {
  const base = RARITY_DEFS[item.rarity].breakdown;
  return Math.floor(base * (1 + item.ilvl / 40) * yieldMult);
}

/** A single comparable number for sorting and for "is this an upgrade" hints. */
export function itemPower(item: WeaponInstance): number {
  const arch = getArchetype(item.archetypeId);
  const dps = (arch.baseDamage * arch.pellets * 40) / arch.fireInterval;
  let mult = RARITY_DEFS[item.rarity].power * (1 + item.ilvl / 25);
  for (const a of item.affixes) {
    if (a.stat === 'damage' || a.stat === 'fireRate') mult *= a.flat ? 1 : a.value;
  }
  return Math.round(dps * mult);
}

export function itemFlavor(item: WeaponInstance): string {
  if (item.signature) return SIGNATURES[item.signature]?.flavor ?? '';
  const base = basesForRarity(item.rarity).find((b) => b.archetypeId === item.archetypeId);
  return base ? getBase(base.id).flavor : '';
}
