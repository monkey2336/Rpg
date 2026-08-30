/**
 * Full-mode shell: input capture, HUD binding, screen routing.
 *
 * The renderer owns no game state. It samples the keyboard and mouse into an
 * input frame, ships it to the host, and draws whatever snapshot comes back.
 * Everything visible here is derived; nothing here is authoritative.
 */
import { formatNumber } from '../../sim/numbers.js';
import type { FullSnapshot } from '../../sim/snapshot.js';
import { api } from './api.js';
import { renderScreen, type ScreenId } from './screens.js';
import { ArenaView } from './view.js';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

const canvas = $<HTMLCanvasElement>('#view');
const view = new ArenaView(canvas);

let snapshot: FullSnapshot | null = null;
let catalog: Record<string, any> = {};
let content: Record<string, any> = {};
let screen: ScreenId = 'map';
let feed: string[] = [];

/* --------------------------------- input --------------------------------- */

const held = new Set<string>();
const pointer = { x: 0, y: 0 };
let firing = false;

const keyMap: Record<string, string> = {
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'dodge',
  ShiftRight: 'dodge',
  KeyE: 'interact',
  KeyR: 'reload',
  KeyF: 'summon',
};

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const action = keyMap[e.code];
  if (action) {
    held.add(action);
    e.preventDefault();
  }
  if (e.code === 'Digit1') void api.command('swap-slot', { slot: 0 });
  if (e.code === 'Digit2') void api.command('swap-slot', { slot: 1 });
  if (e.code === 'Digit3') void api.command('swap-slot', { slot: 2 });
  if (e.code === 'Escape' && snapshot?.mode === 'zone') void command('return-to-ship');
  if (e.code === 'Backquote') void api.setMode('widget');
});
window.addEventListener('keyup', (e) => {
  const action = keyMap[e.code];
  if (action) held.delete(action);
});
window.addEventListener('blur', () => {
  held.clear();
  firing = false;
});

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) firing = true;
});
window.addEventListener('mouseup', () => {
  firing = false;
});
canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  pointer.x = e.clientX - rect.left;
  pointer.y = e.clientY - rect.top;
});

/** Converts the pointer to world coordinates using the same layout the view draws with. */
function aimWorld(): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  // Must track the view's live span, or aiming drifts the moment the camera
  // pulls back for a boss.
  const scale = rect.width / view.currentSpan();
  const groundY = rect.height * 0.72;
  const px = snapshot?.arena?.player.x ?? 0;
  return {
    x: px + (pointer.x - rect.width / 2) / scale,
    y: (pointer.y - groundY) / scale,
  };
}

/** One input frame per animation frame; the host resamples it per sim tick. */
function pushInput(): void {
  if (!snapshot || snapshot.mode !== 'zone') return;
  const aim = aimWorld();
  api.sendInput({
    moveX: (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0),
    jump: held.has('jump'),
    dodge: held.has('dodge'),
    fire: firing,
    reload: held.has('reload'),
    interact: held.has('interact'),
    aimX: aim.x,
    aimY: aim.y,
    swapSlot: -1,
    summonBoss: held.has('summon'),
  });
}

/* --------------------------------- boot ---------------------------------- */

