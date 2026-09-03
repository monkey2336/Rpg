# Architecture

The brief calls one decision "the single most important technical decision in the
project", to be locked before any content work: a fully headless-runnable
simulation, one deterministic sim behind three render targets, and offline
progress that resolves through the same maths as live play rather than a second
economy.

This document states that as a set of contracts, and points at the tests that
enforce each one. Everything here is checkable; none of it is a convention you
have to remember.

---

## 1. The layers

```
              ┌──────────────────────────────────────────────┐
              │  src/sim   pure, deterministic, no platform  │
              │  types, rng, trig, combat, loot, arena,      │
              │  route, offline, save, state, content/       │
              └───────────────────┬──────────────────────────┘
                                  │ snapshots out, commands + input in
              ┌───────────────────┴──────────────────────────┐
              │  src/main  the host: clock, storage, windows │
              └───┬───────────────────┬──────────────────┬───┘
                  │                   │                  │
           full renderer        widget renderer      no renderer
        (canvas + HUD)        (360x220 corner)     (CLI, tests, CI)
```

`src/sim` imports nothing from the DOM, Node or Electron. That is not a style
preference — it is what makes the third render target possible, and it is why
`npm run sim` can play the whole game with no window.

Data flows one way. Renderers receive snapshots and draw them. They mutate
nothing: every write goes through a named command in `src/main/commands.ts`,
which is the entire write surface of the game.

---

## 1b. Arena space

The arena is genuinely three-dimensional, and the convention is worth stating
once because it removes a whole class of sign-flip bugs at the sim/presentation
boundary:

- **y is up and positive.** The ground is `y = 0`.
- **x/z is the ground plane**, and the arena is a disc of radius 620 — a bounded
  corridor invites both actors to crab-walk into a corner, and a disc has none.
- **`yaw` is a heading measured with `atan2(dz, dx)`**, so yaw 0 faces +x.
- **Bodies are upright cylinders**: `radius` in the ground plane, `height` up
  from the feet. Cheap to test, and accurate enough that a shot which looks like
  it should connect does.
- **Weak-point offsets are local**: `ox` forward along the body's yaw, `oz` to
  its left, `oy` up from its feet, rotated into world space by `weakPointPos`.

Movement input is **camera-relative**, which is why `camYaw` is part of the input
frame rather than something presentation keeps to itself: the sim resolves
"forward" against the camera's heading, exactly as the player experiences it. The
headless bot drives this same path — it points a notional camera where it wants
to go and pushes forward — so the reference policy exercises the real code rather
than a shortcut.

### What the move to 3D proved

This project shipped a 2.5D side-scrolling arena first and then converted it to
third-person 3D. That conversion is the strongest evidence available that the
architecture was worth locking before content:

| | |
|---|---|
| Simulation files changed | 5 (`arena.ts`, `types.ts`, `snapshot.ts`, two content files) |
| Economy files changed | **0** |
| Tests changed | 0 |
| Tests passing after | 69 / 69 |
| Tests added since | 13, covering the new 3D geometry — 82 total |

`combat.ts`, `loot.ts`, `route.ts`, `offline.ts`, `derive.ts`, `state.ts`,
`save.ts`, `rng.ts`, `numbers.ts`, `hash.ts` and `trig.ts` are byte-identical
across the change. Geometry lives in the arena; the economy is dimensionless, so
a change of dimension could not reach it. The offline-parity guarantee never came
under threat because there is no code path by which it could.

---

## 2. Determinism

Same seed plus same inputs must give the same game, on every machine, forever.
Two rules make that true.

**Rule 1 — arithmetic.** Inside `src/sim`, only these are allowed: integer ops
via `Math.imul` and `>>>`, `+ - * /` on doubles, `Math.sqrt`, and
`Math.floor/ceil/min/max/abs`. All of those are exactly specified by IEEE 754 and
ECMAScript.

