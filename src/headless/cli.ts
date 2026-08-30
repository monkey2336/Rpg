/**
 * Headless runner — the third render target.
 *
 * Everything the game does can be done here with no window, no GPU and no
 * Electron. That is not a debug convenience, it is the proof that the
 * headless-first architecture actually holds: if a mechanic cannot be exercised
 * from this file, it has leaked into presentation.
 *
 *   node dist/src/headless/cli.js soak    --seeds 8
 *   node dist/src/headless/cli.js route   --hours 8
 *   node dist/src/headless/cli.js parity  --hours 1,4,12,48
 *   node dist/src/headless/cli.js balance
 *   node dist/src/headless/cli.js bench
 */
import { TICK_HZ, TICK_MS, makeDefences, ticksToKill } from '../sim/combat.js';
import { derive, resolveWeapon } from '../sim/derive.js';
import { assertParity, resolveOffline } from '../sim/offline.js';
import { NEUTRAL_INPUT } from '../sim/arena.js';
import { assignRoute, planCycle, routeRates } from '../sim/route.js';
import { landInZone, newSession, tickSession, type Session } from '../sim/sim.js';
import { formatDuration, formatNumber } from '../sim/numbers.js';
import { ENEMY_DEFS, effectiveHp } from '../sim/content/enemies.js';
import { WEAPON_ARCHETYPES } from '../sim/content/weapons.js';
import { DAMAGE_TYPES, STATUS_DEFS, typeMultiplier } from '../sim/content/damage.js';
import { getBoss } from '../sim/content/bosses.js';
import { botInput } from './bot.js';

const T0 = 1_700_000_000_000;
const args = process.argv.slice(2);
const command = args[0] ?? 'help';

function flag(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
}

const pad = (s: string | number, n: number): string => String(s).padEnd(n);
const padL = (s: string | number, n: number): string => String(s).padStart(n);

/* ---------------------------------- soak ---------------------------------- */

interface SoakRun {
  seed: number;
  cleared: boolean;
  ticks: number;
  bossTicks: number;
  kills: number;
  deaths: number;
  accuracy: number;
  weakShare: number;
}

function soak(seeds: number): void {
  console.log(`\nSOAK — ${seeds} scripted clears of The Ochre Shelf\n`);
  const runs: SoakRun[] = [];
  for (let i = 0; i < seeds; i++) {
    const seed = 1000 + i * 7919;
    const session = newSession(seed, T0);
    landInZone(session, 'ochre-shelf');
    let t = 0;
    let bossStart = -1;
    for (; t < 400_000; t++) {
      tickSession(session, botInput(session, t), 1);
      const a = session.arena!;
      if (a.bossSpawned && bossStart < 0) bossStart = t;
      if (a.outcome !== 'running') break;
    }
    const s = session.state.stats;
    runs.push({
      seed,
      cleared: session.state.zones['ochre-shelf']!.cleared,
      ticks: t,
      bossTicks: bossStart >= 0 ? t - bossStart : 0,
      kills: s.kills,
      deaths: s.deaths,
      accuracy: s.shotsFired > 0 ? s.shotsHit / s.shotsFired : 0,
      weakShare: s.shotsHit > 0 ? s.weakPointHits / s.shotsHit : 0,
    });
  }

  console.log(`${pad('seed', 9)}${pad('result', 9)}${padL('run', 8)}${padL('boss', 8)}${padL('kills', 7)}${padL('acc', 7)}${padL('weak', 7)}`);
  for (const r of runs) {
    console.log(
      pad(r.seed, 9) +
        pad(r.cleared ? 'cleared' : 'DOWNED', 9) +
        padL(`${(r.ticks / TICK_HZ).toFixed(0)}s`, 8) +
        padL(`${(r.bossTicks / TICK_HZ).toFixed(0)}s`, 8) +
        padL(r.kills, 7) +
        padL(`${(r.accuracy * 100).toFixed(0)}%`, 7) +
        padL(`${(r.weakShare * 100).toFixed(0)}%`, 7),
    );
  }
  const won = runs.filter((r) => r.cleared).length;
  const avg = (f: (r: SoakRun) => number) => runs.reduce((a, r) => a + f(r), 0) / runs.length;
  console.log(`\nclear rate ${won}/${runs.length}   mean run ${(avg((r) => r.ticks) / TICK_HZ).toFixed(0)}s   mean boss fight ${(avg((r) => r.bossTicks) / TICK_HZ).toFixed(0)}s`);
  console.log('(reference policy, starting kit, no upgrades — this is the floor, not the target)\n');
}

/* --------------------------------- route ---------------------------------- */

