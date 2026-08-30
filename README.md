# Cenotaph

A dual-mode idle RPG. You crew a salvage vessel across a chain of sun-scorched
worlds — mining materials, running scans, and killing escalating bosses for loot.
Playable full-screen and hands-on, or docked to the corner of your desktop
running itself.

This repository is the **Tier 1 prototype** from the build brief: one planet, one
zone, one boss, three weapons, mining and scanning, both window modes working,
and offline progression that provably matches live play.

---

## What is actually built

| Brief requirement | State |
|---|---|
| Deterministic headless sim, three render targets | Done. `src/sim` has zero platform imports; full, widget and none are subscriber sets over one host. |
| Offline progress = the same sim, never a second economy | Done, and tested. Stepwise and closed-form resolvers share one function and are compared by canonical state hash. |
| One zone, one boss, three weapons | Done. The Ochre Shelf, the Kiln Warden (3 phases, 3 weak points), Adze / Thurible / Censer. |
| Layered defences with type interactions | Done. shield → armour → health, four damage types, spill-over between layers. |
| Loot: 5 rarities, rolls on authored bases, signature boss drop | Done. No code path can invent a base item. |
| Frameless always-on-top widget, corner-snapped, hover-expand | Done, and asserted by `npm run smoke` against the real window. |
| Versioned, migration-safe, corruption-recovering saves | Done. Atomic writes, three rolling backups, checksum, explicit repair pass. |
| Big-number formatting from day one | Done. K/M/B/T → aa/ab, with a scientific mode. |
| Prestige axis | Implemented; unlocks at level 25 and pays out on depth. |
| 10–14 bosses, 4–6 planets, full content set | Not in Tier 1 by design. The pipelines are data-driven and a second planet is authored and locked. |
| Audio | Not built. Only the widget's optional alert chime exists. |

## Running it

```bash
npm install
npm start          # build and launch the game
```

```bash
npm test           # 69 tests: parity, determinism, combat, loot, saves, storage
npm run smoke      # boots the real app, plays it, asserts the window contract
npm run sim -- balance   # damage matrix, weapon table, hostile TTK
npm run sim -- soak      # scripted zone clears, headless, no renderer
npm run sim -- route     # idle yields over a period
npm run sim -- parity    # stepwise vs closed-form offline, hash compared
npm run sim -- bench     # sim cost per tick, deployed and docked
```

On a headless Linux box `npm run smoke` wraps itself in `xvfb-run`.

## Controls

`A`/`D` move · `Space` jump · `Shift` dodge (i-frames) · mouse aim · left click fire
`R` reload · `E` channel a deposit or scan site · `1`/`2`/`3` weapon slots
`F` call the boss once the gate is met · `Esc` return to ship · `` ` `` dock to corner

Minimising the game window docks it to the corner rather than dropping it in the
taskbar.

## Measured, not asserted

From `npm run sim` on this build:

```
soak      6/6 clear rate, mean run 166s, mean boss fight 88s
          (reference bot, starting kit, no upgrades — the floor, not the target)
bench     deployed 0.9us/tick   = 0.004% of one core at 40Hz
          docked   0.16us/tick  = 0.001% of one core at 40Hz
          48h of offline resolved closed-form in 6.2ms, 7MB heap
parity    every duration tested matches by state hash, exactly
```

The sim is not what will cost you 3% CPU in widget mode — Chromium is. The
budget is spent on the compositor, which is why the widget throttles snapshots,
skips painting when hidden, and uses no CSS animation.

## Layout

```
src/sim/         pure simulation — no DOM, no Node, no engine types
  content/       all authored data: weapons, enemies, bosses, zones, tech, ship
src/main/        Electron host: sim clock, windows, storage, command surface
src/preload/     the renderer's entire view of the outside world (.mts, see note)
src/renderer/    full-mode shell and canvas view; the corner widget
src/headless/    CLI and the scripted reference bot
test/            69 tests
docs/            DESIGN.md (decisions, answers to the brief's open questions)
                 ARCHITECTURE.md (the contracts the tests enforce)
```

## The one deviation from the brief

The brief says Godot 4 or Unity 6. This is TypeScript and Electron. That is a
real departure and `docs/DESIGN.md` argues it properly, including the port path
and what it would cost. The short version: the widget is the defining feature and
Electron is the only stack where it is a solved problem rather than a plugin, and
`src/sim` is written to be portable precisely because the renderer might not be.
