/**
 * Canonical state hashing.
 *
 * Used by the offline-parity test and by the save integrity check. Keys are
 * sorted and floats are quantised to 6 decimals so that a hash comparison
 * means "these two states are the same game", not "these two objects were
 * serialised in the same key order".
 */

function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'n';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `f${value > 0 ? 'inf' : '-inf'}`;
    if (Number.isInteger(value)) return `i${value}`;
    return `d${value.toFixed(6)}`;
  }
  if (typeof value === 'boolean') return value ? 'T' : 'F';
  if (typeof value === 'string') return `s${value.length}:${value}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${k}=${canonical(obj[k])}`).join(',')}}`;
}

/** FNV-1a over the canonical form. Returned as 8 lowercase hex chars. */
export function hashState(value: unknown): string {
  const s = canonical(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export { canonical as canonicalForm };