**`Math.sin`, `Math.cos`, `Math.atan2`, `Math.pow`, `Math.exp` and `Math.log` are
banned.** Their results are implementation-defined and two engines may differ in
the last few ulps — which is enough to desync a seeded sim and silently break the
offline parity guarantee that everything else rests on. `src/sim/trig.ts` provides
polynomial replacements built from allowed operations only, accurate to about
5e-8 against the native functions. Presentation code may use whatever it likes;
only `src/sim` is bound.

**Rule 2 — two generators, on purpose.**

- `Rng` (xoshiro128\*\*) is a stream. Serialisable, so a save resumes mid-stream.
  Used by live play, where order is fixed by the code path.
- `hash32` / `rngAt(seed, stream, index)` is counter-based. The value at an index
  is the same regardless of what order you ask for indices in.

The counter-based form is what lets the closed-form offline resolver produce
byte-identical results to the stepwise one without replaying a million ticks. It
is used for every discrete idle event.

> Enforced by `test/determinism.test.ts` — stream reproducibility, order
> independence of the counter form, `trig.ts` against the native functions, and a
> full scripted boss kill reproducing exactly.

---

## 3. One economy

**Contract: there is exactly one function that turns idle route cycles into game
state, and it is `resolveCycles` in `src/sim/route.ts`.**

Three callers, one function:

| Caller | How it calls |
|---|---|
| Live ticking, deployed | one cycle at a time, via `advanceRoute` |
| Live ticking, docked | batched per wake, via `advanceRoute` |
| Offline, stepwise | one cycle at a time |
| Offline, closed-form | one batch |

Batching equals stepping because of two properties, both deliberate:

1. **Bulk yields are integers**, computed once in `planCycle`. `n * y` is exact
   for integer `y` and equals `y` added `n` times. Floats would drift, and a
   drift of one part in 10¹⁵ per cycle is a visible discrepancy after a week.
2. **Discrete events are counter-indexed.** Cycle 900's drop is drawn from
   `rngAt(seed, stream, 900)`, so it is the same item whether you stepped there
   or asked for it directly.

There is a third, subtler property: **anything the resolution loop reads must be
captured on the `CyclePlan` before the loop starts.** Inventory slots and
breakdown yield live on the plan rather than being re-derived inside
`resolveCycles`, because a batch derives once and a stepwise pass derives per
cycle. Putting them on the plan makes parity a property of the type rather than a
thing to remember.

Combat time per cycle comes from `ticksToKill`, which runs the same `applyDamage`
the shooter runs, against the same enemy definitions and the same damage-type
matrix. A better loadout genuinely farms faster. There is no separate "idle DPS".

> Enforced by `test/offline-parity.test.ts` — eleven cases across durations,
> seeds, and the hold-overflow branch, plus the strongest form of the claim:
> ticking the game live for twelve minutes and closing the app for twelve minutes
> reach the same state.

---

## 4. Offline resolution

`resolveOffline(state, nowMs, { method })` advances a state to a wall-clock time.

- `stepwise` walks tick by tick through the code live play walks. Slow, and by
  definition correct, so it is the oracle. Refused past six simulated hours.
- `closed` computes the completed cycle count arithmetically and resolves the
  batch in one call. O(1) in bulk resources, O(cycles) in a cheap hash for
  discrete drops. 48 hours resolves in about 6ms.

`assertParity(state, elapsedMs)` runs both against clones and compares canonical
state hashes, reporting the first divergent path when they differ. It is exposed
in the game as a debug command, so the claim can be re-checked against a player's
actual save rather than only against test fixtures.

**If parity ever fails, the closed-form path is wrong.** The fix is the
closed-form path. It is never a tolerance.

Accrual is capped (48 hours, 72 with tech). Being capped is reported in the
offline panel, not silently applied.

---

## 5. The sim clock

The sim runs in the Electron main process, at a fixed 25ms step (40Hz, exact in
binary so tick accounting never drifts). It runs whether or not any window is
open.

