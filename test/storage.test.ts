/**
 * The storage layer's failure modes, exercised against a real temp directory.
 * These are the cases that actually eat people's saves in shipped idle games.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveSave, loadGame, saveGame, storagePaths } from '../src/main/storage.js';
import { createNewGame } from '../src/sim/state.js';
import { hashState } from '../src/sim/hash.js';

const T0 = 1_700_000_000_000;
const scratch = async () => storagePaths(await mkdtemp(join(tmpdir(), 'cenotaph-')));

describe('storage', () => {
  it('saves and loads a game', async () => {
    const paths = await scratch();
    const state = createNewGame(1, T0);
    state.resources.data = 4242;
    const saved = await saveGame(paths, state, T0);
    assert.equal(saved.ok, true);
    const loaded = await loadGame(paths);
    assert.equal(loaded.state?.resources.data, 4242);
    assert.equal(loaded.recovered, false);
  });

  it('returns an empty result rather than throwing when nothing is saved', async () => {
    const loaded = await loadGame(await scratch());
    assert.equal(loaded.state, null);
    assert.equal(loaded.source, null);
  });

  it('keeps a rolling backup chain', async () => {
    const paths = await scratch();
    for (let i = 1; i <= 5; i++) {
      const state = createNewGame(1, T0);
      state.resources.data = i;
      await saveGame(paths, state, T0 + i);
    }
    const files = await readdir(paths.dir);
    assert.ok(files.includes('save.json'));
    assert.ok(files.includes('save.bak1.json'));
    assert.ok(files.includes('save.bak3.json'));
    // bak1 holds the previous save, not the current one.
    const bak1 = JSON.parse(await readFile(paths.backups[0]!, 'utf8'));
    assert.equal(bak1.payload.resources.data, 4);
  });

  it('recovers from a corrupt primary save', async () => {
    const paths = await scratch();
    const good = createNewGame(1, T0);
    good.resources.data = 111;
    await saveGame(paths, good, T0);
    const newer = createNewGame(1, T0);
    newer.resources.data = 222;
    await saveGame(paths, newer, T0 + 1);

    await writeFile(paths.primary, '{"magic":"CENOTAPH","versio', 'utf8');
    const loaded = await loadGame(paths);
    assert.equal(loaded.recovered, true);
    assert.equal(loaded.state?.resources.data, 111);
    assert.equal(loaded.attempts.length, 1);
  });

  it('walks the whole chain when several backups are bad', async () => {
    const paths = await scratch();
    for (let i = 1; i <= 4; i++) {
      const state = createNewGame(1, T0);
      state.resources.data = i;
      await saveGame(paths, state, T0 + i);
    }
    await writeFile(paths.primary, 'garbage', 'utf8');
    await writeFile(paths.backups[0]!, 'garbage', 'utf8');
    const loaded = await loadGame(paths);
    assert.equal(loaded.recovered, true);
    assert.equal(loaded.state?.resources.data, 2);
    assert.equal(loaded.attempts.length, 2);
  });

  it('refuses to overwrite a good save with an unreadable one', async () => {
    const paths = await scratch();
    const good = createNewGame(1, T0);
    good.resources.data = 500;
    await saveGame(paths, good, T0);

    const broken = createNewGame(1, T0) as unknown as Record<string, unknown>;
    // A circular reference makes serialisation throw, standing in for any bug
    // that produces a state the save layer cannot represent.
    broken.self = broken;
    let threw = false;
    try {
      await saveGame(paths, broken as never, T0 + 1);
    } catch {
      threw = true;
    }
    const loaded = await loadGame(paths);
    assert.equal(loaded.state?.resources.data, 500, 'the good save must survive');
    assert.ok(threw || loaded.state?.resources.data === 500);
  });

  it('archives a save outside the rotation', async () => {
    const paths = await scratch();
    const state = createNewGame(1, T0);
    state.resources.data = 77;
    await saveGame(paths, state, T0);
    const archived = await archiveSave(paths, 'pre-prestige');
    assert.ok(archived);
    const raw = JSON.parse(await readFile(archived!, 'utf8'));
    assert.equal(raw.payload.resources.data, 77);
  });

  it('round-trips a state with no loss of fidelity', async () => {
    const paths = await scratch();
    const state = createNewGame(31337, T0);
    state.player.level = 19;
    state.prestige = { count: 2, multiplier: 1.64, marker: 'Bone' };
    state.inventory.items[0]!.affixes.push({ id: 'x', label: 'X', stat: 'damage', value: 1.234567 });
    await saveGame(paths, state, T0);
    const loaded = await loadGame(paths);
    assert.equal(hashState(loaded.state), hashState(state));
  });
});
