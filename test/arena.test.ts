/**
 * Arena geometry.
 *
 * The move to three dimensions put every hit test, every telegraph shape and
 * every weak point into new code. This suite pins the parts that are easy to get
 * quietly wrong and expensive to notice — a weak point rotated into the wrong
 * hemisphere, a cone that catches behind the boss, a shot that passes through a
 * body. A weak-point offset bug of exactly this kind already shipped once in the
 * 2D build, which is why it is tested rather than eyeballed.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  ARENA_RADIUS,
  createArena,
  horizDist,
  NEUTRAL_INPUT,
  playerEntity,
  stepArena,
  weakPointPos,
  type ArenaState,
  type InputFrame,
  type StepContext,
} from '../src/sim/arena.js';
import { derive } from '../src/sim/derive.js';
import { createNewGame } from '../src/sim/state.js';
import { getZone } from '../src/sim/content/zones.js';
import { PI } from '../src/sim/trig.js';
import type { Entity, Telegraph, TelegraphShape } from '../src/sim/types.js';

const T0 = 1_700_000_000_000;

function fixture(): { a: ArenaState; ctx: StepContext } {
  const state = createNewGame(4242, T0);
  const d = derive(state);
  const a = createArena('ochre-shelf', 1234, state.player.defences, 1);
  return {
    a,
    ctx: {
      weapon: d.weapon,
      moveSpeed: d.moveSpeed,
      miningYield: d.miningYield,
      scanSpeed: d.scanSpeed,
      armorRegen: d.armorRegen,
      killRecovery: d.killRecovery,
      gate: getZone('ochre-shelf').gate,
    },
  };
}

const step = (a: ArenaState, ctx: StepContext, input: Partial<InputFrame> = {}, n = 1) => {
  for (let i = 0; i < n; i++) stepArena(a, { ...NEUTRAL_INPUT, ...input }, ctx);
};

/** Drops a telegraph that resolves on the next tick, and reports the damage. */
function resolveAt(shape: TelegraphShape, x: number, z: number, yaw: number, radius: number): number {
  const { a, ctx } = fixture();
  const p = playerEntity(a);
  p.x = 0;
  p.z = 0;
  const before = p.def.shield + p.def.armor + p.def.health;
  const t: Telegraph = {
    id: 9999,
    shape,
    damageType: 'percussive',
    x,
    z,
    radius,
    yaw,
    ticksLeft: 1,
    totalTicks: 40,
    damage: 40,
  };
  a.telegraphs.push(t);
  step(a, ctx);
  const after = p.def.shield + p.def.armor + p.def.health;
  return before - after;
}

