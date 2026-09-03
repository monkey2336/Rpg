/**
 * The score: one drone bed per place.
 *
 * The brief asks for a sparse, low-frequency, drone-forward score — long tracks,
 * few cues — with a distinct sonic identity per planet. That is a description of
 * a *bed*, not a tune, so this synthesises evolving pads rather than melodies.
 *
 * Each soundscape is data: a root, a stack of intervals above it, a filter
 * character, a texture layer, and an occasional struck toll. Two planets that
 * differ only in volume are not two identities, so `soundscape.test`-style
 * verification in the smoke run asserts the beds are measurably different from
 * each other, not merely present.
 *
 * Everything is built against `BaseAudioContext` so a bed can be rendered into
 * an `OfflineAudioContext` and measured. Sound you cannot listen to has to be
 * checked some other way.
 */

export interface Voice {
  /** Frequency ratio above the root. 1 is the root, 1.5 a fifth, 2 an octave. */
  ratio: number;
  detune: number;
  gain: number;
  type: OscillatorType;
}

export interface SoundscapeDef {
  id: string;
  /** Root of the drone in Hz. Everything here sits below the vocal range. */
  root: number;
  voices: Voice[];
  /** Lowpass character, and how far a very slow LFO sweeps it. */
  cutoff: number;
  sweep: number;
  sweepHz: number;
  resonance: number;
  /** Filtered noise: wind on a surface, hull resonance in a hold, nothing in vacuum. */
  texture: { freq: number; q: number; gain: number; type: BiquadFilterType } | null;
  /** A struck low tone, occasionally. The "few cues" half of the brief. */
  toll: { ratio: number; dur: number; gain: number; everyMs: [number, number] } | null;
  flavor: string;
}

/**
 * Khadir is hot, dry and enormous: a low open fifth with a dry high wind over
 * it, and a slow toll like something settling in the heat.
 *
 * Sabb is colder and lower, with a minor third that never resolves and a wetter,
 * duller texture — the brief's "colder, wetter, worse".
 *
 * Orbital has no air, so it has no wind. What it has instead is the hull: a
 * tight resonant band and a metallic toll, because in a derelict the only thing
 * making noise is the structure itself.
 */
export const SOUNDSCAPES: Record<string, SoundscapeDef> = {
  khadir: {
    id: 'khadir',
    root: 41.2,
    voices: [
      { ratio: 1, detune: 0, gain: 0.5, type: 'sawtooth' },
      { ratio: 1, detune: 7, gain: 0.34, type: 'sawtooth' },
      { ratio: 1.5, detune: -5, gain: 0.2, type: 'sawtooth' },
      { ratio: 2, detune: 4, gain: 0.09, type: 'triangle' },
    ],
    cutoff: 230,
    sweep: 95,
    sweepHz: 0.031,
    resonance: 1.4,
    texture: { freq: 900, q: 0.5, gain: 0.045, type: 'bandpass' },
    toll: { ratio: 2, dur: 5.5, gain: 0.075, everyMs: [26000, 52000] },
    flavor: 'One long afternoon. An open fifth and a dry wind.',
  },
  sabb: {
    id: 'sabb',
    root: 32.7,
    voices: [
      { ratio: 1, detune: 0, gain: 0.55, type: 'sawtooth' },
      { ratio: 1, detune: -9, gain: 0.36, type: 'sawtooth' },
      // A minor third that never resolves.
      { ratio: 1.189, detune: 5, gain: 0.22, type: 'sawtooth' },
      { ratio: 1.5, detune: 0, gain: 0.12, type: 'sine' },
    ],
    cutoff: 165,
    sweep: 60,
    sweepHz: 0.019,
    resonance: 2.1,
    texture: { freq: 280, q: 0.8, gain: 0.07, type: 'lowpass' },
    toll: { ratio: 1.189, dur: 7.5, gain: 0.06, everyMs: [34000, 68000] },
    flavor: 'Colder, wetter, worse. A third that never lands.',
  },
  orbital: {
    id: 'orbital',
    root: 55,
    voices: [
      { ratio: 1, detune: 0, gain: 0.32, type: 'sine' },
      { ratio: 2, detune: 3, gain: 0.22, type: 'sine' },
      // A tritone against the root: the interval that refuses to sit still.
      { ratio: 2.828, detune: -4, gain: 0.1, type: 'triangle' },
    ],
    cutoff: 420,
    sweep: 180,
    sweepHz: 0.047,
    resonance: 4.2,
    // No air, so no wind. The hull is the only thing making noise.
    texture: { freq: 1650, q: 9, gain: 0.03, type: 'bandpass' },
    toll: { ratio: 4, dur: 3.2, gain: 0.05, everyMs: [18000, 40000] },
    flavor: 'Vacuum. Hull resonance and a metallic toll, and nothing else.',
  },
};