function route(hours: number): void {
  const session = newSession(4242, T0);
  session.state.zones['ochre-shelf']!.cleared = true;
  assignRoute(session.state, 'ochre-shelf');
  const plan = planCycle(session.state, 'ochre-shelf');
  const rates = routeRates(plan);

  console.log(`\nROUTE — The Ochre Shelf, starting kit\n`);
  console.log(`cycle           ${plan.cycleTicks} ticks (${plan.cycleSeconds.toFixed(1)}s)`);
  console.log(`per cycle       ${plan.matPerCycle} materials, ${plan.dataPerCycle} data, ${(plan.dropChance * 100).toFixed(0)}% drop`);
  console.log(`per hour        ${formatNumber(rates.matPerHour)} materials, ${formatNumber(rates.dataPerHour)} data, ${rates.dropsPerHour.toFixed(1)} items`);
  console.log(`idle rarity cap Refined\n`);

  const report = resolveOffline(session.state, T0 + hours * 3_600_000, { method: 'closed', capHoursOverride: 1e6 });
  const mats = Object.values(report.materials).reduce((a, b) => a + b, 0);
  console.log(`after ${formatDuration(hours * 3_600_000)} away:`);
  console.log(`  ${report.cycles} cycles`);
  console.log(`  ${formatNumber(mats)} materials`);
  console.log(`  ${formatNumber(report.data)} data`);
  console.log(`  ${report.drops} items found`);
  console.log(`  hold ${session.state.inventory.items.length}/${derive(session.state).inventorySlots}\n`);
}

/* --------------------------------- parity --------------------------------- */

function parity(hoursList: number[]): void {
  console.log('\nPARITY — stepwise resolver versus closed-form, on identical state\n');
  const session = newSession(4242, T0);
  session.state.zones['ochre-shelf']!.cleared = true;
  assignRoute(session.state, 'ochre-shelf');

  console.log(`${pad('elapsed', 12)}${padL('ticks', 12)}${pad('  stepwise', 12)}${pad('closed', 11)}${pad('result', 8)}${padL('ms', 8)}`);
  let allOk = true;
  for (const hours of hoursList) {
    const ms = hours * 3_600_000;
    const started = performance.now();
    // Stepwise is refused past its tick limit by design; report that honestly
    // rather than pretending the comparison ran.
    let result;
    try {
      result = assertParity(session.state, ms);
    } catch (err) {
      console.log(pad(formatDuration(ms), 12) + padL(Math.floor(ms / TICK_MS), 12) + '  ' + (err as Error).message);
      continue;
    }
    const elapsed = performance.now() - started;
    allOk = allOk && result.ok;
    console.log(
      pad(formatDuration(ms), 12) +
        padL(result.ticks, 12) +
        pad(`  ${result.stepwiseHash}`, 12) +
        pad(result.closedHash, 11) +
        pad(result.ok ? 'MATCH' : 'FAIL', 8) +
        padL(elapsed.toFixed(0), 8),
    );
    if (!result.ok) console.log(`  first divergence: ${result.detail}`);
  }
  console.log(`\n${allOk ? 'All comparisons matched exactly.' : 'PARITY BROKEN — the closed-form path is wrong.'}\n`);
  if (!allOk) process.exitCode = 1;
}

/* -------------------------------- balance --------------------------------- */

