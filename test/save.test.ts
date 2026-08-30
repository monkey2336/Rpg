/**
 * Save integrity. Quality bar #4 is "zero save loss, ever", so this suite is
 * adversarial on purpose: truncated files, edited payloads, saves from the
 * future, saves from two schema versions ago, and dangling references.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { deserialize, serialize, SAVE_MAGIC } from '../src/sim/save.js';
import { SCHEMA_VERSION, createNewGame } from '../src/sim/state.js';
import { hashState } from '../src/sim/hash.js';

const T0 = 1_700_000_000_000;

describe('save', () => {
  it('round-trips a state exactly', () => {
    const state = createNewGame(4242, T0);
    state.resources.data = 987;
    state.player.level = 12;
    const out = deserialize(serialize(state, T0));
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(hashState(out.state), hashState(state));
  });

  it('rejects a truncated file rather than loading half a game', () => {
    const raw = serialize(createNewGame(1, T0), T0);
    const out = deserialize(raw.slice(0, raw.length - 40));
    assert.equal(out.ok, false);
  });

  it('rejects an edited payload via the checksum', () => {
    const raw = serialize(createNewGame(1, T0), T0);
    const env = JSON.parse(raw);
    env.payload.resources.data = 999999999;
    const out = deserialize(JSON.stringify(env));
    assert.equal(out.ok, false);
    if (!out.ok) assert.match(out.reason, /checksum/);
  });

  it('rejects a save from a newer build instead of mangling it', () => {
    const env = JSON.parse(serialize(createNewGame(1, T0), T0));
    env.version = SCHEMA_VERSION + 5;
    const out = deserialize(JSON.stringify(env));
    assert.equal(out.ok, false);
    if (!out.ok) assert.match(out.reason, /newer build/);
  });

  it('rejects a foreign file', () => {
    const out = deserialize(JSON.stringify({ magic: 'SOMETHINGELSE', version: 1, payload: {} }));
    assert.equal(out.ok, false);
  });

  it('migrates a v1 save forward and reports it', () => {
    const state = createNewGame(7, T0) as unknown as Record<string, unknown>;
    delete state.prestige;
    delete state.route;
    delete state.lastOfflineReport;
    state.version = 1;
    const payloadText = JSON.stringify(state);
    let h = 0x811c9dc5;
    for (let i = 0; i < payloadText.length; i++) {
      h = (h ^ payloadText.charCodeAt(i)) >>> 0;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    const raw = JSON.stringify({
      magic: SAVE_MAGIC,
      version: 1,
      savedAtMs: T0,
      checksum: h.toString(16).padStart(8, '0'),
      payload: JSON.parse(payloadText),
    });
    const out = deserialize(raw);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.migratedFrom, 1);
    assert.equal(out.state.version, SCHEMA_VERSION);
    assert.deepEqual(out.state.prestige, { count: 0, multiplier: 1, marker: '' });
    assert.equal(out.state.route, null);
    assert.equal(out.warnings.length, 2);
  });

  it('repairs a dangling loadout reference rather than crashing on it', () => {
    const state = createNewGame(9, T0);
    state.player.loadout = [99999, null, null];
    const out = deserialize(serialize(state, T0));
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.deepEqual(out.state.player.loadout, [null, null, null]);
  });

  it('repairs invalid resource values and says which', () => {
    const state = createNewGame(9, T0) as unknown as Record<string, unknown>;
    ((state.resources as Record<string, unknown>).materials as Record<string, number>)['1'] = -5;
    (state.resources as Record<string, unknown>).data = Number.NaN;
    const out = deserialize(serialize(state as never, T0));
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.state.resources.materials['1'], 0);
    assert.equal(out.state.resources.data, 0);
    assert.ok(out.warnings.length >= 2);
  });

  it('rebuilds nextUid when it is missing', () => {
    const state = createNewGame(9, T0) as unknown as Record<string, unknown>;
    delete state.nextUid;
    const out = deserialize(serialize(state as never, T0));
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.state.nextUid, 4);
  });
});
