/**
 * Full-mode shell: input capture, HUD binding, screen routing.
 *
 * The renderer owns no game state. It samples the keyboard and mouse into an
 * input frame, ships it to the host, and draws whatever snapshot comes back.
 * Everything visible here is derived; nothing here is authoritative.
 *
 * Aiming is camera-driven, as a third-person shooter should be: the reticle is
 * dead centre and the shot goes where the camera looks, so `aimYaw` and
 * `aimPitch` are simply the camera's own angles. The sim resolves movement
 * against `camYaw`, which is why the camera's heading is part of the input
 * frame rather than something presentation keeps to itself.
 */
import { formatNumber } from '../../sim/numbers.js';
import type { FullSnapshot } from '../../sim/snapshot.js';
import { api } from './api.js';
import { renderScreen, type ScreenId } from './screens.js';
import { AudioEngine } from './audio.js';
import { Scene3D } from './scene.js';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

const canvas = $<HTMLCanvasElement>('#view');
const overlay = $<HTMLCanvasElement>('#overlay-canvas');
const scene = new Scene3D(canvas, overlay);
const audio = new AudioEngine();

let snapshot: FullSnapshot | null = null;
let catalog: Record<string, any> = {};
let content: Record<string, any> = {};
let screen: ScreenId = 'map';
let feed: string[] = [];
let pointerLocked = false;

/* --------------------------------- input --------------------------------- */

const held = new Set<string>();
const camera = { yaw: -Math.PI / 2, pitch: 0.22 };
/**
 * Recoil is a real offset on the aim, not a camera flourish: a shot that kicks
 * without moving where the next one goes is a screensaver. It decays back on
 * its own, and the player fights it with the mouse like any other shooter.
 */
const recoil = { pitch: 0, yaw: 0 };
let firing = false;

const MOUSE_SENS = 0.0024;
const PITCH_MIN = -0.35;
const PITCH_MAX = 1.05;

const keyMap: Record<string, string> = {
  KeyW: 'fwd',
  ArrowUp: 'fwd',
  KeyS: 'back',
  ArrowDown: 'back',
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

// Pointer lock is what makes mouse-look feel like a game rather than a canvas.
// It is also the user gesture browsers require before audio may start, so it is
// the natural place to bring the mixer up.
canvas.addEventListener('click', () => {
  audio.resume();
  if (!pointerLocked && snapshot?.mode === 'zone') void canvas.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
  $('#lock-hint').classList.toggle('on', !pointerLocked && snapshot?.mode === 'zone');
});
window.addEventListener('mousemove', (e) => {
  if (!pointerLocked) return;
  camera.yaw += e.movementX * MOUSE_SENS;
  camera.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, camera.pitch + e.movementY * MOUSE_SENS));
});
window.addEventListener('mousedown', (e) => {
  if (e.button === 0 && pointerLocked) firing = true;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) firing = false;
});

