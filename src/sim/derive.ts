/**
 * Derived stats.
 *
 * Pure function of state -> numbers. Nothing caches; it is cheap and being
 * recomputable from scratch is what keeps the three render targets honest —
 * the widget derives the same numbers the full HUD does, from the same state.
 */
import type { GameState } from './state.js';
import { findItem } from './state.js';
import type { DamageType, Defences, WeaponBehavior, WeaponInstance } from './types.js';
import { getArchetype } from './content/weapons.js';
import { RARITY_DEFS } from './content/items.js';
import { getTech } from './content/tech.js';
import { SHIP_UPGRADES, getShipUpgrade } from './content/ship.js';
import { TICK_HZ } from './combat.js';

export interface ResolvedWeapon {
  item: WeaponInstance;
  archetypeId: string;
  name: string;
  damageType: DamageType;
  behavior: WeaponBehavior;
  /** Damage per pellet, fully scaled. */
  damage: number;
  pellets: number;
  fireInterval: number;
  magazine: number;
  reloadTicks: number;
  spread: number;
  projectileSpeed: number;
  range: number;
  critChance: number;
  critMult: number;
  recoil: number;
  hitstop: number;
  handling: number;
  statusChanceMult: number;
  dps: number;
}

export interface Derived {
  maxHealth: number;
  maxShield: number;
  maxArmor: number;
  shieldRegen: number;
  armorRegen: number;
  killRecovery: number;
  moveSpeed: number;
  damageMult: number;
  luck: number;
  miningYield: number;
  scanSpeed: number;
  dataYield: number;
  idleRate: number;
  breakdownYield: number;
  inventorySlots: number;
  offlineCapHours: number;
  fuelMax: number;
  power: number;
  weapon: ResolvedWeapon | null;
}

interface Mods {
  [stat: string]: number;
}

const BASE_MODS: Mods = {
  miningYield: 1,
  scanSpeed: 1,
  dataYield: 1,
  idleRate: 1,
  breakdownYield: 1,
  weaponDamage: 1,
  luck: 1,
  inventorySlots: 0,
  playerArmor: 0,
  playerShield: 0,
  offlineCapHours: 48,
  fuelMax: 0,
};

function collectMods(state: GameState): Mods {
  const mods: Mods = { ...BASE_MODS };
  for (const id of state.tech.unlocked) {
    const node = getTech(id);
    const { stat, value } = node.effect;
    // Multiplicative stats sit at 1 by default; additive ones at 0.
    if (stat in mods && (mods[stat] === 1 || stat.endsWith('Yield') || stat === 'idleRate' || stat === 'scanSpeed' || stat === 'weaponDamage')) {
      mods[stat] = (mods[stat] ?? 1) * value;
    } else {
      mods[stat] = (mods[stat] ?? 0) + value;
    }
  }
  for (const up of SHIP_UPGRADES) {
    const rank = state.ship.upgrades[up.id] ?? 0;
    if (rank <= 0) continue;
    const def = getShipUpgrade(up.id);
    const { stat, perRank, multiplicative } = def.effect;
    if (multiplicative) mods[stat] = (mods[stat] ?? 1) * (1 + perRank * rank);
    else mods[stat] = (mods[stat] ?? 0) + perRank * rank;
  }
  return mods;
}

