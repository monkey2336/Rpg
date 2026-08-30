/**
 * App lifecycle and IPC wiring.
 *
 * The sim starts before any window does and keeps running if every window is
 * hidden — "render target: none" is not a special case here, it is just what
 * happens when nobody has subscribed.
 */
import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron';
import { runCommand, readCatalog, type CommandName } from './commands.js';
import { SimHost } from './simhost.js';
import { storagePaths } from './storage.js';
import {
  applyWidgetSettings,
  cornerFromBounds,
  createWindows,
  resizeWidget,
  setMode,
  type AppMode,
  type Windows,
} from './windows.js';
import { BOSS_DEFS, PLANETS, ZONES } from '../sim/content/index.js';
import { DAMAGE_COLOR, DAMAGE_LABEL } from '../sim/content/damage.js';
import { MATERIAL_NAMES, RARITY_DEFS } from '../sim/content/items.js';
import { WEAPON_ARCHETYPES } from '../sim/content/weapons.js';

let host: SimHost;
let windows: Windows;
let mode: AppMode = 'full';
let bootInfo: Record<string, unknown> = {};

/** Static content the renderers need to draw labels without duplicating data. */
function contentManifest(): Record<string, unknown> {
  return {
    planets: PLANETS,
    zones: ZONES,
    bosses: BOSS_DEFS.map((b) => ({ id: b.id, name: b.name, epithet: b.epithet, phases: b.phases })),
    archetypes: WEAPON_ARCHETYPES,
    rarities: RARITY_DEFS,
    damageLabels: DAMAGE_LABEL,
    damageColors: DAMAGE_COLOR,
    materials: MATERIAL_NAMES,
  };
}

async function boot(): Promise<void> {
  const paths = storagePaths(app.getPath('userData'));
  const booted = await SimHost.boot(paths);
  host = booted.host;
  bootInfo = { offline: booted.offline, load: { ...booted.load, state: undefined } };

  windows = createWindows(host.session.state.settings);

  host.on({
    onFull: (snapshot) => {
      if (!windows.full.isDestroyed() && windows.full.isVisible()) {
        windows.full.webContents.send('sim:full', snapshot);
      }
    },
    onWidget: (snapshot) => {
      if (!windows.widget.isDestroyed() && windows.widget.isVisible()) {
        windows.widget.webContents.send('sim:widget', snapshot);
      }
    },
    onNotice: (text) => {
      for (const win of [windows.full, windows.widget]) {
        if (!win.isDestroyed()) win.webContents.send('sim:notice', text);
      }
    },
  });

  windows.full.once('ready-to-show', () => setMode(windows, 'full', host.session.state.settings));

  // Minimising the game window docks it rather than dropping it in the taskbar.
  // That is the interaction the widget exists for, so it is the default. The
  // restore() is what keeps the window in a normal state, so bringing it back
  // is a plain show() with nothing to un-minimise first.
  windows.full.on('minimize', () => {
    windows.full.restore();
    mode = 'widget';
    setMode(windows, 'widget', host.session.state.settings);
  });

  windows.full.on('close', async (event) => {
    event.preventDefault();
    await shutdown();
  });

  windows.widget.on('moved', () => {
    const placement = cornerFromBounds(windows.widget);
    host.session.state.settings.widgetCorner = placement.corner;
    host.session.state.settings.widgetOffsetX = placement.offsetX;
    host.session.state.settings.widgetOffsetY = placement.offsetY;
  });

  // A machine waking from sleep has to settle offline progress the same way a
  // cold start does, or an overnight suspend silently eats a night's route.
  powerMonitor.on('resume', () => {
    void host.save();
  });

  host.start();
  registerIpc();
  if (process.env.CENOTAPH_SMOKE) {
    for (const [tag, win] of [['full', windows.full], ['widget', windows.widget]] as const) {
      win.webContents.on('console-message', (_e, level, message, line, source) => {
        console.log(`[${tag}:${level}] ${message} (${source}:${line})`);
      });
      win.webContents.on('preload-error', (_e, path, error) => {
        console.log(`[${tag}:preload-error] ${path}: ${error.message}`);
      });
      win.webContents.on('did-fail-load', (_e, code, desc, url) => {
        console.log(`[${tag}:did-fail-load] ${code} ${desc} ${url}`);
      });
    }
    void smokeTest();
  }
}

/**
 * Headless verification of the shell itself.
 *
 * The sim has a test suite; the window layer does not lend itself to one, so
 * this drives the real app under a virtual display: boot, land in a zone, hold
 * fire for a few seconds, capture the full view, dock to the corner, capture
 * the widget, and report window geometry. Run with
 * `CENOTAPH_SMOKE=<outdir> xvfb-run -a electron .`.
 */
