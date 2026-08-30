/**
 * Save serialisation, versioning and migration.
 *
 * Idle games live and die on save integrity, so the format is boring on purpose:
 * a JSON envelope with a magic string, a schema version, a checksum over the
 * exact payload text, and nothing clever. Anything that cannot be read is
 * reported rather than guessed at — the caller decides whether to fall back to a
 * backup (see src/main/storage.ts, which does exactly that).
 *
 * Migrations are forward-only and each one moves exactly one version. New fields
 * get defaults here, never `undefined` checks scattered through gameplay code.
 */
import { SCHEMA_VERSION, DEFAULT_SETTINGS, emptyMaterials, type GameState } from './state.js';

export const SAVE_MAGIC = 'CENOTAPH';

export interface SaveEnvelope {
  magic: string;
  version: number;
  savedAtMs: number;
  checksum: string;
  payload: unknown;
}

function checksum(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h = (h ^ text.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function serialize(state: GameState, nowMs: number): string {
  const payloadText = JSON.stringify(state);
  const env: SaveEnvelope = {
    magic: SAVE_MAGIC,
    version: SCHEMA_VERSION,
    savedAtMs: nowMs,
    checksum: checksum(payloadText),
    payload: JSON.parse(payloadText),
  };
  return JSON.stringify(env);
}

export type LoadOutcome =
  | { ok: true; state: GameState; migratedFrom: number | null; warnings: string[] }
  | { ok: false; reason: string };

export function deserialize(raw: string): LoadOutcome {
  let env: SaveEnvelope;
  try {
    env = JSON.parse(raw) as SaveEnvelope;
  } catch (err) {
    return { ok: false, reason: `unparseable JSON: ${(err as Error).message}` };
  }
  if (!env || typeof env !== 'object') return { ok: false, reason: 'envelope is not an object' };
  if (env.magic !== SAVE_MAGIC) return { ok: false, reason: `bad magic: ${String(env.magic)}` };
  if (typeof env.version !== 'number') return { ok: false, reason: 'missing version' };
  if (env.version > SCHEMA_VERSION) {
    return { ok: false, reason: `save is from a newer build (v${env.version} > v${SCHEMA_VERSION})` };
  }
  if (env.payload === undefined || env.payload === null) return { ok: false, reason: 'missing payload' };

  const payloadText = JSON.stringify(env.payload);
  if (typeof env.checksum === 'string' && env.checksum !== checksum(payloadText)) {
    return { ok: false, reason: 'checksum mismatch — file is corrupt or was edited' };
  }

  const warnings: string[] = [];
  let data = env.payload as Record<string, unknown>;
  const from = env.version;
  for (let v = env.version; v < SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) return { ok: false, reason: `no migration from v${v} to v${v + 1}` };
    data = step(data, warnings);
  }

  const repaired = repair(data, warnings);
  return { ok: true, state: repaired, migratedFrom: from === SCHEMA_VERSION ? null : from, warnings };
}

type Migration = (data: Record<string, unknown>, warnings: string[]) => Record<string, unknown>;

/**
 * Keyed by the version being migrated *from*.
 *
 * The two entries below are real: v1 predates the prestige axis and v2 predates
 * per-zone route state. They stay here permanently — a save written by any
 * shipped build must keep loading forever.
 */
const MIGRATIONS: Record<number, Migration> = {
  1: (data, warnings) => {
    warnings.push('migrated v1 -> v2: added prestige axis');
    return {
      ...data,
      prestige: data.prestige ?? { count: 0, multiplier: 1, marker: '' },
      version: 2,
    };
  },
  2: (data, warnings) => {
    warnings.push('migrated v2 -> v3: added route state and offline report');
    return {
      ...data,
      route: data.route ?? null,
      lastOfflineReport: data.lastOfflineReport ?? null,
      version: 3,
    };
  },
};

/**
 * Fills in anything a migration could not know about and clamps obvious
 * nonsense. This is the last line of defence before gameplay code sees a save.
 */
function repair(data: Record<string, unknown>, warnings: string[]): GameState {
  const s = data as unknown as GameState;

  if (!s.settings) {
    s.settings = { ...DEFAULT_SETTINGS };
    warnings.push('settings missing; defaults applied');
  } else {
    s.settings = { ...DEFAULT_SETTINGS, ...s.settings };
  }
  if (!s.resources) {
    s.resources = { materials: emptyMaterials(), data: 0, fuel: 100, fuelMax: 100 };
    warnings.push('resources missing; reset to zero');
  }
  if (!s.resources.materials) s.resources.materials = emptyMaterials();
  for (const t of ['1', '2', '3', '4', '5']) {
    const v = s.resources.materials[t];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      s.resources.materials[t] = 0;
      warnings.push(`material tier ${t} was invalid; reset to 0`);
    }
  }
  if (typeof s.resources.data !== 'number' || !Number.isFinite(s.resources.data)) {
    s.resources.data = 0;
    warnings.push('data was invalid; reset to 0');
  }
  if (!Array.isArray(s.inventory?.items)) {
    s.inventory = { slots: 24, items: [] };
    warnings.push('inventory missing; reset to empty');
  }
  if (!Array.isArray(s.tech?.unlocked)) s.tech = { unlocked: [] };
  if (!Array.isArray(s.codex)) s.codex = [];
  if (!s.zones) s.zones = {};
  if (!s.prestige) s.prestige = { count: 0, multiplier: 1, marker: '' };
  if (!s.ship) s.ship = { tier: 1, upgrades: {} };
  if (typeof s.nextUid !== 'number' || s.nextUid < 1) {
    const maxUid = s.inventory.items.reduce((m, i) => Math.max(m, i.uid ?? 0), 0);
    s.nextUid = maxUid + 1;
    warnings.push('nextUid rebuilt from inventory');
  }
  if (typeof s.lastSeenMs !== 'number' || !Number.isFinite(s.lastSeenMs)) {
    s.lastSeenMs = Date.now();
    warnings.push('lastSeenMs was invalid; offline accrual skipped for this load');
  }
  if (typeof s.tick !== 'number' || !Number.isFinite(s.tick) || s.tick < 0) s.tick = 0;

  // A dangling loadout reference would crash derive(); drop it instead.
  const uids = new Set(s.inventory.items.map((i) => i.uid));
  if (Array.isArray(s.player?.loadout)) {
    s.player.loadout = s.player.loadout.map((uid) => (uid !== null && uids.has(uid) ? uid : null));
  }
  s.version = SCHEMA_VERSION;
  return s;
}
