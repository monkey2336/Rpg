/**
 * Weapon mechanics.
 *
 * The brief's bar is "genuinely different feel, not stat reskins", so each
 * archetype owns a verb no other archetype has. These tests hold the verbs:
 * charge, homing, chain, falloff, pierce and lingering fire each do a thing
 * that a difference in numbers could not produce.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  NEUTRAL_INPUT,
  createArena,
  playerEntity,
  stepArena,
  type ArenaState,
  type StepContext,
} from '../src/sim/arena.js';
import { derive, resolveWeapon } from '../src/sim/derive.js';
import { createNewGame } from '../src/sim/state.js';
import { getZone } from '../src/sim/content/zones.js';
import { WEAPON_ARCHETYPES, archetypeVerb, getArchetype } from '../src/sim/content/weapons.js';
import { getEnemy } from '../src/sim/content/enemies.js';
import { makeDefences } from '../src/sim/combat.js';
import type { Entity } from '../src/sim/types.js';

const T0 = 1_700_000_000_000;

/** An arena with the named weapon equipped and loaded, and no waves yet. */
function rig(archetypeId: string): { a: ArenaState; ctx: StepContext } {
  const state = createNewGame(4242, T0);
  const item = state.inventory.items[0]!;
  item.archetypeId = archetypeId;
  const d = derive(state);
  const weapon = resolveWeapon(item, d.damageMult);
  const a = createArena('ochre-shelf', 11, state.player.defences, 1);
  // The player spawns at z = 260; put them at the origin so a dummy placed at
  // (x, 0) is actually down the +x axis from the muzzle rather than 260 units
  // off to one side of it.
  const p = playerEntity(a);
  p.x = 0;
  p.z = 0;
  a.player.ammo = weapon.magazine;
  a.player.reloadLeft = 0;
  return {
    a,
    ctx: {
      weapon,
      moveSpeed: d.moveSpeed,
      miningYield: d.miningYield,
      scanSpeed: d.scanSpeed,
      armorRegen: d.armorRegen,
      killRecovery: d.killRecovery,
      gate: getZone('ochre-shelf').gate,
    },
  };
}

/** Drops a fat, stationary dummy at (x, z) with effectively infinite health. */
function dummy(a: ArenaState, x: number, z: number, radius = 26, height = 70): Entity {
  const def = getEnemy('duster-artillery');
  const e: Entity = {
    id: a.nextId++,
    kind: 'artillery',
    faction: 'hostile',
    defId: def.id,
    x,
    y: 0,
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    radius,
    height,
    yaw: 0,
    def: makeDefences(def.defences, 1),
    statuses: [],
    ai: { cd: 99999, state: 0, timer: 99999 },
    weakPoints: [],
    phase: 0,
    grounded: true,
    iframes: 0,
    stunned: 0,
    dead: false,
    hitFlash: 0,
    gait: 0,
  };
  e.def.healthMax = 1e9;
  e.def.health = 1e9;
  e.def.shieldMax = 0;
  e.def.shield = 0;
  e.def.armorMax = 0;
  e.def.armor = 0;
  a.entities.push(e);
  return e;
}

const total = (e: Entity) => e.def.shield + e.def.armor + e.def.health;

function fire(a: ArenaState, ctx: StepContext, ticks: number, held = true) {
  const seen: Record<string, number> = {};
  for (let i = 0; i < ticks; i++) {
    const events = stepArena(a, { ...NEUTRAL_INPUT, fire: held, aimYaw: 0, aimPitch: 0 }, ctx);
    for (const e of events) seen[e.type] = (seen[e.type] ?? 0) + 1;
  }
  return seen;
}

