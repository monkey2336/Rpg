/**
 * The session: game state plus an optional live arena, and the single tick
 * entry point that drives both.
 *
 * `tickSession` is the whole game clock. The Electron main process calls it,
 * the headless CLI calls it, and the test suite calls it. Renderers never do
 * anything but read the snapshot it produces.
 *
 * Design note on the idle route: it accrues *whenever it is assigned*, including
 * while you are on the ground shooting things. It is the ship running the route,
 * not you. That removes any incentive to stop playing to farm, which is the
 * dark pattern this genre usually walks straight into.
 */
import { TICK_MS } from './combat.js';
import { derive, syncPlayerDefences, type Derived } from './derive.js';
import {
  createArena,
  playerEntity,
  revivePlayer,
  spawnDrop,
  stepArena,
  summonBoss,
  type ArenaEvent,
  type ArenaState,
  type InputFrame,
} from './arena.js';
import { getBoss } from './content/bosses.js';
import { getEnemy } from './content/enemies.js';
import { getZone, nextZoneAfter, travelCost } from './content/zones.js';
import { breakdownValue, makeSignature, rollWeapon, streamSource } from './loot.js';
import { advanceRoute, planCycle, type CyclePlan } from './route.js';
import {
  addMaterials,
  createNewGame,
  grantXp,
  inventoryFull,
  type GameState,
} from './state.js';
import { nextFloat } from './rng.js';
import type { MaterialTier } from './types.js';

export type SessionMode = 'ship' | 'zone';

/** 0.2 fuel per second: a full 100-unit tank in a little over eight minutes. */
const FUEL_PER_TICK = 0.2 / 40;

export interface Session {
  state: GameState;
  arena: ArenaState | null;
  mode: SessionMode;
  /** Cached route plan; invalidated whenever gear or upgrades change. */
  plan: CyclePlan | null;
  /** Drained by presentation each frame. */
  feed: string[];
  /**
   * Names of weapons already banked but not yet walked over, keyed by uid.
   *
   * Runtime only, and deliberately so: the item itself is in the hold the
   * instant the kill lands, so nothing here is ownership. It is the text of a
   * notice waiting for the player to reach the thing it describes.
   */
  pendingDropNames: Map<number, string>;
}

export interface TickResult {
  events: ArenaEvent[];
  notices: string[];
  levelled: boolean;
}

export function newSession(seed: number, nowMs: number): Session {
  return { state: createNewGame(seed, nowMs), arena: null, mode: 'ship', plan: null, feed: [], pendingDropNames: new Map() };
}

export function sessionFromState(state: GameState): Session {
  return { state, arena: null, mode: 'ship', plan: null, feed: [], pendingDropNames: new Map() };
}

/** Call after anything that changes gear, tech, or ship ranks. */
export function invalidatePlan(session: Session): void {
  session.plan = null;
}

function ensurePlan(session: Session): CyclePlan | null {
  const route = session.state.route;
  if (!route) return null;
  if (!session.plan || session.plan.zoneId !== route.zoneId) {
    session.plan = planCycle(session.state, route.zoneId);
  }
  return session.plan;
}

export type LandResult = 'ok' | 'unknown-zone' | 'no-fuel';

/**
 * Fuel is the brief's "soft travel cost": crossing to another planet costs, and
 * it refills while docked. Soft is the operative word — it paces how often you
 * hop between worlds and never gates you out of the zone you are working.
 */
export function travelCostFor(session: Session, zoneId: string): number {
  return travelCost(session.state.currentZone, zoneId);
}

export function landInZone(session: Session, zoneId: string): boolean {
  return landInZoneChecked(session, zoneId) === 'ok';
}

export function landInZoneChecked(session: Session, zoneId: string): LandResult {
  const zone = getZone(zoneId);
  const progress = session.state.zones[zoneId];
  if (!progress?.discovered) return 'unknown-zone';
  const cost = travelCostFor(session, zoneId);
  if (cost > session.state.resources.fuel) return 'no-fuel';
  session.state.resources.fuel -= cost;
  const d = derive(session.state);
  syncPlayerDefences(session.state, d);
  const p = session.state.player.defences;
  p.health = p.healthMax;
  p.shield = p.shieldMax;
  p.armor = p.armorMax;
  // Anything still on the sand of the last zone is already owned; say so
  // before the arena that was holding the markers is thrown away.
  flushPendingDrops(session);
  session.arena = createArena(zoneId, (session.state.seed ^ (session.state.tick * 2654435761)) >>> 0, p, d.scanSpeed);
  session.state.currentZone = zoneId;
  session.mode = 'zone';
  session.feed.push(`Landing: ${zone.name}`);
  return 'ok';
}

