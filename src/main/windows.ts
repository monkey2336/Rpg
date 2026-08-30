/**
 * The dual-mode window layer — the brief's defining feature, treated as a
 * first-class product requirement rather than a window resize.
 *
 * Two BrowserWindows exist for the life of the app:
 *
 *   full   — ordinary resizable game window, hidden while docked.
 *   widget — frameless, transparent, always-on-top, ~360x220, corner-snapped,
 *            position remembered across sessions, never focus-stealing.
 *
 * Switching modes shows one and hides the other. Neither is ever destroyed and
 * neither owns any state, so "click to restore" is instant with no loading
 * screen and nothing to lose — the sim never stopped and never moved.
 */
import { BrowserWindow, screen, shell } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Settings, WidgetCorner } from '../sim/state.js';

const here = fileURLToPath(new URL('.', import.meta.url));
// .mjs, not .js — see the note at the top of src/preload/preload.mts.
const PRELOAD = join(here, '../preload/preload.mjs');
const RENDERER = join(here, '../renderer');

export const WIDGET_SIZE = { width: 360, height: 220 };
export const WIDGET_HOVER_SIZE = { width: 480, height: 320 };

export type AppMode = 'full' | 'widget';

export interface Windows {
  full: BrowserWindow;
  widget: BrowserWindow;
}

export function createWindows(settings: Settings): Windows {
  const full = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0d0b09',
    title: 'Cenotaph',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preloads require the sandbox off. This is a single-player offline
      // game with no remote content: the renderer only ever loads local files,
      // and contextIsolation still keeps Node out of page scripts.
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  full.loadFile(join(RENDERER, 'full/index.html'));

  const widget = new BrowserWindow({
    ...WIDGET_SIZE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // Never steals focus, on show or on click.
    focusable: false,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The widget must keep rendering while it is the only thing on screen and
      // the user is working in another app, so Chromium's background throttling
      // has to be off. Its own frame rate is capped in the sim host instead.
      backgroundThrottling: false,
    },
  });
  widget.loadFile(join(RENDERER, 'widget/index.html'));

  // "Always on top" over full-screen apps needs the screen-saver level; the
  // plain flag sits below them on Windows and macOS alike.
  widget.setAlwaysOnTop(true, 'screen-saver');
  widget.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  for (const win of [full, widget]) {
    win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });
  }

  applyWidgetSettings(widget, settings);
  return { full, widget };
}

/** Corner-snapped placement within the display the widget currently sits on. */
export function positionWidget(widget: BrowserWindow, settings: Settings, hovered = false): void {
  const size = hovered ? WIDGET_HOVER_SIZE : WIDGET_SIZE;
  const bounds = widget.getBounds();
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const wa = display.workArea;
  const ox = Math.max(0, settings.widgetOffsetX);
  const oy = Math.max(0, settings.widgetOffsetY);

  const x = isRight(settings.widgetCorner) ? wa.x + wa.width - size.width - ox : wa.x + ox;
  const y = isBottom(settings.widgetCorner) ? wa.y + wa.height - size.height - oy : wa.y + oy;
  widget.setBounds({ x: Math.round(x), y: Math.round(y), ...size }, false);
}

const isRight = (c: WidgetCorner) => c === 'tr' || c === 'br';
const isBottom = (c: WidgetCorner) => c === 'bl' || c === 'br';

export function applyWidgetSettings(widget: BrowserWindow, settings: Settings): void {
  widget.setOpacity(clamp01(settings.widgetOpacity));
  // Click-through: the widget becomes a pure overlay. `forward: true` keeps
  // mouse-move events flowing so hover-to-expand still works while clicks pass
  // straight to whatever is underneath.
  widget.setIgnoreMouseEvents(settings.widgetClickThrough, { forward: true });
  positionWidget(widget, settings);
}

const clamp01 = (v: number) => (v < 0.15 ? 0.15 : v > 1 ? 1 : v);

/**
 * Infers which corner the widget was dragged to, so a manual move is
 * remembered as a corner plus an offset rather than raw coordinates that break
 * when the display arrangement changes.
 */
export function cornerFromBounds(widget: BrowserWindow): { corner: WidgetCorner; offsetX: number; offsetY: number } {
  const b = widget.getBounds();
  const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  const right = b.x + b.width / 2 > wa.x + wa.width / 2;
  const bottom = b.y + b.height / 2 > wa.y + wa.height / 2;
  const corner: WidgetCorner = right ? (bottom ? 'br' : 'tr') : bottom ? 'bl' : 'tl';
  return {
    corner,
    offsetX: Math.round(right ? wa.x + wa.width - (b.x + b.width) : b.x - wa.x),
    offsetY: Math.round(bottom ? wa.y + wa.height - (b.y + b.height) : b.y - wa.y),
  };
}

export function setMode(windows: Windows, mode: AppMode, settings: Settings): void {
  if (mode === 'widget') {
    positionWidget(windows.widget, settings);
    windows.widget.showInactive();
    windows.full.hide();
  } else {
    windows.widget.hide();
    windows.full.show();
    windows.full.focus();
  }
}

export function resizeWidget(widget: BrowserWindow, settings: Settings, hovered: boolean): void {
  positionWidget(widget, settings, hovered);
}