describe('arena geometry', () => {
  it('rotates weak-point offsets into world space by body yaw', () => {
    const e = { x: 100, y: 0, z: 50, yaw: 0 } as Entity;
    // Facing +x: a purely forward offset lands ahead on x, nothing on z.
    const fwd = weakPointPos(e, { ox: 10, oy: 5, oz: 0 });
    assert.ok(Math.abs(fwd.x - 110) < 1e-6, `x was ${fwd.x}`);
    assert.ok(Math.abs(fwd.z - 50) < 1e-6, `z was ${fwd.z}`);
    assert.equal(fwd.y, 5);

    // Turned a quarter turn, that same forward offset must land on +z.
    e.yaw = PI / 2;
    const turned = weakPointPos(e, { ox: 10, oy: 5, oz: 0 });
    assert.ok(Math.abs(turned.x - 100) < 1e-4, `x was ${turned.x}`);
    assert.ok(Math.abs(turned.z - 60) < 1e-4, `z was ${turned.z}`);
  });

  it('places a side offset on the body\'s left, not its front', () => {
    const e = { x: 0, y: 0, z: 0, yaw: 0 } as Entity;
    const side = weakPointPos(e, { ox: 0, oy: 0, oz: 20 });
    // Tolerance is 1e-4, not 1e-6: sim trig is the polynomial in trig.ts, which
    // is accurate to about 5e-8 relative. Demanding more than that would be
    // testing the approximation rather than the rotation.
    assert.ok(Math.abs(side.x) < 1e-4, `x was ${side.x}`);
    assert.ok(Math.abs(side.z - 20) < 1e-4, `z was ${side.z}`);
  });

  it('keeps everything inside the terrace', () => {
    const { a, ctx } = fixture();
    const p = playerEntity(a);
    // Walk hard at the rim for long enough to leave, if leaving were possible.
    step(a, ctx, { moveX: 0, moveZ: 1, camYaw: 0 }, 900);
    assert.ok(horizDist(0, 0, p.x, p.z) <= ARENA_RADIUS, `escaped to ${p.x},${p.z}`);
  });

  it('resolves camera-relative movement into world space', () => {
    const { a, ctx } = fixture();
    const p = playerEntity(a);
    p.x = 0;
    p.z = 0;
    // Forward with the camera facing +x must move along +x and not +z.
    step(a, ctx, { moveZ: 1, camYaw: 0 }, 10);
    assert.ok(p.x > 20, `expected +x movement, got ${p.x}`);
    assert.ok(Math.abs(p.z) < 1, `expected no z drift, got ${p.z}`);

    p.x = 0;
    p.z = 0;
    // Same input, camera turned a quarter turn: now it must move along +z.
    step(a, ctx, { moveZ: 1, camYaw: PI / 2 }, 10);
    assert.ok(p.z > 20, `expected +z movement, got ${p.z}`);
    assert.ok(Math.abs(p.x) < 1, `expected no x drift, got ${p.x}`);
  });

  it('does not let diagonal movement be faster than cardinal', () => {
    const { a, ctx } = fixture();
    const p = playerEntity(a);
    p.x = 0;
    p.z = 0;
    step(a, ctx, { moveZ: 1, camYaw: 0 }, 20);
    const straight = horizDist(0, 0, p.x, p.z);
    p.x = 0;
    p.z = 0;
    step(a, ctx, { moveX: 1, moveZ: 1, camYaw: 0 }, 20);
    const diagonal = horizDist(0, 0, p.x, p.z);
    assert.ok(Math.abs(diagonal - straight) < 1, `${diagonal} vs ${straight}`);
  });

  it('grants dodge i-frames, and they expire', () => {
    const { a, ctx } = fixture();
    const p = playerEntity(a);
    step(a, ctx, { dodge: true });
    assert.ok(p.iframes > 0, 'a dodge must grant invulnerability');
    step(a, ctx, {}, 40);
    assert.equal(p.iframes, 0, 'invulnerability must not be permanent');
  });

  describe('telegraph shapes', () => {
    it('a ring catches inside and misses outside', () => {
      assert.ok(resolveAt('ring', 0, 0, 0, 150) > 0, 'standing in the ring should hurt');
      assert.equal(resolveAt('ring', 400, 0, 0, 150), 0, 'standing clear should not');
    });

    it('a cone catches in front of it and misses behind', () => {
      // Player sits at the origin; the cone originates 100 away on -x aimed at +x.
      assert.ok(resolveAt('cone', -100, 0, 0, 300) > 0, 'in the cone should hurt');
      assert.equal(resolveAt('cone', 100, 0, 0, 300), 0, 'behind the cone should not');
    });

    it('a line catches on its axis and misses off it', () => {
      assert.ok(resolveAt('line', -200, 0, 0, 30) > 0, 'on the beam should hurt');
      assert.equal(resolveAt('line', -200, 300, 0, 30), 0, 'off the beam should not');
    });

    it('a pulse is safe in the middle and dangerous in the band', () => {
      // Inverse of a ring: the safe place is where a ring would kill you, which
      // is the entire reason the two shapes must be visually distinct.
      assert.equal(resolveAt('pulse', 0, 0, 0, 400), 0, 'the eye of a pulse is safe');
      assert.ok(resolveAt('pulse', 280, 0, 0, 400) > 0, 'the band of a pulse is not');
    });

    it('a column catches directly underneath', () => {
      assert.ok(resolveAt('column', 0, 0, 0, 60) > 0);
      assert.equal(resolveAt('column', 500, 0, 0, 60), 0);
    });
  });

  it('a level shot passes over a knee-high hostile, and aiming down connects', () => {
    // Not pedantry: the muzzle sits at chest height and a Shelf Tick is 20 units
    // tall, so a flat shot genuinely should sail over it. This pins that aim
    // actually matters in the vertical, which is most of what 3D bought.
    const { a, ctx } = fixture();
    const p = playerEntity(a);
    p.x = 0;
    p.z = 0;
    step(a, ctx, {}, 100); // let a wave spawn
    const hostile = a.entities.find((e) => e.faction === 'hostile');
    assert.ok(hostile, 'a wave should have spawned');
    hostile!.x = 120;
    hostile!.z = 0;
    hostile!.radius = 14;
    hostile!.height = 20;
    const total = () => hostile!.def.shield + hostile!.def.armor + hostile!.def.health;

    const before = total();
    step(a, ctx, { fire: true, aimYaw: 0, aimPitch: 0 }, 1);
    assert.equal(total(), before, 'a level shot should sail over something this short');

    // Now aim at it. The muzzle is at ~30, the target's middle at ~10.
    step(a, ctx, { fire: true, aimYaw: 0, aimPitch: -0.17 }, 40);
    assert.ok(total() < before, 'aiming down should connect');
  });

  it('prefers an exposed weak point deeper inside a body over the surface', () => {
    // This is the bug the 2D build shipped: a hit resolves where the ray enters
    // the body, which is never inside a weak-point volume further in.
    const { a, ctx } = fixture();
    const p = playerEntity(a);
    p.x = 0;
    p.z = 0;
    step(a, ctx, {}, 100);
    const hostile = a.entities.find((e) => e.faction === 'hostile');
    assert.ok(hostile);
    hostile!.x = 160;
    hostile!.z = 0;
    hostile!.radius = 40;
    hostile!.height = 60;
    hostile!.weakPoints = [
      {
        id: 'test',
        label: 'Test Point',
        // Behind the leading surface, at the height a level shot travels.
        ox: 20,
        oy: 30,
        oz: 0,
        radius: 14,
        multiplier: 5,
        exposed: true,
        health: 1e9,
        healthMax: 1e9,
        broken: false,
      },
    ];
    const events = stepArena(a, { ...NEUTRAL_INPUT, fire: true, aimYaw: 0, aimPitch: 0 }, ctx);
    const weak = events.filter((e) => e.type === 'weak');
    assert.ok(weak.length > 0, 'the shot should have resolved on the weak point');
    assert.equal(weak[0]!.text, 'Test Point');
  });
});
