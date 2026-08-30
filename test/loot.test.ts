/**
 * Loot rolling: rarity distribution, the authored-base rule, and the property
 * the idle economy depends on — that a counter-based roll is reproducible from
 * its index alone.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { counterSource, itemPower, makeSignature, rollWeapon, streamSource, breakdownValue } from '../src/sim/loot.js';
import { ITEM_BASES, RARITIES, RARITY_DEFS, SIGNATURES } from '../src/sim/content/items.js';
import { makeRng } from '../src/sim/rng.js';
import { getArchetype } from '../src/sim/content/weapons.js';

describe('loot', () => {
  it('counter-based rolls are reproducible from the index alone', () => {
    const a = rollWeapon(counterSource(5, 1, 900), { ilvl: 10, uid: 1 });
    const b = rollWeapon(counterSource(5, 1, 900), { ilvl: 10, uid: 1 });
    assert.deepEqual(a, b);
  });

  it('different indices give different items', () => {
    const names = new Set<string>();
    for (let i = 0; i < 200; i++) {
      names.add(rollWeapon(counterSource(5, 1, i), { ilvl: 10, uid: i }).name);
    }
    assert.ok(names.size > 20, `too few distinct rolls: ${names.size}`);
  });

  it('never invents a base outside the authored pool', () => {
    const authored = new Set(ITEM_BASES.map((b) => b.archetypeId));
    const rng = makeRng(3);
    for (let i = 0; i < 3000; i++) {
      const item = rollWeapon(streamSource(rng), { ilvl: 20, uid: i });
      assert.ok(authored.has(item.archetypeId), `invented archetype ${item.archetypeId}`);
      assert.doesNotThrow(() => getArchetype(item.archetypeId));
    }
  });

  it('rolls the right number of affixes for the rarity', () => {
    const rng = makeRng(11);
    for (let i = 0; i < 2000; i++) {
      const item = rollWeapon(streamSource(rng), { ilvl: 5, uid: i });
      assert.equal(item.affixes.length, RARITY_DEFS[item.rarity].affixes);
    }
  });

  it('never rolls duplicate affixes on one item', () => {
    const rng = makeRng(13);
    for (let i = 0; i < 2000; i++) {
      const item = rollWeapon(streamSource(rng), { ilvl: 5, uid: i });
      const ids = item.affixes.map((a) => a.id);
      assert.equal(new Set(ids).size, ids.length);
    }
  });

  it('respects a rarity cap, which is what gates idle loot', () => {
    const rng = makeRng(17);
    for (let i = 0; i < 3000; i++) {
      const item = rollWeapon(streamSource(rng), { ilvl: 5, uid: i, maxRarity: 'refined' });
      assert.ok(RARITIES.indexOf(item.rarity) <= RARITIES.indexOf('refined'));
    }
  });

  it('rarity is ordered by frequency', () => {
    const counts: Record<string, number> = {};
    const rng = makeRng(23);
    for (let i = 0; i < 40000; i++) {
      const item = rollWeapon(streamSource(rng), { ilvl: 5, uid: i });
      counts[item.rarity] = (counts[item.rarity] ?? 0) + 1;
    }
    for (let i = 1; i < RARITIES.length; i++) {
      const lower = counts[RARITIES[i - 1]!] ?? 0;
      const higher = counts[RARITIES[i]!] ?? 0;
      assert.ok(lower > higher, `${RARITIES[i - 1]} (${lower}) should be commoner than ${RARITIES[i]} (${higher})`);
    }
  });

  it('luck tilts the curve without ever zeroing commons', () => {
    const roll = (luck: number) => {
      const rng = makeRng(29);
      let high = 0;
      let common = 0;
      for (let i = 0; i < 20000; i++) {
        const r = rollWeapon(streamSource(rng), { ilvl: 5, uid: i, luck }).rarity;
        if (r === 'marked' || r === 'relic' || r === 'sovereign') high++;
        if (r === 'common') common++;
      }
      return { high, common };
    };
    const base = roll(1);
    const lucky = roll(1.5);
    assert.ok(lucky.high > base.high, 'luck should raise the top tiers');
    assert.ok(lucky.common > 0, 'commons must never disappear');
  });

  it('signature drops are identical every time', () => {
    const a = makeSignature('wardens-tithe', 16, 1);
    const b = makeSignature('wardens-tithe', 16, 1);
    assert.deepEqual(a, b);
    assert.equal(a.name, SIGNATURES['wardens-tithe']!.name);
    assert.equal(a.locked, true, 'a signature drop should arrive favourited');
  });

  it('item power rises with rarity and item level', () => {
    const low = { uid: 1, archetypeId: 'adze', rarity: 'common' as const, ilvl: 1, affixes: [], name: 'x', locked: false };
    const high = { ...low, rarity: 'relic' as const, ilvl: 30 };
    assert.ok(itemPower(high) > itemPower(low) * 3);
  });

  it('breakdown value scales with rarity and yield bonuses', () => {
    const item = { uid: 1, archetypeId: 'adze', rarity: 'marked' as const, ilvl: 10, affixes: [], name: 'x', locked: false };
    assert.ok(breakdownValue(item, 1.5) > breakdownValue(item, 1));
    assert.ok(Number.isInteger(breakdownValue(item, 1.5)), 'must be an integer for offline parity');
  });
});