describe('weapon archetypes', () => {
  it('every archetype owns a verb no other archetype has', () => {
    // This is the brief's "not stat reskins" bar, as an assertion. Two guns
    // that share a mechanic are a reskin however different their numbers are.
    const verbs = WEAPON_ARCHETYPES.map(archetypeVerb);
    assert.equal(new Set(verbs).size, WEAPON_ARCHETYPES.length, `shared verbs: ${verbs.join(', ')}`);
  });

  it('charge weapons fire on release, not on hold', () => {
    const { a, ctx } = rig('obelisk');
    const target = dummy(a, 300, 0);
    const before = total(target);

    // Holding builds charge and fires nothing.
    const held = fire(a, ctx, 30, true);
    assert.equal(held.shot ?? 0, 0, 'holding a rail must not fire it');
    assert.ok(a.player.charge > 0, 'holding should build charge');
    assert.equal(total(target), before, 'nothing should have been damaged yet');

    // Releasing fires it.
    const released = fire(a, ctx, 2, false);
    assert.equal(released.shot ?? 0, 1, 'releasing should fire exactly once');
    assert.ok(total(target) < before, 'the released shot should connect');
    assert.equal(a.player.charge, 0, 'charge should reset after firing');
  });

  it('a fuller charge hits harder', () => {
    const shotAt = (chargeTicks: number) => {
      const { a, ctx } = rig('obelisk');
      const target = dummy(a, 300, 0);
      const before = total(target);
      fire(a, ctx, chargeTicks, true);
      fire(a, ctx, 2, false);
      return before - total(target);
    };
    const short = shotAt(6);
    const full = shotAt(getArchetype('obelisk').charge!.ticks);
    assert.ok(full > short * 2, `a full charge should be worth far more: ${short} -> ${full}`);
  });

  it('a full charge pierces the queue behind the target', () => {
    const { a, ctx } = rig('obelisk');
    const near = dummy(a, 200, 0);
    const far = dummy(a, 340, 0);
    fire(a, ctx, getArchetype('obelisk').charge!.ticks, true);
    fire(a, ctx, 2, false);
    assert.ok(total(near) < 1e9, 'the near target should be hit');
    assert.ok(total(far) < 1e9, 'a full charge should carry through to the one behind');
  });

  it('a partial charge pierces less deeply than a full one', () => {
    // A rail always goes through one body; the charge buys the rest of the
    // queue. So the test is about depth, not about whether it pierces at all.
    const depth = (chargeTicks: number) => {
      const { a, ctx } = rig('obelisk');
      const line = [180, 280, 380, 480, 580].map((x) => dummy(a, x, 0));
      fire(a, ctx, chargeTicks, true);
      fire(a, ctx, 2, false);
      return line.filter((e) => total(e) < 1e9).length;
    };
    const partial = depth(8);
    const full = depth(getArchetype('obelisk').charge!.ticks);
    assert.equal(partial, 2, 'a rail always carries through one body');
    assert.ok(full > partial, `a full charge should reach deeper: ${partial} -> ${full}`);
  });

  it('falloff means distance costs damage', () => {
    const damageAt = (distance: number) => {
      const { a, ctx } = rig('maw');
      const target = dummy(a, distance, 0, 40, 90);
      const before = total(target);
      fire(a, ctx, 2, true);
      return before - total(target);
    };
    const close = damageAt(70);
    const far = damageAt(190);
    assert.ok(close > 0 && far > 0, 'both should connect at all');
    assert.ok(far < close * 0.5, `range should cost a scattergun dearly: ${close} -> ${far}`);
  });

  it('chaining reaches a second target the shot never touched', () => {
    const { a, ctx } = rig('vespers');
    const shot = dummy(a, 260, 0);
    // Well off the firing line, so nothing but a chain can reach it.
    const bystander = dummy(a, 300, 130);
    const events = fire(a, ctx, 40, true);
    assert.ok(total(shot) < 1e9, 'the aimed target should be hit');
    assert.ok(total(bystander) < 1e9, 'the chain should have reached the bystander');
    assert.ok((events.chain ?? 0) > 0, 'a chain the player cannot see is a damage buff, not a mechanic');
  });

  it('homing munitions steer onto a target off the firing line', () => {
    const { a, ctx } = rig('reliquary');
    // Offset enough that a straight shot misses entirely.
    const target = dummy(a, 300, 110, 30, 80);
    fire(a, ctx, 120, true);
    assert.ok(total(target) < 1e9, 'a swarm should find its own way to the heat');
  });

  it('an unguided projectile does not', () => {
    // The control for the test above: same offset, no homing.
    const { a, ctx } = rig('censer');
    const target = dummy(a, 300, 110, 30, 80);
    fire(a, ctx, 120, true);
    assert.equal(total(target), 1e9, 'a lob should sail past something it was not aimed at');
  });

  it('lingering fire keeps hurting after the trigger is released', () => {
    const { a, ctx } = rig('pyre');
    const target = dummy(a, 90, 0, 30, 80);
    fire(a, ctx, 40, true);
    assert.ok(a.hazards.length > 0, 'the Pyre should leave the floor on fire');
    const afterFiring = total(target);
    fire(a, ctx, 60, false);
    assert.ok(total(target) < afterFiring, 'the fire should still be burning');
  });

  it('lingering patches merge instead of stacking', () => {
    // Twenty-six rounds a second laying twenty-six overlapping patches turned
    // the Pyre into a thousand damage a second through an invisible effect.
    const { a, ctx } = rig('pyre');
    dummy(a, 120, 0, 30, 80);
    fire(a, ctx, 200, true);
    assert.ok(a.hazards.length <= 14, `patches must merge, found ${a.hazards.length}`);
  });

  it('every archetype can be fired without throwing', () => {
    for (const arch of WEAPON_ARCHETYPES) {
      const { a, ctx } = rig(arch.id);
      dummy(a, 150, 0, 40, 90);
      assert.doesNotThrow(() => {
        fire(a, ctx, 60, true);
        fire(a, ctx, 20, false);
      }, `${arch.id} threw`);
    }
  });
});
