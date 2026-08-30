/**
 * The game view.
 *
 * A 2.5D side-on slice drawn entirely with canvas primitives — no art assets,
 * because the direction the brief asks for is silhouette-first: hard sun, long
 * shadows, dust in every frame, and a tiny player against enormous static
 * geometry. That composition is almost free to draw procedurally and it holds
 * up far better than low-budget textures would.
 *
 * This module is pure presentation. It reads an ArenaSnapshot and draws. It
 * cannot reach the sim and has no state that affects gameplay — the only thing
 * it remembers between frames is dust and screen shake.
 */
import type { ArenaSnapshot } from '../../sim/snapshot.js';

const GROUND_FRACTION = 0.72;
/**
 * World units across the viewport. Tuned so the player reads at roughly 80px
 * and the Kiln Warden at well over 200 — the brief's legibility bar for a boss
 * silhouette — while still leaving the kilns behind it enormous by comparison.
 */
export const WORLD_SPAN = 780;

interface Mote {
  x: number;
  y: number;
  z: number;
  size: number;
}

export class ArenaView {
  private ctx: CanvasRenderingContext2D;
  private motes: Mote[] = [];
  private shakeX = 0;
  private shakeY = 0;
  private camX = 0;
  private span = WORLD_SPAN;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    for (let i = 0; i < 220; i++) {
      this.motes.push({
        x: Math.random() * 2400 - 1200,
        y: -Math.random() * 420,
        z: 0.35 + Math.random() * 0.9,
        size: 0.6 + Math.random() * 1.7,
      });
    }
  }

  /** The span the camera is currently using; input conversion must match it. */
  currentSpan(): number {
    return this.span;
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = Math.max(1, Math.floor(w * dpr));
      this.canvas.height = Math.max(1, Math.floor(h * dpr));
    }
  }

  draw(snap: ArenaSnapshot | null): void {
    this.resize();
    const { ctx } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    if (!snap) {
      ctx.fillStyle = '#0d0b09';
      ctx.fillRect(0, 0, W, H);
      return;
    }

    // Camera. Normally it follows the player; with a boss on the field it
    // frames both and pulls back, because a set-piece the player cannot see
    // all of is not a set-piece. Both values are eased, so the pull-back on
    // the boss's arrival reads as a beat rather than a cut.
    const boss = snap.boss ? snap.entities.find((e) => e.kind === 'boss') : undefined;
    let targetX = snap.player.x;
    let targetSpan = WORLD_SPAN;
    if (boss) {
      targetX = snap.player.x * 0.55 + boss.x * 0.45;
      const needed = Math.abs(boss.x - snap.player.x) * 2.1 + boss.w * 1.6;
      targetSpan = Math.max(WORLD_SPAN, Math.min(WORLD_SPAN * 1.85, needed));
    }
    this.camX += (targetX - this.camX) * 0.09;
    this.span += (targetSpan - this.span) * 0.05;
    const scale = W / this.span;
    const groundY = H * GROUND_FRACTION;
    const cam = this.camX;

    // Screen shake decays here, in presentation, from a value the sim only ever
    // writes. Feel lives on this side of the wall.
    const shake = snap.shake;
    this.shakeX = (Math.random() - 0.5) * shake * scale * 0.9;
    this.shakeY = (Math.random() - 0.5) * shake * scale * 0.6;

    const accent = snap.accent;
    this.sky(W, groundY, accent);
    this.sun(W, groundY, accent);

    ctx.save();
    ctx.translate(this.shakeX, this.shakeY);

    // Aerial perspective: distance washes *toward* the sky through the dust, so
    // the far ridge is the lightest thing on screen and the near kilns are
    // darker. Getting this backwards makes actors — which are darker still —
    // vanish into the geometry behind them.
    this.ridge(W, groundY, cam, scale, 0.08, 0.62, '#4a3626');
    this.kilns(W, groundY, cam, scale, 0.26, '#33241a', 0.9);
    this.kilns(W, groundY, cam, scale, 0.52, '#1d1510', 0.62);

    const toX = (wx: number) => W / 2 + (wx - cam) * scale;
    const toY = (wy: number) => groundY + wy * scale;

    this.ground(W, H, groundY, accent);
    this.dust(W, groundY, cam, scale);

    for (const d of snap.deposits) this.deposit(toX(d.x), groundY, scale, d);
    for (const s of snap.scans) this.scanSite(toX(s.x), groundY, scale, s, accent);
    for (const t of snap.telegraphs) this.telegraph(t, toX, toY, scale, groundY);

    // Shadows first, as one pass, so every silhouette sits in the same light.
    for (const e of snap.entities) this.shadow(toX(e.x), groundY, e.w * scale, scale);
    // Hostiles first, player last: the one silhouette that must never be
    // occluded is the one the player is steering.
    for (const e of snap.entities) {
      if (e.kind !== 'player') this.hostile(e, toX, toY, scale, accent);
    }
    for (const e of snap.entities) {
      if (e.kind === 'player') this.player(e, snap, toX, toY, scale);
    }
    for (const p of snap.projectiles) this.projectile(p, toX, toY, scale);

    ctx.restore();
    this.vignette(W, H);
  }

  /* ------------------------------ backdrop ------------------------------- */

  private sky(W: number, groundY: number, accent: string): void {
    const g = this.ctx.createLinearGradient(0, 0, 0, groundY);
    g.addColorStop(0, '#0b0908');
    g.addColorStop(0.55, '#241a13');
    g.addColorStop(0.88, '#6b452a');
    g.addColorStop(1, mix(accent, '#d9b184', 0.5));
    this.ctx.fillStyle = g;
    this.ctx.fillRect(0, 0, W, groundY + 1);
  }

  private sun(W: number, groundY: number, accent: string): void {
    const { ctx } = this;
    const x = W * 0.74;
    const y = groundY - groundY * 0.22;
    const r = Math.max(10, W * 0.018);
    // A halo, not a bloom. The light in this game is hard.
    const halo = ctx.createRadialGradient(x, y, r, x, y, r * 9);
    halo.addColorStop(0, hexA(accent, 0.34));
    halo.addColorStop(1, hexA(accent, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, r * 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f3dcbd';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  private ridge(W: number, groundY: number, cam: number, scale: number, par: number, height: number, color: string): void {
    const { ctx } = this;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    const step = W / 40;
    for (let i = 0; i <= 40; i++) {
      const wx = (i * step - W / 2) / scale + cam * par;
      const n = hash1(Math.floor(wx / 220));
      const n2 = hash1(Math.floor(wx / 70) + 991);
      const h = groundY * height * (0.24 + n * 0.5 + n2 * 0.08);
      ctx.lineTo(i * step, groundY - h);
    }
    ctx.lineTo(W, groundY);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * The kilns: brutalist mass, tapered, pierced with a few tiny apertures.
   * Their whole job is scale — the player should read as a speck against them.
   */
  private kilns(W: number, groundY: number, cam: number, scale: number, par: number, color: string, sizeMult: number): void {
    const { ctx } = this;
    const spacing = 460;
    const first = Math.floor((cam * par - WORLD_SPAN) / spacing) - 1;
    ctx.fillStyle = color;
    for (let i = first; i < first + 12; i++) {
      const wx = i * spacing + hash1(i * 31) * 200;
      const sx = W / 2 + (wx - cam * par) * scale;
      const h = groundY * (0.42 + hash1(i * 17) * 0.5) * sizeMult;
      const w = (110 + hash1(i * 7) * 180) * scale * sizeMult;
      if (sx + w < -50 || sx - w > W + 50) continue;
      const taper = w * (0.14 + hash1(i * 3) * 0.2);
      ctx.beginPath();
      ctx.moveTo(sx - w / 2, groundY);
      ctx.lineTo(sx - w / 2 + taper, groundY - h);
      ctx.lineTo(sx + w / 2 - taper, groundY - h);
      ctx.lineTo(sx + w / 2, groundY);
      ctx.closePath();
      ctx.fill();
      // A stack, and three apertures. Nothing else — the mass carries it.
      const stackW = w * 0.15;
      ctx.fillRect(sx - stackW / 2, groundY - h - h * 0.28, stackW, h * 0.28);
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      for (let a = 0; a < 3; a++) {
        const ay = groundY - h * (0.28 + a * 0.2);
        ctx.fillRect(sx - w * 0.05, ay, w * 0.1, h * 0.045);
      }
      ctx.restore();
    }
  }

  private ground(W: number, H: number, groundY: number, accent: string): void {
    const { ctx } = this;
    const g = ctx.createLinearGradient(0, groundY, 0, H);
    g.addColorStop(0, mix(accent, '#6a4a30', 0.4));
    g.addColorStop(0.16, '#48331f');
    g.addColorStop(1, '#181009');
    ctx.fillStyle = g;
    ctx.fillRect(0, groundY, W, H - groundY);
    ctx.fillStyle = 'rgba(240,220,190,0.16)';
    ctx.fillRect(0, groundY, W, Math.max(1, H * 0.0016));
  }

  private dust(W: number, groundY: number, cam: number, scale: number): void {
    const { ctx } = this;
    const t = performance.now() * 0.00004;
    ctx.fillStyle = 'rgba(226,206,175,0.20)';
    for (const m of this.motes) {
      const wx = m.x + t * 260 * m.z;
      const sx = W / 2 + (wrapTo(wx, 1200) - cam * m.z) * scale;
      if (sx < -10 || sx > W + 10) continue;
      const sy = groundY + m.y * scale + Math.sin(t * 40 + m.x) * 4;
      ctx.fillRect(sx, sy, m.size * m.z, m.size * m.z);
    }
  }

  private vignette(W: number, H: number): void {
    const { ctx } = this;
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.78);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.62)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /* ------------------------------ actors --------------------------------- */

  /**
   * Cast shadow: long, raked away from the sun, and soft at the far end.
   *
   * A flat ellipse at this length reads as a stain on the ground rather than a
   * shadow, so it is a gradient that is dense at the feet and gone by the tip.
   */
  private shadow(sx: number, groundY: number, w: number, scale: number): void {
    const { ctx } = this;
    const len = w * 1.35;
    const cx = sx - len * 0.42;
    const ry = Math.max(2, w * 0.13);
    const g = ctx.createRadialGradient(sx - w * 0.1, groundY, 0, cx, groundY, len);
    g.addColorStop(0, 'rgba(10,8,6,0.5)');
    g.addColorStop(0.45, 'rgba(10,8,6,0.26)');
    g.addColorStop(1, 'rgba(10,8,6,0)');
    ctx.save();
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(cx, groundY + 2 * scale, len, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private player(
    e: ArenaSnapshot['entities'][number],
    snap: ArenaSnapshot,
    toX: (n: number) => number,
    toY: (n: number) => number,
    scale: number,
  ): void {
    const { ctx } = this;
    const x = toX(e.x);
    const y = toY(e.y);
    const h = e.h * scale;
    const w = e.w * scale;
    const face = e.facing;

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(face, 1);
    ctx.fillStyle = snap.player.dodging ? '#6b5a46' : '#080605';
    // Reads as a figure at a glance: legs with a gap, a flared coat hem, a
    // shoulder break, a head, and a pack on the back. A single tapered shape
    // reads as an object, which is what this was before.
    ctx.beginPath();
    ctx.rect(-w * 0.24, -h * 0.42, w * 0.18, h * 0.42);
    ctx.rect(w * 0.06, -h * 0.42, w * 0.18, h * 0.42);
    ctx.moveTo(-w * 0.52, -h * 0.3);
    ctx.lineTo(-w * 0.3, -h * 0.8);
    ctx.lineTo(w * 0.3, -h * 0.8);
    ctx.lineTo(w * 0.52, -h * 0.3);
    ctx.closePath();
    ctx.rect(-w * 0.3, -h * 0.88, w * 0.6, h * 0.1);
    ctx.rect(-w * 0.56, -h * 0.8, w * 0.24, h * 0.34);
    ctx.moveTo(w * 0.2, -h * 0.94);
    ctx.arc(0, -h * 0.94, w * 0.2, 0, Math.PI * 2);
    ctx.fill();

    // A thin bone edge all the way round keeps the silhouette legible against
    // any backdrop; the sun-facing side gets a brighter rim on top of it.
    ctx.strokeStyle = 'rgba(217,205,184,0.34)';
    ctx.lineWidth = Math.max(1, scale * 0.6);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(246,226,192,0.9)';
    ctx.lineWidth = Math.max(1.2, scale * 1.1);
    ctx.beginPath();
    ctx.moveTo(w * 0.3, -h * 0.8);
    ctx.lineTo(w * 0.52, -h * 0.3);
    ctx.stroke();
    ctx.restore();

    // Weapon line, drawn along the true aim angle so the read matches the sim.
    const ox = x;
    const oy = y - h * 0.62;
    ctx.strokeStyle = '#0a0806';
    ctx.lineWidth = Math.max(1.6, scale * 3);
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ox + Math.cos(snap.player.aim) * w * 1.9, oy + Math.sin(snap.player.aim) * w * 1.9);
    ctx.stroke();
  }

  private hostile(
    e: ArenaSnapshot['entities'][number],
    toX: (n: number) => number,
    toY: (n: number) => number,
    scale: number,
    accent: string,
  ): void {
    const { ctx } = this;
    const x = toX(e.x);
    const y = toY(e.y);
    const w = e.w * scale;
    const h = e.h * scale;

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(e.facing, 1);
    ctx.fillStyle = e.flash > 0 ? '#e4d7bf' : '#090706';
    silhouette(ctx, e.defId, e.kind, w, h);
    // Small hostiles need a rim to separate from the terrace; the boss does
    // not, and stroking its internal subpaths turns the mass into scribble.
    if (e.kind !== 'boss') {
      ctx.strokeStyle = 'rgba(232,200,158,0.55)';
      ctx.lineWidth = Math.max(1, scale * 0.7);
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(246,226,192,0.55)';
      ctx.lineWidth = Math.max(1.5, scale * 1.4);
      ctx.beginPath();
      ctx.moveTo(w * 0.22, -h);
      ctx.lineTo(w * 0.46, -h * 0.66);
      ctx.lineTo(w * 0.5, -h * 0.3);
      ctx.stroke();
    }
    ctx.restore();

    // Weak points read as a hard ring in the planet accent — the one piece of
    // saturated colour on the creature, so the eye goes straight to it.
    for (const wp of e.weakPoints) {
      const wx = toX(wp.x);
      const wy = toY(wp.y);
      const r = wp.r * scale;
      ctx.strokeStyle = accent;
      ctx.lineWidth = Math.max(1.4, scale * 2);
      ctx.beginPath();
      ctx.arc(wx, wy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = hexA(accent, 0.18);
      ctx.fill();
    }

    if (e.kind !== 'boss' && e.hpMax > 0) {
      const frac = e.hp / e.hpMax;
      const bw = Math.max(18, w * 1.2);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x - bw / 2, y - h - 9 * scale, bw, 2.5 * scale);
      ctx.fillStyle = e.shield > 0 ? '#6fa9c9' : '#b4462f';
      ctx.fillRect(x - bw / 2, y - h - 9 * scale, bw * (e.shield > 0 ? e.shield / e.shieldMax : frac), 2.5 * scale);
    }
  }

  private projectile(
    p: ArenaSnapshot['projectiles'][number],
    toX: (n: number) => number,
    toY: (n: number) => number,
    scale: number,
  ): void {
    const { ctx } = this;
    ctx.fillStyle = p.hostile ? '#d0673f' : DAMAGE_TINT[p.type] ?? '#d9cdb8';
    ctx.beginPath();
    ctx.arc(toX(p.x), toY(p.y), Math.max(1.5, p.r * scale * 0.55), 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Telegraphs. The shape vocabulary is fixed game-wide (ring, line, cone,
   * pulse, column) and the colour is the damage type, so a player who learns
   * one boss can read the next one's openers on sight.
   */
  private telegraph(
    t: ArenaSnapshot['telegraphs'][number],
    toX: (n: number) => number,
    toY: (n: number) => number,
    scale: number,
    groundY: number,
  ): void {
    const { ctx } = this;
    const color = DAMAGE_TINT[t.type] ?? '#e8853a';
    const x = toX(t.x);
    const y = toY(t.y);
    const r = t.r * scale;
    const fill = 0.08 + t.progress * 0.2;

    ctx.save();
    ctx.lineWidth = Math.max(1.2, scale * 1.4);
    ctx.strokeStyle = hexA(color, 0.3 + t.progress * 0.45);
    ctx.fillStyle = hexA(color, fill);

    switch (t.shape) {
      case 'ring':
        ctx.beginPath();
        ctx.ellipse(x, groundY, r, r * 0.18, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        break;
      case 'column': {
        // A shaft of light that fades out with height, plus a hard marker on
        // the ground where it actually lands. An opaque full-height wall reads
        // as a wall, not as a warning.
        const shaft = ctx.createLinearGradient(0, groundY - 620, 0, groundY);
        shaft.addColorStop(0, hexA(color, 0));
        shaft.addColorStop(1, hexA(color, 0.06 + t.progress * 0.16));
        ctx.fillStyle = shaft;
        ctx.fillRect(x - r, groundY - 620, r * 2, 620);
        ctx.beginPath();
        ctx.ellipse(x, groundY, r, r * 0.2, 0, 0, Math.PI * 2);
        ctx.fillStyle = hexA(color, fill + 0.12);
        ctx.fill();
        ctx.stroke();
        break;
      }
      case 'line': {
        const len = 900 * scale;
        ctx.translate(x, y);
        ctx.rotate(t.angle);
        ctx.fillRect(0, -r, len, r * 2);
        ctx.strokeRect(0, -r, len, r * 2);
        break;
      }
      case 'cone':
        ctx.translate(x, y);
        ctx.rotate(t.angle);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, r, -0.55, 0.55);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        break;
      case 'pulse': {
        const band = r * (0.35 + t.progress * 0.5);
        ctx.beginPath();
        ctx.ellipse(x, groundY, band, band * 0.2, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
    }
    ctx.restore();
  }

  private deposit(x: number, groundY: number, scale: number, d: { progress: number; depleted: boolean }): void {
    const { ctx } = this;
    const s = 13 * scale;
    ctx.fillStyle = d.depleted ? '#251c14' : '#0d0a07';
    ctx.beginPath();
    ctx.moveTo(x - s, groundY);
    ctx.lineTo(x - s * 0.5, groundY - s * 1.5);
    ctx.lineTo(x + s * 0.6, groundY - s * 1.2);
    ctx.lineTo(x + s, groundY);
    ctx.closePath();
    ctx.fill();
    if (!d.depleted && d.progress > 0) {
      ctx.fillStyle = '#c9b98f';
      ctx.fillRect(x - s, groundY - s * 1.9, s * 2 * d.progress, 2 * scale);
    }
  }

  private scanSite(x: number, groundY: number, scale: number, s: { progress: number; done: boolean }, accent: string): void {
    const { ctx } = this;
    const h = 30 * scale;
    ctx.strokeStyle = s.done ? '#3a3128' : accent;
    ctx.lineWidth = Math.max(1, scale * 1.4);
    ctx.beginPath();
    ctx.moveTo(x, groundY);
    ctx.lineTo(x, groundY - h);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, groundY - h, 4 * scale, 0, Math.PI * 2);
    ctx.stroke();
    if (!s.done && s.progress > 0) {
      ctx.fillStyle = accent;
      ctx.fillRect(x - 12 * scale, groundY - h - 9 * scale, 24 * scale * s.progress, 2 * scale);
    }
  }
}

/* ------------------------------- helpers --------------------------------- */

const DAMAGE_TINT: Record<string, string> = {
  percussive: '#d9c7a3',
  solar: '#e8853a',
  caustic: '#8fae4b',
  arc: '#6fa9c9',
};

/**
 * Creature silhouettes. Insectoid and industrial, never cute: everything is
 * built from wedges, drums and legs, and nothing has a face.
 */
/**
 * Creature silhouettes. Insectoid and industrial, never cute: wedges, drums and
 * legs, and nothing has a face.
 *
 * Convention: y = 0 is the ground the thing stands on, -h is the top of it.
 * Legged creatures raise their body to `stand` and hang legs down into the gap,
 * because a body that reaches the ground and legs drawn on top of it reads as
 * teeth rather than as an animal.
 */
function silhouette(ctx: CanvasRenderingContext2D, defId: string, kind: string, w: number, h: number): void {
  ctx.beginPath();
  switch (defId) {
    case 'shelf-tick': {
      const stand = h * 0.34;
      ctx.moveTo(-w * 0.5, -stand);
      ctx.lineTo(-w * 0.28, -h * 0.92);
      ctx.lineTo(w * 0.24, -h);
      ctx.lineTo(w * 0.5, -h * 0.5);
      ctx.lineTo(w * 0.36, -stand);
      ctx.closePath();
      legs(ctx, w, 3, stand);
      break;
    }
    case 'flint-skirmisher':
      ctx.moveTo(-w * 0.36, 0);
      ctx.lineTo(-w * 0.16, -h * 0.52);
      ctx.lineTo(-w * 0.34, -h * 0.95);
      ctx.lineTo(w * 0.12, -h);
      ctx.lineTo(w * 0.3, -h * 0.55);
      ctx.lineTo(w * 0.62, -h * 0.74);
      ctx.lineTo(w * 0.34, -h * 0.42);
      ctx.lineTo(w * 0.3, 0);
      ctx.closePath();
      break;
    case 'duster-artillery': {
      const stand = h * 0.3;
      ctx.moveTo(-w * 0.42, -stand);
      ctx.lineTo(-w * 0.34, -h * 0.88);
      ctx.lineTo(w * 0.34, -h * 0.88);
      ctx.lineTo(w * 0.42, -stand);
      ctx.closePath();
      // The barrel it lobs from, angled up and out.
      ctx.moveTo(w * 0.2, -h * 0.78);
      ctx.lineTo(w * 0.86, -h * 1.02);
      ctx.lineTo(w * 0.9, -h * 0.86);
      ctx.lineTo(w * 0.24, -h * 0.62);
      ctx.closePath();
      legs(ctx, w, 4, stand);
      break;
    }
    case 'hollow-drone':
      // Hovers: no legs, a hanging spine instead.
      ctx.ellipse(0, -h * 0.68, w * 0.5, h * 0.4, 0, 0, Math.PI * 2);
      ctx.moveTo(-w * 0.08, -h * 0.34);
      ctx.lineTo(w * 0.08, -h * 0.34);
      ctx.lineTo(w * 0.02, 0);
      ctx.lineTo(-w * 0.02, 0);
      ctx.closePath();
      break;
    case 'vault-mite': {
      const stand = h * 0.3;
      ctx.moveTo(-w * 0.5, -stand);
      ctx.lineTo(0, -h);
      ctx.lineTo(w * 0.5, -stand);
      ctx.closePath();
      legs(ctx, w, 3, stand);
      break;
    }
    case 'chalk-praetor': {
      const stand = h * 0.22;
      ctx.moveTo(-w * 0.4, -stand);
      ctx.lineTo(-w * 0.48, -h * 0.58);
      ctx.lineTo(-w * 0.24, -h * 0.98);
      ctx.lineTo(w * 0.2, -h);
      ctx.lineTo(w * 0.46, -h * 0.62);
      ctx.lineTo(w * 0.34, -stand);
      ctx.closePath();
      // The slab it carries on its off side.
      ctx.rect(-w * 0.68, -h * 0.8, w * 0.2, h * 0.52);
      legs(ctx, w, 4, stand);
      break;
    }
    case 'kiln-warden': {
      // A kiln that learned to walk. The body is held high on six legs so the
      // player can run under it, which is what phase two is about.
      const stand = h * 0.3;
      ctx.moveTo(-w * 0.48, -stand);
      ctx.lineTo(-w * 0.4, -h * 0.66);
      ctx.lineTo(-w * 0.18, -h * 0.96);
      ctx.lineTo(w * 0.22, -h);
      ctx.lineTo(w * 0.46, -h * 0.66);
      ctx.lineTo(w * 0.5, -stand);
      ctx.closePath();
      // Three stacks, rooted into the body rather than floating over it.
      for (let i = 0; i < 3; i++) {
        const sx = -w * 0.2 + i * w * 0.2;
        ctx.rect(sx, -h * 1.3 + i * h * 0.07, w * 0.075, h * 0.42);
      }
      legs(ctx, w, 6, stand);
      break;
    }
    default:
      ctx.rect(-w / 2, -h, w, h);
  }
  void kind;
  ctx.fill();
}

/** Legs hanging from `stand` (the body's underside) down to the ground. */
function legs(ctx: CanvasRenderingContext2D, w: number, count: number, stand: number): void {
  const span = w * 0.86;
  for (let i = 0; i < count; i++) {
    const lx = -span / 2 + (i * span) / Math.max(1, count - 1);
    const kneeOut = (i < count / 2 ? -1 : 1) * w * 0.09;
    const thick = Math.max(1.2, w * 0.028);
    ctx.moveTo(lx - thick, -stand);
    ctx.lineTo(lx + kneeOut - thick, -stand * 0.42);
    ctx.lineTo(lx + kneeOut * 1.5, 0);
    ctx.lineTo(lx + kneeOut * 1.5 + thick, 0);
    ctx.lineTo(lx + kneeOut + thick, -stand * 0.42);
    ctx.lineTo(lx + thick, -stand);
    ctx.closePath();
  }
}

function hash1(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return (Math.imul(h, 0xc2b2ae35) >>> 0) / 4294967296;
}

function wrapTo(v: number, half: number): number {
  const span = half * 2;
  return ((((v + half) % span) + span) % span) - half;
}

function hexA(hex: string, alpha: number): string {
  const { r, g, b } = parse(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

function mix(a: string, b: string, t: number): string {
  const x = parse(a);
  const y = parse(b);
  const c = (p: number, q: number) => Math.round(p + (q - p) * t);
  return `rgb(${c(x.r, y.r)},${c(x.g, y.g)},${c(x.b, y.b)})`;
}

function parse(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}
