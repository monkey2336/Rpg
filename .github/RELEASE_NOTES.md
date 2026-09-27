A dual-mode idle RPG: crew a salvage vessel across sun-scorched worlds, mine and
scan, and kill escalating bosses for loot. Play it full-screen, or dock it to the
corner of your desktop and let it run itself.

## Download

| | |
|---|---|
| **`Cenotaph-0.1.3-portable.exe`** | **Start here.** Double-click and it runs. No install. |
| `Cenotaph-0.1.3-x64.exe` | Installer — Start Menu entry, desktop shortcut, choose your own folder. |

**Windows will block it on first run.** The build is unsigned — signing needs a
paid certificate tied to a real publisher — so SmartScreen shows *"Windows
protected your PC"* with the Run button hidden. Click **More info** →
**Run anyway**. You should be wary of unsigned executables in general; the honest
reassurance here is that every line of this one is in the repo and
`npm run pack:win` reproduces it on your own machine.

It uses Electron's default icon. A real one is an art task, and a placeholder
would be worse than none.

## New in 0.1.3

**You can find the deposits and scan sites now.** The gate wants three mined
and two scanned, and the game never told you where any of them were: six dark
rocks and five short posts at random bearings across a disc twelve hundred
units wide, no marker, no prompt when you were finally standing on one, and a
four-second channel that shows nothing at all if you tap `E` instead of
holding it. The mechanic worked. There was no way to know that.

Objectives are now marked. The ones you still need show a diamond with their
distance, clamped to the edge of the screen with an arrow when they are behind
you. Stand close enough and the marker says **HOLD E** — and it means hold;
mining takes about four seconds and scanning about six, with a ring that
closes as you channel. Markers for a requirement you have already met go away
rather than cluttering the screen, and the sites themselves now carry a lit
seam so they read as somewhere to go rather than as scenery.

The range you have to be inside was also a shade over one body-length. It is
about half again as much now, and the prompt appears at exactly that radius —
the renderer reads the number out of the simulation rather than keeping its
own copy.

## New in 0.1.2

**Dying no longer throws away the run.** Landing again rebuilt the whole zone:
kills, deposits and scans back to zero, and the crossing charged its fuel a
second time. Dying at 20 of 24 kills meant redoing the entire approach, which
is why clearing an area could feel impossible. The button now says **Get up**,
and it means it — you stand up where you fell with everything you had.

The exception is a boss. If it kills you it withdraws and the gate stays open,
so you replay the fight rather than the ninety seconds that unlocked it. A
set-piece you stumble into half-dead is one nobody can learn.

**Loot is on the ground now.** Killing something has always had a chance to
roll you a weapon; it just appeared silently in the Hold. It now falls where
the body did, glows in its rarity's colour, and flies to you when you get
close, with the sound and the name arriving as you pick it up. Nothing changed
about ownership — the weapon is yours from the instant the kill lands, and
anything still on the sand when a run ends comes home with you. There is no
timer and nothing to scramble for.

**A Loadout screen.** The Hold is a warehouse — every weapon you own, sortable
and scrappable — and its Equip button silently dropped things into whichever
slot happened to be active. You could not see your three side by side and you
could not choose which slot anything went to. Loadout gives each slot a card:
what is in it, what it *does* (stagger, ramp, lob, chain, falloff, charge,
homing, linger), and a picker that targets that slot and no other. It also
tells you when all three of your weapons deal the same damage type, which is
the kind of gap a column of DPS numbers hides.

## Fixed in 0.1.1

**Vertical look was inverted, and it broke aiming.** The camera rig placed the
camera on an orbit that swung *down* as the aim swung *up*. The two agreed at
exactly one angle — the one the camera rests at before you touch the mouse — so
it looked right in every screenshot and inverted the moment anyone aimed. Push
the mouse up, the crosshair climbed and the view dropped, and the bullets went
somewhere you were not looking.

Three smaller faults came from the same confused sign, and all three are gone:
recoil kicked the aim toward the floor instead of the sky; the gun on your
character's shoulder pointed the opposite way to the shot; and the crosshair
was never told about parallax, so a camera sitting behind and beside the gun
aimed eleven degrees away from the reticle. The shot now converges on whatever
the crosshair is actually covering, at whatever range that is.

The rig is also no longer allowed to bury itself in the sand when you look up,
and your own character fades out rather than standing in front of the
crosshair when the camera closes in.

## Controls

Click anywhere in the game view to take the controls.

`W A S D` move · mouse aim · left click fire · `Space` jump · `Shift` dodge
`E` channel a deposit or scan site · `R` reload · `1` `2` `3` weapons
`F` call the boss once the gate is met · `Esc` release the mouse (again to dock)
`` ` `` dock to the corner

Clear 24, mine 3, scan 2 to open the beacon. The Kiln Warden vents roughly every
seven seconds and that is the only window its shield drops — use it and the
fight halves.

Saves live in `%APPDATA%\Cenotaph\saves` and survive uninstall.

## What's in it

Three planets' worth of systems on one and a half planets of content: three
zones, three bosses with three phases each, eight weapon archetypes that each own
a mechanic no other has, five loot rarities, a tech tree, a ship, and a prestige
axis. Offline progression resolves through the same simulation live play uses,
and a test proves the two reach an identical state rather than merely a similar
one.

Known gap: the corner widget's transparent always-on-top behaviour has not been
watched on real Windows. If it misbehaves, that is the first place to look.
