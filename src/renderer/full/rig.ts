/**
 * The third-person rig: where the camera sits, where it points, and where the
 * shot goes.
 *
 * This is deliberately separate from `scene.ts` and touches neither Three.js
 * nor the DOM, because it is the piece that decides whether the crosshair is
 * telling the truth — and a claim like that is worth a test. `test/rig.test.ts`
 * sweeps the whole pitch range in microseconds and fails the build if the view
 * and the shot ever disagree again.
 *
 * They did disagree. The rig used to place the camera at
 * `height + sin(-pitch) * dist`, which swings the camera *down* as the aim
 * swings *up*. The two happened to line up at pitch 0.22 — the value the
 * camera rests at before the mouse is touched — so it looked correct in every
 * screenshot and inverted the moment anyone aimed.
 *
 * Two conventions, held to everywhere below:
 *
 *   - **Screen pitch** is what the mouse produces: positive is looking *down*,
 *     because a downward mouse movement is a positive `movementY`.
 *   - **World pitch** is what the simulation shoots along: positive is *up*.
 *
 * They are negations of each other and that negation happens in exactly one
 * place, `aimDirection`. Anywhere else is a bug.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A body the centre ray can land on: an upright cylinder, as in the sim. */
export interface RigTarget {
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
}

export interface RigParams {
  yaw: number;
  /** Screen pitch: positive looks down. */
  pitch: number;
  /** Boom length, straight back along the aim ray. */
  dist: number;
  /** How far the camera is stepped up off that ray, purely for framing. */
  lift: number;
  /** How far it is stepped sideways off that ray, purely for framing. */
  shoulder: number;
  /** The muzzle — where the shot actually starts. */
  muzzle: Vec3;
  /** Lowest the camera may sit. Defaults to just above the sand. */
  floor?: number;
}

export interface Rig {
  pos: Vec3;
  /** Unit vector the camera looks along. Screen centre lies on this ray. */
  forward: Vec3;
  muzzle: Vec3;
}

/** World-space aim direction for a set of screen angles. The one negation. */
export function aimDirection(yaw: number, pitch: number): Vec3 {
  const world = -pitch;
  const cp = Math.cos(world);
  return { x: cp * Math.cos(yaw), y: Math.sin(world), z: cp * Math.sin(yaw) };
}

/**
 * Places the camera.
 *
 * The boom lies *along* the aim ray rather than on a separate orbit, so the
 * camera and the gun can never point in different directions. Lift and
 * shoulder step the camera off that ray for framing, which is the whole of the
 * parallax the rig has to deal with — see `convergeDistance`.
 */
export function solveRig(p: RigParams): Rig {
  const forward = aimDirection(p.yaw, p.pitch);
  // Level with the horizon, not with the aim: a shoulder step that pitched
  // with the barrel would roll the horizon every time you looked down.
  const rx = -Math.sin(p.yaw);
  const rz = Math.cos(p.yaw);

  // Looking up swings the boom down, and the muzzle is only twenty-odd units
  // off the sand, so past a shallow angle the camera wants to be underground.
  // Pull the boom *in* rather than clamping the camera's height: shortening
  // keeps the camera on the ray, where clamping would tilt the view off the
  // shot and undo the whole point of the rig. Lift and shoulder shrink with
  // it, so a short boom has the same parallax angle as a long one instead of
  // a far worse one.
  let dist = p.dist;
  const drop = p.dist > 0 ? forward.y - p.lift / p.dist : 0;
  if (drop > 1e-6) {
    const room = p.muzzle.y - (p.floor ?? FLOOR);
    dist = Math.min(dist, Math.max(BOOM_MIN, room / drop));
  }
  const k = p.dist > 0 ? dist / p.dist : 0;
  const lift = p.lift * k;
  const shoulder = p.shoulder * k;

  return {
    pos: {
      x: p.muzzle.x - forward.x * dist + rx * shoulder,
      y: p.muzzle.y - forward.y * dist + lift,
      z: p.muzzle.z - forward.z * dist + rz * shoulder,
    },
    forward,
    muzzle: { x: p.muzzle.x, y: p.muzzle.y, z: p.muzzle.z },
  };
}

/** Just clear of the sand. */
const FLOOR = 10;
/** Never let the boom collapse into the player's own head. */
const BOOM_MIN = 22;

const CONVERGE_MIN = 60;
const CONVERGE_MAX = 2200;
const CONVERGE_DEFAULT = 1100;

