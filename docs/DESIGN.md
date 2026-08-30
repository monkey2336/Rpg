# Design decisions

This document answers the brief's open questions, records the calls made where
the brief left room, and states plainly the one place this build departs from
what was asked for.

---

## 1. Answers to the brief's open questions (§13)

### 1.1 Combat perspective: third-person 3D, top-down, or 2.5D side-scroll?

**2.5D side-scroll.**

The art direction decides this, not the combat. The brief asks for hard sun, long
shadows, brutalist mass, and "tiny player silhouette against enormous static
geometry". That is a *side elevation*. It is the composition of every reference
image the Dune films are cited for. In a side-on slice you get it for free from
geometry you can draw with polygons; in third-person 3D you get it only when the
camera happens to be somewhere flattering, which means either camera work you
cannot afford or set dressing you cannot afford.

Three more things fall out of it:

- **Telegraph legibility.** The brief wants boss silhouettes readable at 200px
  and a telegraph language consistent across the game. A ring, a line, a cone, a
  pulse and a column are unambiguous in a side elevation. In third person they
  need ground decals, height cues, and a camera that never occludes them.
- **Headless tractability.** The sim carries 2D positions, so a six-hour
  fast-forward is a few seconds of CPU and the encounter sim is a file, not a
  subsystem. That is what makes offline parity provable rather than aspirational.
- **Cost.** No rigs, no animation blending, no navmesh, no LODs. The prototype's
  entire visual layer is one 600-line canvas module with no art assets in it.

What it gives up: verticality as a real axis, and the "walk up to something huge
and look up" moment. Jump and dodge partly cover the first. The second is the
genuine loss, and it is paid for by having a boss that reads at a glance.

### 1.2 Is idle progression a reduced-rate version of active play, or a distinct activity set?

**Reduced-rate, through literally the same code — with two deliberate asymmetries
that are not rate reductions.**

A distinct activity set is the wrong answer here for a specific reason: the brief
also demands that offline and online progression provably match the same maths.
Two activity sets means two economies means the proof is impossible. So idle
routes run the same encounter resolver, against the same enemy definitions,
through the same `applyDamage` the shooter runs. A better loadout genuinely
farms faster because the route prices its combat time with your actual weapon
against the actual damage-type matrix. There is one economy and it is checked by
a test.

The two asymmetries are *shape* changes, not rate changes:

1. **Data is throttled far harder than materials** (35% versus 62%). Materials
   are the time currency and scale with idle. Data funds the tech tree and is
   heavily weighted toward active play. This is the single lever that keeps
   active sessions valuable, and it lives in one constant in `route.ts`.
2. **Idle loot is capped at Refined.** Marked, Relic and Sovereign require hands
   on the sticks. A route can fill your hold; it cannot improve your ceiling.

And the hard gate the brief asks for: **new bosses never auto-clear**. A route can
only be assigned to a zone you have already cleared by hand.

One decision the brief did not ask about but that follows from "idle can never
finish the game for you, and active play should never feel obligatory for
maintenance chores": **the route runs whenever it is assigned, including while
you are on the ground playing.** It is the ship running the route, not you. Any
other choice creates a reason to stop playing in order to farm, which is the dark
pattern this genre walks into by default.

### 1.3 Solo project, small team, or AI-assisted solo?

**AI-assisted solo through Tier 2; a small team of three to five for Tier 3.**

Tier 1 and Tier 2 are mostly systems and authoring, and this codebase is shaped
for one person to hold in their head: the sim is pure and tested, content is data
files, and the headless CLI means balance work happens in a terminal in seconds
rather than by playing. That is a solo-tractable shape and it is why the
architecture was locked first.

Tier 3 is where solo stops working, and it is specific about where:

- **Bosses.** Ten to fourteen at the quality bar "people record and share" is not
  a systems problem. Each one is a mechanic, a silhouette, a telegraph set, an
  audio identity and a lot of iteration. That is a designer and an artist,
  full-time, for a year.
- **Audio.** The brief says weapon impact is 50% of how a shooter feels. That is
  a specialist, not a spare afternoon.
- **The platform layer.** Always-on-top, click-through and per-window opacity on
  macOS and Linux are three separate pieces of per-platform work.

So: solo for the parts where the leverage is real, and hire against the parts
where the quality bar is a person's whole job.

### 1.4 Steam release, or personal project?

**Steam, premium, one purchase.**

The brief's own quality bar rules out the alternative business models: no dark
patterns, no energy timers, no mandatory dailies, cosmetic-only or premium. An
idle game with none of those hooks cannot be free-to-play in any honest way, and
should not try.