async function boot(): Promise<void> {
  const info = await api.boot();
  content = (info.content ?? {}) as Record<string, any>;
  await refresh();

  const offline = info.offline as { cycles?: number; data?: number; materials?: Record<string, number> } | null;
  if (offline && (offline.cycles ?? 0) > 0) {
    const mats = Object.values(offline.materials ?? {}).reduce((a, b) => a + b, 0);
    note(`While you were gone: ${offline.cycles} cycles, ${formatNumber(mats)} materials, ${formatNumber(offline.data ?? 0)} data.`);
  }
  const load = info.load as { recovered?: boolean; source?: string; warnings?: string[] } | null;
  if (load?.recovered) note(`Primary save was unreadable. Recovered from ${load.source}.`);
  for (const w of load?.warnings ?? []) note(`Save note: ${w}`);

  api.onFull((s) => {
    snapshot = s;
  });
  api.onNotice(note);

  $('#btn-dock').addEventListener('click', () => void api.setMode('widget'));
  document.querySelectorAll<HTMLButtonElement>('#nav button').forEach((btn) => {
    btn.addEventListener('click', () => {
      screen = btn.dataset.screen as ScreenId;
      document.querySelectorAll('#nav button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      void refresh();
    });
  });
  $('#ov-again').addEventListener('click', () => void command('land', { zoneId: snapshot?.arena?.zoneId }));
  $('#ov-ship').addEventListener('click', () => void command('return-to-ship'));

  snapshot = (await api.snapshot('full')) as FullSnapshot;
  requestAnimationFrame(frame);
}

async function command(name: string, payload: Record<string, unknown> = {}): Promise<void> {
  const result = await api.command(name, payload);
  if (result.message) note(result.message);
  await refresh();
}

async function refresh(): Promise<void> {
  catalog = (await api.catalog()) as Record<string, any>;
  if (snapshot && document.querySelector('#screens')?.classList.contains('on')) {
    renderScreen(screen, $('#screen'), {
      snap: snapshot,
      catalog,
      content,
      refresh: () => void refresh(),
      notify: note,
    });
  }
}

function note(text: string): void {
  feed.push(text);
  if (feed.length > 8) feed = feed.slice(-8);
  $('#feed').innerHTML = feed.map((t, i) => (i === feed.length - 1 ? `<b>${t}</b>` : t)).join(' · ');
}

/* --------------------------------- frame --------------------------------- */

let lastScreenPaint = 0;
let lastMode = '';

function frame(now: number): void {
  requestAnimationFrame(frame);
  pushInput();
  if (!snapshot) return;

  const deployed = snapshot.mode === 'zone';
  $('#stage').classList.toggle('on', deployed);
  $('#screens').classList.toggle('on', !deployed);

  if (snapshot.mode !== lastMode) {
    lastMode = snapshot.mode;
    void refresh();
  }

  if (deployed) {
    view.draw(snapshot.arena);
    paintHud(snapshot);
  } else if (now - lastScreenPaint > 500) {
    // Docked screens are static markup; repainting them at 60fps would be
    // pointless work. Half a second is plenty for a resource ticker.
    lastScreenPaint = now;
    paintTop(snapshot);
    void refresh();
  }
  paintTop(snapshot);
  paintBottom(snapshot);
}

function paintTop(s: FullSnapshot): void {
  const n = s.notation;
  const f = (v: number) => formatNumber(v, { mode: n === 'scientific' ? 'scientific' : 'short' });
  $('#t-mat1').textContent = f(s.resources.materials['1'] ?? 0);
  $('#t-mat2').textContent = f(s.resources.materials['2'] ?? 0);
  $('#t-data').textContent = f(s.resources.data);
  $('#t-hold').textContent = `${s.hold.used}/${s.hold.max}`;
  $('#t-power').textContent = f(s.power);
  $('#ident-sub').textContent = `Level ${s.level}${s.route.prestige > 0 ? ` · Reset ${s.route.prestige}` : ''}`;
}

function paintBottom(s: FullSnapshot): void {
  const r = s.route;
  $('#route-chip').textContent = r.routeZone ? `Route: ${r.routeZoneName} · ${r.cycles} cycles` : 'No route';
  $('#hint').innerHTML =
    s.mode === 'zone'
      ? '<span class="kbd">A D</span> move <span class="kbd">Space</span> jump <span class="kbd">Shift</span> dodge <span class="kbd">E</span> channel <span class="kbd">R</span> reload <span class="kbd">F</span> beacon <span class="kbd">Esc</span> dock'
      : '<span class="kbd">`</span> dock to corner';
}

function paintHud(s: FullSnapshot): void {
  const a = s.arena;
  if (!a) return;
  const p = s.player;
  $('#v-shield').style.width = `${pct(p.shield, p.shieldMax)}%`;
  $('#v-armor').style.width = `${pct(p.armor, p.armorMax)}%`;
  $('#v-health').style.width = `${pct(p.health, p.healthMax)}%`;
  $('#v-text').textContent = `${Math.ceil(p.health)} / ${Math.ceil(p.healthMax)}`;
  $('#v-status').textContent = a.player.dodging ? 'EVADING' : a.player.interacting ? 'CHANNELLING' : '';

  if (s.weapon) {
    $('#w-name').textContent = s.weapon.name;
    $('#w-ammo').textContent = `${s.weapon.ammo} / ${s.weapon.magazine}`;
    $('#w-reload').style.width = `${(s.weapon.reloadProgress * 100).toFixed(0)}%`;
  }
  $('#w-slots').innerHTML = [0, 1, 2]
    .map((i) => `<span class="slot ${i === (catalog.activeSlot ?? 0) ? 'on' : ''}">${i + 1}</span>`)
    .join('');

  $('#obj-zone').textContent = a.zoneName;
  const g = a.gate;
  $('#obj-gate').innerHTML = g.met
    ? '<span class="ready">Beacon ready — press F</span>'
    : `<b>${g.kills}</b>/${g.killsNeeded} cleared · <b>${g.deposits}</b>/${g.depositsNeeded} mined · <b>${g.scans}</b>/${g.scansNeeded} scanned`;

  const bar = $('#bossbar');
  bar.classList.toggle('on', !!a.boss);
  if (a.boss) {
    $('#boss-name').textContent = a.boss.name;
    $('#boss-fill').style.width = `${(a.boss.fraction * 100).toFixed(1)}%`;
    $('#boss-pips').innerHTML = Array.from(
      { length: a.boss.phases },
      (_, i) => `<span class="pip ${i <= a.boss!.phase ? 'on' : ''}"></span>`,
    ).join('');
    $('#boss-brief').textContent = a.boss.briefing;
  }

  const overlay = $('#overlay');
  const done = a.outcome !== 'running';
  overlay.classList.toggle('on', done);
  if (done) {
    $('#ov-title').textContent = a.outcome === 'cleared' ? 'Zone cleared' : 'Downed';
    $('#ov-text').textContent =
      a.outcome === 'cleared'
        ? 'The terrace is quiet. The zone is now available as an idle route, and the ship has recorded the codex entry.'
        : 'Everything you banked is still aboard. The run is what you lost.';
  }
}

const pct = (v: number, max: number): number => (max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0);

void boot();
