/**
 * The camera rig, and the promise it makes to the crosshair.
 *
 * This suite exists because of a shipped bug that a sixteen-assertion smoke
 * suite waved through: the rig placed the camera on an orbit that swung
 * *down* as the aim swung *up*. The two agreed at screen pitch 0.22 — the
 * value the camera rests at before the mouse is touched — so every screenshot
 * looked right and the game inverted itself the moment anyone aimed.
 *
 * The lesson is that "the camera looks correct" is not a property you can
 * check by looking, because the resting pose is exactly the pose that hides
 * the fault. So it is stated numerically here instead: across the whole pitch
 * range, the view and the shot must move together, and a body under the
 * reticle must be a body the bullet arrives inside.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  aimAngles,
  aimDirection,
  convergeDistance,
  missAt,
  solveRig,
  type RigTarget,
} from '../src/renderer/full/rig.js';

/** Mirrors `main.ts`. Positive screen pitch looks down. */
const PITCH_MIN = -0.8;
const PITCH_MAX = 1.05;
/** Mirrors `scene.ts`. */
const ARENA_RADIUS = 620;

type Rig = ReturnType<typeof solveRig>;

/** The rig as `scene.ts` configures it, with the player at the origin. */
function rigAt(pitch: number, yaw = 0.7, opts: { dist?: number; lift?: number; shoulder?: number } = {}): Rig {
  return solveRig({
    yaw,
    pitch,
    dist: opts.dist ?? 108,
    lift: opts.lift ?? 34,
    shoulder: opts.shoulder ?? 18,
    muzzle: { x: 0, y: 24, z: 0 },
  });
}

/** Every pitch the player can reach, ends included. */
function pitchSweep(): number[] {
  const out: number[] = [];
  for (let i = 0; i <= 40; i++) out.push(PITCH_MIN + ((PITCH_MAX - PITCH_MIN) * i) / 40);
  return out;
}

function degreesBetween(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  const la = Math.hypot(a.x, a.y, a.z);
  const lb = Math.hypot(b.x, b.y, b.z);
  return (Math.acos(Math.min(1, Math.max(-1, dot / (la * lb)))) * 180) / Math.PI;
}

/**
 * Does a ray pass through an upright cylinder? Written out longhand rather
 * than imported, so this suite checks the rig against independent geometry
 * instead of against itself.
 */
function raycastsInto(o: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }, t: RigTarget): boolean {
  const dx = o.x - t.x;
  const dz = o.z - t.z;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-9) return false;
  const b = 2 * (d.x * dx + d.z * dz);
  const c = dx * dx + dz * dz - t.radius * t.radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return false;
  const root = Math.sqrt(disc);
  for (const hit of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
    if (hit <= 0) continue;
    const y = o.y + d.y * hit;
    if (y >= t.y && y <= t.y + t.height) return true;
  }
  return false;
}

/** Unit vector the bullet actually travels along. */
function shotDirection(rig: Rig, converge: number) {
  const a = aimAngles(rig, converge);
  return { x: Math.cos(a.pitch) * Math.cos(a.yaw), y: Math.sin(a.pitch), z: Math.cos(a.pitch) * Math.sin(a.yaw) };
}

/**
 * A body standing exactly under the crosshair at `range` — centred on the
 * camera's centre ray. Null where that ray is below ground, since nothing can
 * stand in the sand.
 */
function bodyOnCentreRay(rig: Rig, range: number, radius = 16, height = 40): RigTarget | null {
  // `range` is from the shooter, not from the camera — the camera is a whole
  // boom further back, and a body "120 out" from it would be standing behind
  // the player.
  const t =
    (rig.muzzle.x - rig.pos.x) * rig.forward.x +
    (rig.muzzle.y - rig.pos.y) * rig.forward.y +
    (rig.muzzle.z - rig.pos.z) * rig.forward.z +
    range;
  const y = rig.pos.y + rig.forward.y * t;
  if (y < height * 0.5 + 1) return null;
  return {
    x: rig.pos.x + rig.forward.x * t,
    y: y - height * 0.5,
    z: rig.pos.z + rig.forward.z * t,
    radius,
    height,
  };
}