What choosing Steam commits this build to, concretely:

- Save integrity is a shipping requirement, not a nicety — hence the atomic
  writes, the backup chain and the nine adversarial tests.
- Offline progression must be right on the first patch, because "the numbers
  changed while I was away" is the review that kills an idle game.
- The widget must survive real desktops: multiple monitors, DPI changes,
  full-screen apps. `cornerFromBounds` stores a corner and an offset rather than
  coordinates for exactly this reason.
- No leaderboards in v1. The brief is right that they force server-side sim
  validation, and that is not worth it here. If they ever ship, they ship
  labelled unranked.

### 1.5 Target session length for an active play session?

**25 to 40 minutes, built around a 3-to-6 minute zone run.**

This is measured, not guessed. The reference bot clears The Ochre Shelf in a mean
166 seconds with the starting kit and no upgrades — and the bot does not read the
boss well (it lands about 7% of its hits on weak points). A competent player
learning the fight sits in the 3-to-6 minute band, and a player who has not
learned the vent window sits well above it.

That gives a session shape of roughly: land, clear, bank, spend, decide — four to
eight times. Long enough to make a real decision about the tech tree, short
enough that quitting after one run never feels like it wasted your time. Both
halves of that matter: the brief's promise is that active play is the
gate-breaker, so it must be possible to break exactly one gate and stop.

---

## 2. The deviation: TypeScript and Electron, not Godot 4 or Unity 6

The brief says pick Godot 4 or Unity 6 before prototyping. This build is
TypeScript and Electron. That is a real departure and it deserves a real
argument rather than a footnote.

**Why.** The brief calls the dual-mode window the defining feature and the
headless sim the single most important technical decision. Those two things
decide the stack, and they point the same way:

- A frameless, transparent, always-on-top, non-focusable, click-through,
  per-window-opacity, corner-snapped second window that never steals focus is
  *ordinary* in Electron. In Godot it is a mix of engine flags and per-platform
  native work; in Unity it is a plugin or a native window handle you manage
  yourself. The brief already flags that Godot has the cleaner window control of
  the two — the honest extension of that reasoning is that a Chromium shell has
  cleaner control than either.
- "The sim must be fully headless-runnable" is a statement about *language and
  discipline*, not about engine. In this build `src/sim` imports nothing from
  the DOM, Node, or Electron, and the whole thing runs under `node --test` and
  under a CLI with no window at all. That property is easy to enforce here and
  easy to lose inside an engine, where the temptation to reach for a node, a
  signal, or a MonoBehaviour is constant.

**What it costs.** A 2.5D side-scroller drawn on a canvas is well inside what
this stack does comfortably, but the ceiling is real: no built-in physics,
particles, animation tooling, audio middleware or asset pipeline, and a ~150MB
install. Electron is also the reason the widget's performance budget needs care —
Chromium's compositor is the cost, not the simulation.

**The port path, if the ceiling is reached.** The seam is already cut. `src/sim`
is pure data and arithmetic with a documented determinism rule (integer ops,
`+-*/`, `sqrt`, and the polynomial trig in `trig.ts` — never `Math.sin`, whose
results are implementation-defined and will desync a seeded sim across runtimes).
Porting means reimplementing three hosts — the clock, the storage layer, the
window layer — against an unchanged sim, and the test suite comes along as the
oracle. In Godot the practical route is to run the sim as-is on a JS runtime, or
to port it to GDScript/C# with `test/determinism.test.ts` and
`test/offline-parity.test.ts` as the acceptance criteria.

**The recommendation.** Ship Tier 1 and Tier 2 on this stack, because the widget
is the differentiator and it is already solved here. Revisit at Tier 3, when the
question is driven by content tooling and audio middleware rather than by
windows — and revisit it as a measured decision, not a default.

---

## 3. Calls made where the brief left room

**Idle routes never stall on a full hold.** Overflow drops are scrapped into
materials and the widget says so. The brief lists "inventory-full warning" as a
widget feature and also demands an idle mode a player leaves running for eight
hours without annoyance. A route that stops because a hold filled is a
maintenance chore with extra steps, and the brief explicitly rules those out. The
warning stays; the stall does not.

**Death costs the run, not the bank.** Materials and data bank on pickup, loot
banks on drop. Being downed loses your progress toward the gate and nothing else.
Losing hours of banked resources to one bad boss attempt is the kind of
punishment that makes people stop attempting bosses, and the brief wants boss
fights people record.

