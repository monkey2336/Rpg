/**
 * Procedural audio.
 *
 * The brief puts weapon impact at half of how a shooter feels and asks for a
 * sparse, low-frequency, drone-forward identity. Everything here is synthesised
 * at runtime through the Web Audio API — no sample files — for the same reason
 * there are no art assets: it keeps the whole game one committed direction with
 * no pipeline, it ships offline, and a cue is a handful of numbers to tune
 * rather than a file to re-record.
 *
 * The cue table is written against `BaseAudioContext`, not `AudioContext`, so
 * every cue can also be rendered into an `OfflineAudioContext`. That is what
 * makes the audio testable: `scripts/smoke.mjs` renders each cue headlessly and
 * asserts it is audible and the right length, which is the only way to verify
 * sound in a build nobody can listen to.
 */
import { buildBed, playToll, soundscapeFor, type Bed, type SoundscapeDef } from './soundscape.js';

export type CueName =
  | 'fire-adze'
  | 'fire-censer'
  | 'fire-generic'
  | 'impact-shield'
  | 'impact-armor'
  | 'impact-health'
  | 'impact-weak'
  | 'warded'
  | 'chain'
  | 'kill'
  | 'reload'
  | 'dodge'
  | 'player-hit'
  | 'shield-break'
  | 'telegraph'
  | 'resolve'
  | 'phase'
  | 'vent'
  | 'gate'
  | 'mined'
  | 'scanned'
  | 'boss-down'
  | 'player-down';

export interface CueOptions {
  /** 0..1, scales the cue's own level. */
  gain?: number;
  /** Semitone-ish detune, so repeats never sound like a loop. */
  vary?: number;
}

/* ------------------------------ primitives -------------------------------- */

let sharedNoise: AudioBuffer | null = null;
let sharedNoiseCtxRate = 0;

/** One second of white noise, cached per sample rate. */
export function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  if (sharedNoise && sharedNoiseCtxRate === ctx.sampleRate) return sharedNoise;
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate), ctx.sampleRate);
  const d = buf.getChannelData(0);
  // Deterministic noise: the same buffer every run, so the offline render test
  // measures the cue rather than the weather.
  let seed = 0x9e3779b9;
  for (let i = 0; i < d.length; i++) {
    seed = (Math.imul(seed ^ (seed >>> 15), 0x2545f491) + 0x6d2b79f5) >>> 0;
    d[i] = (seed / 2147483648 - 1) * 0.9;
  }
  sharedNoise = buf;
  sharedNoiseCtxRate = ctx.sampleRate;
  return buf;
}

interface ToneSpec {
  type?: OscillatorType;
  from: number;
  to?: number;
  dur: number;
  gain: number;
  /** Seconds before the body starts; 0 is a click, higher is a swell. */
  attack?: number;
  delay?: number;
}

function tone(ctx: BaseAudioContext, dest: AudioNode, t: number, s: ToneSpec): void {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  const start = t + (s.delay ?? 0);
  osc.type = s.type ?? 'sine';
  osc.frequency.setValueAtTime(Math.max(20, s.from), start);
  if (s.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, s.to), start + s.dur);
  const atk = s.attack ?? 0.002;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, s.gain), start + atk);
  g.gain.exponentialRampToValueAtTime(0.0001, start + s.dur);
  osc.connect(g).connect(dest);
  osc.start(start);
  osc.stop(start + s.dur + 0.02);
}

interface NoiseSpec {
  dur: number;
  gain: number;
  /** Band centre, swept from `from` to `to`. */
  from: number;
  to?: number;
  q?: number;
  type?: BiquadFilterType;
  attack?: number;
  delay?: number;
}

function noise(ctx: BaseAudioContext, dest: AudioNode, t: number, s: NoiseSpec): void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  const start = t + (s.delay ?? 0);
  // Start somewhere random-ish in the buffer so repeats do not phase-align.
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = s.type ?? 'bandpass';
  filter.Q.value = s.q ?? 1.2;
  filter.frequency.setValueAtTime(Math.max(40, s.from), start);
  if (s.to !== undefined) filter.frequency.exponentialRampToValueAtTime(Math.max(40, s.to), start + s.dur);
  const g = ctx.createGain();
  const atk = s.attack ?? 0.001;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, s.gain), start + atk);
  g.gain.exponentialRampToValueAtTime(0.0001, start + s.dur);
  src.connect(filter).connect(g).connect(dest);
  src.start(start, (start * 7.3) % 0.9);
  src.stop(start + s.dur + 0.02);
}

