/**
 * Snapshots: the one-way channel from sim to presentation.
 *
 * Renderers never touch `GameState`. They receive a snapshot and draw it. Two
 * shapes, because the widget's whole performance budget depends on not shipping
 * a full arena across IPC twelve times a second:
 *
 *   WidgetSnapshot — a few hundred bytes. Route status, tickers, alert badge.
 *   FullSnapshot   — everything the game view and HUD need for one frame.
 *
 * Both are derived from the same state by the same code, so the widget can never
 * drift from the game. That is the point.
 */
import { derive } from './derive.js';
import { formatNumber } from './numbers.js';
import { planCycle, routeRates } from './route.js';
import type { Session } from './sim.js';
import { getZone } from './content/zones.js';
import { RARITY_DEFS } from './content/items.js';
import { getBoss } from './content/bosses.js';
import { TICK_HZ } from './combat.js';
import { weakPointPos, type ArenaState } from './arena.js';

export type AlertKind = 'none' | 'hold-full' | 'stalled' | 'boss-ready' | 'downed';

export interface WidgetSnapshot {
  kind: 'widget';
  tick: number;
  routeZone: string | null;
  routeZoneName: string;
  accent: string;
  cycleProgress: number;
  cycles: number;
  materials: number;
  materialsPerHour: number;
  data: number;
  dataPerHour: number;
  drops: number;
  holdUsed: number;
  holdMax: number;
  alert: AlertKind;
  alertText: string;
  level: number;
  prestige: number;
  /** Present only while a fight is live, so the widget can show a pulse. */
  inCombat: boolean;
  bossPhase: number;
  bossHealthFraction: number;
}

export interface FullSnapshot {
  kind: 'full';
  tick: number;
  mode: 'ship' | 'zone';
  level: number;
  xp: number;
  xpNext: number;
  power: number;
  notation: string;
  resources: { materials: Record<string, number>; data: number; fuel: number; fuelMax: number };
  hold: { used: number; max: number };
  player: { health: number; healthMax: number; shield: number; shieldMax: number; armor: number; armorMax: number };
  weapon: {
    name: string;
    rarity: string;
    rarityColor: string;
    damageType: string;
    ammo: number;
    magazine: number;
    reloadProgress: number;
    dps: number;
  } | null;
  route: WidgetSnapshot;
  arena: ArenaSnapshot | null;
  notices: string[];
}

export interface ArenaSnapshot {
  zoneId: string;
  zoneName: string;
  accent: string;
  tick: number;
  shake: number;
  hitstop: number;
  outcome: string;
  gate: { kills: number; killsNeeded: number; deposits: number; depositsNeeded: number; scans: number; scansNeeded: number; met: boolean };
  entities: {
    id: number;
    kind: string;
    defId: string;
    x: number;
    y: number;
    w: number;
    h: number;
    facing: number;
    hp: number;
    hpMax: number;
    shield: number;
    shieldMax: number;
    armor: number;
    armorMax: number;
    flash: number;
    statuses: string[];
    weakPoints: { x: number; y: number; r: number; label: string; broken: boolean }[];
  }[];
  projectiles: { x: number; y: number; type: string; r: number; hostile: boolean }[];
  telegraphs: { x: number; y: number; r: number; shape: string; type: string; progress: number; angle: number }[];
  deposits: { x: number; progress: number; depleted: boolean }[];
  scans: { x: number; progress: number; done: boolean }[];
  player: { x: number; y: number; aim: number; dodging: boolean; interacting: boolean };
  boss: { name: string; phase: number; phases: number; fraction: number; briefing: string } | null;
}

export function buildWidgetSnapshot(session: Session): WidgetSnapshot {
  const { state } = session;
  const d = derive(state);
  const route = state.route;
  const arena = session.arena;

  let zoneName = 'No route assigned';
  let accent = '#8d8577';
  let progress = 0;
  let matPerHour = 0;
  let dataPerHour = 0;

  if (route) {
    const zone = getZone(route.zoneId);
    zoneName = zone.name;
    accent = zone.accent;
    const plan = session.plan ?? planCycle(state, route.zoneId);
    progress = plan.cycleTicks > 0 ? route.tickInCycle / plan.cycleTicks : 0;
    const rates = routeRates(plan);
    matPerHour = rates.matPerHour;
    dataPerHour = rates.dataPerHour;
  }

  const holdUsed = state.inventory.items.length;
  const holdMax = d.inventorySlots;

  let alert: AlertKind = 'none';
  let alertText = '';
  if (arena?.outcome === 'down') {
    alert = 'downed';
    alertText = 'Downed on the surface';
  } else if (arena?.gateMet && !arena.bossSpawned) {
    alert = 'boss-ready';
    alertText = 'Beacon ready';
  } else if (route?.stalled) {
    alert = 'stalled';
    alertText = route.stallReason || 'Route stalled';
  } else if (holdUsed >= holdMax) {
    alert = 'hold-full';
    alertText = 'Hold full — scrapping overflow';
  }

  const bossEnt = arena?.bossSpawned ? arena.entities.find((e) => e.id === arena.bossEntityId) : undefined;

  return {
    kind: 'widget',
    tick: state.tick,
    routeZone: route?.zoneId ?? null,
    routeZoneName: zoneName,
    accent,
    cycleProgress: progress,
    cycles: route?.cycleIndex ?? 0,
    materials: totalMaterials(state.resources.materials),
    materialsPerHour: matPerHour,
    data: state.resources.data,
    dataPerHour,
    drops: state.stats.itemsDropped,
    holdUsed,
    holdMax,
    alert,
    alertText,
    level: state.player.level,
    prestige: state.prestige.count,
    inCombat: !!arena && arena.outcome === 'running',
    bossPhase: arena?.bossPhase ?? 0,
    bossHealthFraction: bossEnt ? bossEnt.def.health / bossEnt.def.healthMax : 0,
  };
}

