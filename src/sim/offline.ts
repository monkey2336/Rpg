/**
 * Offline progression.
 *
 * Two entry points, one economy:
 *
 *   stepwise — walks the route tick by tick through exactly the code live play
 *              runs. Slow (about a million ticks per simulated day) but it is
 *              by definition correct, so it is the oracle.
 *   closed   — computes the completed cycle count arithmetically and resolves
 *              the batch in one call. O(1) in bulk resources, O(cycles) in the
 *              cheap counter-hash used for discrete drops.
 *
 * `assertParity` runs both against a cloned state and compares canonical hashes.
 * The test suite runs it across a spread of durations and loadouts; the debug
 * overlay can run it on demand. If it ever fails, the closed-form path is wrong
 * and the fix is the closed-form path — never a tolerance.
 */
import { TICK_MS } from './combat.js';
import { hashState } from './hash.js';
import { advanceRoute, planCycle, resolveCycles, type CyclePlan } from './route.js';
import type { GameState, OfflineReport } from './state.js';
import { emptyMaterials } from './state.js';
import { derive } from './derive.js';

export type OfflineMethod = 'stepwise' | 'closed';

/** Beyond this the sim refuses to fast-forward tick-by-tick; closed form only. */
export const STEPWISE_TICK_LIMIT = 40 * 3600 * 6; // six simulated hours

export interface OfflineOptions {
  method?: OfflineMethod;
  /** Overrides the derived cap. Tests use it; the game does not. */
  capHoursOverride?: number;
}

export function offlineCapMs(state: GameState, override?: number): number {
  const hours = override ?? derive(state).offlineCapHours;
  return hours * 3600 * 1000;
}

function blankReport(method: OfflineMethod, elapsedMs: number): OfflineReport {
  return {
    elapsedMs,
    cycles: 0,
    materials: emptyMaterials(),
    data: 0,
    drops: 0,
    stalled: false,
    stallReason: '',
    method,
  };
}

/**
 * Advances `state` to `nowMs`, resolving any assigned idle route.
 *
 * Mutates state. Returns what happened, for the "while you were gone" panel.
 */
export function resolveOffline(state: GameState, nowMs: number, opts: OfflineOptions = {}): OfflineReport {
  const method: OfflineMethod = opts.method ?? 'closed';
  const rawElapsed = Math.max(0, nowMs - state.lastSeenMs);
  const cap = offlineCapMs(state, opts.capHoursOverride);
  const elapsed = Math.min(rawElapsed, cap);
  const ticks = Math.floor(elapsed / TICK_MS);

  const report = blankReport(method, elapsed);
  if (rawElapsed > cap) {
    report.stalled = true;
    report.stallReason = 'Accrual cap reached — the route idled.';
  }

  if (ticks <= 0 || !state.route) {
    state.lastSeenMs = nowMs;
    state.tick += Math.max(0, ticks);
    state.lastOfflineReport = report;
    return report;
  }

  const plan = planCycle(state, state.route.zoneId);
  const before = { ...state.resources.materials };
  const beforeData = state.resources.data;
  const beforeDrops = state.stats.itemsDropped;
  const beforeCycle = state.route.cycleIndex;

  if (method === 'stepwise') {
    if (ticks > STEPWISE_TICK_LIMIT) {
      throw new Error(
        `stepwise offline refused for ${ticks} ticks (limit ${STEPWISE_TICK_LIMIT}); use the closed-form path`,
      );
    }
    for (let i = 0; i < ticks; i++) advanceRoute(state, plan, 1);
  } else {
    resolveClosed(state, plan, ticks);
  }

  state.tick += ticks;
  state.lastSeenMs = nowMs;

  for (const k of Object.keys(state.resources.materials)) {
    report.materials[k] = (state.resources.materials[k] ?? 0) - (before[k] ?? 0);
  }
  report.data = state.resources.data - beforeData;
  report.drops = state.stats.itemsDropped - beforeDrops;
  report.cycles = state.route.cycleIndex - beforeCycle;
  state.lastOfflineReport = report;
  return report;
}

/**
 * Closed-form advance. The arithmetic replaces the *loop*, not the *economy*:
 * the completed cycles still go through `resolveCycles`, byte for byte.
 */
function resolveClosed(state: GameState, plan: CyclePlan, ticks: number): void {
  const route = state.route;
  if (!route) return;
  const total = route.tickInCycle + ticks;
  const completed = Math.floor(total / plan.cycleTicks);
  route.tickInCycle = total - completed * plan.cycleTicks;
  if (completed <= 0) return;
  const from = route.cycleIndex;
  route.cycleIndex = from + completed;
  resolveCycles(state, plan, from, from + completed);
}

/* --------------------------------- parity -------------------------------- */

export interface ParityResult {
  ok: boolean;
  stepwiseHash: string;
  closedHash: string;
  ticks: number;
  /** Human-readable first divergence, when there is one. */
  detail: string;
}

function cloneState(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

/**
 * Runs both resolvers over a copy of `state` for `elapsedMs` and compares.
 * Never mutates the state you hand it.
 */
export function assertParity(state: GameState, elapsedMs: number): ParityResult {
  const now = state.lastSeenMs + elapsedMs;
  const a = cloneState(state);
  const b = cloneState(state);
  resolveOffline(a, now, { method: 'stepwise', capHoursOverride: 1e6 });
  resolveOffline(b, now, { method: 'closed', capHoursOverride: 1e6 });

  // The report itself records which resolver produced it, so exclude it from
  // the comparison — everything else must match exactly.
  a.lastOfflineReport = null;
  b.lastOfflineReport = null;

  const ha = hashState(a);
  const hb = hashState(b);
  let detail = '';
  if (ha !== hb) detail = firstDivergence(a as unknown, b as unknown, '$');
  return {
    ok: ha === hb,
    stepwiseHash: ha,
    closedHash: hb,
    ticks: Math.floor(elapsedMs / TICK_MS),
    detail,
  };
}

/** Depth-first walk reporting the first path where two states differ. */
function firstDivergence(a: unknown, b: unknown, path: string): string {
  if (typeof a !== typeof b) return `${path}: type ${typeof a} vs ${typeof b}`;
  if (a === null || b === null || typeof a !== 'object') {
    return a === b ? '' : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length: ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDivergence(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return '';
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of [...keys].sort()) {
    const d = firstDivergence(ao[k], bo[k], `${path}.${k}`);
    if (d) return d;
  }
  return '';
}

/** Projected yield for a duration, for the "assign route" confirmation screen. */
export function projectRoute(
  state: GameState,
  zoneId: string,
  durationMs: number,
): { cycles: number; materials: number; data: number; expectedDrops: number } {
  const plan = planCycle(state, zoneId);
  const cycles = Math.floor(durationMs / TICK_MS / plan.cycleTicks);
  return {
    cycles,
    materials: plan.matPerCycle * cycles,
    data: plan.dataPerCycle * cycles,
    expectedDrops: plan.dropChance * cycles,
  };
}
