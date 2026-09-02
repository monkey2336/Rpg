/**
 * Bosses. The centrepiece.
 *
 * Every phase must change a *mechanic*, not a number, and every boss owns one
 * named weak point that rewards knowledge. Both requirements are expressed as
 * data here so the encounter sim stays generic and the next thirteen bosses are
 * authoring work rather than engineering work.
 *
 * Telegraph language (consistent game-wide, learn it once):
 *   ring   — ground area, leave the circle
 *   line   — directional beam, step off the axis
 *   cone   — frontal sweep, get behind or far
 *   pulse  — expanding knockback, stand still or brace
 *   column — vertical drop, the marker is where it lands
 */
import type { BossDef } from '../types.js';

export const BOSS_DEFS: readonly BossDef[] = [
  {
    id: 'kiln-warden',
    name: 'The Kiln Warden',
    epithet: 'Third of the Shelf Kilns, still tending a furnace that went out an age ago',
    zoneId: 'ochre-shelf',
    radius: 92,
    height: 150,
    speed: 0.85,
    defences: {
      shield: 1800,
      shieldMax: 1800,
      shieldRegen: 70,
      shieldDelay: 180,
      armor: 2400,
      armorMax: 2400,
      health: 5200,
      healthMax: 5200,
    },
    // Local space: +ox is forward along its heading, +oz is to its left, oy is
    // height above its feet. The three are deliberately spread around the body
    // so each phase asks the player to stand somewhere different: the vents are
    // on its flanks, the ganglion is on its back, the core is under its chest.
    weakPoints: [
      { id: 'vents', label: 'Thermal Vents', ox: -6, oy: 104, oz: 74, radius: 26, multiplier: 2.6, healthMax: 900 },
      { id: 'ganglion', label: 'Spine Ganglion', ox: -78, oy: 122, oz: 0, radius: 22, multiplier: 3.2, healthMax: 1100 },
      { id: 'aperture', label: 'Core Aperture', ox: 58, oy: 74, oz: 0, radius: 30, multiplier: 4.0, healthMax: 1600 },
    ],
    phases: [
      {
        atHealthFraction: 1.0,
        name: 'Tending',
        speedMult: 1.0,
        attackIntervalMult: 1.0,
        armorMult: 1.0,
        shieldMult: 1.0,
        exposes: [],
        // Was hardcoded in the arena; now the same data every other boss uses.
        window: {
          weakPointId: 'vents',
          openTicks: 92,
          periodTicks: 300,
          suppressShield: true,
          label: 'Vents open',
        },
        spawns: [],
        arenaDps: 0,
        arenaDamageType: 'solar',
        patterns: ['sweep-line', 'ash-ring'],
        briefing:
          'It vents to cool itself. The vents open for two seconds and the shield drops with them. ' +
          'Shoot the vents, not the plate — the plate is thicker than your patience.',
      },
      {
        atHealthFraction: 0.66,
        name: 'Digging',
        speedMult: 1.35,
        attackIntervalMult: 0.82,
        armorMult: 1.45,
        shieldMult: 0,
        exposes: ['ganglion'],
        spawns: [{ defId: 'hollow-drone', count: 3 }],
        arenaDps: 0,
        arenaDamageType: 'solar',
        patterns: ['burrow-column', 'ash-ring', 'shelf-pulse'],
        briefing:
          'Shield gone, plate doubled. It goes under the shelf and comes up beneath you. ' +
          'The spine is bare for the second it surfaces. That is the whole fight now.',
      },
      {
        atHealthFraction: 0.33,
        name: 'Firing',
        speedMult: 1.7,
        attackIntervalMult: 0.6,
        armorMult: 0.55,
        shieldMult: 0,
        exposes: ['aperture'],
        spawns: [{ defId: 'shelf-tick', count: 6 }],
        arenaDps: 5.5,
        arenaDamageType: 'solar',
        patterns: ['sweep-line', 'burrow-column', 'shelf-pulse', 'kiln-cone'],
        briefing:
          'The kiln relights. Everything on the shelf takes heat, including you. ' +
          'The core stays open from here — it just refuses to hold still.',
      },
    ],
    signatureDrop: 'wardens-tithe',
    codexId: 'codex-kiln-warden',
    matDrop: 420,
    dataDrop: 260,
  },
  {
    id: 'the-bellows',
    name: 'The Bellows',
    epithet: 'The vent network\'s lung, still drawing breath for a fire that went out',
    zoneId: 'the-throats',
    radius: 78,
    height: 190,
    speed: 0,
    defences: {
      shield: 6200,
      shieldMax: 6200,
      shieldRegen: 90,
      shieldDelay: 200,
      armor: 10400,
      armorMax: 10400,
      health: 19600,
      healthMax: 19600,
    },
    weakPoints: [
      { id: 'throat', label: 'Throat Lining', ox: 62, oy: 148, oz: 0, radius: 30, multiplier: 3.0, healthMax: 1800 },
      { id: 'root-bulb', label: 'Root Bulb', ox: -34, oy: 28, oz: 0, radius: 27, multiplier: 3.6, healthMax: 2100 },
      { id: 'crown', label: 'Crown Vents', ox: 0, oy: 184, oz: 0, radius: 25, multiplier: 4.2, healthMax: 2600 },
    ],
    phases: [
      {
        atHealthFraction: 1.0,
        name: 'Drawing',
        speedMult: 0,
        attackIntervalMult: 1.0,
        armorMult: 1.0,
        shieldMult: 1.0,
        exposes: [],
        // The inversion of the Warden: its opening drags you toward it, so the
        // only moment you can hurt it is the moment it is hardest to survive.
        window: {
          weakPointId: 'throat',
          openTicks: 110,
          periodTicks: 330,
          suppressShield: true,
          pull: 1.9,
          label: 'Drawing breath',
        },
        spawns: [],
        arenaDps: 0,
        arenaDamageType: 'caustic',
        patterns: ['throat-cone', 'vent-ring'],
        briefing:
          'Anchored, and it cannot be moved. It draws breath before it blows — and the throat is only open while it is pulling. ' +
          'The safe moment and the useful moment are not the same moment.',
      },
      {
        atHealthFraction: 0.66,
        name: 'Uprooting',
        speedMult: 1.0,
        attackIntervalMult: 0.85,
        armorMult: 0.7,
        shieldMult: 0,
        exposes: ['root-bulb'],
        spawns: [{ defId: 'vault-mite', count: 4 }],
        respawnTicks: 900,
        arenaDps: 0,
        arenaDamageType: 'caustic',
        patterns: ['vent-ring', 'shelf-pulse', 'root-column'],
        briefing:
          'It tears itself out of the floor and starts walking. The root bulb is bare underneath it now, ' +
          'and the vents it was plugging are open — so is everything that lives in them.',
      },
      {
        atHealthFraction: 0.33,
        name: 'Drowning',
        speedMult: 1.4,
        attackIntervalMult: 0.62,
        armorMult: 0.5,
        shieldMult: 0,
        exposes: ['crown'],
        spawns: [],
        arenaDps: 6.5,
        arenaDamageType: 'caustic',
        patterns: ['throat-cone', 'vent-ring', 'shelf-pulse', 'root-column'],
        briefing:
          'It caps the vents with itself and the chamber begins to fill. Everything down here is breathing spore now, including you. ' +
          'The crown stays open from here. Be quick about it.',
      },
    ],
    signatureDrop: 'the-drawn-breath',
    codexId: 'codex-the-bellows',
    matDrop: 780,
    dataDrop: 430,
  },
  {
    id: 'the-choir',
    name: 'The Choir',
    epithet: 'Cargo handling for a hold that emptied itself, still sorting',
    zoneId: 'lantern-derelict',
    radius: 58,
    height: 210,
    speed: 0.7,
    defences: {
      shield: 15000,
      shieldMax: 15000,
      shieldRegen: 120,
      shieldDelay: 220,
      armor: 6500,
      armorMax: 6500,
      health: 22500,
      healthMax: 22500,
    },
    weakPoints: [
      { id: 'counterweight', label: 'Counterweight', ox: -48, oy: 152, oz: 0, radius: 25, multiplier: 3.2, healthMax: 2000 },
      { id: 'spine-core', label: 'Spine Core', ox: 0, oy: 94, oz: 0, radius: 27, multiplier: 4.0, healthMax: 2400 },
    ],
    phases: [
      {
        atHealthFraction: 1.0,
        name: 'Manifest',
        speedMult: 1.0,
        attackIntervalMult: 1.0,
        armorMult: 1.0,
        shieldMult: 1.0,
        exposes: [],
        // A different problem entirely: the boss is not the target yet.
        spawns: [{ defId: 'shield-pylon', count: 3 }],
        respawnTicks: 720,
        invulnerableWhileAdds: true,
        arenaDps: 0,
        arenaDamageType: 'arc',
        patterns: ['arc-lash', 'manifest-ring'],
        briefing:
          'Three pylons ward it and nothing you do reaches it while one still stands. They come back — ' +
          'so the question is not whether you can kill them, it is whether you can kill them fast enough to matter.',
      },
      {
        atHealthFraction: 0.66,
        name: 'Sorting',
        speedMult: 1.2,
        attackIntervalMult: 0.78,
        armorMult: 1.0,
        shieldMult: 0.45,
        exposes: ['counterweight'],
        spawns: [],
        arenaDps: 0,
        arenaDamageType: 'arc',
        patterns: ['arc-lash', 'sweep-arc', 'manifest-ring'],
        briefing:
          'The pylons stop coming and the arms start moving. It sweeps the bay on a pattern — ' +
          'it is sorting, and it has decided which pile you are.',
      },
      {
        atHealthFraction: 0.33,
        name: 'Jettison',
        speedMult: 1.35,
        attackIntervalMult: 0.6,
        armorMult: 0.6,
        shieldMult: 0,
        exposes: ['spine-core'],
        spawns: [{ defId: 'hollow-drone', count: 3 }],
        // The grav plating gives out. Everything, including you, gets lighter.
        gravityMult: 0.34,
        arenaDps: 0,
        arenaDamageType: 'arc',
        patterns: ['arc-lash', 'sweep-arc', 'jettison-pulse'],
        briefing:
          'The bay\'s grav plating fails. You will jump higher and fall slower, and so will everything it throws. ' +
          'The core is open. Nothing is where your hands expect it to be.',
      },
    ],
    signatureDrop: 'the-sorting-arm',
    codexId: 'codex-the-choir',
    matDrop: 720,
    dataDrop: 620,
  },
];