/* -------------------------------- the cues -------------------------------- */

type Cue = (ctx: BaseAudioContext, dest: AudioNode, t: number, o: Required<CueOptions>) => void;

/**
 * Every cue is built the same way: a transient that tells you it happened, a
 * body that tells you what it was, and a tail that tells you how big it was.
 * Weapons get all three; UI ticks get only the first.
 */
export const CUES: Record<CueName, Cue> = {
  // A bolt-fed slug: sharp crack, a hard low body, and a little receiver ring.
  'fire-adze': (c, d, t, o) => {
    noise(c, d, t, { dur: 0.09, gain: 0.55 * o.gain, from: 3200 * o.vary, to: 700, q: 0.8, type: 'highpass' });
    tone(c, d, t, { type: 'triangle', from: 190 * o.vary, to: 48, dur: 0.22, gain: 0.5 * o.gain });
    tone(c, d, t, { type: 'square', from: 1400 * o.vary, to: 900, dur: 0.05, gain: 0.09 * o.gain, delay: 0.01 });
  },
  // A sealed censer leaving the tube: hollow, wet, no crack at all.
  'fire-censer': (c, d, t, o) => {
    noise(c, d, t, { dur: 0.16, gain: 0.32 * o.gain, from: 520 * o.vary, to: 150, q: 2.4 });
    tone(c, d, t, { type: 'sine', from: 240 * o.vary, to: 70, dur: 0.2, gain: 0.34 * o.gain });
  },
  'fire-generic': (c, d, t, o) => {
    noise(c, d, t, { dur: 0.07, gain: 0.4 * o.gain, from: 2400 * o.vary, to: 800, q: 1 });
    tone(c, d, t, { type: 'triangle', from: 160 * o.vary, to: 60, dur: 0.12, gain: 0.3 * o.gain });
  },

  // Impacts, one per defence layer, so the player hears what they are chewing
  // through without reading a bar.
  'impact-shield': (c, d, t, o) => {
    tone(c, d, t, { type: 'sine', from: 1750 * o.vary, to: 2400, dur: 0.12, gain: 0.16 * o.gain });
    noise(c, d, t, { dur: 0.08, gain: 0.14 * o.gain, from: 4200, to: 6000, q: 3 });
  },
  'impact-armor': (c, d, t, o) => {
    noise(c, d, t, { dur: 0.1, gain: 0.24 * o.gain, from: 900 * o.vary, to: 420, q: 2.6 });
    tone(c, d, t, { type: 'square', from: 300 * o.vary, to: 180, dur: 0.06, gain: 0.09 * o.gain });
  },
  'impact-health': (c, d, t, o) => {
    noise(c, d, t, { dur: 0.13, gain: 0.26 * o.gain, from: 320 * o.vary, to: 110, q: 1.1, type: 'lowpass' });
    tone(c, d, t, { type: 'sine', from: 120 * o.vary, to: 48, dur: 0.14, gain: 0.2 * o.gain });
  },
  // The reward sound. Brighter, longer, and it rises — the only cue in the game
  // that goes up, so it is unmistakable.
  'impact-weak': (c, d, t, o) => {
    tone(c, d, t, { type: 'triangle', from: 600 * o.vary, to: 1500, dur: 0.24, gain: 0.3 * o.gain });
    tone(c, d, t, { type: 'sine', from: 900, to: 2100, dur: 0.2, gain: 0.16 * o.gain, delay: 0.02 });
    noise(c, d, t, { dur: 0.16, gain: 0.2 * o.gain, from: 1800, to: 5200, q: 2 });
  },

  // A deflection. Dull, short and pitched below every impact cue, so it never
  // gets mistaken for a hit that landed.
  warded: (c, d, t, o) => {
    tone(c, d, t, { type: 'sine', from: 320 * o.vary, to: 190, dur: 0.1, gain: 0.14 * o.gain });
    noise(c, d, t, { dur: 0.07, gain: 0.1 * o.gain, from: 1200, to: 500, q: 3.5 });
  },
  // Thinner and higher than a direct hit, so an arc is audibly secondary.
  chain: (c, d, t, o) => {
    tone(c, d, t, { type: 'sawtooth', from: 1400 * o.vary, to: 2600, dur: 0.09, gain: 0.09 * o.gain });
    noise(c, d, t, { dur: 0.06, gain: 0.08 * o.gain, from: 3400, to: 6200, q: 4 });
  },
  kill: (c, d, t, o) => {
    noise(c, d, t, { dur: 0.28, gain: 0.22 * o.gain, from: 900 * o.vary, to: 90, q: 1, type: 'lowpass' });
    tone(c, d, t, { type: 'sine', from: 180, to: 40, dur: 0.3, gain: 0.18 * o.gain });
  },
  reload: (c, d, t, o) => {
    noise(c, d, t, { dur: 0.04, gain: 0.2 * o.gain, from: 2600, to: 1400, q: 4 });
    noise(c, d, t, { dur: 0.05, gain: 0.24 * o.gain, from: 1800, to: 900, q: 5, delay: 0.13 });
    tone(c, d, t, { type: 'square', from: 220, to: 160, dur: 0.04, gain: 0.06 * o.gain, delay: 0.13 });
  },
  dodge: (c, d, t, o) => {
    noise(c, d, t, { dur: 0.26, gain: 0.16 * o.gain, from: 380, to: 1900, q: 0.7, attack: 0.05 });
  },
  'player-hit': (c, d, t, o) => {
    tone(c, d, t, { type: 'sine', from: 150 * o.vary, to: 42, dur: 0.26, gain: 0.4 * o.gain });
    noise(c, d, t, { dur: 0.14, gain: 0.2 * o.gain, from: 500, to: 140, q: 1, type: 'lowpass' });
  },
  'shield-break': (c, d, t, o) => {
    noise(c, d, t, { dur: 0.4, gain: 0.26 * o.gain, from: 5200, to: 700, q: 1.4 });
    tone(c, d, t, { type: 'triangle', from: 2400, to: 600, dur: 0.3, gain: 0.14 * o.gain });
  },

  // A warning that rises for as long as the wind-up lasts, so the ear learns
  // the deadline the same way the eye learns the decal.
  telegraph: (c, d, t, o) => {
    tone(c, d, t, { type: 'sawtooth', from: 90 * o.vary, to: 260, dur: 0.85, gain: 0.075 * o.gain, attack: 0.3 });
  },
  resolve: (c, d, t, o) => {
    tone(c, d, t, { type: 'sine', from: 90, to: 32, dur: 0.55, gain: 0.5 * o.gain });
    noise(c, d, t, { dur: 0.34, gain: 0.3 * o.gain, from: 1400, to: 120, q: 0.8, type: 'lowpass' });
  },
  // Deep, slow, and the only cue allowed to be this long.
  phase: (c, d, t, o) => {
    tone(c, d, t, { type: 'sine', from: 70, to: 26, dur: 1.5, gain: 0.55 * o.gain, attack: 0.02 });
    tone(c, d, t, { type: 'triangle', from: 190, to: 95, dur: 1.1, gain: 0.16 * o.gain, delay: 0.06 });
    noise(c, d, t, { dur: 1.3, gain: 0.16 * o.gain, from: 260, to: 70, q: 0.7, type: 'lowpass', attack: 0.15 });
  },
  vent: (c, d, t, o) => {
    noise(c, d, t, { dur: 0.9, gain: 0.24 * o.gain, from: 900, to: 2600, q: 0.6, attack: 0.12 });
    tone(c, d, t, { type: 'sine', from: 130, to: 200, dur: 0.7, gain: 0.1 * o.gain, attack: 0.1 });
  },
  gate: (c, d, t, o) => {
    for (let i = 0; i < 3; i++) {
      tone(c, d, t, { type: 'sine', from: 220 * (1 + i * 0.5), dur: 0.9, gain: 0.11 * o.gain, attack: 0.06, delay: i * 0.08 });
    }
  },
  mined: (c, d, t, o) => {
    noise(c, d, t, { dur: 0.16, gain: 0.2 * o.gain, from: 700 * o.vary, to: 220, q: 2.2 });
    tone(c, d, t, { type: 'triangle', from: 330, to: 440, dur: 0.14, gain: 0.1 * o.gain });
  },
  scanned: (c, d, t, o) => {
    tone(c, d, t, { type: 'sine', from: 660, to: 990, dur: 0.3, gain: 0.12 * o.gain, attack: 0.02 });
    tone(c, d, t, { type: 'sine', from: 990, dur: 0.22, gain: 0.07 * o.gain, delay: 0.1 });
  },
  'boss-down': (c, d, t, o) => {
    tone(c, d, t, { type: 'sine', from: 60, to: 22, dur: 2.4, gain: 0.6 * o.gain, attack: 0.01 });
    noise(c, d, t, { dur: 2.0, gain: 0.3 * o.gain, from: 1800, to: 60, q: 0.6, type: 'lowpass' });
    tone(c, d, t, { type: 'triangle', from: 300, to: 74, dur: 1.6, gain: 0.16 * o.gain, delay: 0.1 });
  },
  'player-down': (c, d, t, o) => {
    tone(c, d, t, { type: 'sine', from: 200, to: 28, dur: 1.9, gain: 0.5 * o.gain });
    noise(c, d, t, { dur: 1.4, gain: 0.2 * o.gain, from: 700, to: 60, q: 0.7, type: 'lowpass' });
  },
};