Two cadences:

| State | Interval | Ticks per wake |
|---|---|---|
| Deployed (an arena is live) | 25ms | 1, with the current input frame |
| Docked (route only) | 250ms | 10, batched |

The docked cadence is the widget's entire performance story. There is no arena to
step, so the batch resolves through the same arithmetic the offline resolver
uses and the process sleeps between wakes. `npm run sim -- bench` measures
0.16µs/tick docked — about 0.001% of one core.

> Enforced by the `batched live ticking` case in `test/offline-parity.test.ts`:
> stepping 60,000 ticks one at a time and batching them 40 at a time reach the
> same state hash. The optimisation cannot become a third economy.

---

## 5b. Rendering

The 3D view is Three.js over WebGL2, vendored as a local file (`src/renderer/vendor/`)
because the renderer is a `file://` page under a `script-src 'self'` policy and
the game must run with no network. There is no bundler: the renderer is plain ES
modules, which keeps cold start cheap and the build a single `tsc` invocation.

Three rules keep it honest:

1. **It cannot reach the sim.** It reads an `ArenaSnapshot` and draws. The only
   state it keeps between frames is visual: camera easing, shake, effect pools,
   and a map of live meshes keyed by entity id.
2. **The sim says what happened; presentation decides how it feels.** Each
   snapshot carries that tick's `ArenaEvent[]`. Muzzle flash, tracer, spark
   spray, floating damage number, hitstop and shake are all derived from that
   list in `Scene3D.consumeEvents` and nowhere else.
3. **No art assets.** Every mesh is built from primitives at runtime and every
   environment layout is generated from a hash of the zone id. The look is
   carried by lighting — one low, hard, shadow-mapped sun, a cool sky fill, a
   warm ground bounce, a dim camera-riding fill so silhouettes are not black
   cut-outs, and exponential fog for aerial perspective.

Effects are pooled into a fixed, small number of draw calls: one `LineSegments`
for every tracer, one `Points` for every spark, one `Points` for all the dust,
and a single reused muzzle light. Damage numbers and the reticle are drawn on a
2D canvas layered over the WebGL one, so they stay crisp at any distance.

---

## 5c. Audio

Every sound is synthesised at runtime through the Web Audio API. No sample
files, for the same reasons there are no art assets: one committed direction, no
pipeline, works offline, and a cue is a handful of numbers to tune rather than a
recording to redo.

It is driven by the **same `ArenaEvent` stream that drives the visual effects**,
which is the point — the sim reports what happened once, and both the eye and the
ear are served from that one report. Nothing in `src/sim` knows audio exists.

The cue table is typed against `BaseAudioContext` rather than `AudioContext`, so
every cue can be rendered into an `OfflineAudioContext`. That is what makes sound
testable in a build nobody can listen to: `npm run smoke` renders all 21 cues
headlessly and asserts each one is audible, does not clip, and ends. Those are
exactly the three failure modes of synthesised audio you cannot hear.

The master bus ends in a `DynamicsCompressor` acting as a limiter, because
procedural cues stack unpredictably in a firefight and clipping is the fastest
way to sound cheap.

**The score** is a bed per place, defined as data in `soundscape.ts`: a root, a
stack of intervals above it, a filter character, a texture layer and an
occasional struck toll. Khadir gets an open fifth under a dry high wind; Sabb a
minor third that never resolves, lower and duller; orbital zones get no wind at
all, because vacuum has none — just a tight resonant hull band and a metallic
toll. Beds crossfade when the player changes place, so arriving somewhere reads
as the room changing rather than a track ending.

Intensity (docked → deployed → boss) opens the bed's filter and lifts its gain.
It never raises a tempo, because this score does not have one. That is the
brief's "sparse, low-frequency, drone-forward, long tracks, few cues" taken
literally: the only *event* in the whole bed is the toll.