function balance(): void {
  const session = newSession(1, T0);
  const d = derive(session.state);

  console.log('\nBALANCE — damage type matrix\n');
  console.log(pad('', 13) + ['shield', 'armor', 'health'].map((s) => padL(s, 9)).join(''));
  for (const type of DAMAGE_TYPES) {
    console.log(
      pad(type, 13) + (['shield', 'armor', 'health'] as const).map((l) => padL(typeMultiplier(type, l).toFixed(2), 9)).join(''),
    );
  }

  console.log('\nWEAPON ARCHETYPES (common, ilvl 1, no affixes)\n');
  console.log(
    pad('archetype', 13) + pad('type', 12) + pad('behaviour', 11) + padL('dps', 8) + padL('dot', 8) + padL('mag', 6) + padL('rpm', 7) + '  proto',
  );
  for (const a of WEAPON_ARCHETYPES) {
    const r = resolveWeapon(
      { uid: 0, archetypeId: a.id, rarity: 'common', ilvl: 1, affixes: [], name: a.name, locked: false },
      d.damageMult,
    );
    // DoT weapons read as weak on direct damage alone, which is the point of
    // showing both: the Censer's corrosion is most of its output.
    const dot = a.status && STATUS_DEFS[a.status.kind].dot ? a.status.magnitude * STATUS_DEFS[a.status.kind].maxStacks : 0;
    console.log(
      pad(a.name, 13) +
        pad(a.damageType, 12) +
        pad(a.behavior, 11) +
        padL(r.dps.toFixed(0), 8) +
        padL(dot > 0 ? dot.toFixed(0) : '—', 8) +
        padL(r.magazine, 6) +
        padL(((60 * TICK_HZ) / r.fireInterval).toFixed(0), 7) +
        (a.prototype ? '  yes' : '  —'),
    );
  }
  console.log('\n(dot = damage per second at maximum stacks, on top of dps)');

  console.log('\nHOSTILES — effective HP and time to kill with the starting Adze\n');
  const weapon = d.weapon!;
  const perShot = weapon.damage * weapon.pellets * (1 + weapon.critChance * (weapon.critMult - 1));
  const ticksPerShot = Math.round((weapon.magazine * weapon.fireInterval + weapon.reloadTicks) / weapon.magazine);
  console.log(pad('hostile', 18) + padL('shield', 8) + padL('armor', 8) + padL('health', 8) + padL('ehp', 8) + padL('ttk', 8));
  for (const e of ENEMY_DEFS) {
    const ttk = ticksToKill(makeDefences(e.defences), perShot, weapon.damageType, ticksPerShot);
    console.log(
      pad(e.name, 18) +
        padL(e.defences.shieldMax, 8) +
        padL(e.defences.armorMax, 8) +
        padL(e.defences.healthMax, 8) +
        padL(effectiveHp(e), 8) +
        padL(`${(ttk / TICK_HZ).toFixed(1)}s`, 8),
    );
  }

  const boss = getBoss('kiln-warden');
  const bossTtk = ticksToKill(makeDefences(boss.defences), perShot, weapon.damageType, ticksPerShot, TICK_HZ * 3600);
  console.log(
    `\n${boss.name}: ${boss.defences.shieldMax} shield / ${boss.defences.armorMax} armour / ${boss.defences.healthMax} health` +
      ` — ${(bossTtk / TICK_HZ).toFixed(0)}s of uninterrupted uptime with the starting kit, before weak points.\n`,
  );
}

/* --------------------------------- bench ---------------------------------- */

function bench(): void {
  console.log('\nBENCH\n');

  const combat: Session = newSession(9, T0);
  landInZone(combat, 'ochre-shelf');
  for (let i = 0; i < 4000; i++) tickSession(combat, botInput(combat, i), 1);
  let start = performance.now();
  const TICKS = 40_000;
  for (let i = 0; i < TICKS; i++) tickSession(combat, botInput(combat, i), 1);
  let ms = performance.now() - start;
  console.log(`deployed  ${TICKS} ticks in ${ms.toFixed(0)}ms  =  ${((ms / TICKS) * 1000).toFixed(1)}us/tick`);
  console.log(`          real-time cost at ${TICK_HZ}Hz: ${(((ms / TICKS) * TICK_HZ) / 10).toFixed(2)}% of one core`);

  const docked: Session = newSession(9, T0);
  docked.state.zones['ochre-shelf']!.cleared = true;
  assignRoute(docked.state, 'ochre-shelf');
  start = performance.now();
  for (let i = 0; i < 4000; i++) tickSession(docked, NEUTRAL_INPUT, 10);
  ms = performance.now() - start;
  console.log(`docked    ${4000 * 10} ticks in ${ms.toFixed(0)}ms  =  ${((ms / (4000 * 10)) * 1000).toFixed(2)}us/tick`);
  console.log(`          real-time cost at ${TICK_HZ}Hz: ${(((ms / (4000 * 10)) * TICK_HZ) / 10).toFixed(3)}% of one core`);

  const off = newSession(9, T0);
  off.state.zones['ochre-shelf']!.cleared = true;
  assignRoute(off.state, 'ochre-shelf');
  start = performance.now();
  resolveOffline(off.state, T0 + 48 * 3_600_000, { method: 'closed', capHoursOverride: 1e6 });
  ms = performance.now() - start;
  console.log(`offline   48h resolved closed-form in ${ms.toFixed(1)}ms`);
  console.log(`\nheap after all three: ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)}MB\n`);
}

/* ---------------------------------- main ---------------------------------- */

switch (command) {
  case 'soak':
    soak(Number(flag('seeds', '8')));
    break;
  case 'route':
    route(Number(flag('hours', '8')));
    break;
  case 'parity':
    parity(flag('hours', '0.25,1,4').split(',').map(Number));
    break;
  case 'balance':
    balance();
    break;
  case 'bench':
    bench();
    break;
  default:
    console.log(`
cenotaph headless runner

  soak    [--seeds N]      scripted zone clears; reports clear rate and pacing
  route   [--hours H]      idle route yields over a period
  parity  [--hours a,b,c]  stepwise vs closed-form offline, hash compared
  balance                  damage matrix, weapon table, hostile TTK
  bench                    sim cost per tick, deployed and docked
`);
}
