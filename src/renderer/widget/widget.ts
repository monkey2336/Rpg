/**
 * The idle widget.
 *
 * Performance budget from the brief: under 3% CPU on a mid-range machine, under
 * 120MB RAM, GPU near idle. The things that buy that here:
 *
 *  - It receives a WidgetSnapshot of a few hundred bytes at the configured fps
 *    (default 12), not a full arena state at 40Hz. The host does the throttling.
 *  - The vignette canvas is 360x54 at capped DPR, repainted only when a
 *    snapshot arrives, and skipped entirely when the window is hidden or the
 *    user has set fps to 0.
 *  - No CSS animations, filters or shadows: an idle widget composites almost
 *    nothing between snapshots.
 *  - `document.hidden` pauses painting outright, so a widget behind a
 *    full-screen app costs nothing at all.
 *
 * It never steals focus (the window is created non-focusable) and never makes
 * a sound unless the player opted into alert chimes.
 */
import { formatNumber } from '../../sim/numbers.js';
import type { WidgetSnapshot } from '../../sim/snapshot.js';
import { api } from '../full/api.js';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

const canvas = $<HTMLCanvasElement>('#vig');
const ctx = canvas.getContext('2d');
let latest: WidgetSnapshot | null = null;
let lastAlert = '';
let notation = 'short';

const fmt = (v: number): string => formatNumber(v, { mode: notation === 'scientific' ? 'scientific' : 'short' });

/* ------------------------------ interaction ------------------------------- */

// Hover grows the window; leaving shrinks it. The main process owns the actual
// resize so the corner anchor stays correct on every display.
document.body.addEventListener('mouseenter', () => {
  document.body.classList.add('expanded');
  api.widgetHover(true);
});
document.body.addEventListener('mouseleave', () => {
  document.body.classList.remove('expanded');
  api.widgetHover(false);
});

$('#restore').addEventListener('click', () => void api.setMode('full'));
// Clicking the vignette restores too — the whole widget should feel like a door.
$('#vignette').addEventListener('click', () => void api.setMode('full'));

/* -------------------------------- updates -------------------------------- */

api.onWidget((snap) => {
  latest = snap;
  paint(snap);
});

void (async () => {
  const boot = await api.boot();
  const content = boot.content as Record<string, unknown> | undefined;
  void content;
  latest = (await api.snapshot('widget')) as WidgetSnapshot;
  paint(latest);
})();

function paint(s: WidgetSnapshot): void {
  if (document.hidden) return;

  document.documentElement.style.setProperty('--accent', s.accent);
  $('#zone').textContent = s.routeZone ? s.routeZoneName : 'No route assigned';
  $('#lvl').textContent = `LV ${s.level}${s.prestige > 0 ? ` · R${s.prestige}` : ''}`;
  $('#cycle-fill').style.width = `${(s.cycleProgress * 100).toFixed(1)}%`;

  $('#t-mat').textContent = fmt(s.materials);
  $('#r-mat').textContent = s.routeZone ? `${fmt(s.materialsPerHour)}/h` : '—';
  $('#t-data').textContent = fmt(s.data);
  $('#r-data').textContent = s.routeZone ? `${fmt(s.dataPerHour)}/h` : '—';
  $('#t-hold').textContent = `${s.holdUsed}/${s.holdMax}`;
  $('#r-drops').textContent = `${s.drops} found`;

  $('#d-cycles').textContent = String(s.cycles);
  $('#d-drops').textContent = String(s.drops);
  $('#d-status').textContent = s.inCombat ? 'Deployed' : s.routeZone ? 'Running route' : 'Docked';

  const badge = $('#badge');
  badge.className = s.alert === 'none' ? 'idle' : s.alert === 'boss-ready' ? '' : 'warn';
  badge.textContent =
    s.alert === 'none' ? (s.routeZone ? 'Running' : 'Docked') : s.alertText;
  $('#tick').textContent = s.inCombat ? 'IN CONTACT' : `${s.cycles} cyc`;

  // One chime per new alert, and only if the player asked for chimes.
  if (s.alert !== 'none' && s.alert !== lastAlert) chime(s.alert);
  lastAlert = s.alert;

  paintVignette(s);
}

/**
 * The animated vignette: a horizon, the planet's accent, a drifting dust band,
 * and a mass on the right. Cheap enough to run at 12fps forever, and it makes
 * the corner feel like a window onto somewhere rather than a progress bar.
 */
function paintVignette(s: WidgetSnapshot): void {
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * dpr)) {
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
  }
  const W = canvas.width;
  const H = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#100c09');
  sky.addColorStop(0.62, '#2a1d14');
  sky.addColorStop(1, s.accent);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  const groundY = H * 0.86;
  // Two kiln masses, offset by the cycle so the scene creeps as the route runs.
  const drift = (s.cycleProgress * W * 0.5) % (W * 0.5);
  ctx.fillStyle = '#0c0907';
  for (let i = -1; i < 3; i++) {
    const x = i * W * 0.5 - drift;
    const bw = W * 0.16;
    const bh = H * (0.4 + ((i + 3) % 3) * 0.16);
    ctx.beginPath();
    ctx.moveTo(x, groundY);
    ctx.lineTo(x + bw * 0.18, groundY - bh);
    ctx.lineTo(x + bw * 0.82, groundY - bh);
    ctx.lineTo(x + bw, groundY);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = '#0a0806';
  ctx.fillRect(0, groundY, W, H - groundY);
  ctx.fillStyle = 'rgba(240,220,190,0.14)';
  ctx.fillRect(0, groundY, W, 1);

  // A single silhouette on the ground: the ship, small, doing the work.
  const px = W * 0.24 + Math.sin(s.tick * 0.004) * W * 0.05;
  ctx.fillStyle = '#050403';
  ctx.fillRect(px, groundY - H * 0.16, W * 0.045, H * 0.16);

  if (s.inCombat) {
    ctx.fillStyle = `rgba(196,74,47,${0.18 + 0.14 * Math.sin(s.tick * 0.25)})`;
    ctx.fillRect(0, 0, W, H);
  }
}

/**
 * Alert chimes. Off by default and generated inline rather than shipped as an
 * asset, so the silent case costs nothing — no audio context is created at all
 * until the player opts in and something actually happens.
 */
let audio: AudioContext | null = null;
function chime(kind: string): void {
  const s = latest;
  if (!s) return;
  if (!chimesEnabled) return;
  try {
    audio = audio ?? new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = kind === 'downed' ? 110 : kind === 'boss-ready' ? 293.66 : 174.61;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, audio.currentTime + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 1.1);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 1.2);
  } catch {
    // No audio device, or autoplay policy. Silence is the correct fallback.
  }
}

let chimesEnabled = false;
void api.catalog().then((cat) => {
  const settings = (cat as Record<string, any>).settings ?? {};
  chimesEnabled = !!settings.alertChimes;
  notation = settings.notation ?? 'short';
});

// Settings can change while the widget is open; re-read them on a slow timer
// rather than subscribing, because this is the only thing here that polls.
setInterval(() => {
  void api.catalog().then((cat) => {
    const settings = (cat as Record<string, any>).settings ?? {};
    chimesEnabled = !!settings.alertChimes;
    notation = settings.notation ?? 'short';
  });
}, 5000);