async function smokeTest(): Promise<void> {
  const outDir = process.env.CENOTAPH_SMOKE!;
  const { writeFile } = await import('node:fs/promises');
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const report: Record<string, unknown> = {};

  try {
    await wait(1200);
    runCommand(host, 'land', { zoneId: 'ochre-shelf' });

    // Drive with the reference bot so the captures show the game actually being
    // played, not a mannequin on an empty terrace. The host reads whatever input
    // frame is current, so pushing one per sim tick is exactly what a human does.
    const { botInput } = await import('../headless/bot.js');
    let botTick = 0;
    const driving = setInterval(() => {
      host.setInput(botInput(host.session, botTick++) as unknown as Record<string, unknown>);
    }, 25);

    await wait(6000);
    const full = await windows.full.webContents.capturePage();
    await writeFile(`${outDir}/full.png`, full.toPNG());
    report.fullBounds = windows.full.getBounds();

    // Force the gate rather than waiting for the bot to grind it. This harness
    // exists to verify that the shell renders the set-piece; that the loop is
    // *completable* is proven by the headless soak, which does grind it.
    const arena = host.session.arena;
    if (arena) {
      arena.kills = 999;
      arena.minedCount = 999;
      arena.scannedCount = 999;
    }
    const deadline = Date.now() + 40_000;
    while (!host.session.arena?.bossSpawned && Date.now() < deadline) await wait(200);
    await wait(6000);
    const bossShot = await windows.full.webContents.capturePage();
    await writeFile(`${outDir}/boss.png`, bossShot.toPNG());
    clearInterval(driving);

    report.arena = {
      entities: host.session.arena?.entities.length ?? 0,
      kills: host.session.arena?.kills ?? 0,
      bossSpawned: host.session.arena?.bossSpawned,
      bossPhase: host.session.arena?.bossPhase,
      outcome: host.session.arena?.outcome,
    };

    // Clear the zone outright so the widget capture shows a running route.
    host.session.state.zones['ochre-shelf']!.cleared = true;
    runCommand(host, 'return-to-ship');
    runCommand(host, 'assign-route', { zoneId: 'ochre-shelf' });
    host.setInput({ fire: false, moveX: 0, interact: false, summonBoss: false });

    mode = 'widget';
    setMode(windows, 'widget', host.session.state.settings);
    await wait(3000);
    const widget = await windows.widget.webContents.capturePage();
    await writeFile(`${outDir}/widget.png`, widget.toPNG());
    report.widgetBounds = windows.widget.getBounds();
    report.widgetAlwaysOnTop = windows.widget.isAlwaysOnTop();
    report.widgetFocusable = windows.widget.isFocusable();
    report.fullVisible = windows.full.isVisible();

    // Hover expansion, then back.
    resizeWidget(windows.widget, host.session.state.settings, true);
    await wait(700);
    report.widgetHoverBounds = windows.widget.getBounds();
    const hovered = await windows.widget.webContents.capturePage();
    await writeFile(`${outDir}/widget-hover.png`, hovered.toPNG());

    mode = 'full';
    setMode(windows, 'full', host.session.state.settings);
    await wait(1200);
    const back = await windows.full.webContents.capturePage();
    await writeFile(`${outDir}/full-docked.png`, back.toPNG());

    // Walk the docked screens. Each pulls a different projection out of the
    // catalog, so a capture of each is the cheapest real check that they bind.
    for (const screen of ['hold', 'tech', 'ship', 'codex', 'settings']) {
      await windows.full.webContents.executeJavaScript(
        `document.querySelector('#nav button[data-screen="${screen}"]').click()`,
      );
      await wait(700);
      const shot = await windows.full.webContents.capturePage();
      await writeFile(`${outDir}/screen-${screen}.png`, shot.toPNG());
    }
    report.screensCaptured = 5;
    report.route = host.session.state.route;
    report.restoredVisible = windows.full.isVisible();
    report.ok = true;
  } catch (err) {
    report.ok = false;
    report.error = (err as Error).message;
    report.stack = (err as Error).stack;
  }
  await writeFile(`${outDir}/report.json`, JSON.stringify(report, null, 2));
  await shutdown();
}

function registerIpc(): void {
  ipcMain.handle('app:boot', () => ({ ...bootInfo, content: contentManifest(), mode }));

  ipcMain.handle('sim:snapshot', (_e, kind: 'full' | 'widget') =>
    kind === 'widget' ? host.widgetSnapshot() : host.fullSnapshot(),
  );

  ipcMain.handle('sim:catalog', () => readCatalog(host));

  ipcMain.handle('sim:command', (_e, name: CommandName, payload: Record<string, unknown>) => {
    const result = runCommand(host, name, payload);
    if (name === 'update-settings') applyWidgetSettings(windows.widget, host.session.state.settings);
    return result;
  });

  ipcMain.on('sim:input', (_e, frame: Record<string, unknown>) => host.setInput(frame));

  ipcMain.handle('app:set-mode', (_e, next: AppMode) => {
    mode = next;
    setMode(windows, next, host.session.state.settings);
    // Push one snapshot immediately so a restored window is never blank.
    const target = next === 'widget' ? windows.widget : windows.full;
    const channel = next === 'widget' ? 'sim:widget' : 'sim:full';
    const payload = next === 'widget' ? host.widgetSnapshot() : host.fullSnapshot();
    target.webContents.send(channel, payload);
    return mode;
  });

  ipcMain.on('app:widget-hover', (_e, hovered: boolean) => {
    if (mode !== 'widget' || windows.widget.isDestroyed()) return;
    resizeWidget(windows.widget, host.session.state.settings, hovered);
  });

  ipcMain.handle('app:save', async () => {
    await host.save();
    return true;
  });

  ipcMain.on('app:quit', () => void shutdown());
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  host.stop();
  // The last save is the one that matters most; nothing else runs until it lands.
  await host.save();
  app.exit(0);
}

app.whenReady().then(boot).catch((err) => {
  console.error('failed to start:', err);
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') void shutdown();
});

app.on('before-quit', (event) => {
  if (!shuttingDown) {
    event.preventDefault();
    void shutdown();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void boot();
});