export function buildFullSnapshot(session: Session, notices: string[] = []): FullSnapshot {
  const { state } = session;
  const d = derive(state);
  const p = state.player.defences;
  const w = d.weapon;
  const pr = session.arena?.player;

  return {
    kind: 'full',
    tick: state.tick,
    mode: session.mode,
    level: state.player.level,
    xp: state.player.xp,
    xpNext: Math.floor(80 * state.player.level * (1 + state.player.level * 0.35)),
    power: d.power,
    notation: state.settings.notation,
    resources: {
      materials: { ...state.resources.materials },
      data: state.resources.data,
      fuel: state.resources.fuel,
      fuelMax: d.fuelMax,
    },
    hold: { used: state.inventory.items.length, max: d.inventorySlots },
    player: {
      health: p.health,
      healthMax: p.healthMax,
      shield: p.shield,
      shieldMax: p.shieldMax,
      armor: p.armor,
      armorMax: p.armorMax,
    },
    weapon: w
      ? {
          name: w.name,
          rarity: w.item.rarity,
          rarityColor: RARITY_DEFS[w.item.rarity].color,
          damageType: w.damageType,
          ammo: pr?.ammo ?? w.magazine,
          magazine: w.magazine,
          reloadProgress: pr && pr.reloadLeft > 0 ? 1 - pr.reloadLeft / Math.max(1, w.reloadTicks) : 1,
          dps: w.dps,
        }
      : null,
    route: buildWidgetSnapshot(session),
    arena: session.arena ? buildArenaSnapshot(session.arena) : null,
    notices,
  };
}

function buildArenaSnapshot(a: ArenaState): ArenaSnapshot {
  const zone = getZone(a.zoneId);
  const bossEnt = a.bossSpawned ? a.entities.find((e) => e.id === a.bossEntityId) : undefined;
  const bossDef = zone.bossId ? getBoss(zone.bossId) : null;
  const player = a.entities.find((e) => e.id === a.player.entityId)!;

  return {
    zoneId: a.zoneId,
    zoneName: zone.name,
    accent: zone.accent,
    tick: a.tick,
    shake: a.shake,
    hitstop: a.hitstop,
    outcome: a.outcome,
    gate: {
      kills: a.kills,
      killsNeeded: zone.gate.kills,
      deposits: a.minedCount,
      depositsNeeded: zone.gate.deposits,
      scans: a.scannedCount,
      scansNeeded: zone.gate.scans,
      met: a.gateMet,
    },
    entities: a.entities
      .filter((e) => !e.dead)
      .map((e) => ({
        id: e.id,
        kind: e.kind,
        defId: e.defId,
        x: e.x,
        y: e.y,
        w: e.w,
        h: e.h,
        facing: e.facing,
        hp: e.def.health,
        hpMax: e.def.healthMax,
        shield: e.def.shield,
        shieldMax: e.def.shieldMax,
        armor: e.def.armor,
        armorMax: e.def.armorMax,
        flash: e.hitFlash,
        statuses: e.statuses.map((s) => s.kind),
        weakPoints: e.weakPoints
          .filter((wp) => wp.exposed && !wp.broken)
          .map((wp) => ({ ...weakPointPos(e, wp), r: wp.radius, label: wp.label, broken: wp.broken })),
      })),
    projectiles: a.projectiles.map((pj) => ({ x: pj.x, y: pj.y, type: pj.damageType, r: pj.radius, hostile: pj.faction === 'hostile' })),
    telegraphs: a.telegraphs.map((t) => ({
      x: t.x,
      y: t.y,
      r: t.radius,
      shape: t.shape,
      type: t.damageType,
      progress: 1 - t.ticksLeft / Math.max(1, t.totalTicks),
      angle: t.angle,
    })),
    deposits: a.deposits.map((dp) => ({ x: dp.x, progress: dp.progress / dp.required, depleted: dp.depleted })),
    scans: a.scans.map((s) => ({ x: s.x, progress: s.progress / s.required, done: s.done })),
    player: {
      x: player.x,
      y: player.y,
      aim: a.player.aimAngle,
      dodging: a.player.dodgeLeft > 0,
      interacting: a.player.interactTargetId >= 0,
    },
    boss:
      bossEnt && bossDef
        ? {
            name: bossDef.name,
            phase: bossEnt.phase,
            phases: bossDef.phases.length,
            fraction: bossEnt.def.health / bossEnt.def.healthMax,
            briefing: bossDef.phases[bossEnt.phase]?.briefing ?? '',
          }
        : null,
  };
}

export function totalMaterials(materials: Record<string, number>): number {
  let sum = 0;
  for (const k of Object.keys(materials)) sum += materials[k] ?? 0;
  return sum;
}

/** Convenience for the widget's tickers. */
export function fmt(value: number, notation: string): string {
  return formatNumber(value, { mode: notation === 'scientific' ? 'scientific' : 'short' });
}

export { TICK_HZ };