export function returnToShip(session: Session): void {
  flushPendingDrops(session);
  session.arena = null;
  session.mode = 'ship';
}

/**
 * Stands a downed player back up in the zone they are already in.
 *
 * Returns false when there is nothing to revive, so the caller can say why.
 */
export function reviveInZone(session: Session): boolean {
  if (!session.arena) return false;
  const d = derive(session.state);
  syncPlayerDefences(session.state, d);
  return revivePlayer(session.arena, session.state.player.defences);
}

export function requestBoss(session: Session): boolean {
  if (!session.arena) return false;
  const ok = summonBoss(session.arena);
  if (ok) session.state.stats.bossAttempts += 1;
  return ok;
}

/**
 * Advances the whole session by `ticks` fixed steps.
 *
 * `input` is held for the duration, which is exactly what a fast-forward or a
 * headless soak run wants. Interactive callers pass ticks = 1.
 */
export function tickSession(session: Session, input: InputFrame, ticks = 1): TickResult {
  const { state } = session;
  const out: TickResult = { events: [], notices: [], levelled: false };
  const d = derive(state);

  // Docked with a route running is the widget-mode case, and it is by far the
  // most common state this game is in. There is no arena to step, so the whole
  // batch resolves in one call instead of `ticks` iterations. `advanceRoute`
  // computes completed cycles arithmetically, so this is the same arithmetic
  // the offline resolver uses and produces identical state — which is exactly
  // what test/offline-parity.test.ts pins down.
  if (!session.arena && ticks > 1) {
    const plan = ensurePlan(session);
    if (plan && state.route) {
      const outcome = advanceRoute(state, plan, ticks);
      if (outcome.autoScrapped > 0) {
        out.notices.push(`Hold full — ${outcome.autoScrapped} scrapped for ${outcome.scrapMaterials}`);
      }
      if (outcome.levelled) out.levelled = true;
    }
    if (session.mode === 'ship' && state.resources.fuel < d.fuelMax) {
      state.resources.fuel = Math.min(d.fuelMax, state.resources.fuel + FUEL_PER_TICK * ticks);
    }
    state.tick += ticks;
    state.lastSeenMs += ticks * TICK_MS;
    return out;
  }

  for (let i = 0; i < ticks; i++) {
    state.tick += 1;

    // The route runs regardless of what the player is doing.
    const plan = ensurePlan(session);
    if (plan && state.route) {
      const outcome = advanceRoute(state, plan, 1);
      if (outcome.cycles > 0) {
        if (outcome.autoScrapped > 0) {
          out.notices.push(`Hold full — ${outcome.autoScrapped} scrapped for ${outcome.scrapMaterials}`);
        }
        if (outcome.levelled) out.levelled = true;
      }
    }

    if (session.mode === 'ship' && state.resources.fuel < d.fuelMax) {
      // Refuelling is deliberately unhurried: a full tank from empty is about
      // eight minutes docked, which prices a planet hop without ever blocking
      // the zone you are already working.
      state.resources.fuel = Math.min(d.fuelMax, state.resources.fuel + FUEL_PER_TICK);
    }

    if (session.arena && session.mode === 'zone') {
      state.stats.activeTicks += 1;
      const events = stepArena(session.arena, input, {
        weapon: d.weapon,
        moveSpeed: d.moveSpeed,
        miningYield: d.miningYield,
        scanSpeed: d.scanSpeed,
        armorRegen: d.armorRegen,
        killRecovery: d.killRecovery,
        gate: getZone(session.arena.zoneId).gate,
      });
      if (events.length > 0) {
        out.events.push(...events);
        applyArenaEvents(session, events, d, out);
      }
    }
  }

  state.lastSeenMs += ticks * TICK_MS;
  return out;
}

