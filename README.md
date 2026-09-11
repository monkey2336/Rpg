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
| 10–14 bosses, 4–6 planets, full content set | Three bosses, three zones, two planets. The rest is authoring, not engineering — see below. |
| Travel layer: fuel as a soft cost | Done. Crossing planets costs fuel; it refills while docked. Same-planet travel is free. |
| Audio | Combat audio, weapon feel, and a drone score with a distinct bed per place — all synthesised at runtime, no sample files. |

## Running it on Windows

The brief says Windows first, and that is the primary target.

**Get a build.** Every push builds a Windows installer and a portable zip on a
real Windows runner — grab them from the Actions tab under the `windows`
workflow, artifact `cenotaph-windows`. `Cenotaph-0.1.0-x64.exe` is a normal
installer (Start Menu entry, desktop shortcut, choose your own install
directory); `Cenotaph-0.1.0-portable.exe` runs from anywhere.

Saves live in `%APPDATA%\Cenotaph\saves` and are **not** removed when you
uninstall.

**Windows will refuse to run it the first time.** The build is unsigned — code
signing needs a certificate that costs money and belongs to a real publisher —
so SmartScreen shows "Windows protected your PC". Click **More info**, then
**Run anyway**. There is no way around that short of buying a certificate, and
you should be suspicious of any unsigned executable you did not build yourself,
including this one: the honest reassurance is that you can read every line that
went into it and rebuild it yourself with `npm run pack:win`.

It also uses Electron's default icon. A real icon is an art task, and a
placeholder would be worse than none.

**Or build it yourself**, on Windows:

```bash
npm ci
npm run pack:win     # release/Cenotaph-0.1.0-x64.exe + portable
```

**Or just run it from source**, on any platform:

```bash
npm install
npm start            # build and launch the game
```

### What has and has not been verified on Windows

Honesty matters more here than reassurance. This was developed and tested on
Linux, so:

- **Verified**: the package layout. A packaged build (asar, vendored Three.js,
  ESM preload, `file://` renderer paths) boots and runs the full smoke suite —
  WebGL, all three bosses, correct widget geometry, every docked screen. That is
  the same layout the Windows build ships, and packaging is where this normally
  breaks.
- **Verified**: the whole simulation, on any platform, with no window at all.
  The Windows CI job runs the offline-parity check, a soak and the balance dump
  before it packages anything.
- **Not verified on real Windows**: the widget's transparent, frameless,
  always-on-top behaviour. It is written to the documented Windows contract —
  `screen-saver` always-on-top level so it sits above full-screen apps,
  `setIgnoreMouseEvents(forward)` for click-through, non-focusable so it never
  steals focus, corner-plus-offset placement so it survives a monitor being
  unplugged — but nobody has watched it do that on Windows. Transparent
  always-on-top windows are the part of Electron most likely to behave
  differently there, particularly with hardware acceleration disabled.

If the widget misbehaves on your machine, that is the first place to look, and
`src/main/windows.ts` is where every one of those flags lives.

## Running it

```bash
npm test           # 110 tests: parity, determinism, arena geometry, hitstop, bosses, travel, loot, saves
npm run smoke      # boots the real app, plays it, asserts the window contract,
                   # and renders every audio cue offline to check it is audible
npm run sim -- balance   # damage matrix, weapon table, hostile TTK
npm run sim -- soak -- --zone the-throats   # scripted clears of any zone, headless
npm run sim -- route     # idle yields over a period
npm run sim -- parity    # stepwise vs closed-form offline, hash compared
npm run sim -- bench     # sim cost per tick, deployed and docked
```

On a headless Linux box `npm run smoke` wraps itself in `xvfb-run`.

## Controls

Click anywhere in the game view to take the controls (pointer lock). `Esc`
releases the mouse; pressing it again while the cursor is free returns you to
the ship, so a reflex press of `Esc` never costs you a run.

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
soak      Kiln Warden  4/4 clears, boss fight 96s
          The Bellows  4/4 clears, boss fight 81s
          The Choir    5/5 clears, boss fight 83s
          (reference bot geared to each zone — the floor, not the target)
bench     deployed 1.4us/tick   = 0.01% of one core at 40Hz
          docked   0.22us/tick  = 0.001% of one core at 40Hz
          48h of offline resolved closed-form in 8.9ms, 6MB heap
parity    every duration tested matches by state hash, exactly
smoke     13 window, boss and audio assertions against the running app;
          22 cues rendered offline, peak 0.03-0.92, 0.05s-1.64s;
          3 score beds rendered and checked for being distinct from each other,
          not merely present (Sabb reads 3x duller than Khadir)
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
test/            110 tests
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
