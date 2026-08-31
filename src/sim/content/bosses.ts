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
};
