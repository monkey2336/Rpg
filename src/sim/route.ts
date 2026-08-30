/**
 * Idle route resolution.
 *
 * The whole offline-parity guarantee rests on one rule enforced here:
 * **there is exactly one function that turns route cycles into game state**,
 * `resolveCycles`. Live idle ticking calls it one cycle at a time. The offline
 * closed-form path calls it once for a batch. The offline stepwise path calls
 * it one cycle at a time again. There is no second economy anywhere.
 *
 * Two properties make batching exact rather than approximately exact:
 *
 *  1. Bulk yields are integers, computed once in `planCycle`. `n * y` is exact
 *     for integer y, and equals y added n times. Floats would drift.
 *  2. Discrete events (loot drops) are drawn from a *counter-based* RNG keyed
 *     on the cycle index, not from the streaming generator. Cycle 900's drop is
 *     the same whether you got there by stepping 900 cycles or by asking for
 *     cycle 900 directly.
 *
 * Combat time per cycle comes from `ticksToKill`, which is the same
 * `applyDamage` the shooter runs. A better loadout genuinely farms faster, and
 * the damage-type matrix matters to idle exactly as much as it does in a fight.
 */
import { TICK_HZ, makeDefences, ticksToKill } from './combat.js';
import { derive, type Derived } from './derive.js';
import { effectiveHp, getEnemy } from './content/enemies.js';
import { RARITY_DEFS } from './content/items.js';
import { getZone } from './content/zones.js';
import { breakdownValue, counterSource, rollWeapon } from './loot.js';
import { hash32, rngAt } from './rng.js';
import { addMaterials, grantXp, type GameState } from './state.js';
import type { MaterialTier, Rarity, WeaponInstance } from './types.js';

/** RNG stream ids. Distinct so adding a new random system never desyncs an old one. */
export const STREAM_ROUTE_DROP = 0x1001;
export const STREAM_ROUTE_ROLL = 0x1002;

/**
 * Idle pays less for data than for materials, deliberately. This is the single
 * lever that keeps active sessions valuable (brief §5.2); it lives here, alone,
 * so balance can move it without touching anything else.
 */
export const IDLE_DATA_RATE = 0.35;
export const IDLE_MATERIAL_RATE = 0.62;

/** Idle cannot roll above Refined. New rarities require hands on the sticks. */
export const IDLE_MAX_RARITY: Rarity = 'refined';

export interface CyclePlan {
  zoneId: string;
  /** Integer. Travel + harvest overhead plus resolved combat time. */
  cycleTicks: number;
  /** Integer. */
  matPerCycle: number;
  matTier: MaterialTier;
  /** Integer. */
  dataPerCycle: number;
  /** Integer. */
  xpPerCycle: number;
  dropChance: number;
  maxRarity: Rarity;
  ilvl: number;
  luck: number;
  /**
   * Captured into the plan rather than re-derived inside `resolveCycles`.
   * Batched and stepwise resolution must see identical values for anything the
   * loop reads, so nothing the loop can itself mutate (level, item count) is
   * allowed to feed back into these. Keeping them on the plan makes that a
   * property of the type instead of a thing to remember.
   */
  inventorySlots: number;
  breakdownYield: number;
  /** Cached so the widget can show an honest ETA without recomputing. */
  cycleSeconds: number;
}

/**
 * Prices one route cycle. Pure; depends only on state + content, so it is safe
 * to recompute at any time and must be recomputed whenever gear changes.
 */
export function planCycle(state: GameState, zoneId: string): CyclePlan {
  const zone = getZone(zoneId);
  const d: Derived = derive(state);

  // Combat time: run the real resolver against one of each hostile in the pool.
  let combatTicks = 0;
  let matFromKills = 0;
  let dataFromKills = 0;
  let xp = 0;
  if (d.weapon) {
    const dmgPerShot = d.weapon.damage * d.weapon.pellets * (1 + d.weapon.critChance * (d.weapon.critMult - 1));
    // Sustained cadence: magazine spent, then a reload, averaged per shot.
    const shots = Math.max(1, d.weapon.magazine);
    const ticksPerShot = Math.max(1, Math.round((shots * d.weapon.fireInterval + d.weapon.reloadTicks) / shots));
    for (const id of zone.enemyPool) {
      const e = getEnemy(id);
      combatTicks += ticksToKill(makeDefences(e.defences), dmgPerShot, d.weapon.damageType, ticksPerShot);
      matFromKills += e.matDrop;
      dataFromKills += e.dataDrop;
      xp += e.xp;
    }
  } else {
    // No weapon equipped: the route still runs, just badly.
    combatTicks = 40 * 120;
  }

  const overheadTicks = zone.idle.cycleTicks;
  const cycleTicks = Math.max(40, Math.floor(overheadTicks + combatTicks));

  const matRaw =
    (zone.idle.matPerCycle * d.miningYield + matFromKills) * IDLE_MATERIAL_RATE * d.idleRate;
  const dataRaw = (zone.idle.dataPerCycle + dataFromKills) * d.dataYield * IDLE_DATA_RATE * d.idleRate;

  return {
    zoneId,
    cycleTicks,
    matPerCycle: Math.floor(matRaw),
    matTier: zone.depositTier,
    dataPerCycle: Math.floor(dataRaw),
    xpPerCycle: Math.floor(xp * IDLE_MATERIAL_RATE),
    dropChance: zone.idle.dropChance,
    maxRarity: IDLE_MAX_RARITY,
    ilvl: Math.max(1, zone.recommendedPower),
    luck: d.luck,
    inventorySlots: d.inventorySlots,
    breakdownYield: d.breakdownYield,
    cycleSeconds: cycleTicks / TICK_HZ,
  };
}

