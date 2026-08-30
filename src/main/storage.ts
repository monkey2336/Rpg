/**
 * Save storage: atomic writes, rolling backups, corruption recovery.
 *
 * Quality bar #4 is "zero save loss, ever", so the write path is paranoid:
 *
 *   1. Serialise and verify the bytes deserialise before anything touches disk.
 *   2. Write to a temp file in the same directory, fsync it, fsync the dir.
 *   3. Rotate the existing save down the backup chain.
 *   4. Rename the temp file over the live save (rename is atomic on POSIX and
 *      on NTFS via ReplaceFile semantics).
 *
 * A crash at any point leaves either the previous save or the new one intact,
 * never a half-written file. On load, a bad primary falls through the backup
 * chain rather than starting a new game — losing an hour is survivable, losing
 * the save is not.
 */
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { deserialize, serialize } from '../sim/save.js';
import type { GameState } from '../sim/state.js';

export const BACKUP_DEPTH = 3;

export interface StoragePaths {
  dir: string;
  primary: string;
  backups: string[];
  temp: string;
}

export function storagePaths(userDataDir: string): StoragePaths {
  const dir = join(userDataDir, 'saves');
  return {
    dir,
    primary: join(dir, 'save.json'),
    backups: Array.from({ length: BACKUP_DEPTH }, (_, i) => join(dir, `save.bak${i + 1}.json`)),
    temp: join(dir, 'save.tmp'),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** fsync a directory entry so a rename is durable, not just visible. */
async function syncDir(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is unsupported on some platforms; the rename is still
    // atomic there, so this is a durability nicety rather than a correctness one.
  }
}

export interface SaveResult {
  ok: boolean;
  path: string;
  bytes: number;
  error?: string;
}

export async function saveGame(paths: StoragePaths, state: GameState, nowMs: number): Promise<SaveResult> {
  await mkdir(paths.dir, { recursive: true });
  const raw = serialize(state, nowMs);

  // Read-back check *before* the old save is touched. If the state cannot be
  // deserialised, the bug is upstream and the existing save is still good.
  const verify = deserialize(raw);
  if (!verify.ok) {
    return { ok: false, path: paths.primary, bytes: 0, error: `refused to write unreadable save: ${verify.reason}` };
  }

  try {
    const handle = await open(paths.temp, 'w');
    try {
      await handle.writeFile(raw, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    // Rotate: bak2 -> bak3, bak1 -> bak2, primary -> bak1.
    for (let i = paths.backups.length - 1; i > 0; i--) {
      const from = paths.backups[i - 1]!;
      const to = paths.backups[i]!;
      if (await exists(from)) await rename(from, to);
    }
    if (await exists(paths.primary)) await rename(paths.primary, paths.backups[0]!);

    await rename(paths.temp, paths.primary);
    await syncDir(paths.dir);
    return { ok: true, path: paths.primary, bytes: Buffer.byteLength(raw, 'utf8') };
  } catch (err) {
    return { ok: false, path: paths.primary, bytes: 0, error: (err as Error).message };
  }
}

export interface LoadResult {
  state: GameState | null;
  /** Which file actually supplied the state. */
  source: string | null;
  /** True when the primary save was unusable and a backup was used. */
  recovered: boolean;
  migratedFrom: number | null;
  warnings: string[];
  /** Every file tried, with why it was rejected. Surfaced in the debug overlay. */
  attempts: { path: string; reason: string }[];
}

export async function loadGame(paths: StoragePaths): Promise<LoadResult> {
  const result: LoadResult = {
    state: null,
    source: null,
    recovered: false,
    migratedFrom: null,
    warnings: [],
    attempts: [],
  };

  const candidates = [paths.primary, ...paths.backups];
  for (let i = 0; i < candidates.length; i++) {
    const path = candidates[i]!;
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') result.attempts.push({ path, reason: e.message });
      continue;
    }
    const parsed = deserialize(raw);
    if (!parsed.ok) {
      result.attempts.push({ path, reason: parsed.reason });
      continue;
    }
    result.state = parsed.state;
    result.source = path;
    result.recovered = i > 0;
    result.migratedFrom = parsed.migratedFrom;
    result.warnings = parsed.warnings;
    return result;
  }
  return result;
}

/**
 * Snapshot the current save outside the rotation, before something risky —
 * a schema migration or a prestige reset. These are never overwritten.
 */
export async function archiveSave(paths: StoragePaths, label: string): Promise<string | null> {
  if (!(await exists(paths.primary))) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(paths.dir, `archive-${label}-${stamp}.json`);
  await writeFile(target, await readFile(paths.primary, 'utf8'), 'utf8');
  return target;
}

export async function clearSaves(paths: StoragePaths): Promise<void> {
  for (const path of [paths.primary, ...paths.backups, paths.temp]) {
    try {
      await unlink(path);
    } catch {
      // Already gone is the desired end state.
    }
  }
}

export { dirname };
