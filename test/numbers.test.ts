/** Big-number formatting. Wired in from day one, so it is pinned from day one. */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { formatDuration, formatNumber, formatRate, groupSuffix } from '../src/sim/numbers.js';

describe('numbers', () => {
  it('prints small values plainly', () => {
    assert.equal(formatNumber(0), '0');
    assert.equal(formatNumber(7), '7');
    assert.equal(formatNumber(9999), '9999');
  });

  it('suffixes K/M/B/T', () => {
    assert.equal(formatNumber(10_000), '10K');
    assert.equal(formatNumber(1_250_000), '1.25M');
    assert.equal(formatNumber(3_000_000_000), '3B');
    assert.equal(formatNumber(4.2e12), '4.2T');
  });

  it('rolls over to two-letter notation past T', () => {
    assert.equal(groupSuffix(5), 'aa');
    assert.equal(groupSuffix(6), 'ab');
    assert.equal(groupSuffix(31), 'ba');
    assert.equal(formatNumber(1e15), '1aa');
    assert.equal(formatNumber(5.5e18), '5.5ab');
  });

  it('does not fall for the log10(1000) rounding trap', () => {
    for (const e of [3, 6, 9, 12, 15, 18, 21]) {
      const s = formatNumber(Math.pow(10, e));
      assert.ok(s.startsWith('1'), `10^${e} formatted as ${s}`);
    }
  });

  it('honours scientific mode', () => {
    assert.equal(formatNumber(1_250_000, { mode: 'scientific' }), '1.25e6');
  });

  it('handles negatives and non-finite values', () => {
    assert.equal(formatNumber(-2_500_000), '-2.5M');
    assert.equal(formatNumber(Infinity), '∞');
  });

  it('formats rates per hour from a per-second input', () => {
    assert.equal(formatRate(10), '36K/h');
  });

  it('formats durations at a sensible granularity', () => {
    assert.equal(formatDuration(38_000), '38s');
    assert.equal(formatDuration(252_000), '4m 12s');
    assert.equal(formatDuration(360_000_000), '4d 04h');
  });
});