export function resolveWeapon(item: WeaponInstance, damageMult: number): ResolvedWeapon {
  const a = getArchetype(item.archetypeId);
  const rarity = RARITY_DEFS[item.rarity];
  let damage = a.baseDamage * rarity.power * (1 + item.ilvl * 0.055) * damageMult;
  let fireInterval = a.fireInterval;
  let magazine = a.magazine;
  let reloadTicks = a.reloadTicks;
  let critChance = a.critChance;
  let critMult = a.critMult;
  let handling = a.handling;
  let statusChanceMult = 1;

  for (const aff of item.affixes) {
    switch (aff.stat) {
      case 'damage':
        damage *= aff.value;
        break;
      case 'fireRate':
        fireInterval = Math.max(1, fireInterval / aff.value);
        break;
      case 'magazine':
        magazine += aff.flat ? Math.round(aff.value) : 0;
        break;
      case 'reload':
        reloadTicks = Math.max(6, reloadTicks * aff.value);
        break;
      case 'crit':
        critChance += aff.value;
        break;
      case 'critMult':
        critMult += aff.value;
        break;
      case 'handling':
        handling *= aff.value;
        break;
      case 'statusChance':
        statusChanceMult *= aff.value;
        break;
    }
  }

  // Sustained DPS including the reload, which is the number that should drive
  // idle route maths — burst DPS would systematically overpay the idle loop.
  const shotsPerMag = Math.max(1, magazine);
  const cycleTicks = shotsPerMag * fireInterval + reloadTicks;
  const perShot = damage * a.pellets * (1 + critChance * (critMult - 1));
  const dps = (perShot * shotsPerMag * TICK_HZ) / cycleTicks;

  return {
    item,
    archetypeId: a.id,
    name: item.name,
    damageType: a.damageType,
    behavior: a.behavior,
    damage,
    pellets: a.pellets,
    fireInterval: Math.round(fireInterval),
    magazine: Math.round(magazine),
    reloadTicks: Math.round(reloadTicks),
    spread: a.spread,
    projectileSpeed: a.projectileSpeed,
    range: a.range,
    critChance,
    critMult,
    recoil: a.recoil,
    hitstop: a.hitstop,
    handling,
    statusChanceMult,
    dps,
  };
}

export function derive(state: GameState): Derived {
  const mods = collectMods(state);
  const prestige = state.prestige.multiplier;
  const level = state.player.level;

  const damageMult = (mods.weaponDamage ?? 1) * prestige * (1 + (level - 1) * 0.04);
  const item = findItem(state, state.player.loadout[state.player.activeSlot] ?? null);
  const weapon = item ? resolveWeapon(item, damageMult) : null;

  const maxHealth = 220 + (level - 1) * 18;
  const maxShield = 120 + (mods.playerShield ?? 0) + (level - 1) * 6;
  const maxArmor = 60 + (mods.playerArmor ?? 0) + (level - 1) * 4;

  return {
    maxHealth,
    maxShield,
    maxArmor,
    shieldRegen: 22 + (level - 1) * 1.2,
    // Plate repairs itself steadily; ranks in Ablative Plate speed it up.
    armorRegen: 3.2 + (state.ship.upgrades.plating ?? 0) * 0.6,
    killRecovery: 0.025,
    moveSpeed: 3.4 * (weapon?.handling ?? 1),
    damageMult,
    luck: mods.luck ?? 1,
    miningYield: (mods.miningYield ?? 1) * prestige,
    scanSpeed: mods.scanSpeed ?? 1,
    dataYield: (mods.dataYield ?? 1) * prestige,
    idleRate: (mods.idleRate ?? 1) * prestige,
    breakdownYield: mods.breakdownYield ?? 1,
    inventorySlots: 24 + (mods.inventorySlots ?? 0),
    offlineCapHours: mods.offlineCapHours ?? 48,
    fuelMax: 100 + (mods.fuelMax ?? 0),
    power: weapon ? Math.round(weapon.dps) : 0,
    weapon,
  };
}

/** Applies derived caps to the live defence block, preserving current fill ratios. */
export function syncPlayerDefences(state: GameState, d: Derived): void {
  const p: Defences = state.player.defences;
  const hFrac = p.healthMax > 0 ? p.health / p.healthMax : 1;
  const sFrac = p.shieldMax > 0 ? p.shield / p.shieldMax : 1;
  const aFrac = p.armorMax > 0 ? p.armor / p.armorMax : 1;
  p.healthMax = d.maxHealth;
  p.shieldMax = d.maxShield;
  p.armorMax = d.maxArmor;
  p.shieldRegen = d.shieldRegen;
  p.health = Math.min(p.healthMax, hFrac * p.healthMax);
  p.shield = Math.min(p.shieldMax, sFrac * p.shieldMax);
  p.armor = Math.min(p.armorMax, aFrac * p.armorMax);
}
