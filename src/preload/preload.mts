/**
 * The renderer's entire view of the outside world.
 *
 * This file is `.mts`, not `.ts`, on purpose: Electron loads a preload through
 * `require()`, so an ES-module preload has to carry the `.mjs` extension for
 * Node to accept it. Compiling it as ESM `.js` fails at runtime with
 * ERR_REQUIRE_ESM and the renderer silently loses its entire API surface.
 *
 * Deliberately small: subscribe to snapshots, send input, name a command. There
 * is no way for a page script to reach the sim, the filesystem or Node from
 * here, and no way for it to mutate state except by naming a command the host
 * chooses to honour.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { FullSnapshot, WidgetSnapshot } from '../sim/snapshot.js';

export interface BootInfo {
  offline: unknown;
  load: unknown;
  content: unknown;
  mode: 'full' | 'widget';
}

const api = {
  onFull: (fn: (s: FullSnapshot) => void) => {
    const listener = (_e: unknown, s: FullSnapshot) => fn(s);
    ipcRenderer.on('sim:full', listener);
    return () => ipcRenderer.removeListener('sim:full', listener);
  },
  onWidget: (fn: (s: WidgetSnapshot) => void) => {
    const listener = (_e: unknown, s: WidgetSnapshot) => fn(s);
    ipcRenderer.on('sim:widget', listener);
    return () => ipcRenderer.removeListener('sim:widget', listener);
  },
  onNotice: (fn: (text: string) => void) => {
    const listener = (_e: unknown, text: string) => fn(text);
    ipcRenderer.on('sim:notice', listener);
    return () => ipcRenderer.removeListener('sim:notice', listener);
  },

  /** High frequency, fire and forget — an input frame must never await. */
  sendInput: (frame: Record<string, unknown>) => ipcRenderer.send('sim:input', frame),

  command: (name: string, payload?: Record<string, unknown>) =>
    ipcRenderer.invoke('sim:command', name, payload ?? {}),
  catalog: () => ipcRenderer.invoke('sim:catalog'),
  boot: (): Promise<BootInfo> => ipcRenderer.invoke('app:boot'),
  snapshot: (kind: 'full' | 'widget') => ipcRenderer.invoke('sim:snapshot', kind),

  setMode: (mode: 'full' | 'widget') => ipcRenderer.invoke('app:set-mode', mode),
  widgetHover: (hovered: boolean) => ipcRenderer.send('app:widget-hover', hovered),
  widgetMoved: () => ipcRenderer.send('app:widget-moved'),
  save: () => ipcRenderer.invoke('app:save'),
  quit: () => ipcRenderer.send('app:quit'),
};

export type CenotaphApi = typeof api;

contextBridge.exposeInMainWorld('cenotaph', api);
