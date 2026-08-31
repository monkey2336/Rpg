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
  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
  }
  const W = canvas.width;
  const H = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const groundY = H * 0.82;

  // Sky: the same dusk the game renders, flattened into two stops.
  const sky = ctx.createLinearGradient(0, 0, 0, groundY);
  sky.addColorStop(0, '#141c2b');
  sky.addColorStop(0.52, '#6d3a1c');
  sky.addColorStop(1, '#e8a86a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, groundY);

  // Sun, low, with a wide warm halo — the light source the scene implies.
  const sunX = W * 0.72;
  const sunY = groundY - H * 0.14;
  const halo = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, H * 0.9);
  halo.addColorStop(0, hexA(s.accent, 0.55));
  halo.addColorStop(1, hexA(s.accent, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, W, groundY);
  ctx.fillStyle = '#fff0d4';
  ctx.beginPath();
  ctx.arc(sunX, sunY, H * 0.05, 0, Math.PI * 2);
  ctx.fill();

  // Kilns: tapered, parallaxed off cycle progress so the scene creeps as the
  // route runs. Two layers, the far one lighter, for a little aerial depth.
  const drift = s.cycleProgress * W * 0.35;
  for (const [layer, color, scale] of [[0.45, '#3a2718', 0.7], [1, '#150f0a', 1]] as const) {
    for (let i = -1; i < 5; i++) {
      const seedX = i * W * 0.31;
      const x = ((seedX - drift * layer) % (W * 1.55) + W * 1.55) % (W * 1.55) - W * 0.28;
      const bw = W * (0.05 + ((i + 5) % 3) * 0.018) * scale;
      const bh = H * (0.3 + ((i + 7) % 4) * 0.11) * scale;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x - bw, groundY);
      ctx.lineTo(x - bw * 0.68, groundY - bh);
      ctx.lineTo(x + bw * 0.68, groundY - bh);
      ctx.lineTo(x + bw, groundY);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(x - bw * 0.14, groundY - bh - H * 0.1 * scale, bw * 0.28, H * 0.1 * scale);
    }
  }

  // Ground, with a lit rim at the horizon.
  const sand = ctx.createLinearGradient(0, groundY, 0, H);
  sand.addColorStop(0, '#4a2f1a');
  sand.addColorStop(1, '#120c08');
  ctx.fillStyle = sand;
  ctx.fillRect(0, groundY, W, H - groundY);
  ctx.fillStyle = hexA(s.accent, 0.5);
  ctx.fillRect(0, groundY, W, Math.max(1, H * 0.006));

  // The ship, small, doing the work.
  const px = W * 0.2 + Math.sin(s.tick * 0.003) * W * 0.04;
  ctx.fillStyle = '#0a0705';
  ctx.beginPath();
  ctx.moveTo(px - W * 0.035, groundY);
  ctx.lineTo(px - W * 0.022, groundY - H * 0.11);
  ctx.lineTo(px + W * 0.022, groundY - H * 0.11);
  ctx.lineTo(px + W * 0.035, groundY);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(px - W * 0.004, groundY - H * 0.17, W * 0.008, H * 0.06);

  if (s.inCombat) {
    ctx.fillStyle = `rgba(196,74,47,${0.14 + 0.12 * Math.sin(s.tick * 0.25)})`;
    ctx.fillRect(0, 0, W, H);
  }
}

function hexA(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
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