Verification goes further than "does it make sound". Three beds that differ only
in level are not three identities, so the smoke run renders each offline and
compares loudness and a zero-crossing brightness proxy, failing if any pair is
within 12% on both. The solar lance's whine is the only other continuous source;
its gain follows the beam ramp.

Audio starts on the pointer-lock click, because browsers refuse to open an audio
context without a user gesture and that click is the natural moment.

---

## 5d. Feel

Hitstop is **simulation state, not a renderer flourish**. It lives in
`ArenaState`, `stepArena` returns early while it is counting down, and a replay
of the same seed stutters in exactly the same places. That is what makes it
safe: feel is recorded, deterministic, and covered by tests.

Two rules keep it from becoming a stutter:

- **Beams never freeze.** A twenty-shots-a-second weapon that hitches every tick
  reads as a dropped frame, not as impact.
- **Fast weapons freeze only on something worth freezing for** — a weak point, a
  crit, or a kill. Slow committed weapons freeze on every connect, because that
  is the entire promise of firing one.

Recoil is the mirror image: it lives entirely in presentation, but it offsets the
*aim* that gets sent to the sim, not just the camera. A kick that does not move
where the next shot goes is a screensaver.

Adding hitstop lengthened a reference run by about 10% (162s to 178s). That is
the cost of the world holding still on a connect, and it is the right trade.

---

## 5e. The boss pipeline

A boss is data. `BossDef` carries its geometry, defences, weak points and phases;
`stepBoss` is generic and has no knowledge of any particular boss.

A phase may change: speed, attack cadence, armour and shield multipliers, which
weak points are exposed, what it spawns, arena damage-over-time, arena gravity,
and which telegraph patterns it may use. It may also declare:

- **`window`** — a timed exposure that opens a named weak point on a cycle, with
  optional shield suppression and an optional pull toward the boss. The Kiln
  Warden venting to cool and the Bellows drawing breath are the same mechanic
  with different numbers; both are this field. It used to be `if (e.phase === 0)`
  against a weak point named `'vents'`, which is a special case, not a mechanic.
- **`invulnerableWhileAdds`** with **`respawnTicks`** — the boss cannot be hurt
  while any escort lives, and the escort returns a fixed time after being
  *fully* cleared. Counting from full clear rather than on a free-running timer
  is the difference between "kill them fast and you get a window" and "the boss
  is permanently immune", which is what the first version produced.
- **`gravityMult`** — the arena's physics as a phase property.

Deflected shots emit a distinct `warded` event rather than silently doing
nothing, so "shoot the escort" is learnable from one attempt.

Telegraph patterns stay a closed vocabulary of five shapes. A new boss adds new
*entries* to `PATTERNS` — different shape, damage type and numbers — never new
shapes, because the point of the vocabulary is that learning one boss teaches you
how to read the next.

> Enforced by `test/bosses.test.ts`: every boss is well formed, phases descend,
> each phase changes a mechanic rather than a number, every referenced pattern,
> spawn and weak point exists, and the pull / ward / gravity mechanics are each
> owned by exactly one boss so a fourth boss cannot be a reskin.

---

## 6. Snapshots

Renderers never see `GameState`. They receive one of two projections built by the
same code from the same state, so the widget can never disagree with the game:

- `WidgetSnapshot` — a few hundred bytes. Route status, tickers, alert badge.
- `FullSnapshot` — everything one frame of the game view and HUD needs.

The host pushes full snapshots per tick while deployed, and widget snapshots at
the configured fps (default 12). Throttling lives in the host, not the renderer,
so a widget cannot accidentally become a 40Hz IPC firehose.

---

## 7. Saves

Quality bar #4 is "zero save loss, ever". The write path is deliberately boring:

1. Serialise, and **verify the bytes deserialise** before anything touches disk.
   If the state cannot be represented, the existing save is still good and the
   write is refused.
