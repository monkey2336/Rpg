/**
 * The boss pipeline, and the travel layer that makes bosses reachable.
 *
 * The point of a second and third boss is to prove the phase machine
 * generalises. These tests hold that: the timed-window mechanic, the escort
 * ward, and the escort respawn are all data-driven, so they are tested through
 * the data rather than through one boss's hardcoded special case.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { BOSS_DEFS, PATTERNS, getBoss } from '../src/sim/content/bosses.js';
import { PLANETS, ZONES, getZone, nextZoneAfter, travelCost } from '../src/sim/content/zones.js';
import { SIGNATURES } from '../src/sim/content/items.js';
import { getEnemy } from '../src/sim/content/enemies.js';
import { NEUTRAL_INPUT, bossIsWarded, createArena, playerEntity, stepArena, summonBoss, type ArenaState, type StepContext } from '../src/sim/arena.js';
import { derive } from '../src/sim/derive.js';
import { createNewGame } from '../src/sim/state.js';
import { landInZoneChecked, newSession, tickSession, travelCostFor } from '../src/sim/sim.js';

const T0 = 1_700_000_000_000;

function arenaFor(zoneId: string): { a: ArenaState; ctx: StepContext } {
  const state = createNewGame(99, T0);
  const d = derive(state);
  const a = createArena(zoneId, 7, state.player.defences, 1);
  return {
    a,
    ctx: {
      weapon: d.weapon,
      moveSpeed: d.moveSpeed,
      miningYield: d.miningYield,
      scanSpeed: d.scanSpeed,
      armorRegen: d.armorRegen,
      killRecovery: d.killRecovery,
      gate: getZone(zoneId).gate,
    },
  };
}

/** Opens the gate and puts the boss on the field, with a loaded weapon. */
function withBoss(zoneId: string) {
  const { a, ctx } = arenaFor(zoneId);
  a.kills = 9999;
  a.minedCount = 9999;
  a.scannedCount = 9999;
  a.gateMet = true;
  assert.ok(summonBoss(a), `${zoneId} should have a boss to summon`);
  const boss = a.entities.find((e) => e.kind === 'boss')!;
  // The magazine starts empty and the Adze reloads for 68 ticks. A test that
  // fires for fewer ticks than that fires nothing at all and passes for the
  // wrong reason, so loading it is part of the fixture rather than a detail
  // each test has to remember.
  a.player.ammo = ctx.weapon?.magazine ?? 6;
  a.player.reloadLeft = 0;
  return { a, ctx, boss };
}

/**
 * Fires until `shots` rounds have actually left the barrel, reporting what the
 * shots produced. Counting shots rather than ticks is the difference between a
 * test that fires and one that sits through a reload and asserts nothing.
 */
function fireShots(a: ArenaState, ctx: StepContext, shots: number) {
  let fired = 0;
  const seen: Record<string, number> = {};
  for (let i = 0; i < 2000 && fired < shots; i++) {
    const events = stepArena(a, { ...NEUTRAL_INPUT, fire: true, aimYaw: 0, aimPitch: 0.3 }, ctx);
    for (const e of events) seen[e.type] = (seen[e.type] ?? 0) + 1;
    fired += events.filter((e) => e.type === 'shot').length;
  }
  return { fired, seen };
}

const step = (a: ArenaState, ctx: StepContext, n = 1) => {
  for (let i = 0; i < n; i++) stepArena(a, NEUTRAL_INPUT, ctx);
};

