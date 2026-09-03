/**
 * A scripted operator, for headless soak runs, balance dumps and tests.
 *
 * It is not an AI showcase — it is a fixed policy that exercises every verb the
 * Tier 1 loop has (move, aim, fire, reload, dodge, channel a deposit, channel a
 * scan, call the boss, hit exposed weak points). If the bot can complete a zone,
 * the loop is completable with no renderer attached, which is the property the
 * headless-first architecture is supposed to buy.
 *
 * Movement is expressed the way a player's is: camera-relative. The bot simply
 * points its notional camera where it wants to go and pushes forward, so it
 * drives the exact same code path a human does.
 */
import { bossIsWarded, horizDist, NEUTRAL_INPUT, weakPointPos, type ArenaState, type InputFrame } from '../sim/arena.js';
import { getZone } from '../sim/content/zones.js';
import { atan2, PI } from '../sim/trig.js';
import type { Session } from '../sim/sim.js';

export interface BotOptions {
  /** Skips the boss call, for runs that only want the farming loop. */
  avoidBoss?: boolean;
}

/** Anything closer than this gets dealt with before the boss does. */
const ADD_THREAT_RANGE = 230;

export function botInput(session: Session, tick: number, opts: BotOptions = {}): InputFrame {
  const a = session.arena;
  if (!a || a.outcome !== 'running') return NEUTRAL_INPUT;
  const p = a.entities.find((e) => e.id === a.player.entityId);
  if (!p) return NEUTRAL_INPUT;

  const zone = getZone(a.zoneId);
  const input: InputFrame = { ...NEUTRAL_INPUT };

  // Dodge whatever is about to land, whether or not we understand it.
  const imminent = a.telegraphs.some(
    (t) => t.ticksLeft < 8 && horizDist(t.x, t.z, p.x, p.z) < t.radius + 90,
  );
  input.dodge = imminent || tick % 140 === 0;

  const hostile = nearestHostile(a, p.x, p.z);
  // A charge weapon fires on release, so holding the trigger forever means
  // never firing at all. The policy charges to full and lets go.
  const charging = a.player.chargeMax > 0;
  const wantsToFire = !charging || a.player.charge < a.player.chargeMax;

  // --- objective: satisfy the gate before touching the boss ----------------
  const needDeposits = a.minedCount < zone.gate.deposits;
  const needScans = a.scannedCount < zone.gate.scans;
  const objective = needDeposits
    ? nearest(a.deposits.filter((d) => !d.depleted), p.x, p.z)
    : needScans
      ? nearest(a.scans.filter((s) => !s.done), p.x, p.z)
      : null;

  if (objective) {
    const gap = horizDist(objective.x, objective.z, p.x, p.z);
    if (gap > 26) {
      // Point the notional camera at the objective and walk forward.
      input.camYaw = atan2(objective.z - p.z, objective.x - p.x);
      input.moveZ = 1;
    } else {
      input.interact = true;
    }
    // Channelling does not stop you shooting; it only stops you moving.
    if (hostile) {
      aimAt(input, p, hostile);
      input.fire = wantsToFire && horizDist(hostile.x, hostile.z, p.x, p.z) < 700;
    }
    return input;
  }

  // --- objective: fight ----------------------------------------------------
  if (a.gateMet && !a.bossSpawned && !opts.avoidBoss) input.summonBoss = true;

  if (hostile) {
    aimAt(input, p, hostile);
    input.fire = wantsToFire;

    const gap = horizDist(hostile.x, hostile.z, p.x, p.z);
    // Falloff weapons have to be flown differently: a scattergun held at rifle
    // range is doing a fifth of its damage, and a policy that does not close is
    // measuring the wrong thing.
    const shortRanged = a.player.effectiveRange > 0 && a.player.effectiveRange < 260;
    const want = shortRanged ? 90 : hostile.kind === 'boss' ? 300 : 170;
    const bearing = atan2(hostile.z - p.z, hostile.x - p.x);
    input.camYaw = bearing;
    if (gap > want + 60) input.moveZ = 1;
    else if (gap < want - 60) input.moveZ = -1;
    else input.moveX = tick % 300 < 150 ? 1 : -1; // circle-strafe
    if (p.grounded && tick % 220 === 0) input.jump = true;
  } else {
    // Nothing to shoot: patrol a slow circle rather than standing still.
    input.camYaw = (tick / 400) % (2 * PI);
    input.moveZ = 1;
  }
  return input;
}

function aimAt(input: InputFrame, p: { x: number; y: number; z: number; height: number }, target: ArenaState['entities'][number]): void {
  // Prefer an exposed weak point: that is the entire skill expression of the
  // boss fight, so the reference policy has to use it.
  const wp = target.weakPoints.find((w) => w.exposed && !w.broken);
  const at = wp
    ? weakPointPos(target, wp)
    : { x: target.x, y: target.y + target.height * 0.55, z: target.z };
  const eyeY = p.y + p.height * 0.72;
  input.aimYaw = atan2(at.z - p.z, at.x - p.x);
  input.aimPitch = atan2(at.y - eyeY, horizDist(p.x, p.z, at.x, at.z));
}

function nearest<T extends { x: number; z: number }>(items: T[], x: number, z: number): T | null {
  let best: T | null = null;
  let bestD = Infinity;
  for (const it of items) {
    const d = horizDist(it.x, it.z, x, z);
    if (d < bestD) {
      bestD = d;
      best = it;
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
function nearestHostile(a: ArenaState, x: number, z: number) {
  let boss: ArenaState['entities'][number] | null = null;
  let closestAdd: ArenaState['entities'][number] | null = null;
  let bestD = Infinity;
  for (const e of a.entities) {
    if (e.faction !== 'hostile' || e.dead || e.iframes > 0) continue;
    if (e.kind === 'boss') {
      boss = e;
      continue;
    }
    const d = horizDist(e.x, e.z, x, z);
    if (d < bestD) {
      bestD = d;
      closestAdd = e;
    }
  }
  // A warded boss cannot be hurt at all, so shooting it is not a suboptimal
  // choice, it is a wasted fight. Clear the escort at any range — which is
  // exactly what a player works out on their first attempt.
  if (closestAdd && boss && bossIsWarded(a, boss)) return closestAdd;
  if (closestAdd && bestD < ADD_THREAT_RANGE) return closestAdd;
  return boss ?? closestAdd;
}