2. Write to a temp file in the same directory; fsync it.
3. Rotate the backup chain: `save.bak2 → bak3`, `bak1 → bak2`, `save → bak1`.
4. Rename the temp file over the live save. Rename is atomic; fsync the directory.

A crash at any point leaves either the previous save or the new one intact, never
a half-written file.

On load, `deserialize` checks a magic string, a schema version, and a checksum
over the exact payload text. A save from a newer build is refused rather than
mangled. Migrations are forward-only, one version per step, and stay in the tree
permanently — a save written by any shipped build must keep loading forever.
After migration a `repair` pass fills defaults, clamps nonsense, drops dangling
loadout references and rebuilds `nextUid`, reporting every repair as a warning
the UI shows.

If the primary save is unusable, the loader walks the backup chain rather than
starting a new game, and reports which file it recovered from and why the others
failed.

> Enforced by `test/save.test.ts` and `test/storage.test.ts` — truncation, edited
> payloads, future versions, foreign files, a v1 save migrating forward, multiple
> bad backups in a row, and a refusal to overwrite a good save with an
> unrepresentable one.

---

## 8. The window layer

Two `BrowserWindow`s exist for the life of the app and neither is ever destroyed.
Switching modes shows one and hides the other, so restoring is instant with no
loading screen and nothing to lose — the sim never stopped and never moved.

The widget is frameless, transparent, non-resizable, `skipTaskbar`, and
**non-focusable**, with `alwaysOnTop` at the `screen-saver` level (the plain flag
sits below full-screen apps on Windows and macOS alike). Click-through uses
`setIgnoreMouseEvents(true, { forward: true })` so hover-to-expand still works
while clicks pass through to whatever is underneath.

Position is stored as a **corner plus an offset**, not as coordinates:
`cornerFromBounds` infers which corner a manual drag landed in. Coordinates break
when a display is unplugged or rearranged; a corner does not.

> Enforced by `npm run smoke`, which boots the real app under a virtual display,
> plays it with the reference bot, and asserts the size, the hover expansion, the
> always-on-top flag, non-focusability, that the full window hides while docked
> and restores afterward, that the boss encounter renders, and that the route runs
> while docked.

---

## 9. A note on `preload.mts`

The preload is `.mts`, compiling to `.mjs`, on purpose. Electron loads preloads
through `require()`, so an ES-module preload must carry the `.mjs` extension for
Node to accept it. Compiled as ESM `.js` it fails at runtime with
`ERR_REQUIRE_ESM` — and the failure mode is quiet: the renderer simply has no API
object and every call throws `undefined`. This cost a debugging cycle during the
build; the extension is load-bearing.

---

## 10. Adding content

Nearly all content is data and needs no engine work.

| To add | Edit | Notes |
|---|---|---|
| A weapon | `content/weapons.ts` | Behaviours are `hitscan`, `projectile`, `beam`, `lob` |
| An item base | `content/items.ts` | Bases are hand-authored; nothing can invent one |
| A hostile | `content/enemies.ts` | AI is per `kind`; a new pressure needs a case in `arena.ts` |
| A boss | `content/bosses.ts` | Phases, weak points, spawns and patterns are all data |
| A telegraph | `PATTERNS` in `content/bosses.ts` | Reuse the five shapes; a new shape needs `resolveTelegraph` |
| A zone or planet | `content/zones.ts` | Idle yields must stay integers — see §3 |
| A tech node | `content/tech.ts` | Effects are declarative; wire the stat in `derive.ts` |
| A ship upgrade | `content/ship.ts` | Costs can reach back to lower material tiers |

Weak-point offsets are measured **from the entity's centre**: `ox` along its
facing, `oy` up from the middle of the body. Authoring them relative to the top
puts the hitbox in the air above the model, which is a bug this build already
shipped once and fixed.

After any balance change, run `npm run sim -- balance` and `npm run sim -- soak`
before playing. The soak reports clear rate and pacing across seeds in a couple of
seconds, which is faster and more honest than a play session.
