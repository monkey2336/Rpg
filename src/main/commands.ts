/**
 * Every action a renderer can ask for, in one place.
 *
 * Renderers never mutate state — they name an intent and the host applies it.
 * That keeps the "strict separation of simulation, presentation and input"
 * requirement enforceable: this file is the entire write surface.
 */
import { derive, resolveWeapon } from '../sim/derive.js';
import { assertParity } from '../sim/offline.js';
import { assignRoute, canAssignRoute, clearRoute, planCycle } from '../sim/route.js';
import { doPrestige, landInZoneChecked, requestBoss, returnToShip, reviveInZone, canPrestige, prestigeGain, travelCostFor } from '../sim/sim.js';
import { breakdownValue, itemPower } from '../sim/loot.js';
import { addMaterials, findItem, type Settings } from '../sim/state.js';
import { getTech, techAvailable, TECH_NODES } from '../sim/content/tech.js';
import { SHIP_UPGRADES, getShipUpgrade, upgradeCost } from '../sim/content/ship.js';
import type { MaterialTier } from '../sim/types.js';
import type { SimHost } from './simhost.js';

export type CommandName =
  | 'land'
  | 'return-to-ship'
  | 'revive'
  | 'summon-boss'
  | 'assign-route'
  | 'clear-route'
  | 'equip'
  | 'unequip'
  | 'swap-slot'
  | 'breakdown'
  | 'toggle-lock'
  | 'buy-tech'
  | 'buy-upgrade'
  | 'prestige'
  | 'update-settings'
  | 'parity-check';

export interface CommandResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

const ok = (message = '', data?: unknown): CommandResult => ({ ok: true, message, data });
const no = (message: string): CommandResult => ({ ok: false, message });

export function runCommand(host: SimHost, name: CommandName, payload: Record<string, unknown> = {}): CommandResult {
  const session = host.session;
  const state = session.state;

  switch (name) {
    case 'land': {
      const zoneId = String(payload.zoneId ?? '');
      const result = landInZoneChecked(session, zoneId);
      if (result === 'unknown-zone') return no('That zone is not on the chart yet.');
      if (result === 'no-fuel') {
        return no(`Not enough fuel — that crossing needs ${travelCostFor(session, zoneId)}. It refills while docked.`);
      }
      return ok(`Landing at ${zoneId}.`);
    }

    case 'return-to-ship': {
      returnToShip(session);
      return ok('Docked.');
    }

    case 'revive': {
      if (!session.arena) return no('You are not planetside.');
      if (session.arena.outcome !== 'down') return no('Nothing to get up from.');
      if (!reviveInZone(session)) return no('Could not get up.');
      host.invalidate();
      return ok('On your feet.');
    }

    case 'summon-boss': {
      if (!requestBoss(session)) return no('The beacon is not answering yet.');
      return ok('The beacon answers.');
    }

    case 'assign-route': {
      const zoneId = String(payload.zoneId ?? '');
      if (!canAssignRoute(state, zoneId)) return no('Clear the zone by hand before the ship can run it.');
      assignRoute(state, zoneId);
      host.invalidate();
      const plan = planCycle(state, zoneId);
      return ok(`Route assigned: ${zoneId}.`, { cycleSeconds: plan.cycleSeconds });
    }

    case 'clear-route': {
      clearRoute(state);
      host.invalidate();
      return ok('Route cleared.');
    }

    case 'equip': {
      const uid = Number(payload.uid);
      const slot = Number(payload.slot ?? state.player.activeSlot);
      if (!findItem(state, uid)) return no('No such item in the hold.');
      if (slot < 0 || slot > 2) return no('No such slot.');
      state.player.loadout[slot] = uid;
      host.invalidate();
      return ok('Equipped.');
    }

    case 'unequip': {
      const slot = Number(payload.slot);
      if (slot < 0 || slot > 2) return no('No such slot.');
      if (state.player.loadout[slot] == null) return ok('');
      state.player.loadout[slot] = null;
      host.invalidate();
      return ok('Slot cleared.');
    }

    case 'swap-slot': {
      const slot = Number(payload.slot);
      if (slot < 0 || slot > 2) return no('No such slot.');
      state.player.activeSlot = slot;
      host.invalidate();
      return ok('');
    }

    case 'breakdown': {
      const uid = Number(payload.uid);
      const item = findItem(state, uid);
      if (!item) return no('No such item.');
      if (item.locked) return no('That one is locked.');
      if (state.player.loadout.includes(uid)) return no('Unequip it first.');
      const d = derive(state);
      const value = breakdownValue(item, d.breakdownYield);
      state.inventory.items = state.inventory.items.filter((i) => i.uid !== uid);
      addMaterials(state, 1, value);
      state.stats.itemsBrokenDown += 1;
      host.invalidate();
      return ok(`Broken down for ${value}.`);
    }

    case 'toggle-lock': {
      const item = findItem(state, Number(payload.uid));
      if (!item) return no('No such item.');
      item.locked = !item.locked;
      return ok(item.locked ? 'Locked.' : 'Unlocked.');
    }

    case 'buy-tech': {
      const id = String(payload.id ?? '');
      if (!TECH_NODES.some((t) => t.id === id)) return no('Unknown node.');
      if (!techAvailable(id, state.tech.unlocked)) return no('Prerequisites not met.');
      const node = getTech(id);
      if (state.resources.data < node.cost) return no(`Needs ${node.cost} data.`);
      state.resources.data -= node.cost;
      state.tech.unlocked.push(id);
      host.invalidate();
      return ok(`${node.name} translated.`);
    }

    case 'buy-upgrade': {
      const id = String(payload.id ?? '');
      if (!SHIP_UPGRADES.some((u) => u.id === id)) return no('Unknown upgrade.');
      const def = getShipUpgrade(id);
      const rank = state.ship.upgrades[id] ?? 0;
      if (rank >= def.maxRank) return no('Already at maximum rank.');
      const cost = upgradeCost(id, rank);
      for (const c of cost) {
        if ((state.resources.materials[String(c.tier)] ?? 0) < c.amount) {
          return no(`Needs ${c.amount} of tier ${c.tier}.`);
        }
      }
      for (const c of cost) addMaterials(state, c.tier as MaterialTier, -c.amount);
      state.ship.upgrades[id] = rank + 1;
      host.invalidate();
      return ok(`${def.name} rank ${rank + 1}.`);
    }

    case 'prestige': {
      if (!canPrestige(state)) return no('Not yet. The reset wants more depth than this run has.');
      const gain = prestigeGain(state);
      if (!doPrestige(session, Date.now())) return no('Reset refused.');
      host.invalidate();
      return ok(`Reset. Permanent multiplier +${gain.toFixed(2)}.`);
    }

    case 'update-settings': {
      const patch = (payload.settings ?? {}) as Partial<Settings>;
      state.settings = { ...state.settings, ...patch };
      return ok('', state.settings);
    }

    case 'parity-check': {
      // Exposed to the debug overlay so the claim can be re-checked against the
      // player's actual save, not just the test fixtures.
      const hours = Number(payload.hours ?? 2);
      const result = assertParity(state, hours * 3_600_000);
      return ok(result.ok ? `Parity holds over ${hours}h.` : `PARITY FAILED: ${result.detail}`, result);
    }

    default:
      return no(`Unknown command: ${String(name)}`);
  }
}

