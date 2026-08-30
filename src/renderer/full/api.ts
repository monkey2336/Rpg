/** The preload bridge, as the renderer sees it. */
import type { FullSnapshot, WidgetSnapshot } from '../../sim/snapshot.js';

export interface CenotaphApi {
  onFull(fn: (s: FullSnapshot) => void): () => void;
  onWidget(fn: (s: WidgetSnapshot) => void): () => void;
  onNotice(fn: (text: string) => void): () => void;
  sendInput(frame: Record<string, unknown>): void;
  command(name: string, payload?: Record<string, unknown>): Promise<{ ok: boolean; message: string; data?: unknown }>;
  catalog(): Promise<Record<string, unknown>>;
  boot(): Promise<Record<string, unknown>>;
  snapshot(kind: 'full' | 'widget'): Promise<FullSnapshot | WidgetSnapshot>;
  setMode(mode: 'full' | 'widget'): Promise<string>;
  widgetHover(hovered: boolean): void;
  widgetMoved(): void;
  save(): Promise<boolean>;
  quit(): void;
}

declare global {
  interface Window {
    cenotaph: CenotaphApi;
  }
}

export const api: CenotaphApi = window.cenotaph;
