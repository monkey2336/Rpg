# Cenotaph

A dual-mode idle RPG. You crew a salvage vessel across a chain of sun-scorched
worlds — mining materials, running scans, and killing escalating bosses for loot.
Playable full-screen and hands-on as a third-person shooter, or docked to the
corner of your desktop running itself.

This repository is the **Tier 1 prototype** from the build brief: one planet, one
zone, one boss, three weapons, mining and scanning, both window modes working,
and offline progression that provably matches live play.

---

## What is actually built

| Brief requirement | State |
|---|---|
| Deterministic headless sim, three render targets | Done. `src/sim` has zero platform imports; full, widget and none are subscriber sets over one host. |
| Third-person 3D combat | Done. WebGL via Three.js: shadow-mapped sun, fogged depth, procedural meshes and environment, pooled effects. No art assets. |
| Offline progress = the same sim, never a second economy | Done, and tested. Stepwise and closed-form resolvers share one function and are compared by canonical state hash. |
| One zone, one boss, three weapons | Done. The Ochre Shelf, the Kiln Warden (3 phases, 3 weak points), Adze / Thurible / Censer. |
| Layered defences with type interactions | Done. shield → armour → health, four damage types, spill-over between layers. |
| Loot: 5 rarities, rolls on authored bases, signature boss drop | Done. No code path can invent a base item. |
| Frameless always-on-top widget, corner-snapped, hover-expand | Done, and asserted by `npm run smoke` against the real window. |
| Versioned, migration-safe, corruption-recovering saves | Done. Atomic writes, three rolling backups, checksum, explicit repair pass. |
| Big-number formatting from day one | Done. K/M/B/T → aa/ab, with a scientific mode. |
| Prestige axis | Implemented; unlocks at level 25 and pays out on depth. |
| 10–14 bosses, 4–6 planets, full content set | Not in Tier 1 by design. The pipelines are data-driven and a second planet is authored and locked. |
| Audio | Weapon feel and combat audio built, procedurally synthesised — no sample files. Score and per-planet identity not built. |

## Running it

```bash
npm install
npm start          # build and launch the game
```

```bash
npm test           # 86 tests: parity, determinism, arena geometry, hitstop, combat, loot, saves
npm run smoke      # boots the real app, plays it, asserts the window contract,
                   # and renders every audio cue offline to check it is audible
npm run sim -- balance   # damage matrix, weapon table, hostile TTK
npm run sim -- soak      # scripted zone clears, headless, no renderer
npm run sim -- route     # idle yields over a period
npm run sim -- parity    # stepwise vs closed-form offline, hash compared
npm run sim -- bench     # sim cost per tick, deployed and docked
```

On a headless Linux box `npm run smoke` wraps itself in `xvfb-run`.

## Controls

Click the view to take the controls (pointer lock).

`W A S D` move · mouse look · left click fire · `Space` jump · `Shift` dodge (i-frames)
`R` reload · `E` channel a deposit or scan site · `1`/`2`/`3` weapon slots
`F` call the boss once the gate is met · `Esc` return to ship · `` ` `` dock to corner

Aiming is camera-driven: the reticle is dead centre and the shot goes where you
look. Movement is camera-relative, and the sim resolves it that way — the
camera's heading is part of the input frame, not something the renderer keeps to
itself. Recoil moves your actual aim, not just the view, so a burst has to be
fought.

Minimising the game window docks it to the corner rather than dropping it in the
taskbar.

## Measured, not asserted

From `npm run sim` on this build:

```
soak      6/6 clear rate, mean run 178s, mean boss fight 95s
          (reference bot, starting kit, no upgrades — the floor, not the target)
bench     deployed 1.4us/tick   = 0.01% of one core at 40Hz
          docked   0.22us/tick  = 0.001% of one core at 40Hz
          48h of offline resolved closed-form in 8.9ms, 6MB heap
parity    every duration tested matches by state hash, exactly
smoke     11 window-and-audio assertions against the running app;
          21 audio cues rendered offline, peak 0.03-0.92, 0.05s-1.64s
```

Runs got ~10% longer when hitstop landed, which is the point: the world now
freezes for a few hundredths of a second on a solid connect.

The sim is not what will cost you 3% CPU in widget mode — Chromium is. The
budget is spent on the compositor, which is why the widget throttles snapshots,
skips painting when hidden, and uses no CSS animation.

## Layout

```
src/sim/         pure simulation — no DOM, no Node, no engine types
  content/       all authored data: weapons, enemies, bosses, zones, tech, ship
src/main/        Electron host: sim clock, windows, storage, command surface
src/preload/     the renderer's entire view of the outside world (.mts, see note)
src/renderer/    full-mode shell, 3D scene, actors and effects; the corner widget
  vendor/        Three.js, vendored (file:// page, script-src 'self', no network)
src/headless/    CLI and the scripted reference bot
test/            86 tests
docs/            DESIGN.md (decisions, answers to the brief's open questions)
                 ARCHITECTURE.md (the contracts the tests enforce)
```

## What the move to 3D proved

This started as a 2.5D side-scroller — that was the answer to the brief's open
question #1, and it was overruled. Converting the whole game to third-person 3D
touched **5 simulation files and zero economy files**:

| | |
|---|---|
| Changed | `arena.ts`, `types.ts`, `snapshot.ts`, and the two content files carrying body geometry |
| Byte-identical | `combat`, `loot`, `route`, `offline`, `derive`, `state`, `save`, `rng`, `numbers`, `hash`, `trig` |
| Tests changed | 0 · **69 / 69 passing after**, offline parity included |
| Tests added since | 17, covering 3D geometry and hitstop — 86 total |

Geometry lives in the arena; the economy is dimensionless, so a change of
*dimension* could not reach it. That is what locking the architecture before
content buys, and it is the reason a request to rebuild the game in 3D was a
renderer rewrite rather than a project restart.

## The one deviation from the brief

The brief says Godot 4 or Unity 6. This is TypeScript and Electron. That is a
real departure and `docs/DESIGN.md` argues it properly, including the port path
and what it would cost. The short version: the widget is the defining feature and
Electron is the only stack where it is a solved problem rather than a plugin, and
`src/sim` is written to be portable precisely because the renderer might not be.