describe('boss content', () => {
  it('every boss is well formed', () => {
    for (const b of BOSS_DEFS) {
      assert.ok(b.phases.length >= 3, `${b.id} needs at least three phases`);
      assert.ok(b.weakPoints.length >= 2, `${b.id} needs weak points`);
      assert.ok(SIGNATURES[b.signatureDrop], `${b.id} has no signature drop`);
      assert.ok(getZone(b.zoneId), `${b.id} points at a zone that does not exist`);
      assert.equal(getZone(b.zoneId).bossId, b.id, `${b.zoneId} does not point back at ${b.id}`);

      // Phases must descend, or the transition search picks the wrong one.
      for (let i = 1; i < b.phases.length; i++) {
        assert.ok(
          b.phases[i]!.atHealthFraction < b.phases[i - 1]!.atHealthFraction,
          `${b.id} phase ${i} does not come after phase ${i - 1}`,
        );
      }
      // Every phase must change a mechanic, not just a number.
      for (let i = 1; i < b.phases.length; i++) {
        const p = b.phases[i]!;
        const q = b.phases[i - 1]!;
        const changed =
          p.exposes.join() !== q.exposes.join() ||
          p.spawns.length !== q.spawns.length ||
          p.arenaDps !== q.arenaDps ||
          p.patterns.join() !== q.patterns.join() ||
          (p.gravityMult ?? 1) !== (q.gravityMult ?? 1) ||
          !!p.window !== !!q.window ||
          !!p.invulnerableWhileAdds !== !!q.invulnerableWhileAdds;
        assert.ok(changed, `${b.id} phase ${i} only changes numbers`);
      }
      // Everything a phase references must exist.
      for (const p of b.phases) {
        for (const id of p.patterns) assert.ok(PATTERNS[id], `${b.id} references unknown pattern ${id}`);
        for (const s of p.spawns) assert.doesNotThrow(() => getEnemy(s.defId), `${b.id} spawns unknown ${s.defId}`);
        const known = new Set(b.weakPoints.map((w) => w.id));
        for (const id of p.exposes) assert.ok(known.has(id), `${b.id} exposes unknown weak point ${id}`);
        if (p.window) assert.ok(known.has(p.window.weakPointId), `${b.id} window names unknown ${p.window.weakPointId}`);
      }
    }
  });

  it('the three bosses are mechanically distinct, not reskins', () => {
    // The brief's bar is that a phase changes a mechanic. This checks the
    // stronger property across bosses: each one owns a mechanic the others
    // do not lean on.
    const usesWindow = BOSS_DEFS.filter((b) => b.phases.some((p) => !!p.window)).map((b) => b.id);
    const usesPull = BOSS_DEFS.filter((b) => b.phases.some((p) => !!p.window?.pull)).map((b) => b.id);
    const usesWard = BOSS_DEFS.filter((b) => b.phases.some((p) => p.invulnerableWhileAdds)).map((b) => b.id);
    const usesGravity = BOSS_DEFS.filter((b) => b.phases.some((p) => p.gravityMult !== undefined)).map((b) => b.id);
    assert.deepEqual(usesPull, ['the-bellows']);
    assert.deepEqual(usesWard, ['the-choir']);
    assert.deepEqual(usesGravity, ['the-choir']);
    assert.ok(usesWindow.length >= 2, 'the window mechanic should be shared, not bespoke');
  });
});

describe('phase mechanics', () => {
  it('a timed window opens the named weak point and closes again', () => {
    const { a, ctx, boss } = withBoss('ochre-shelf');
    const win = getBoss('kiln-warden').phases[0]!.window!;
    const vents = () => boss.weakPoints.find((w) => w.id === win.weakPointId)!;

    assert.equal(vents().exposed, false, 'a phase must not start mid-window');
    step(a, ctx, win.periodTicks + 2);
    assert.equal(vents().exposed, true, 'the window should have opened');
    step(a, ctx, win.openTicks + 2);
    assert.equal(vents().exposed, false, 'the window should have closed again');
  });

  it('the Bellows drags the player in while its throat is open', () => {
    const { a, ctx, boss } = withBoss('the-throats');
    const p = playerEntity(a);
    const win = getBoss('the-bellows').phases[0]!.window!;
    assert.ok(win.pull, 'the Bellows window should pull');

    p.x = boss.x + 400;
    p.z = boss.z;
    const before = Math.abs(p.x - boss.x);
    step(a, ctx, win.periodTicks + 20);
    const after = Math.abs(p.x - boss.x);
    assert.ok(after < before - 10, `expected to be pulled in: ${before} -> ${after}`);
  });

  it('a warded boss takes nothing until its escort is dead', () => {
    const { a, ctx, boss } = withBoss('lantern-derelict');
    assert.ok(bossIsWarded(a, boss), 'the Choir should start warded by its pylons');

    const before = boss.def.shield + boss.def.armor + boss.def.health;
    const p = playerEntity(a);
    p.x = boss.x - 120;
    p.z = boss.z;
    boss.iframes = 0;
    const { fired, seen } = fireShots(a, ctx, 8);
    assert.ok(fired >= 8, `the test must actually fire; only ${fired} shots left the barrel`);
    assert.equal(boss.def.shield + boss.def.armor + boss.def.health, before, 'a warded boss must take nothing');
    // The shots reached it and were turned away — the distinction between the
    // ward working and the test simply missing.
    assert.ok((seen.warded ?? 0) > 0, 'the shots should have been deflected, not missed');
    assert.equal(seen.hit ?? 0, 0, 'nothing should have registered as a hit');

    // Clear the escort and it becomes a target.
    for (const e of a.entities) if (e.faction === 'hostile' && e.kind !== 'boss') e.dead = true;
    assert.equal(bossIsWarded(a, boss), false);
  });

  it('the escort only returns after it has been fully cleared', () => {
    const { a, ctx, boss } = withBoss('lantern-derelict');
    const phase = getBoss('the-choir').phases[0]!;
    const escort = () => a.entities.filter((e) => e.faction === 'hostile' && !e.dead && e.kind !== 'boss').length;
    const wanted = phase.spawns.reduce((n, s) => n + s.count, 0);
    assert.equal(escort(), wanted);

    // Kill all but one and wait out the full respawn period. Nothing should
    // come back: a free-running timer here made the boss permanently immune.
    const alive = a.entities.filter((e) => e.faction === 'hostile' && e.kind !== 'boss');
    for (let i = 1; i < alive.length; i++) alive[i]!.dead = true;
    step(a, ctx, phase.respawnTicks! + 40);
    assert.equal(escort(), 1, 'a partly-cleared escort must not top itself up');

    // Clear the last one; now the countdown runs and it returns.
    alive[0]!.dead = true;
    step(a, ctx, 5);
    assert.equal(escort(), 0, 'clearing the escort must open a window');
    step(a, ctx, phase.respawnTicks! + 40);
    assert.equal(escort(), wanted, 'the escort should return after the window');
    void boss;
  });

  it('a phase can change the arena\'s gravity', () => {
    const { a, ctx, boss } = withBoss('lantern-derelict');
    const phases = getBoss('the-choir').phases;
    assert.equal(phases[0]!.gravityMult, undefined, 'the first phase should not touch gravity');
    assert.ok(phases[2]!.gravityMult !== undefined, 'the last phase should');

    step(a, ctx, 3);
    assert.equal(a.gravityMult, 1, 'gravity is normal until a phase says otherwise');

    // The escort has to go first — a warded boss takes nothing, so damaging it
    // into its last phase is not possible while a pylon still stands.
    for (const e of a.entities) if (e.faction === 'hostile' && e.kind !== 'boss') e.dead = true;
    boss.def.shield = 0;
    boss.def.armor = 0;
    boss.def.health = boss.def.healthMax * 0.2;
    boss.iframes = 0;
    const p = playerEntity(a);
    p.x = boss.x - 120;
    p.z = boss.z;
    fireShots(a, ctx, 3);
    assert.equal(boss.phase, 2, 'it should have dropped into Jettison');
    step(a, ctx, 3);
    assert.equal(a.gravityMult, phases[2]!.gravityMult, 'the failing grav plating should be in effect');
  });
});