**Calling the boss resets the arena.** Remaining adds withdraw, ordnance clears,
and you are restored to full. A set-piece whose difficulty depends on how chewed
up the approach left you cannot be learned, and learning it is the entire point
of the weak-point design.

**Sustain is tied to aggression.** Shields regenerate on a delay, plate repairs
itself slowly, and health only returns from kills (2.5% of max each). There is no
consumable to remember, no chore, and running away is never the optimal way to
recover.

**Offline accrual caps at 48 hours**, raised to 72 by tech. The cap exists so the
closed-form path has a bound and so that "I left for a month" does not trivialise
a planet. Being capped is reported in the offline panel rather than silently
applied.

**The prestige multiplier pays out on depth, not time.** `0.22 * sqrt(levels past
25) + 0.08 * boss clears`. Sub-linear in level so grinding the same zone stops
paying; linear in bosses because bosses are the content. The brief asks for a
real decision rather than a treadmill, and a treadmill is exactly what a
time-linear payout produces.

---

## 4. Tone bible

Everything named here is original. The references in the brief are tone only.

**The world.** A decaying interstellar feudal order, seen from the bottom. You
are a lone operator with a ship and a debt. Nothing is heroic and nothing is
explained. The vessel is the *Cenotaph* — a monument to someone buried elsewhere,
which is the joke and also the setting.

**Khadir**, the first planet: a tidally locked salt shelf in one long afternoon.
The terminator never moves. Everything worth taking is on the hot side under a
metre of caked salt, and everything that survives out there has learned to dig.

**The Ochre Shelf**: a terrace of dead kilns the size of cathedrals, cut into the
shelf by people who left no name on them. The shadows are the only cover and they
are two hundred metres long.

**The Kiln Warden**: third of the shelf kilns, still tending a furnace that went
out an age ago. It is not guarding anything. It is doing its job.

**Register.** Sacred-industrial. Equipment has liturgical names given by people
who work with it every day and are not being reverent — an Adze, a Thurible, a
Censer. Materials are Slag, Ferrite, Bone-glass, Vitrine, Sovereign Ash. Item
flavour is one or two dry sentences from someone who has used the thing. Never
jokes, never winking, never grimdark posturing. Grim is a texture, not a voice.

**Damage types**, renamed from the classic roles: Percussive (kinetic), Solar
(thermal), Caustic (corrosive), Arc (ion).

**Rarities**: Common, Refined, Marked, Relic, Sovereign.

**Colour.** Ochre, bone, rust, deep shadow, with one saturated accent per planet
(Khadir is `#e8853a`). The accent is rationed: a weak point, a telegraph, an
alert. If everything is accented, nothing is.

**Enemies** are insectoid and industrial. Wedges, drums and legs. Nothing has a
face.

**UI** is monolithic and ceremonial: thin type, wide tracking, hard edges, no
rounded corners, no glow, no easing longer than 90ms. It should read as stamped
into metal.

---

## 5. Content that exists

| | |
|---|---|
| Planets | Khadir (playable), Sabb (authored, locked) |
| Zones | The Ochre Shelf (playable), The Throats, The Lantern (orbital), The Grey Flats |
| Bosses | The Kiln Warden — 3 phases, 3 weak points, signature drop, codex entry |
| Hostiles | 4 base types + 1 elite, one pressure each |
| Weapons | 8 archetypes authored, 3 unlocked in the prototype |
| Item bases | 11 hand-authored, plus 1 signature |
| Affixes | 10, rolled with ±15% magnitude jitter |
| Tech nodes | 10, data-funded |
| Ship upgrades | 7, materials-funded, costs reaching back to tier-1 |
| Material tiers | 5, with tier 1 remaining an input at every rank |

## 6. What Tier 2 needs next, in order

1. **Two more bosses.** The phase machine and telegraph vocabulary are data-driven
   and generalise; this is authoring plus iteration, and it is the thing that
   proves the boss pipeline rather than the boss.
2. **Audio.** Weapon impact first, per the brief's own weighting. Nothing else in
   the game moves the perceived quality bar as far per hour spent.
3. **The remaining five weapon archetypes.** They are already specified; the beam
   ramp and the lob arc are implemented, so the mechanically novel work is the
   rail's charge and the swarm's homing.
4. **Controller support.** The input layer is already a per-tick frame, so this is
   a mapping, not a refactor.
5. **A second planet's art identity.** One accent, one horizon, one silhouette
   language — the pipeline is procedural, so this is a palette and a shape set.
