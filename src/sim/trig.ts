/**
 * Deterministic trigonometry.
 *
 * Math.sin/cos/atan2 are implementation-defined in ECMAScript — two engines
 * may differ in the last few ulps, which is enough to desync a seeded sim.
 * Everything here is built from +-*\/ and comparisons only, so the sim gets
 * bit-identical angles on every platform. Presentation code is free to use the
 * native Math functions; only `src/sim` is bound by this rule.
 */

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
const HALF_PI = 1.5707963267948966;

/** Wrap to [-PI, PI] using only exact float ops. */
export function wrapAngle(x: number): number {
  let a = x - TAU * Math.floor((x + PI) / TAU);
  if (a > PI) a -= TAU;
  if (a < -PI) a += TAU;
  return a;
}

/** 11th-order Taylor on [-PI/2, PI/2] after symmetry reduction. |err| < 4e-8. */
export function sin(x: number): number {
  let a = wrapAngle(x);
  if (a > HALF_PI) a = PI - a;
  else if (a < -HALF_PI) a = -PI - a;
  const x2 = a * a;
  return a * (1 - x2 * (1 / 6 - x2 * (1 / 120 - x2 * (1 / 5040 - x2 * (1 / 362880 - x2 / 39916800)))));
}

export function cos(x: number): number {
  return sin(x + HALF_PI);
}

/** Rational approximation to atan on [-1,1], then octant fold. |err| < 1e-5. */
function atanUnit(z: number): number {
  const z2 = z * z;
  return z * (0.9998660 + z2 * (-0.3302995 + z2 * (0.1801410 + z2 * (-0.0851330 + z2 * 0.0208351))));
}

export function atan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  let a: number;
  if (ax >= ay) {
    a = atanUnit(ay / ax);
  } else {
    a = HALF_PI - atanUnit(ax / ay);
  }
  if (x < 0) a = PI - a;
  return y < 0 ? -a : a;
}

/** Shortest signed delta from `from` to `to`. */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Approach `to` from `a` by at most `maxStep`. */
export function toward(a: number, to: number, maxStep: number): number {
  const d = to - a;
  if (d > maxStep) return a + maxStep;
  if (d < -maxStep) return a - maxStep;
  return to;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}
