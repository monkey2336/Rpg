/**
 * Two things a run must never do: throw away the approach when you die, and
 * hand you loot you never see.
 *
 * Both were reported from play rather than found here, which is the point of
 * writing them down. "I am unable to clear an area" was not a difficulty
 * problem — dying rebuilt the arena from scratch, so twenty of twenty-four
 * kills became zero of twenty-four and the crossing charged its fuel again.
 * And every weapon a kill rolled went straight into a list, so the loot in a
 * loot game was a line of text that scrolled past.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  createArena,
  NEUTRAL_INPUT,
  playerEntity,
  revivePlayer,
  spawnDrop,
  stepArena,
  summonBoss,
  type ArenaState,
  type StepContext,
} from '../src/sim/arena.js';
import { getZone } from '../src/sim/content/zones.js';
import { derive } from '../src/sim/derive.js';
import { createNewGame } from '../src/sim/state.js';

const T0 = 1_700_000_000_000;

function fixture(zoneId = 'ochre-shelf'): { a: ArenaState; ctx: StepContext; defences: ReturnType<typeof derive>['weapon'] extends never ? never : any } {
  const state = createNewGame(4242, T0);
  const d = derive(state);
  const a = createArena(zoneId, 1234, state.player.defences, 1);
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
    defences: { ...state.player.defences },
  };
}

const step = (a: ArenaState, ctx: StepContext, n = 1, input: Partial<typeof NEUTRAL_INPUT> = {}) => {
  for (let i = 0; i < n; i++) stepArena(a, { ...NEUTRAL_INPUT, ...input }, ctx);
};

/** Kills the player outright, the way a boss slam does. */
function knockDown(a: ArenaState, ctx: StepContext): void {
  const p = playerEntity(a);
  p.def.health = 0;
  p.def.shield = 0;
  p.def.armor = 0;
  step(a, ctx, 1);
  assert.equal(a.outcome, 'down', 'setup failed: the player should be down');
}

describe('getting up', () => {
  it('keeps every scrap of gate progress', () => {
    const { a, ctx, defences } = fixture();
    a.kills = 20;
    a.minedCount = 2;
    a.scannedCount = 1;
    knockDown(a, ctx);

    assert.ok(revivePlayer(a, defences), 'revive should succeed on a downed player');
    assert.equal(a.outcome, 'running');
    assert.equal(a.kills, 20, 'kills must survive a death');
    assert.equal(a.minedCount, 2, 'mined deposits must survive a death');
    assert.equal(a.scannedCount, 1, 'scans must survive a death');
  });

  it('puts the player back at full strength, briefly untouchable', () => {
    const { a, ctx, defences } = fixture();
    knockDown(a, ctx);
    revivePlayer(a, defences);
    const p = playerEntity(a);
    assert.equal(p.dead, false);
    assert.equal(p.def.health, defences.healthMax);
    assert.ok(p.iframes > 40, `expected real grace on standing up, got ${p.iframes} ticks`);
  });

  it('clears the air so a revive cannot land back in the attack that killed you', () => {
    const { a, ctx, defences } = fixture();
    // The first wave lands at tick 90; before that the terrace is empty.
    step(a, ctx, 100);
    knockDown(a, ctx);
    // Something hostile standing on the body, and live ordnance inbound.
    const p = playerEntity(a);
    const hostile = a.entities.find((e) => e.faction === 'hostile' && !e.dead);
    assert.ok(hostile, 'setup failed: no hostile on the field');
    hostile!.x = p.x + 4;
    hostile!.z = p.z + 4;
    a.projectiles.push({
      id: 9001, ownerId: hostile!.id, faction: 'hostile',
      x: p.x, y: p.y + 20, z: p.z, vx: 0, vy: 0, vz: 0,
      damage: 999, damageType: 'percussive', radius: 12, ticksLeft: 60,
      gravity: 0, pierce: 0, travelled: 0, crit: false,
    });

    revivePlayer(a, defences);

    assert.equal(
      a.projectiles.filter((pr) => pr.faction === 'hostile').length,
      0,
      'hostile ordnance in the air must not survive the revive',
    );
    const gap = Math.hypot(hostile!.x - p.x, hostile!.z - p.z);
    assert.ok(gap > 100, `hostile was left ${gap.toFixed(0)} units away; it should be shoved clear`);
  });

  it('sends the boss away but leaves the gate open', () => {
    const { a, ctx, defences } = fixture();
    a.kills = 999;
    a.minedCount = 999;
    a.scannedCount = 999;
    step(a, ctx, 1);
    assert.ok(a.gateMet, 'setup failed: gate should be met');
    assert.ok(summonBoss(a), 'setup failed: boss should spawn');

    knockDown(a, ctx);
    revivePlayer(a, defences);

    assert.equal(a.bossSpawned, false, 'the boss must withdraw — a set-piece starts from a known state');
    assert.equal(a.gateMet, true, 'the approach must not have to be redone to call it again');
    assert.ok(summonBoss(a), 'the boss must be callable again immediately');
  });

  it('refuses to revive someone who is not down', () => {
    const { a, ctx, defences } = fixture();
    step(a, ctx, 1);
    assert.equal(revivePlayer(a, defences), false);
  });
});

