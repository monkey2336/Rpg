/**
 * Public surface of the simulation.
 *
 * Everything a host (Electron main, the headless CLI, a test) needs is exported
 * from here, and nothing in this subtree imports anything platform-specific.
 * Porting the game to another engine means reimplementing the hosts, not this.
 */
export * from './types.js';
export * from './rng.js';
export * from './trig.js';
export * from './numbers.js';
export * from './hash.js';
export * from './combat.js';
export * from './loot.js';
export * from './derive.js';
export * from './state.js';
export * from './route.js';
export * from './offline.js';
export * from './arena.js';
export * from './sim.js';
export * from './save.js';
export * from './snapshot.js';
export * from './content/index.js';
export * from './content/ship.js';
