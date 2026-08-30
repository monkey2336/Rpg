/**
 * Big-number formatting. Wired in from day one because retrofitting notation
 * across a UI is miserable and idle curves get large fast.
 *
 * Scale: '' K M B T then two-letter aa, ab, ac ... zz (each step is 1e3).
 * `scientific` mode is a user setting, not a separate code path.
 */

export type NotationMode = 'short' | 'scientific';

const SHORT_UNITS = ['', 'K', 'M', 'B', 'T'] as const;
const A = 'a'.charCodeAt(0);

/** Suffix for the i-th group of three digits. i=0 -> '', 5 -> 'aa', 6 -> 'ab'. */
export function groupSuffix(i: number): string {
  if (i < SHORT_UNITS.length) return SHORT_UNITS[i]!;
  let j = i - SHORT_UNITS.length;
  const first = Math.floor(j / 26);
  const second = j % 26;
  if (first < 26) return String.fromCharCode(A + first, A + second);
  // Beyond 'zz' (~1e90) fall back to scientific rather than inventing glyphs.
  return '';
}

function decimalExponent(n: number): number {
  // Derived from toExponential rather than log10 to dodge the classic
  // log10(1000) === 2.9999999999999996 off-by-one.
  const s = n.toExponential();
  return parseInt(s.slice(s.indexOf('e') + 1), 10);
}

export interface FormatOptions {
  mode?: NotationMode;
  /** Significant decimals shown once the value is suffixed. Default 2. */
  decimals?: number;
  /** Values below this print as plain integers. Default 10000. */
  plainBelow?: number;
}

export function formatNumber(value: number, opts: FormatOptions = {}): string {
  const { mode = 'short', decimals = 2, plainBelow = 10000 } = opts;
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '-∞';
  const neg = value < 0;
  const n = neg ? -value : value;
  const sign = neg ? '-' : '';

  if (n < plainBelow) {
    const rounded = n < 100 && !Number.isInteger(n) ? n.toFixed(1) : String(Math.floor(n + 0.5));
    return sign + rounded;
  }
  if (mode === 'scientific') {
    const e = decimalExponent(n);
    const mant = n / Math.pow(10, e);
    return `${sign}${mant.toFixed(decimals)}e${e}`;
  }
  const e = decimalExponent(n);
  const group = Math.floor(e / 3);
  const suffix = groupSuffix(group);
  if (suffix === '') {
    const mant = n / Math.pow(10, e);
    return `${sign}${mant.toFixed(decimals)}e${e}`;
  }
  const scaled = n / Math.pow(10, group * 3);
  // Trim trailing zeros so "1.00M" reads as "1M" but "1.25M" survives intact.
  const text = scaled.toFixed(decimals).replace(/\.?0+$/, '');
  return sign + text + suffix;
}

/** Compact rate, e.g. "1.25M/h". Rates are stored per second internally. */
export function formatRate(perSecond: number, opts: FormatOptions = {}): string {
  return `${formatNumber(perSecond * 3600, opts)}/h`;
}

/** "3d 04h", "4h 12m", "38s" — for offline reports and route ETAs. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v: number) => (v < 10 ? `0${v}` : String(v));
  if (d > 0) return `${d}d ${pad(h)}h`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

export function formatPercent(v: number, decimals = 0): string {
  return `${(v * 100).toFixed(decimals)}%`;
}
