/**
 * The test that protects the whole design.
 *
 * The brief calls offline/online parity "the single most important technical
 * decision in the project". This suite is what makes that claim checkable: it
 * runs the stepwise resolver (which walks the same code live play walks, one
 * tick at a time) against the closed-form resolver, and demands the resulting
 * game states hash identically. Not "within tolerance". Identically.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { assertParity, resolveOffline } from '../src/sim/offline.js';
import { newSession, tickSession } from '../src/sim/sim.js';
import { assignRoute, planCycle } from '../src/sim/route.js';
import { NEUTRAL_INPUT } from '../src/sim/arena.js';
import { TICK_MS } from '../src/sim/combat.js';
import { hashState } from '../src/sim/hash.js';
import type { GameState } from '../src/sim/state.js';

const T0 = 1_700_000_000_000;

function readyState(seed = 1234, opts: { slots?: number; level?: number } = {}): GameState {
  const session = newSession(seed, T0);
  const s = session.state;
  s.zones['ochre-shelf']!.cleared = true;
  s.zones['ochre-shelf']!.discovered = true;
  if (opts.slots !== undefined) s.inventory.slots = opts.slots;
  if (opts.level !== undefined) s.player.level = opts.level;
  assignRoute(s, 'ochre-shelf');
  return s;
}

describe('offline parity', () => {
  const durations: [string, number][] = [
    ['1 minute', 60_000],
    ['17 minutes', 17 * 60_000],
    ['1 hour', 3_600_000],
    ['2 hours 37 minutes', (2 * 3600 + 37 * 60) * 1000],
    ['5 hours', 5 * 3_600_000],
  ];

  for (const [label, ms] of durations) {
    it(`stepwise and closed-form agree exactly over ${label}`, () => {
      const state = readyState();
      const result = assertParity(state, ms);
      assert.equal(result.ok, true, `divergence at ${result.detail}`);
      assert.equal(result.stepwiseHash, result.closedHash);
    });
  }

  it('agrees when the hold overflows and the route auto-scraps', () => {
    // Four slots and three starting weapons: the very first idle drop overflows,
    // which exercises the scrap branch inside the shared resolver.
    const state = readyState(99, { slots: 4 });
    const result = assertParity(state, 3 * 3_600_000);
    assert.equal(result.ok, true, `divergence at ${result.detail}`);
  });

  it('agrees across a spread of seeds', () => {
    for (const seed of [1, 7, 42, 5150, 987654321]) {
      const result = assertParity(readyState(seed), 90 * 60_000);
      assert.equal(result.ok, true, `seed ${seed} diverged at ${result.detail}`);
    }
  });

  it('produces no progress at all without an assigned route', () => {
    const session = newSession(3, T0);
    const before = hashState(session.state.resources);
    resolveOffline(session.state, T0 + 8 * 3_600_000, { method: 'closed' });
    assert.equal(hashState(session.state.resources), before);
  });

  it('honours the offline accrual cap and says so', () => {
    const state = readyState();
    const report = resolveOffline(state, T0 + 200 * 3_600_000, { method: 'closed' });
    assert.equal(report.stalled, true);
    // Default cap is 48h, so the report covers 48h of elapsed time, not 200.
    assert.equal(report.elapsedMs, 48 * 3_600_000);
  });

  it('live ticking and offline resolution reach the same state', () => {
    // The strongest form of the claim: play the game forward in real time with
    // no input, versus close the app and come back. Same numbers.
    const minutes = 12;
    const ticks = (minutes * 60_000) / TICK_MS;

    const live = newSession(777, T0);
    live.state.zones['ochre-shelf']!.cleared = true;
    assignRoute(live.state, 'ochre-shelf');
    tickSession(live, NEUTRAL_INPUT, ticks);

    const away = readyState(777);
    resolveOffline(away, T0 + minutes * 60_000, { method: 'closed' });

    assert.equal(hashState(live.state.resources), hashState(away.resources));
    assert.equal(live.state.route!.cycleIndex, away.route!.cycleIndex);
    assert.equal(live.state.inventory.items.length, away.inventory.items.length);
  });

  it('cycle plans are integers, which is what makes batching exact', () => {
    const plan = planCycle(readyState(), 'ochre-shelf');
    assert.ok(Number.isInteger(plan.matPerCycle), 'matPerCycle must be an integer');
    assert.ok(Number.isInteger(plan.dataPerCycle), 'dataPerCycle must be an integer');
    assert.ok(Number.isInteger(plan.cycleTicks), 'cycleTicks must be an integer');
  });

  it('a better weapon genuinely farms faster', () => {
    const weak = readyState();
    const strong = readyState();
    // Same state, but one has the boss signature equipped.
    const item = strong.inventory.items[0]!;
    item.ilvl = 40;
    item.rarity = 'relic';
    const planWeak = planCycle(weak, 'ochre-shelf');
    const planStrong = planCycle(strong, 'ochre-shelf');
    assert.ok(
      planStrong.cycleTicks < planWeak.cycleTicks,
      `expected faster cycles: ${planStrong.cycleTicks} vs ${planWeak.cycleTicks}`,
    );
  });
});