export const CUE_NAMES = Object.keys(CUES) as CueName[];

/* -------------------------------- the engine ------------------------------ */

interface SimEvent {
  type: string;
  x: number;
  y: number;
  z: number;
  amount: number;
  text: string;
  damageType: string;
  crit: boolean;
}

/**
 * Live audio. Owns one context, a master chain with a limiter, and a drone bed.
 *
 * Cue selection is driven by the same `ArenaEvent` stream that drives the visual
 * effects, for the same reason: the sim reports what happened, and every
 * decision about how it lands is made on this side of the wall.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private ambience: GainNode | null = null;
  private beamGain: GainNode | null = null;
  private droneNodes: AudioNode[] = [];
  private bed: Bed | null = null;
  private scene: SoundscapeDef | null = null;
  private sceneId = '';
  private nextToll = 0;
  private intensity = 0;
  private volume = 0.8;
  private enabled = true;
  /** Cheap flood control: at most one of each cue per this many ms. */
  private lastFired = new Map<string, number>();

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /**
   * Must be called from a user gesture. Browsers refuse to start an audio
   * context otherwise, and the pointer-lock click is the natural moment.
   */
  resume(): void {
    if (!this.ctx) this.init();
    void this.ctx?.resume();
  }

  private init(): void {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;

    // A limiter on the master bus. Procedural cues stack unpredictably in a
    // firefight and clipping is the fastest way to sound cheap.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.18;

    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.sfx = ctx.createGain();
    this.ambience = ctx.createGain();
    this.ambience.gain.value = 0.42;

    this.sfx.connect(this.master);
    this.ambience.connect(this.master);
    this.master.connect(limiter).connect(ctx.destination);

    this.beamGain = ctx.createGain();
    this.beamGain.gain.value = 0;
    this.beamGain.connect(this.sfx);
    this.startBeam(ctx, this.beamGain);
  }

  /**
   * Swaps the bed when the player changes place.
   *
   * Crossfaded rather than cut: arriving somewhere new should feel like the
   * room changing, not like a track ending. The old bed is released once it has
   * faded, so beds never accumulate.
   */
  setScene(planetId: string, zoneKind: string, intensity: number): void {
    if (!this.ctx || !this.ambience) return;
    const def = soundscapeFor(planetId, zoneKind);
    const swapped = def.id !== this.sceneId;
    if (swapped) {
      this.sceneId = def.id;
      const now = this.ctx.currentTime;
      const old = this.bed;
      if (old) {
        old.stop(now);
        setTimeout(() => old.output.disconnect(), 4000);
      }
      const bed = buildBed(this.ctx, def, noiseBuffer(this.ctx));
      bed.output.gain.setValueAtTime(0.0001, now);
      bed.output.gain.setTargetAtTime(1, now, 1.5);
      bed.output.connect(this.ambience);
      this.bed = bed;
      this.scene = def;
      this.nextToll = performance.now() + (def.toll?.everyMs[0] ?? 30000);
    }
    // Called every frame, so only push a change when there is one: a
    // setTargetAtTime sixty times a second is sixty scheduled ramps a second.
    // A freshly built bed always gets one, or it would sit at its constructed
    // default until the player happened to change intensity.
    if (swapped || Math.abs(intensity - this.intensity) > 0.01) {
      this.bed?.setIntensity(intensity);
      this.intensity = intensity;
    }
  }

  /**
   * The sparse half of the score. A single struck tone every half-minute or so,
   * scheduled from the soundscape's own interval range — the brief asks for few
   * cues, and this is the only thing in the bed that is an event at all.
   */
  private maybeToll(): void {
    if (!this.ctx || !this.ambience || !this.scene?.toll) return;
    const now = performance.now();
    if (now < this.nextToll) return;
    const [lo, hi] = this.scene.toll.everyMs;
    // Quieter when docked: the ship is not the place for a bell.
    this.nextToll = now + lo + Math.random() * (hi - lo);
    const gain = this.ctx.createGain();
    gain.gain.value = 0.5 + this.intensity * 0.5;
    gain.connect(this.ambience);
    playToll(this.ctx, gain, this.scene, this.ctx.currentTime);
    setTimeout(() => gain.disconnect(), (this.scene.toll.dur + 1) * 1000);
  }

  /** The solar lance runs continuously; its gain is driven by the beam ramp. */
  private startBeam(ctx: AudioContext, dest: GainNode): void {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 128;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900;
    filter.Q.value = 2.2;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    src.loop = true;
    osc.connect(filter);
    src.connect(filter);
    filter.connect(dest);
    osc.start();
    src.start();
    this.droneNodes.push(osc, src);
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.enabled ? this.volume : 0, this.ctx.currentTime, 0.05);
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.setVolume(this.volume);
  }

  play(name: CueName, opts: CueOptions = {}): void {
    if (!this.ready || !this.ctx || !this.sfx) return;
    const now = performance.now();
    const last = this.lastFired.get(name) ?? -1e9;
    // Two identical cues inside 25ms is a comb filter, not a louder sound.
    if (now - last < 25) return;
    this.lastFired.set(name, now);
    CUES[name](this.ctx, this.sfx, this.ctx.currentTime, {
      gain: opts.gain ?? 1,
      vary: opts.vary ?? 0.94 + Math.random() * 0.12,
    });
  }

  /** Continuous state that is not event-driven: the beam's whine, and the bed. */
  update(firing: boolean, beamRamp: number, isBeam: boolean): void {
    if (!this.ctx || !this.beamGain) return;
    const want = isBeam && firing ? 0.05 + beamRamp * 0.14 : 0;
    this.beamGain.gain.setTargetAtTime(want, this.ctx.currentTime, 0.04);
    this.maybeToll();
  }

  consumeEvents(events: SimEvent[], playerY: number): void {
    if (!this.ready) return;
    for (const ev of events) {
      switch (ev.type) {
        case 'shot':
          this.play(
            ev.text === 'adze' ? 'fire-adze' : ev.text === 'censer' ? 'fire-censer' : 'fire-generic',
          );
          break;
        case 'hit':
          // Layer is inferred from what the shot is eating, so the mix tells the
          // player which defence they are working through.
          this.play(
            ev.amount > 60 ? 'impact-health' : ev.amount > 25 ? 'impact-armor' : 'impact-shield',
            { gain: 0.8 },
          );
          break;
        case 'weak':
          this.play('impact-weak');
          break;
        case 'warded':
          this.play('warded', { gain: 0.6 });
          break;
        case 'chain':
          this.play('chain', { gain: 0.7 });
          break;
        case 'kill':
          this.play('kill', { gain: 0.7 });
          break;
        case 'reload':
          this.play('reload');
          break;
        case 'dodge':
          this.play('dodge');
          break;
        case 'player-hit':
          this.play('player-hit', { gain: Math.min(1, 0.4 + ev.amount / 60) });
          break;
        case 'telegraph':
          this.play('telegraph');
          break;
        case 'resolve':
          this.play('resolve', { gain: 0.8 });
          break;
        case 'phase':
          this.play('phase');
          break;
        case 'vent':
          this.play('vent');
          break;
        case 'gate':
          this.play('gate');
          break;
        case 'mined':
          this.play('mined');
          break;
        case 'scanned':
          this.play('scanned');
          break;
        case 'boss-down':
          this.play('boss-down');
          break;
        case 'player-down':
          this.play('player-down');
          break;
        default:
          break;
      }
    }
    void playerY;
  }
}
