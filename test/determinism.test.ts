/**
 * Determinism: same seed, same inputs, same game — including a full headless
 * boss kill. If this ever fails, the offline parity guarantee is worthless,
 * because both resolvers would be reproducing the same wrong thing.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { makeRng, nextInt, nextU32, rngAt } from '../src/sim/rng.js';
import { hashState } from '../src/sim/hash.js';
import { landInZone, newSession, tickSession } from '../src/sim/sim.js';
import { botInput } from '../src/headless/bot.js';
import { atan2, cos, sin } from '../src/sim/trig.js';

const T0 = 1_700_000_000_000;

function runHeadless(seed: number, ticks: number): { hash: string; kills: number; cleared: boolean } {
  const session = newSession(seed, T0);
  landInZone(session, 'ochre-shelf');
  for (let t = 0; t < ticks; t++) {
    tickSession(session, botInput(session, t), 1);
    if (session.arena && session.arena.outcome !== 'running') break;
  }
  return {
    hash: hashState(session.state),
    kills: session.arena?.kills ?? 0,
    cleared: session.state.zones['ochre-shelf']!.cleared,
  };
}

describe('determinism', () => {
  it('the RNG stream is reproducible from a seed', () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    for (let i = 0; i < 1000; i++) assert.equal(nextU32(a), nextU32(b));
  });

  it('different seeds produce different streams', () => {
    const a = makeRng(1);
    const b = makeRng(2);
    let same = 0;
    for (let i = 0; i < 200; i++) if (nextU32(a) === nextU32(b)) same++;
    assert.ok(same < 3, `streams too similar: ${same} collisions`);
  });

  it('nextInt stays in range and covers it', () => {
    const r = makeRng(9);
    const seen = new Set<number>();
    for (let i = 0; i < 4000; i++) {
      const v = nextInt(r, 3, 9);
      assert.ok(v >= 3 && v <= 9, `out of range: ${v}`);
      seen.add(v);
    }
    assert.equal(seen.size, 7);
  });

  it('counter-based RNG is order independent', () => {
    const forward: number[] = [];
    for (let i = 0; i < 500; i++) forward.push(rngAt(77, 3, i));
    const backward: number[] = new Array(500);
    for (let i = 499; i >= 0; i--) backward[i] = rngAt(77, 3, i);
    assert.deepEqual(forward, backward);
  });

  it('deterministic trig has no engine-defined dependencies', () => {
    // Cross-checked against the native implementations to prove the polynomial
    // is close enough to feel identical while staying exactly reproducible.
    for (let i = -300; i <= 300; i++) {
      const x = i / 40;
      assert.ok(Math.abs(sin(x) - Math.sin(x)) < 1e-7, `sin(${x})`);
      assert.ok(Math.abs(cos(x) - Math.cos(x)) < 1e-7, `cos(${x})`);
    }
    for (const [y, x] of [[1, 1], [-3, 2], [0.5, -4], [-7, -7], [0, -1], [5, 0]] as [number, number][]) {
      assert.ok(Math.abs(atan2(y, x) - Math.atan2(y, x)) < 1e-4, `atan2(${y},${x})`);
    }
  });

  it('a full headless run reproduces exactly', () => {
    const a = runHeadless(2024, 20000);
    const b = runHeadless(2024, 20000);
    assert.equal(a.hash, b.hash);
    assert.equal(a.kills, b.kills);
  });

  it('a scripted run actually reaches and kills the boss', () => {
    // Not just determinism: proof the Tier 1 loop is completable end to end
    // with no renderer attached at all.
    const result = runHeadless(2024, 200000);
    assert.equal(result.cleared, true, 'scripted run failed to clear the zone');
  });

  it('different seeds diverge', () => {
    assert.notEqual(runHeadless(1, 6000).hash, runHeadless(2, 6000).hash);
  });
});