/** Which bed a place uses. Orbital overrides the planet: vacuum is vacuum. */
export function soundscapeFor(planetId: string, zoneKind: string): SoundscapeDef {
  if (zoneKind === 'orbital') return SOUNDSCAPES.orbital!;
  return SOUNDSCAPES[planetId] ?? SOUNDSCAPES.khadir!;
}

export const SOUNDSCAPE_IDS = Object.keys(SOUNDSCAPES);

export interface Bed {
  /** 0 docked, 1 deployed, higher in a boss fight. Opens the filter and lifts gain. */
  setIntensity(v: number): void;
  /** Fades out and releases every node. */
  stop(atTime: number): void;
  output: GainNode;
}

/**
 * Builds a bed. Works on any BaseAudioContext, so the same code that plays is
 * the code the test measures.
 */
export function buildBed(ctx: BaseAudioContext, def: SoundscapeDef, noise: AudioBuffer): Bed {
  const out = ctx.createGain();
  out.gain.value = 1;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = def.cutoff;
  filter.Q.value = def.resonance;
  filter.connect(out);

  const sources: (OscillatorNode | AudioBufferSourceNode)[] = [];

  for (const v of def.voices) {
    const osc = ctx.createOscillator();
    osc.type = v.type;
    osc.frequency.value = def.root * v.ratio;
    osc.detune.value = v.detune;
    const g = ctx.createGain();
    g.gain.value = v.gain * 0.34;
    osc.connect(g).connect(filter);
    osc.start();
    sources.push(osc);
  }

  if (def.texture) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const tf = ctx.createBiquadFilter();
    tf.type = def.texture.type;
    tf.frequency.value = def.texture.freq;
    tf.Q.value = def.texture.q;
    const g = ctx.createGain();
    g.gain.value = def.texture.gain;
    src.connect(tf).connect(g).connect(out);
    src.start();
    sources.push(src);
  }

  // The very slow sweep. Nothing here should ever settle into a loop the ear
  // can catch, which is the difference between a bed and a backing track.
  const lfo = ctx.createOscillator();
  lfo.frequency.value = def.sweepHz;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = def.sweep;
  lfo.connect(lfoGain).connect(filter.frequency);
  lfo.start();
  sources.push(lfo);

  return {
    output: out,
    setIntensity(v: number): void {
      const t = ctx.currentTime;
      // Intensity opens the filter and lifts the bed. It never speeds anything
      // up: this score has no tempo to raise.
      filter.frequency.setTargetAtTime(def.cutoff + def.sweep * 0.4 + v * def.cutoff * 0.9, t, 1.6);
      out.gain.setTargetAtTime(0.55 + v * 0.45, t, 2.2);
    },
    stop(atTime: number): void {
      out.gain.setTargetAtTime(0.0001, atTime, 0.5);
      for (const s of sources) {
        try {
          s.stop(atTime + 3);
        } catch {
          // Already stopped. Nothing to do.
        }
      }
    },
  };
}

/** The occasional struck toll, rendered as a one-shot so it can be measured. */
export function playToll(ctx: BaseAudioContext, dest: AudioNode, def: SoundscapeDef, t: number): void {
  if (!def.toll) return;
  const freq = def.root * def.toll.ratio;
  for (const [mult, gainMult, delay] of [[1, 1, 0], [2.01, 0.28, 0.01], [2.98, 0.12, 0.02]] as const) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * mult, t + delay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t + delay);
    g.gain.exponentialRampToValueAtTime(def.toll.gain * gainMult, t + delay + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + delay + def.toll.dur);
    osc.connect(g).connect(dest);
    osc.start(t + delay);
    osc.stop(t + delay + def.toll.dur + 0.05);
  }
}
