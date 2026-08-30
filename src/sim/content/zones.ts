/**
 * Travel layer content.
 *
 * The prototype ships one planet. The table is shaped for 4–6, and the second
 * planet is present but locked so the gating, fuel and tier-progression code
 * has something real to be tested against rather than a single-node no-op.
 *
 * Idle yields are authored as integers per cycle. That is not cosmetic: it is
 * what makes the closed-form offline path exactly equal to the stepwise one
 * (N * y is exact for integer y; y summed N times is not). See route.ts.
 */
import type { PlanetDef, ZoneDef } from '../types.js';

export const PLANETS: readonly PlanetDef[] = [
  {
    id: 'khadir',
    name: 'Khadir',
    epithet: 'Salt shelf, tidally locked, one long afternoon',
    accent: '#e8853a',
    fuel: 0,
    zones: ['ochre-shelf', 'the-throats', 'lantern-derelict'],
    flavor:
      'The terminator never moves. Everything worth taking is on the hot side, under a metre of caked salt, ' +
      'and everything that survives out here has learned to dig.',
  },
  {
    id: 'sabb',
    name: 'Sabb',
    epithet: 'Ash basin under permanent overcast',
    accent: '#6fa9c9',
    fuel: 34,
    zones: ['grey-flats'],
    flavor: 'Colder, wetter, worse. The rot here is organised.',
  },
];

export const ZONES: readonly ZoneDef[] = [
  {
    id: 'ochre-shelf',
    planetId: 'khadir',
    name: 'The Ochre Shelf',
    subtitle: 'Kiln terrace, sunward face',
    kind: 'surface',
    tier: 1,
    recommendedPower: 10,
    enemyPool: ['shelf-tick', 'flint-skirmisher', 'duster-artillery', 'hollow-drone'],
    elite: 'chalk-praetor',
    bossId: 'kiln-warden',
    gate: { kills: 24, deposits: 3, scans: 2 },
    idle: { matPerCycle: 26, dataPerCycle: 3, cycleTicks: 480, dropChance: 0.16 },
    depositTier: 1,
    accent: '#e8853a',
    flavor:
      'A terrace of dead kilns the size of cathedrals, cut into the shelf by people who left no name on them. ' +
      'The shadows are the only cover and they are two hundred metres long.',
  },
  {
    id: 'the-throats',
    planetId: 'khadir',
    name: 'The Throats',
    subtitle: 'Vent network beneath the terrace',
    kind: 'surface',
    tier: 2,
    recommendedPower: 26,
    enemyPool: ['vault-mite', 'flint-skirmisher', 'hollow-drone', 'duster-artillery'],
    elite: 'chalk-praetor',
    bossId: null,
    gate: { kills: 40, deposits: 5, scans: 4 },
    idle: { matPerCycle: 61, dataPerCycle: 6, cycleTicks: 620, dropChance: 0.19 },
    depositTier: 2,
    accent: '#c9743a',
    flavor: 'Down out of the sun at last, which turns out to be worse.',
  },
  {
    id: 'lantern-derelict',
    planetId: 'khadir',
    name: 'The Lantern',
    subtitle: 'Derelict hauler, low orbit, decaying',
    kind: 'orbital',
    tier: 2,
    recommendedPower: 34,
    enemyPool: ['vault-mite', 'hollow-drone', 'flint-skirmisher', 'duster-artillery'],
    elite: 'chalk-praetor',
    bossId: null,
    gate: { kills: 30, deposits: 2, scans: 8 },
    idle: { matPerCycle: 38, dataPerCycle: 17, cycleTicks: 560, dropChance: 0.14 },
    depositTier: 2,
    accent: '#8fae4b',
    flavor:
      'Orbital salvage: thin on ore, thick on records. Somebody kept very good logs right up until they stopped.',
  },
  {
    id: 'grey-flats',
    planetId: 'sabb',
    name: 'The Grey Flats',
    subtitle: 'Ash pan, windward',
    kind: 'surface',
    tier: 3,
    recommendedPower: 58,
    enemyPool: ['vault-mite', 'flint-skirmisher', 'duster-artillery', 'hollow-drone'],
    elite: 'chalk-praetor',
    bossId: null,
    gate: { kills: 55, deposits: 7, scans: 6 },
    idle: { matPerCycle: 129, dataPerCycle: 11, cycleTicks: 720, dropChance: 0.21 },
    depositTier: 3,
    accent: '#6fa9c9',
    flavor: 'Nothing grows. Things still move.',
  },
];

const ZONE_BY_ID = new Map(ZONES.map((z) => [z.id, z]));
const PLANET_BY_ID = new Map(PLANETS.map((p) => [p.id, p]));

export function getZone(id: string): ZoneDef {
  const z = ZONE_BY_ID.get(id);
  if (!z) throw new Error(`unknown zone: ${id}`);
  return z;
}

export function getPlanet(id: string): PlanetDef {
  const p = PLANET_BY_ID.get(id);
  if (!p) throw new Error(`unknown planet: ${id}`);
  return p;
}

/** Zones playable in the Tier 1 prototype build. */
export const PROTOTYPE_ZONES = ['ochre-shelf'];
export const STARTING_ZONE = 'ochre-shelf';