export interface CycleOutcome {
  cycles: number;
  materials: number;
  matTier: MaterialTier;
  data: number;
  drops: WeaponInstance[];
  /** Items scrapped on arrival because the hold was full. */
  autoScrapped: number;
  scrapMaterials: number;
  levelled: boolean;
}

/**
 * THE single mutation path for idle progress.
 *
 * Resolves cycles [fromCycle, toCycle) into `state`. Called with one cycle by
 * live play and by the stepwise offline resolver, and with a batch by the
 * closed-form resolver. Identical inputs must give identical state — that is
 * asserted by test/offline-parity.test.ts, which is the test that protects the
 * whole design.
 */
export function resolveCycles(
  state: GameState,
  plan: CyclePlan,
  fromCycle: number,
  toCycle: number,
): CycleOutcome {
  const count = Math.max(0, toCycle - fromCycle);
  const out: CycleOutcome = {
    cycles: count,
    materials: 0,
    matTier: plan.matTier,
    data: 0,
    drops: [],
    autoScrapped: 0,
    scrapMaterials: 0,
    levelled: false,
  };
  if (count === 0) return out;

  // --- bulk: exact integer arithmetic, batched or not, same answer ----------
  const materials = plan.matPerCycle * count;
  const data = plan.dataPerCycle * count;
  const xp = plan.xpPerCycle * count;
  addMaterials(state, plan.matTier, materials);
  state.resources.data += data;
  out.materials = materials;
  out.data = data;
  if (xp > 0) out.levelled = grantXp(state, xp) || out.levelled;

  // --- discrete: counter-indexed, so batching cannot reorder it ------------
  const zoneSalt = hash32(hashZone(plan.zoneId));
  for (let c = fromCycle; c < toCycle; c++) {
    if (rngAt(state.seed ^ zoneSalt, STREAM_ROUTE_DROP, c) >= plan.dropChance) continue;
    const src = counterSource(state.seed ^ zoneSalt, STREAM_ROUTE_ROLL, c);
    const item = rollWeapon(src, {
      ilvl: plan.ilvl,
      maxRarity: plan.maxRarity,
      luck: plan.luck,
      uid: state.nextUid++,
    });
    state.stats.itemsDropped += 1;
    if (state.inventory.items.length < plan.inventorySlots) {
      state.inventory.items.push(item);
      out.drops.push(item);
    } else {
      // A full hold never stalls a route. Overflow is scrapped, the widget says
      // so, and an eight-hour AFK stays an eight-hour AFK (quality bar #3).
      const value = breakdownValue(item, plan.breakdownYield);
      addMaterials(state, plan.matTier, value);
      state.stats.itemsBrokenDown += 1;
      out.autoScrapped += 1;
      out.scrapMaterials += value;
      out.materials += value;
    }
  }

  state.stats.idleTicks += count * plan.cycleTicks;
  return out;
}

function hashZone(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h = (h ^ id.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Advances an assigned route by `ticks`, resolving every cycle boundary crossed.
 * This is what live play calls each tick (with ticks = 1) and what the stepwise
 * offline resolver calls in a loop.
 */
export function advanceRoute(state: GameState, plan: CyclePlan, ticks: number): CycleOutcome {
  const route = state.route;
  const empty: CycleOutcome = {
    cycles: 0,
    materials: 0,
    matTier: plan.matTier,
    data: 0,
    drops: [],
    autoScrapped: 0,
    scrapMaterials: 0,
    levelled: false,
  };
  if (!route || route.zoneId !== plan.zoneId || ticks <= 0) return empty;

  const total = route.tickInCycle + ticks;
  const completed = Math.floor(total / plan.cycleTicks);
  route.tickInCycle = total - completed * plan.cycleTicks;
  if (completed === 0) return empty;

  const from = route.cycleIndex;
  route.cycleIndex = from + completed;
  return resolveCycles(state, plan, from, from + completed);
}

/** Assigning a route requires the zone to have been cleared by hand first. */
export function canAssignRoute(state: GameState, zoneId: string): boolean {
  const progress = state.zones[zoneId];
  return !!progress && progress.cleared;
}

export function assignRoute(state: GameState, zoneId: string): boolean {
  if (!canAssignRoute(state, zoneId)) return false;
  state.route = {
    zoneId,
    cycleIndex: 0,
    tickInCycle: 0,
    startedAtTick: state.tick,
    stalled: false,
    stallReason: '',
  };
  return true;
}

export function clearRoute(state: GameState): void {
  state.route = null;
}

/** Hourly rates for the widget tickers. Presentation only; never fed back in. */
export function routeRates(plan: CyclePlan): { matPerHour: number; dataPerHour: number; dropsPerHour: number } {
  const cyclesPerHour = 3600 / plan.cycleSeconds;
  return {
    matPerHour: plan.matPerCycle * cyclesPerHour,
    dataPerHour: plan.dataPerCycle * cyclesPerHour,
    dropsPerHour: plan.dropChance * cyclesPerHour,
  };
}

export { RARITY_DEFS, effectiveHp };
