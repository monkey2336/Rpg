/**
 * Combat maths: the layered defences and the damage-type matrix.
 *
 * These are the numbers every other system quotes, so they are pinned here
 * rather than left to be inferred from how a fight felt.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { applyDamage, makeDefences, regenShield, applyStatus, tickStatuses, TICK_HZ } from '../src/sim/combat.js';
import { typeMultiplier } from '../src/sim/content/damage.js';
import type { Defences } from '../src/sim/types.js';

function target(shield: number, armor: number, health: number): Defences {
  return makeDefences({
    shield,
    shieldMax: shield,
    shieldRegen: 10,
    shieldDelay: 40,
    armor,
    armorMax: armor,
    health,
    healthMax: health,
  });
}

describe('combat', () => {
  it('eats the shield first, at the shield multiplier', () => {
    const t = target(100, 50, 100);
    applyDamage(t, 50, 'arc', {});
    // arc vs shield is 1.75x, so 50 raw removes 87.5 shield.
    assert.equal(Math.round(t.shield * 10) / 10, 12.5);
    assert.equal(t.armor, 50);
    assert.equal(t.health, 100);
  });

  it('spills leftover raw damage into the next layer at that layer\'s rate', () => {
    const t = target(10, 100, 100);
    // arc: 10 shield costs 10/1.75 = 5.714 raw. The remaining 14.286 raw hits
    // armour at 0.7 -> 10 armour removed.
    applyDamage(t, 20, 'arc', {});
    assert.equal(t.shield, 0);
    assert.equal(Math.round(t.armor), 90);
  });

  it('caustic bypasses shields entirely', () => {
    const t = target(500, 0, 100);
    applyDamage(t, 40, 'caustic', {});
    assert.equal(t.shield, 500);
    assert.equal(Math.round(t.health), Math.round(100 - 40 * typeMultiplier('caustic', 'health')));
  });

  it('reports the layer that was actually struck', () => {
    const t = target(0, 0, 100);
    assert.equal(applyDamage(t, 10, 'solar', {}).layer, 'health');
    const u = target(100, 0, 100);
    assert.equal(applyDamage(u, 10, 'solar', {}).layer, 'shield');
  });

  it('crit and weak-point multipliers stack multiplicatively', () => {
    const flat = target(0, 0, 10000);
    const boosted = target(0, 0, 10000);
    applyDamage(flat, 100, 'percussive', {});
    applyDamage(boosted, 100, 'percussive', { crit: true, critMult: 2, weakMult: 3 });
    assert.equal(Math.round((10000 - boosted.health) / (10000 - flat.health)), 6);
  });

  it('armour piercing scales the armour multiplier toward 1', () => {
    const normal = target(0, 100, 100);
    const piercing = target(0, 100, 100);
    applyDamage(normal, 50, 'arc', {});
    applyDamage(piercing, 50, 'arc', { pierce: 1 });
    assert.ok(piercing.health < normal.health, 'full pierce should skip armour and reach health');
    assert.equal(piercing.armor, 100);
  });

  it('reports kills and overkill', () => {
    const t = target(0, 0, 10);
    const res = applyDamage(t, 1000, 'percussive', {});
    assert.equal(res.killed, true);
    assert.ok(res.overkill > 0);
  });

  it('shields wait out the delay, then knit', () => {
    const t = target(100, 0, 100);
    applyDamage(t, 10, 'percussive', {});
    const after = t.shield;
    for (let i = 0; i < 39; i++) regenShield(t, false);
    assert.equal(t.shield, after, 'must not regen during the delay');
    for (let i = 0; i < TICK_HZ; i++) regenShield(t, false);
    assert.ok(t.shield > after, 'must regen once the delay elapses');
  });

  it('disruption suppresses shield regeneration', () => {
    const t = target(100, 0, 100);
    t.shield = 50;
    t.shieldCooldown = 0;
    for (let i = 0; i < TICK_HZ; i++) regenShield(t, true);
    assert.equal(t.shield, 50);
  });

  it('corrosion stacks and expires', () => {
    const t = target(0, 0, 1000);
    const statuses: Parameters<typeof tickStatuses>[0] = [];
    applyStatus(statuses, 'corrosion', 20, 40, 'caustic');
    applyStatus(statuses, 'corrosion', 20, 40, 'caustic');
    assert.equal(statuses[0]!.stacks, 2);
    for (let i = 0; i < 40; i++) tickStatuses(statuses, t);
    assert.equal(statuses.length, 0, 'status should expire');
    assert.ok(t.health < 1000, 'corrosion should have dealt damage');
  });

  it('stacking is capped', () => {
    const statuses: Parameters<typeof tickStatuses>[0] = [];
    for (let i = 0; i < 50; i++) applyStatus(statuses, 'corrosion', 5, 100, 'caustic');
    assert.equal(statuses[0]!.stacks, 10);
  });

  it('the type matrix has no dominant type', () => {
    // Every damage type must lose somewhere, or the choice is not a choice.
    for (const type of ['percussive', 'solar', 'caustic', 'arc'] as const) {
      const layers = (['shield', 'armor', 'health'] as const).map((l) => typeMultiplier(type, l));
      assert.ok(Math.min(...layers) < 1, `${type} has no weakness`);
      assert.ok(Math.max(...layers) > 1, `${type} has no strength`);
    }
  });
});