describe('drops on the ground', () => {
  it('lands where the kill happened, then comes to you', () => {
    const { a, ctx } = fixture();
    const p = playerEntity(a);
    spawnDrop(a, 77, 'relic', p.x + 150, 40, p.z);
    assert.equal(a.drops.length, 1);
    assert.equal(a.drops[0]!.rarity, 'relic', 'rarity is the one thing the arena needs to know');

    const before = Math.hypot(a.drops[0]!.x - p.x, a.drops[0]!.z - p.z);
    step(a, ctx, 6);
    // Reaching the player and being collected are the same success.
    const first = a.drops[0];
    const after = first === undefined ? 0 : Math.hypot(first.x - p.x, first.z - p.z);
    assert.ok(after < before, `drop should close on the player: ${before.toFixed(0)} → ${after.toFixed(0)}`);
  });

  it('is picked up, and says which one it was', () => {
    const { a, ctx } = fixture();
    const p = playerEntity(a);
    spawnDrop(a, 77, 'relic', p.x + 120, 40, p.z);

    let pickup: { id: number } | undefined;
    for (let i = 0; i < 90 && !pickup; i++) {
      const events = stepArena(a, { ...NEUTRAL_INPUT }, ctx);
      pickup = events.find((e) => e.type === 'pickup');
    }
    assert.ok(pickup, 'a drop within magnet range must reach the player');
    assert.equal(pickup!.id, 77, 'the pickup has to name the item, or nothing can be announced');
    assert.equal(a.drops.length, 0, 'a collected drop must leave the field');
  });

  it('does not chase a player who is down', () => {
    const { a, ctx } = fixture();
    const p = playerEntity(a);
    spawnDrop(a, 77, 'common', p.x + 60, 40, p.z);
    knockDown(a, ctx);
    const at = { x: a.drops[0]!.x, z: a.drops[0]!.z };
    step(a, ctx, 20);
    assert.equal(a.drops.length, 1, 'a corpse does not collect loot');
    assert.equal(Math.round(a.drops[0]!.x), Math.round(at.x));
    assert.equal(Math.round(a.drops[0]!.z), Math.round(at.z));
  });

  it('falls to the ground rather than hanging in the air', () => {
    const { a, ctx } = fixture();
    const p = playerEntity(a);
    // Well outside magnet range, so gravity is the only thing acting on it.
    spawnDrop(a, 77, 'common', p.x + 520, 220, p.z);
    step(a, ctx, 60);
    const d = a.drops[0];
    assert.ok(d, 'a drop out of reach should still be there');
    assert.ok(d!.y <= 9, `expected it to settle on the sand, it is at y=${d!.y.toFixed(1)}`);
  });
});