/**
 * Read-only projections the UI needs but the snapshot would be bloated by:
 * inventory listings, the tech tree with affordability resolved, and so on.
 */
export function readCatalog(host: SimHost): Record<string, unknown> {
  const state = host.session.state;
  const d = derive(state);
  return {
    zoneProgress: state.zones,
    travelCosts: Object.fromEntries(Object.keys(state.zones).map((z) => [z, travelCostFor(host.session, z)])),
    offlineCapHours: d.offlineCapHours,
    lastOffline: state.lastOfflineReport,
    inventory: state.inventory.items.map((item) => {
      const r = resolveWeapon(item, d.damageMult);
      return {
        uid: item.uid,
        name: item.name,
        rarity: item.rarity,
        ilvl: item.ilvl,
        archetypeId: item.archetypeId,
        damageType: r.damageType,
        dps: Math.round(r.dps),
        power: itemPower(item),
        locked: item.locked,
        signature: item.signature ?? null,
        equipped: state.player.loadout.indexOf(item.uid),
        affixes: item.affixes.map((a) => ({ label: a.label, value: a.value, flat: !!a.flat })),
        breakdown: breakdownValue(item, d.breakdownYield),
      };
    }),
    loadout: state.player.loadout,
    activeSlot: state.player.activeSlot,
    activeArchetype: d.weapon?.archetypeId ?? null,
    tech: TECH_NODES.map((t) => ({
      ...t,
      unlocked: state.tech.unlocked.includes(t.id),
      available: techAvailable(t.id, state.tech.unlocked),
      affordable: state.resources.data >= t.cost,
    })),
    upgrades: SHIP_UPGRADES.map((u) => {
      const rank = state.ship.upgrades[u.id] ?? 0;
      const cost = upgradeCost(u.id, rank);
      return {
        id: u.id,
        name: u.name,
        description: u.description,
        rank,
        maxRank: u.maxRank,
        cost,
        affordable: cost.every((c) => (state.resources.materials[String(c.tier)] ?? 0) >= c.amount),
      };
    }),
    prestige: {
      available: canPrestige(state),
      gain: prestigeGain(state),
      count: state.prestige.count,
      multiplier: state.prestige.multiplier,
      marker: state.prestige.marker,
      requirement: 25,
    },
    settings: state.settings,
    stats: state.stats,
    codex: state.codex,
  };
}