/**
 * How far along the camera's centre ray the shot should converge.
 *
 * The camera does not sit on the gun. "Fire along the camera's angles" and
 * "fire at what the crosshair covers" are therefore two different shots, and
 * at this boom length they differ by enough to miss a weak point. Converging
 * on whatever the centre ray actually meets makes them the same shot at the
 * one range that matters: the range of the thing being pointed at.
 *
 * This is not aim assist. It never moves the crosshair toward a target, never
 * widens a hitbox and never bends a bullet. It removes a parallax error that
 * the player did not introduce and cannot see.
 */
export function convergeDistance(rig: Rig, targets: readonly RigTarget[], arenaRadius = 0): number {
  // Nothing between the camera and the shooter may be converged on. A hostile
  // that walks behind the player crosses the centre ray, and without this it
  // would drag the aim backwards through the player's own shoulder.
  const behind =
    (rig.muzzle.x - rig.pos.x) * rig.forward.x +
    (rig.muzzle.y - rig.pos.y) * rig.forward.y +
    (rig.muzzle.z - rig.pos.z) * rig.forward.z;
  const near = Math.max(CONVERGE_MIN, behind + 24);

  let best = Infinity;

  for (const t of targets) {
    const hit = rayCylinder(rig.pos, rig.forward, t, near);
    if (hit !== null && hit < best) best = hit;
  }

  // Failing a body, the ground: pointing at the sand should put the impact
  // under the crosshair too.
  if (rig.forward.y < -1e-6) {
    const g = -rig.pos.y / rig.forward.y;
    if (g > near && g < best) best = g;
  }

  if (!Number.isFinite(best)) {
    // Nothing under the reticle. Converge far enough out that the residual
    // parallax is a fraction of a degree, but stay inside the arena so a shot
    // at the skyline does not converge behind the player on the far wall.
    best = arenaRadius > 0 ? Math.min(CONVERGE_DEFAULT, arenaRadius * 2) : CONVERGE_DEFAULT;
  }

  return Math.min(CONVERGE_MAX, Math.max(near, best));
}

/** Nearest intersection beyond `near` of a ray with an upright cylinder. */
function rayCylinder(o: Vec3, d: Vec3, t: RigTarget, near: number): number | null {
  const dx = o.x - t.x;
  const dz = o.z - t.z;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-9) return null; // looking straight up or down
  const b = 2 * (d.x * dx + d.z * dz);
  const c = dx * dx + dz * dz - t.radius * t.radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  for (const hit of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
    if (hit <= near) continue;
    const y = o.y + d.y * hit;
    if (y < t.y || y > t.y + t.height) continue;
    return hit;
  }
  return null;
}

/**
 * The angles to hand the simulation: from the muzzle to the point the
 * crosshair covers. Returns *world* pitch, positive up.
 */
export function aimAngles(rig: Rig, converge: number): { yaw: number; pitch: number } {
  const tx = rig.pos.x + rig.forward.x * converge - rig.muzzle.x;
  const ty = rig.pos.y + rig.forward.y * converge - rig.muzzle.y;
  const tz = rig.pos.z + rig.forward.z * converge - rig.muzzle.z;
  const flat = Math.sqrt(tx * tx + tz * tz);
  return { yaw: Math.atan2(tz, tx), pitch: Math.atan2(ty, flat) };
}

/**
 * How far from screen centre the shot lands at `range`, in world units.
 *
 * The rig's own error bar. Zero at the convergence distance by construction;
 * the test bounds it everywhere else.
 */
export function missAt(rig: Rig, converge: number, range: number): number {
  const a = aimAngles(rig, converge);
  const cp = Math.cos(a.pitch);
  // Where the bullet is after `range`.
  const px = rig.muzzle.x + cp * Math.cos(a.yaw) * range;
  const py = rig.muzzle.y + Math.sin(a.pitch) * range;
  const pz = rig.muzzle.z + cp * Math.sin(a.yaw) * range;
  // Perpendicular distance from that point to the camera's centre ray.
  const vx = px - rig.pos.x;
  const vy = py - rig.pos.y;
  const vz = pz - rig.pos.z;
  const along = vx * rig.forward.x + vy * rig.forward.y + vz * rig.forward.z;
  const ex = vx - rig.forward.x * along;
  const ey = vy - rig.forward.y * along;
  const ez = vz - rig.forward.z * along;
  return Math.sqrt(ex * ex + ey * ey + ez * ez);
}