/**
 * Turns arena events into persistent progress.
 *
 * Kept out of the arena itself so the arena stays a pure encounter sim with no
 * opinion about inventories, XP curves or codices.
 */
function applyArenaEvents(session: Session, events: ArenaEvent[], d: Derived, out: TickResult): void {
  const { state } = session;
  const arena = session.arena!;
  const zone = getZone(arena.zoneId);
  const progress = state.zones[arena.zoneId]!;

  for (const ev of events) {
    switch (ev.type) {
      case 'shot':
        state.stats.shotsFired += 1;
        break;
      case 'weak':
        state.stats.weakPointHits += 1;
        state.stats.shotsHit += 1;
        state.stats.damageDealt += ev.amount;
        break;
      case 'hit':
        state.stats.shotsHit += 1;
        state.stats.damageDealt += ev.amount;
        break;
      case 'kill': {
        const def = getEnemy(ev.text);
        progress.kills += 1;
        state.stats.kills += 1;
        addMaterials(state, zone.depositTier as MaterialTier, def.matDrop);
        state.resources.data += def.dataDrop;
        if (grantXp(state, def.xp)) out.levelled = true;
        // Active play rolls the full rarity table. Idle cannot; that gap is the
        // reason to show up in person.
        const dropChance = def.kind === 'elite' ? 0.65 : 0.11;
        if (nextFloat(state.rng) < dropChance) {
          rollDrop(session, d, zone.recommendedPower, out, { x: ev.x, y: ev.y, z: ev.z });
        }
        break;
      }
      case 'mined': {
        progress.deposits += 1;
        addMaterials(state, Number(ev.text) as MaterialTier, ev.amount);
        break;
      }
      case 'scanned': {
        progress.scans += 1;
        state.resources.data += Math.floor(ev.amount * d.dataYield);
        break;
      }
      case 'boss-down': {
        onBossDown(session, d, out);
        break;
      }
      case 'pickup': {
        // The item was banked when the kill landed; this is the moment the
        // player actually sees it. Announcing here rather than at the kill
        // means the notice arrives with the pickup, not four seconds before.
        const name = session.pendingDropNames.get(ev.id);
        if (name !== undefined) {
          session.pendingDropNames.delete(ev.id);
          out.notices.push(`Recovered: ${name}`);
        }
        break;
      }
      case 'player-down': {
        state.stats.deaths += 1;
        out.notices.push('Downed. The approach holds — get up and keep going.');
        break;
      }
      case 'revive': {
        out.notices.push(
          arena.gateMet ? 'On your feet. The beacon is still lit.' : 'On your feet.',
        );
        break;
      }
      case 'gate': {
        out.notices.push(`${zone.name}: gate condition met. The beacon will answer now.`);
        break;
      }
      default:
        break;
    }
  }

  const p = playerEntity(arena);
  state.player.defences = p.def;
}

/**
 * Rolls a weapon from a kill and banks it immediately.
 *
 * `at` makes the drop visible: the arena throws a marker onto the sand that
 * flies to the player when they come near, and the "Recovered" notice waits
 * for that moment instead of firing from across the terrace. The item is the
 * player's either way, from the instant the kill lands — the marker is how
 * they see it, not how they earn it.
 */
function rollDrop(
  session: Session,
  d: Derived,
  ilvl: number,
  out: TickResult,
  at?: { x: number; y: number; z: number },
): void {
  const { state } = session;
  const item = rollWeapon(streamSource(state.rng), {
    ilvl,
    luck: d.luck,
    uid: state.nextUid++,
  });
  state.stats.itemsDropped += 1;
  if (inventoryFull(state)) {
    const value = breakdownValue(item, d.breakdownYield);
    addMaterials(state, 1, value);
    state.stats.itemsBrokenDown += 1;
    out.notices.push(`Hold full — ${item.name} scrapped (+${value})`);
    return;
  }
  state.inventory.items.push(item);
  if (at && session.arena) {
    session.pendingDropNames.set(item.uid, item.name);
    spawnDrop(session.arena, item.uid, item.rarity, at.x, at.y, at.z);
    return;
  }
  out.notices.push(`Recovered: ${item.name}`);
}