const BY_ID = new Map(BOSS_DEFS.map((b) => [b.id, b]));

export function getBoss(id: string): BossDef {
  const b = BY_ID.get(id);
  if (!b) throw new Error(`unknown boss: ${id}`);
  return b;
}

/** Telegraph patterns, shared vocabulary across every boss in the game. */
export interface PatternDef {
  id: string;
  shape: 'ring' | 'line' | 'cone' | 'pulse' | 'column';
  damageType: 'percussive' | 'solar' | 'caustic' | 'arc';
  /** Ticks of wind-up before it resolves. Long enough to read, short enough to matter. */
  windup: number;
  radius: number;
  damage: number;
  /** Ticks the boss must wait before using this pattern again. */
  cooldown: number;
}

export const PATTERNS: Record<string, PatternDef> = {
  'sweep-line': { id: 'sweep-line', shape: 'line', damageType: 'solar', windup: 46, radius: 34, damage: 42, cooldown: 150 },
  'ash-ring': { id: 'ash-ring', shape: 'ring', damageType: 'caustic', windup: 58, radius: 150, damage: 34, cooldown: 190 },
  'shelf-pulse': { id: 'shelf-pulse', shape: 'pulse', damageType: 'percussive', windup: 40, radius: 240, damage: 28, cooldown: 210 },
  'burrow-column': { id: 'burrow-column', shape: 'column', damageType: 'percussive', windup: 52, radius: 60, damage: 55, cooldown: 165 },
  'kiln-cone': { id: 'kiln-cone', shape: 'cone', damageType: 'solar', windup: 44, radius: 300, damage: 48, cooldown: 175 },

  // The Bellows. Same five shapes; caustic, and slower to read because the
  // chamber is dark.
  'throat-cone': { id: 'throat-cone', shape: 'cone', damageType: 'solar', windup: 52, radius: 360, damage: 58, cooldown: 190 },
  'vent-ring': { id: 'vent-ring', shape: 'ring', damageType: 'caustic', windup: 60, radius: 170, damage: 44, cooldown: 200 },
  'root-column': { id: 'root-column', shape: 'column', damageType: 'caustic', windup: 50, radius: 72, damage: 62, cooldown: 170 },

  // The Choir. Arc, and fast — an orbital bay is a tighter space than a terrace.
  'arc-lash': { id: 'arc-lash', shape: 'line', damageType: 'arc', windup: 40, radius: 30, damage: 50, cooldown: 140 },
  'sweep-arc': { id: 'sweep-arc', shape: 'cone', damageType: 'arc', windup: 42, radius: 330, damage: 54, cooldown: 165 },
  'manifest-ring': { id: 'manifest-ring', shape: 'ring', damageType: 'arc', windup: 54, radius: 160, damage: 40, cooldown: 185 },
  'jettison-pulse': { id: 'jettison-pulse', shape: 'pulse', damageType: 'arc', windup: 46, radius: 280, damage: 46, cooldown: 200 },
};
