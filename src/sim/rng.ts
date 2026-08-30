/**
 * Deterministic RNG.
 *
 * Two facilities, both pure-integer so they behave identically on every JS
 * engine (Math.imul and >>> are exactly specified; float math is not used
 * anywhere in the generator itself):
 *
 *  - `Rng`: a streaming xoshiro128** generator. Serialisable, so a save can
 *    resume mid-stream. Used by live play.
 *  - `hash32` / `rngAt`: counter-based. `rngAt(seed, streamId, index)` gives
 *    the same value no matter what order you ask for indices in. This is what
 *    lets the closed-form offline path produce byte-identical results to the
 *    stepwise one without replaying every tick.
 *
 * Determinism rule for the whole sim (see docs/ARCHITECTURE.md): integer ops,
 * +-*\/ on doubles, Math.sqrt, Math.floor/min/max/abs are allowed. Transcendentals
 * (sin/cos/pow/exp/log) are NOT, because their results are implementation-defined.
 * Where the sim needs angles it uses the lookup table in `trig.ts`.
 */

export interface Rng {
  s0: number;
  s1: number;
  s2: number;
  s3: number;
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

/** Murmur3 finalizer. Strong avalanche, pure 32-bit integer ops. */
export function mix32(h: number): number {
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Counter-based hash of up to three 32-bit words. Order-independent access. */
export function hash32(a: number, b = 0, c = 0): number {
  let h = 0x9e3779b9;
  h = mix32((h ^ (a >>> 0)) >>> 0);
  h = mix32((h ^ Math.imul(b >>> 0, 0x27d4eb2f)) >>> 0);
  h = mix32((h ^ Math.imul(c >>> 0, 0x165667b1)) >>> 0);
  return h >>> 0;
}

/** Counter-based float in [0,1). Identical for identical (seed, stream, index). */
export function rngAt(seed: number, stream: number, index: number): number {
  return hash32(seed, stream, index) / 4294967296;
}

/** SplitMix32 — used only to expand a single seed into generator state. */
function splitmix32(state: number): [number, number] {
  let z = (state + 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return [(z ^ (z >>> 15)) >>> 0, state === 0 ? 1 : (state + 0x9e3779b9) >>> 0];
}

export function makeRng(seed: number): Rng {
  let s = seed >>> 0;
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [v, next] = splitmix32(s);
    out.push(v);
    s = next;
  }
  const r: Rng = { s0: out[0]!, s1: out[1]!, s2: out[2]!, s3: out[3]! };
  // Guard against the all-zero state, which is absorbing for xoshiro.
  if ((r.s0 | r.s1 | r.s2 | r.s3) === 0) r.s0 = 0x9e3779b9;
  return r;
}

export function cloneRng(r: Rng): Rng {
  return { s0: r.s0, s1: r.s1, s2: r.s2, s3: r.s3 };
}

/** xoshiro128** — next raw 32-bit word. Advances the stream. */
export function nextU32(r: Rng): number {
  const result = Math.imul(rotl(Math.imul(r.s1, 5) >>> 0, 7) >>> 0, 9) >>> 0;
  const t = (r.s1 << 9) >>> 0;
  r.s2 = (r.s2 ^ r.s0) >>> 0;
  r.s3 = (r.s3 ^ r.s1) >>> 0;
  r.s1 = (r.s1 ^ r.s2) >>> 0;
  r.s0 = (r.s0 ^ r.s3) >>> 0;
  r.s2 = (r.s2 ^ t) >>> 0;
  r.s3 = rotl(r.s3, 11);
  return result;
}

/** Float in [0,1). Exactly representable: a 32-bit int over 2^32. */
export function nextFloat(r: Rng): number {
  return nextU32(r) / 4294967296;
}

/** Integer in [lo, hi] inclusive. Debiased by rejection, so still deterministic. */
export function nextInt(r: Rng, lo: number, hi: number): number {
  const span = hi - lo + 1;
  if (span <= 0) return lo;
  const limit = 4294967296 - (4294967296 % span);
  let v = nextU32(r);
  while (v >= limit) v = nextU32(r);
  return lo + (v % span);
}

export function nextRange(r: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * nextFloat(r);
}

export function chance(r: Rng, p: number): boolean {
  return nextFloat(r) < p;
}

export function pick<T>(r: Rng, arr: readonly T[]): T {
  return arr[nextInt(r, 0, arr.length - 1)]!;
}

/** Weighted pick. Weights must be non-negative; ties resolve by array order. */
export function pickWeighted<T>(r: Rng, entries: readonly { readonly item: T; readonly weight: number }[]): T {
  let total = 0;
  for (const e of entries) total += e.weight;
  let roll = nextFloat(r) * total;
  for (const e of entries) {
    roll -= e.weight;
    if (roll < 0) return e.item;
  }
  return entries[entries.length - 1]!.item;
}