/** One input frame per animation frame; the host resamples it per sim tick. */
function pushInput(): void {
  if (!snapshot || snapshot.mode !== 'zone') return;
  api.sendInput({
    moveX: (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0),
    moveZ: (held.has('fwd') ? 1 : 0) - (held.has('back') ? 1 : 0),
    camYaw: camera.yaw,
    jump: held.has('jump'),
    dodge: held.has('dodge'),
    fire: firing && pointerLocked,
    reload: held.has('reload'),
    interact: held.has('interact'),
    // Third person: the shot goes where the camera looks. Pitch is negated
    // because screen-down is a positive mouse delta but a negative world pitch.
    aimYaw: camera.yaw + recoil.yaw,
    aimPitch: -(camera.pitch + recoil.pitch),
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
    // Every snapshot carries the tick's events; they become muzzle flashes,
    // tracers, sparks, floating numbers, recoil and sound here and nowhere else.
    if (s.events && s.events.length > 0) {
      scene.consumeEvents(s.events, s.arena);
      audio.consumeEvents(s.events, s.arena?.player.y ?? 0);
      for (const ev of s.events) {
        if (ev.type !== 'shot') continue;
        // `amount` carries the archetype's recoil figure. Up and slightly off
        // to one side, so a burst walks rather than climbing a straight line.
        recoil.pitch += ev.amount * 0.0042;
        recoil.yaw += (Math.random() - 0.5) * ev.amount * 0.0026;
      }
    }
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
  if (name === 'return-to-ship' && document.pointerLockElement) document.exitPointerLock();
  const result = await api.command(name, payload);
  if (result.message) note(result.message);
  await refresh();
}

async function refresh(): Promise<void> {
  catalog = (await api.catalog()) as Record<string, any>;
  const settings = catalog.settings ?? {};
  audio.setVolume(typeof settings.masterVolume === 'number' ? settings.masterVolume : 0.8);
  audio.setEnabled(settings.audioEnabled !== false);
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
let lastFrame = performance.now();

function frame(now: number): void {
  requestAnimationFrame(frame);
  // Effects and camera easing run on sim-tick units so they stay in step with
  // the simulation regardless of display refresh rate.
  const dtTicks = Math.min(4, ((now - lastFrame) / 25) || 1);
  lastFrame = now;

  // Recoil recovers toward zero on its own; roughly a third of a second to
  // settle, which is long enough to feel and short enough not to fight.
  const recover = Math.pow(0.86, dtTicks);
  recoil.pitch *= recover;
  recoil.yaw *= recover;

  pushInput();
  if (!snapshot) return;

  const deployed = snapshot.mode === 'zone';
  $('#stage').classList.toggle('on', deployed);
  $('#screens').classList.toggle('on', !deployed);

  if (snapshot.mode !== lastMode) {
    lastMode = snapshot.mode;
    if (!deployed && document.pointerLockElement) document.exitPointerLock();
    $('#lock-hint').classList.toggle('on', deployed && !pointerLocked);
    void refresh();
  }

  if (deployed) {
    // The view is offset by recoil too, so the kick is visible as well as felt.
    scene.render(snapshot.arena, { yaw: camera.yaw + recoil.yaw, pitch: camera.pitch + recoil.pitch }, dtTicks, now);
    paintHud(snapshot);
    audio.update(
      !!snapshot.arena?.player.firing,
      snapshot.arena?.player.beamRamp ?? 0,
      snapshot.weapon?.damageType === 'solar' && catalog.activeArchetype === 'thurible',
    );
  } else if (now - lastScreenPaint > 500) {
    // Docked screens are static markup; repainting them at 60fps would be
    // pointless work. Half a second is plenty for a resource ticker.
    lastScreenPaint = now;
    void refresh();
  }
  paintTop(snapshot);
  paintBottom(snapshot);

  // The score follows the place, and lifts for a fight. It never speeds up —
  // intensity opens the bed's filter rather than adding a tempo this music
  // does not have.
  const intensity = !deployed ? 0 : snapshot.arena?.boss ? 1.5 : 1;
  audio.setScene(snapshot.place.planetId, snapshot.place.zoneKind, intensity);
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
      ? '<span class="kbd">W A S D</span> move <span class="kbd">Mouse</span> aim <span class="kbd">Space</span> jump <span class="kbd">Shift</span> dodge <span class="kbd">E</span> channel <span class="kbd">R</span> reload <span class="kbd">F</span> beacon <span class="kbd">Esc</span> dock'
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
    const vent = $('#boss-vent');
    vent.classList.toggle('on', a.boss.windowOpen || a.boss.warded);
    vent.textContent = a.boss.warded ? 'Warded — destroy the pylons' : a.boss.windowLabel;
    vent.style.color = a.boss.warded ? 'var(--danger)' : 'var(--accent)';
  }

  // A red bloom at the edges when badly hurt, instead of a number to read.
  const hurt = 1 - p.health / Math.max(1, p.healthMax);
  $('#damage-vignette').style.opacity = String(Math.max(0, hurt - 0.35) * 1.4);

  const ovl = $('#overlay');
  const done = a.outcome !== 'running';
  ovl.classList.toggle('on', done);
  if (done) {
    if (document.pointerLockElement) document.exitPointerLock();
    $('#ov-title').textContent = a.outcome === 'cleared' ? 'Zone cleared' : 'Downed';
    $('#ov-text').textContent =
      a.outcome === 'cleared'
        ? 'The terrace is quiet. The zone is now available as an idle route, and the ship has recorded the codex entry.'
        : 'Everything you banked is still aboard. The run is what you lost.';
  }
}

const pct = (v: number, max: number): number => (max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0);

void boot();