describe('travel', () => {
  it('zones open in order, planet by planet', () => {
    for (const planet of PLANETS) {
      for (let i = 0; i < planet.zones.length - 1; i++) {
        assert.equal(nextZoneAfter(planet.zones[i]!), planet.zones[i + 1]!);
      }
    }
    // The last zone of a planet opens the first zone of the next.
    const last = PLANETS[0]!.zones[PLANETS[0]!.zones.length - 1]!;
    assert.equal(nextZoneAfter(last), PLANETS[1]!.zones[0]!);
    // And the final zone in the game opens nothing.
    const finalPlanet = PLANETS[PLANETS.length - 1]!;
    assert.equal(nextZoneAfter(finalPlanet.zones[finalPlanet.zones.length - 1]!), null);
  });

  it('every zone is reachable from the start', () => {
    const start = ZONES.find((z) => z.id === 'ochre-shelf')!;
    const seen = new Set<string>([start.id]);
    let cur: string | null = start.id;
    while (cur) {
      cur = nextZoneAfter(cur);
      if (cur) seen.add(cur);
    }
    assert.equal(seen.size, ZONES.length, `unreachable zones: ${ZONES.filter((z) => !seen.has(z.id)).map((z) => z.id)}`);
  });

  it('travel within a planet is free and crossing costs fuel', () => {
    assert.equal(travelCost('ochre-shelf', 'the-throats'), 0);
    assert.ok(travelCost('ochre-shelf', 'grey-flats') > 0);
  });

  it('fuel gates a crossing and refills while docked', () => {
    const session = newSession(5, T0);
    for (const z of Object.keys(session.state.zones)) session.state.zones[z]!.discovered = true;
    const cost = travelCostFor(session, 'grey-flats');
    assert.ok(cost > 0);

    session.state.resources.fuel = cost - 1;
    assert.equal(landInZoneChecked(session, 'grey-flats'), 'no-fuel');

    session.state.resources.fuel = cost;
    assert.equal(landInZoneChecked(session, 'grey-flats'), 'ok');
    assert.equal(session.state.resources.fuel, 0, 'the crossing should have spent the fuel');

    // Docked, it comes back on its own.
    session.arena = null;
    session.mode = 'ship';
    tickSession(session, NEUTRAL_INPUT, 40 * 60);
    assert.ok(session.state.resources.fuel > 10, `expected refuelling, got ${session.state.resources.fuel}`);
  });

  it('refuelling is the same whether time passed live or batched', () => {
    // The docked fast path skips the per-tick loop, so it has to refuel too.
    const mk = () => {
      const s = newSession(5, T0);
      s.state.resources.fuel = 0;
      return s;
    };
    const stepped = mk();
    for (let i = 0; i < 4000; i++) tickSession(stepped, NEUTRAL_INPUT, 1);
    const batched = mk();
    for (let i = 0; i < 100; i++) tickSession(batched, NEUTRAL_INPUT, 40);
    assert.ok(Math.abs(stepped.state.resources.fuel - batched.state.resources.fuel) < 1e-6);
  });
});
