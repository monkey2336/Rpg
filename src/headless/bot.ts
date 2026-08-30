/**
 * A scripted operator, for headless soak runs, balance dumps and tests.
 *
 * It is not an AI showcase — it is a fixed policy that exercises every verb the
 * Tier 1 loop has (move, aim, fire, reload, dodge, channel a deposit, channel a
 * scan, call the boss, hit exposed weak points). If the bot can complete a zone,
 * the loop is completable with no renderer attached, which is the property the
 * headless-first architecture is supposed to buy.
 */
import { GROUND_Y, NEUTRAL_INPUT, weakPointPos, type ArenaState, type InputFrame } from '../sim/arena.js';
import { getZone } from '../sim/content/zones.js';
import type { Session } from '../sim/sim.js';

export interface BotOptions {
  /** Skips the boss call, for runs that only want the farming loop. */
  avoidBoss?: boolean;
}

export function botInput(session: Session, tick: number, opts: BotOptions = {}): InputFrame {
  const a = session.arena;
  if (!a || a.outcome !== 'running') return NEUTRAL_INPUT;
  const p = a.entities.find((e) => e.id === a.player.entityId);
  if (!p) return NEUTRAL_INPUT;

  const zone = getZone(a.zoneId);
  const input: InputFrame = { ...NEUTRAL_INPUT, aimX: p.x + 200 * p.facing, aimY: p.y - 30 };

  // Dodge whatever is about to land on us, whether or not we understand it.
  const imminent = a.telegraphs.some((t) => t.ticksLeft < 8 && Math.abs(t.x - p.x) < t.radius + 60);
  input.dodge = imminent || tick % 140 === 0;

  // --- objective: satisfy the gate before touching the boss ---------------
  const needDeposits = a.minedCount < zone.gate.deposits;
  const needScans = a.scannedCount < zone.gate.scans;
  const target = needDeposits
    ? nearest(a.deposits.filter((d) => !d.depleted).map((d) => d.x), p.x)
    : needScans
      ? nearest(a.scans.filter((s) => !s.done).map((s) => s.x), p.x)
      : null;

  const hostile = nearestHostile(a, p.x);

  if (target !== null && (needDeposits || needScans)) {
    const dx = target - p.x;
    if (Math.abs(dx) > 18) {
      input.moveX = dx > 0 ? 1 : -1;
    } else {
      input.moveX = 0;
      input.interact = true;
    }
    // Channelling does not stop you shooting; it just stops you moving.
    if (hostile) {
      input.aimX = hostile.x;
      input.aimY = hostile.y - hostile.h * 0.5;
      input.fire = Math.abs(hostile.x - p.x) < 700;
    }
    return input;
  }

  // --- objective: fight ---------------------------------------------------
  if (a.gateMet && !a.bossSpawned && !opts.avoidBoss) input.summonBoss = true;

  if (hostile) {
    // Prefer an exposed weak point: that is the entire skill expression of the
    // boss fight, so the reference policy has to use it.
    const wp = hostile.weakPoints.find((w) => w.exposed && !w.broken);
    if (wp) {
      const at = weakPointPos(hostile, wp);
      input.aimX = at.x;
      input.aimY = at.y;
    } else {
      input.aimX = hostile.x;
      input.aimY = hostile.y - hostile.h * 0.5;
    }
    const gap = hostile.x - p.x;
    const want = hostile.kind === 'boss' ? 320 : 180;
    input.moveX = Math.abs(gap) > want + 60 ? Math.sign(gap) : Math.abs(gap) < want - 60 ? -Math.sign(gap) : 0;
    // Do not back into the arena wall; there is nowhere to dodge from there.
    if (Math.abs(p.x) > 1000 && Math.sign(input.moveX) === Math.sign(p.x)) input.moveX = 0;
    input.fire = true;
    if (p.y >= GROUND_Y && tick % 220 === 0) input.jump = true;
  } else {
    input.moveX = tick % 200 < 100 ? 1 : -1;
  }
  return input;
}

function nearest(xs: number[], from: number): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const x of xs) {
    const d = Math.abs(x - from);
    if (d < bestD) {
      bestD = d;
      best = x;
    }
  }
  return best;
}

/**
 * Targeting policy: clear anything crowding you, then go back to the boss.
 *
 * The boss's second phase spawns adds precisely to force this switch, so a
 * reference policy that tunnels the boss is not a reference policy — it is a
 * demonstration of the mechanic working.
 */
const ADD_THREAT_RANGE = 230;

function nearestHostile(a: ArenaState, x: number) {
  let boss: ArenaState['entities'][number] | null = null;
  let closestAdd: ArenaState['entities'][number] | null = null;
  let bestD = Infinity;
  for (const e of a.entities) {
    if (e.faction !== 'hostile' || e.dead || e.iframes > 0) continue;
    if (e.kind === 'boss') {
      boss = e;
      continue;
    }
    const d = Math.abs(e.x - x);
    if (d < bestD) {
      bestD = d;
      closestAdd = e;
    }
  }
  if (closestAdd && bestD < ADD_THREAT_RANGE) return closestAdd;
  return boss ?? closestAdd;
}