describe('camera rig', () => {
  it('is not inverted: pushing the mouse up raises the aim', () => {
    // Mouse up is a negative movementY, so a smaller screen pitch. World aim
    // must go the other way.
    let previous = -Infinity;
    for (const pitch of pitchSweep().slice().reverse()) {
      const world = aimDirection(0, pitch).y;
      assert.ok(world > previous, `aim must rise as screen pitch falls (at ${pitch})`);
      previous = world;
    }
  });

  it('is not inverted: the view rises with the aim, never against it', () => {
    // The assertion the shipped bug failed. Its view pitch moved opposite to
    // its aim pitch at every value but the one the camera rested at.
    const sweep = pitchSweep();
    for (let i = 1; i < sweep.length; i++) {
      const dView = rigAt(sweep[i]!).forward.y - rigAt(sweep[i - 1]!).forward.y;
      const dAim = aimDirection(0.7, sweep[i]!).y - aimDirection(0.7, sweep[i - 1]!).y;
      assert.ok(
        dView * dAim > 0,
        `view and aim must move together (screen pitch ${sweep[i - 1]!.toFixed(2)} → ${sweep[i]!.toFixed(2)}: ` +
          `view ${dView.toFixed(4)}, aim ${dAim.toFixed(4)})`,
      );
    }
  });

  it('barely toes the barrel in when the crosshair is on something distant', () => {
    // Converging on a *near* target necessarily angles the barrel inward —
    // that is what aiming a gun that is not the camera means, and it is
    // geometry, not a defect. What would be a defect is toe-in on a distant
    // target, where the two rays are nearly parallel and any angle is the
    // rig's own error. The shipped rig was sixty degrees out at every range.
    let checked = 0;
    for (const pitch of pitchSweep()) {
      const rig = rigAt(pitch);
      const converge = convergeDistance(rig, [], ARENA_RADIUS);
      const reach = Math.hypot(
        rig.pos.x + rig.forward.x * converge - rig.muzzle.x,
        rig.pos.y + rig.forward.y * converge - rig.muzzle.y,
        rig.pos.z + rig.forward.z * converge - rig.muzzle.z,
      );
      if (reach < 400) continue;
      checked++;
      const off = degreesBetween(rig.forward, shotDirection(rig, converge));
      // 38 units of offset at the shipping lift, which is 4.7° at 460 reach.
      // The bound sits just above that, so raising the lift for framing trips
      // this and makes someone decide the trade rather than drift into it.
      assert.ok(off < 5.5, `view and shot differ by ${off.toFixed(1)}° at ${reach.toFixed(0)} reach`);
    }
    assert.ok(checked > 15, `expected distant convergence at most pitches, got ${checked}`);
  });

  it('hits what the crosshair is on, at every pitch and every range', () => {
    // The property the rig exists for. A body on the centre ray is a body
    // under the reticle; the shot has to arrive inside it.
    let checked = 0;
    for (const pitch of pitchSweep()) {
      for (const range of [120, 240, 480, 900]) {
        const rig = rigAt(pitch);
        const target = bodyOnCentreRay(rig, range);
        if (target === null) continue;
        checked++;
        const dir = shotDirection(rig, convergeDistance(rig, [target], ARENA_RADIUS));
        assert.ok(
          raycastsInto(rig.muzzle, dir, target),
          `shot missed a body ${range} out under the crosshair (screen pitch ${pitch.toFixed(2)})`,
        );
      }
    }
    // Steep down-look puts the far ranges underground, so not every pair is
    // a real placement. Enough of them are.
    assert.ok(checked > 70, `expected a broad sweep, only checked ${checked} cases`);
  });

  it('converges on the body under the reticle rather than on the horizon', () => {
    const rig = rigAt(0.05, 0);
    const target = bodyOnCentreRay(rig, 300)!;
    const converge = convergeDistance(rig, [target], ARENA_RADIUS);
    // The convergence point should land on the near face of that body, not
    // out on the horizon behind it.
    const gap = Math.hypot(
      rig.pos.x + rig.forward.x * converge - target.x,
      rig.pos.z + rig.forward.z * converge - target.z,
    );
    assert.ok(gap <= target.radius + 1, `converged ${gap.toFixed(0)} units from the body it was pointed at`);

    // And it must ignore a body the reticle is *not* on. Converging on
    // something merely nearby would be aim assist, which this is not.
    const beside: RigTarget = { ...target, z: target.z + target.radius * 3 };
    assert.equal(
      convergeDistance(rig, [beside], ARENA_RADIUS),
      convergeDistance(rig, [], ARENA_RADIUS),
      'converged on a body the crosshair was not covering',
    );
  });

  it('keeps the camera near the barrel line', () => {
    // How far the camera sits off the line the bullet travels is the whole
    // of the rig's parallax, and it caps how wrong the crosshair can ever be
    // when there is nothing under it to converge on. `missAt` at range zero
    // is exactly that distance. Bound it so a later change to lift or
    // shoulder cannot quietly make the reticle a suggestion again.
    let worst = 0;
    for (const pitch of pitchSweep()) {
      const rig = rigAt(pitch);
      worst = Math.max(worst, missAt(rig, convergeDistance(rig, [], ARENA_RADIUS), 0));
    }
    assert.ok(worst < 42, `camera sits ${worst.toFixed(1)} units off the barrel line`);
  });

  it('falls back to the ground when nothing is under the reticle', () => {
    const rig = rigAt(0.6, 0);
    const converge = convergeDistance(rig, [], ARENA_RADIUS);
    const hitY = rig.pos.y + rig.forward.y * converge;
    assert.ok(Math.abs(hitY) < 1, `expected to converge on the sand, landed at y=${hitY.toFixed(1)}`);
  });

  it('keeps the boss framing honest', () => {
    // Pulled back and lifted for a set-piece, the rig must still put the shot
    // where the reticle is. This is where the old rig biased its look target
    // 30% of the way toward the boss while the bullets carried straight on.
    for (const pitch of pitchSweep()) {
      const rig = rigAt(pitch, 0.7, { dist: 430, lift: 120, shoulder: 8.1 });
      const target = bodyOnCentreRay(rig, 520, 60, 150);
      if (target === null) continue;
      const dir = shotDirection(rig, convergeDistance(rig, [target], ARENA_RADIUS));
      assert.ok(
        raycastsInto(rig.muzzle, dir, target),
        `boss rig put the shot beside its target at screen pitch ${pitch.toFixed(2)}`,
      );
    }
  });

  it('rejects the rig that shipped', () => {
    // A direct guard against the specific regression: an orbit whose vertical
    // offset is a constant height plus sin(-pitch) * dist. If anyone
    // reintroduces it, this fails loudly rather than subtly.
    const OLD_DIST = 132;
    const OLD_HEIGHT = 62;
    let worst = 0;
    for (const pitch of pitchSweep()) {
      const offY = OLD_HEIGHT + Math.sin(-pitch) * OLD_DIST;
      const viewPitch = Math.atan2(-offY, Math.cos(pitch) * OLD_DIST);
      worst = Math.max(worst, Math.abs(viewPitch - -pitch));
    }
    assert.ok(
      (worst * 180) / Math.PI > 45,
      'the old rig should be wildly wrong — if this fails, the test is measuring the wrong thing',
    );
  });
});
