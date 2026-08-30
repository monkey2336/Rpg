/**
 * The sim host: the one place the game clock lives.
 *
 * The simulation runs here, in the main process, whether or not any window is
 * open. Renderers are subscribers. That is the concrete form of the "three
 * render targets" requirement — full, widget and none are all just different
 * subscription sets over one authoritative sim.
 *
 * Two cadences:
 *   deployed (an arena is live) — 40Hz, one tick at a time, full input.
 *   docked   (route only)       — 4Hz, batching 10 ticks per step.
 *
 * The docked cadence is the widget's whole performance story. There is no arena
 * to step, so the batch resolves through the same arithmetic the offline
 * resolver uses, and the process spends its time asleep instead of ticking.
 */
import { TICK_MS } from '../sim/combat.js';
import { NEUTRAL_INPUT, type InputFrame } from '../sim/arena.js';
import { resolveOffline } from '../sim/offline.js';
import {
  invalidatePlan,
  newSession,
  sessionFromState,
  tickSession,
  type Session,
  type TickResult,
} from '../sim/sim.js';
import { buildFullSnapshot, buildWidgetSnapshot, type FullSnapshot, type WidgetSnapshot } from '../sim/snapshot.js';
import type { OfflineReport } from '../sim/state.js';
import { loadGame, saveGame, type LoadResult, type StoragePaths } from './storage.js';

/** Ticks batched per step while docked. 10 ticks = 250ms of sim per wake. */
const DOCKED_BATCH = 10;
const DOCKED_INTERVAL_MS = TICK_MS * DOCKED_BATCH;
const AUTOSAVE_MS = 20_000;

export interface HostEvents {
  onFull?: (snapshot: FullSnapshot) => void;
  onWidget?: (snapshot: WidgetSnapshot) => void;
  onNotice?: (text: string) => void;
}

export class SimHost {
  session: Session;
  private input: InputFrame = { ...NEUTRAL_INPUT };
  private timer: NodeJS.Timeout | null = null;
  private cadence: 'docked' | 'deployed' = 'docked';
  private lastAutosave = 0;
  private lastWidgetPush = 0;
  private notices: string[] = [];
  private handlers: HostEvents = {};
  private saving = false;
  private dirty = false;

  constructor(
    private paths: StoragePaths,
    session?: Session,
  ) {
    this.session = session ?? newSession((Date.now() ^ 0x5f3759df) >>> 0, Date.now());
  }

  /**
   * Loads a save (falling back through backups) and settles offline progress.
   * Returns both so the UI can show "while you were gone" and any recovery
   * warnings in the same panel.
   */
  static async boot(paths: StoragePaths): Promise<{ host: SimHost; load: LoadResult; offline: OfflineReport | null }> {
    const load = await loadGame(paths);
    const now = Date.now();
    let session: Session;
    let offline: OfflineReport | null = null;
    if (load.state) {
      session = sessionFromState(load.state);
      offline = resolveOffline(session.state, now);
    } else {
      session = newSession((now ^ 0x5f3759df) >>> 0, now);
    }
    return { host: new SimHost(paths, session), load, offline };
  }

  on(handlers: HostEvents): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  setInput(frame: Partial<InputFrame>): void {
    this.input = { ...this.input, ...frame };
  }

  /** Called after anything that changes gear, tech or ship ranks. */
  invalidate(): void {
    invalidatePlan(this.session);
    this.dirty = true;
  }

  start(): void {
    this.reschedule();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private desiredCadence(): 'docked' | 'deployed' {
    return this.session.arena && this.session.arena.outcome === 'running' ? 'deployed' : 'docked';
  }

  private reschedule(): void {
    const want = this.desiredCadence();
    if (this.timer && want === this.cadence) return;
    if (this.timer) clearInterval(this.timer);
    this.cadence = want;
    const interval = want === 'deployed' ? TICK_MS : DOCKED_INTERVAL_MS;
    this.timer = setInterval(() => this.step(), interval);
    if (this.timer.unref) this.timer.unref();
  }

  private step(): void {
    const result: TickResult =
      this.cadence === 'deployed'
        ? tickSession(this.session, this.input, 1)
        : tickSession(this.session, NEUTRAL_INPUT, DOCKED_BATCH);

    if (result.notices.length > 0) {
      for (const n of result.notices) {
        this.notices.push(n);
        this.handlers.onNotice?.(n);
      }
      if (this.notices.length > 40) this.notices = this.notices.slice(-40);
      this.dirty = true;
    }
    if (result.events.length > 0) this.dirty = true;

    this.publish();
    this.reschedule();
    void this.maybeAutosave();
  }

  /**
   * Pushes snapshots. The full view gets one per tick while deployed; the
   * widget gets one at its configured fps, which is the difference between a
   * 12fps corner vignette and a 40Hz IPC firehose nobody asked for.
   */
  private publish(): void {
    const now = Date.now();
    if (this.handlers.onFull) {
      this.handlers.onFull(buildFullSnapshot(this.session, this.notices.slice(-6)));
    }
    if (this.handlers.onWidget) {
      const fps = this.session.state.settings.widgetFps;
      const minGap = fps > 0 ? 1000 / fps : 1000;
      if (now - this.lastWidgetPush >= minGap) {
        this.lastWidgetPush = now;
        this.handlers.onWidget(buildWidgetSnapshot(this.session));
      }
    }
  }

  fullSnapshot(): FullSnapshot {
    return buildFullSnapshot(this.session, this.notices.slice(-6));
  }

  widgetSnapshot(): WidgetSnapshot {
    return buildWidgetSnapshot(this.session);
  }

  private async maybeAutosave(): Promise<void> {
    const now = Date.now();
    if (this.saving || now - this.lastAutosave < AUTOSAVE_MS) return;
    this.lastAutosave = now;
    await this.save();
  }

  async save(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    try {
      const result = await saveGame(this.paths, this.session.state, Date.now());
      if (!result.ok) this.handlers.onNotice?.(`Save failed: ${result.error ?? 'unknown'}`);
      else this.dirty = false;
    } catch (err) {
      this.handlers.onNotice?.(`Save failed: ${(err as Error).message}`);
    } finally {
      this.saving = false;
    }
  }

  hasUnsavedWork(): boolean {
    return this.dirty;
  }
}