/**
 * Names anything still lying on the sand when a run ends.
 *
 * Leaving a zone never costs loot. The markers are feedback, and feedback the
 * player walked past still has to be delivered.
 */
function flushPendingDrops(session: Session): void {
  if (session.pendingDropNames.size === 0) return;
  const names = [...session.pendingDropNames.values()];
  session.pendingDropNames.clear();
  session.feed.push(
    names.length === 1
      ? `Recovered: ${names[0]}`
      : `Recovered ${names.length} weapons left on the ground.`,
  );
}

function onBossDown(session: Session, d: Derived, out: TickResult): void {
  const { state } = session;
  const arena = session.arena!;
  const zone = getZone(arena.zoneId);
  if (!zone.bossId) return;
  const boss = getBoss(zone.bossId);
  const progress = state.zones[arena.zoneId]!;

  flushPendingDrops(session);
  progress.bossKills += 1;
  progress.cleared = true;
  state.stats.bossKills += 1;
  if (progress.bestClearTicks === 0 || arena.tick < progress.bestClearTicks) {
    progress.bestClearTicks = arena.tick;
  }

  addMaterials(state, zone.depositTier as MaterialTier, Math.floor(boss.matDrop * d.miningYield));
  state.resources.data += Math.floor(boss.dataDrop * d.dataYield);
  if (grantXp(state, 400)) out.levelled = true;

  if (!state.codex.includes(boss.codexId)) {
    state.codex.push(boss.codexId);
    out.notices.push(`Codex updated: ${boss.name}`);
  }

  // Guaranteed, hand-authored, identical every time. This is the item people
  // remember the fight by, so it does not roll.
  const sig = makeSignature(boss.signatureDrop, zone.recommendedPower + 6, state.nextUid++);
  state.inventory.items.push(sig);
  state.stats.itemsDropped += 1;
  out.notices.push(`${boss.name} down. Signature recovered: ${sig.name}`);

  // Clearing a zone opens the next node in order and makes this one farmable.
  const next = nextZoneAfter(arena.zoneId);
  if (next && state.zones[next] && !state.zones[next]!.discovered) {
    state.zones[next]!.discovered = true;
    out.notices.push(`Charted: ${getZone(next).name}.`);
  }
  out.notices.push(`${zone.name} is now available as an idle route.`);
}

/* ------------------------------- prestige -------------------------------- */

export const PRESTIGE_LEVEL_REQUIREMENT = 25;

export function canPrestige(state: GameState): boolean {
  return state.player.level >= PRESTIGE_LEVEL_REQUIREMENT;
}

/**
 * What a reset would be worth right now.
 *
 * Deliberately sub-linear in level and linear in boss clears, so the decision
 * is "have I gone as deep as this run usefully can" rather than "have I ground
 * out the next flat tick".
 */
export function prestigeGain(state: GameState): number {
  if (!canPrestige(state)) return 0;
  const depth = Math.sqrt(state.player.level - PRESTIGE_LEVEL_REQUIREMENT + 1);
  return 0.22 * depth + 0.08 * state.stats.bossKills;
}

export function doPrestige(session: Session, nowMs: number): boolean {
  const { state } = session;
  if (!canPrestige(state)) return false;
  const gain = prestigeGain(state);
  const keep = {
    count: state.prestige.count + 1,
    multiplier: state.prestige.multiplier + gain,
    marker: markerFor(state.prestige.count + 1),
  };
  const codex = [...state.codex];
  const settings = { ...state.settings };
  const stats = { ...state.stats };
  const seed = state.seed;

  const fresh = createNewGame(seed, nowMs);
  fresh.prestige = keep;
  fresh.codex = codex;
  fresh.settings = settings;
  fresh.stats = stats;
  fresh.tick = state.tick;

  session.state = fresh;
  session.arena = null;
  session.mode = 'ship';
  session.plan = null;
  session.feed.push(`Reset ${keep.count}. Multiplier now ${keep.multiplier.toFixed(2)}x.`);
  return true;
}

const MARKERS = ['', 'Ochre', 'Bone', 'Rust', 'Ash', 'Salt', 'Kiln', 'Sovereign'];
function markerFor(count: number): string {
  return MARKERS[Math.min(count, MARKERS.length - 1)] ?? 'Sovereign';
}
