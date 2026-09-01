/**
 * The persisted game state and its constructors.
 *
 * Everything here is plain JSON-safe data. No functions, no class instances, no
 * Maps — a save is `JSON.stringify(state)` and nothing more, which is what makes
 * migration and corruption recovery tractable.
 */
import { makeRng, type Rng } from './rng.js';
import type { Defences, MaterialTier, WeaponInstance } from './types.js';
import type { NotationMode } from './numbers.js';
import { STARTING_ZONE, ZONES } from './content/zones.js';
import { PROTOTYPE_ARCHETYPES } from './content/weapons.js';

export const SCHEMA_VERSION = 3;

export type WidgetCorner = 'tl' | 'tr' | 'bl' | 'br';

export interface Settings {
  notation: NotationMode;
  /** Widget placement is remembered across sessions, per the dual-mode spec. */
  widgetCorner: WidgetCorner;
  widgetOffsetX: number;
  widgetOffsetY: number;
  widgetOpacity: number;
  widgetClickThrough: boolean;
  /** Widget is silent unless the player opts in. */
  alertChimes: boolean;
  /** Widget render rate. 0 means "state only, static frame". */
  widgetFps: number;
  telemetryOptIn: boolean;
  audioEnabled: boolean;
  masterVolume: number;
}

export interface ZoneProgress {
  discovered: boolean;
  /** A zone must be cleared (boss down, or gate met for bossless zones) to farm it. */
  cleared: boolean;
  kills: number;
  deposits: number;
  scans: number;
  bossKills: number;
  bestClearTicks: number;
}

export interface RouteState {
  zoneId: string;
  /** Monotonic count of completed cycles; the loot RNG is keyed on it. */
  cycleIndex: number;
  /** Ticks elapsed inside the current, incomplete cycle. */
  tickInCycle: number;
  startedAtTick: number;
  /** Set when the hold filled or the route otherwise cannot continue. */
  stalled: boolean;
  stallReason: string;
}

export interface OfflineReport {
  elapsedMs: number;
  cycles: number;
  materials: Record<string, number>;
  data: number;
  drops: number;
  stalled: boolean;
  stallReason: string;
  /** Which resolver produced it — surfaced in the debug overlay. */
  method: 'stepwise' | 'closed';
}

export interface Stats {
  kills: number;
  bossKills: number;
  bossAttempts: number;
  deaths: number;
  shotsFired: number;
  shotsHit: number;
  weakPointHits: number;
  damageDealt: number;
  activeTicks: number;
  idleTicks: number;
  itemsDropped: number;
  itemsBrokenDown: number;
}

export interface GameState {
  version: number;
  seed: number;
  createdAtMs: number;
  /** Wall-clock ms at the last authoritative advance. Offline is computed from this. */
  lastSeenMs: number;
  /** Total sim ticks ever run, active + idle. The sim's own clock. */
  tick: number;
  rng: Rng;
  settings: Settings;

  player: {
    level: number;
    xp: number;
    defences: Defences;
    /** Slots hold inventory uids; null is an empty slot. */
    loadout: (number | null)[];
    activeSlot: number;
  };

  inventory: {
    slots: number;
    items: WeaponInstance[];
  };

  resources: {
    materials: Record<string, number>;
    data: number;
    fuel: number;
    fuelMax: number;
  };

  ship: {
    tier: number;
    /** upgradeId -> rank */
    upgrades: Record<string, number>;
  };

  tech: { unlocked: string[] };
  codex: string[];
  zones: Record<string, ZoneProgress>;
  currentZone: string;
  route: RouteState | null;
  lastOfflineReport: OfflineReport | null;
  prestige: { count: number; multiplier: number; marker: string };
  stats: Stats;
  nextUid: number;
}

export const BASE_PLAYER_DEFENCES: Defences = {
  shield: 120,
  shieldMax: 120,
  shieldRegen: 22,
  shieldDelay: 110,
  shieldCooldown: 0,
  armor: 60,
  armorMax: 60,
  health: 220,
  healthMax: 220,
};

export const DEFAULT_SETTINGS: Settings = {
  notation: 'short',
  widgetCorner: 'br',
  widgetOffsetX: 24,
  widgetOffsetY: 24,
  widgetOpacity: 0.94,
  widgetClickThrough: false,
  alertChimes: false,
  widgetFps: 12,
  telemetryOptIn: false,
  audioEnabled: true,
  masterVolume: 0.8,
};

export function emptyMaterials(): Record<string, number> {
  return { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
}

function emptyStats(): Stats {
  return {
    kills: 0,
    bossKills: 0,
    bossAttempts: 0,
    deaths: 0,
    shotsFired: 0,
    shotsHit: 0,
    weakPointHits: 0,
    damageDealt: 0,
    activeTicks: 0,
    idleTicks: 0,
    itemsDropped: 0,
    itemsBrokenDown: 0,
  };
}

export function createNewGame(seed: number, nowMs: number): GameState {
  const zones: Record<string, ZoneProgress> = {};
  for (const z of ZONES) {
    zones[z.id] = {
      discovered: z.id === STARTING_ZONE,
      cleared: false,
      kills: 0,
      deposits: 0,
      scans: 0,
      bossKills: 0,
      bestClearTicks: 0,
    };
  }

  let uid = 1;
  // Starting kit: one of each prototype archetype, common, so the very first
  // decision a player makes is "which of these three do I actually like".
  const items: WeaponInstance[] = PROTOTYPE_ARCHETYPES.map((a) => ({
    uid: uid++,
    archetypeId: a.id,
    rarity: 'common' as const,
    ilvl: 1,
    affixes: [],
    name: a.name,
    locked: false,
  }));

  return {
    version: SCHEMA_VERSION,
    seed: seed >>> 0,
    createdAtMs: nowMs,
    lastSeenMs: nowMs,
    tick: 0,
    rng: makeRng(seed),
    settings: { ...DEFAULT_SETTINGS },
    player: {
      level: 1,
      xp: 0,
      defences: { ...BASE_PLAYER_DEFENCES },
      loadout: [items[0]?.uid ?? null, items[1]?.uid ?? null, items[2]?.uid ?? null],
      activeSlot: 0,
    },
    inventory: { slots: 24, items },
    resources: { materials: emptyMaterials(), data: 0, fuel: 100, fuelMax: 100 },
    ship: { tier: 1, upgrades: {} },
    tech: { unlocked: [] },
    codex: [],
    zones,
    currentZone: STARTING_ZONE,
    route: null,
    lastOfflineReport: null,
    prestige: { count: 0, multiplier: 1, marker: '' },
    stats: emptyStats(),
    nextUid: uid,
  };
}

export function findItem(state: GameState, uid: number | null): WeaponInstance | null {
  if (uid === null) return null;
  return state.inventory.items.find((i) => i.uid === uid) ?? null;
}

export function activeWeapon(state: GameState): WeaponInstance | null {
  return findItem(state, state.player.loadout[state.player.activeSlot] ?? null);
}

export function addMaterials(state: GameState, tier: MaterialTier, amount: number): void {
  const key = String(tier);
  state.resources.materials[key] = (state.resources.materials[key] ?? 0) + amount;
}

export function inventoryFull(state: GameState): boolean {
  return state.inventory.items.length >= state.inventory.slots;
}

/** XP needed to reach the next level. Gentle curve; power comes from gear. */
export function xpForLevel(level: number): number {
  return Math.floor(80 * level * (1 + level * 0.35));
}

export function grantXp(state: GameState, amount: number): boolean {
  state.player.xp += amount;
  let levelled = false;
  while (state.player.xp >= xpForLevel(state.player.level)) {
    state.player.xp -= xpForLevel(state.player.level);
    state.player.level += 1;
    levelled = true;
  }
  return levelled;
}
