A dual-mode idle RPG: crew a salvage vessel across sun-scorched worlds, mine and
scan, and kill escalating bosses for loot. Play it full-screen, or dock it to the
corner of your desktop and let it run itself.

## Download

| | |
|---|---|
| **`Cenotaph-0.1.1-portable.exe`** | **Start here.** Double-click and it runs. No install. |
| `Cenotaph-0.1.1-x64.exe` | Installer — Start Menu entry, desktop shortcut, choose your own folder. |

**Windows will block it on first run.** The build is unsigned — signing needs a
paid certificate tied to a real publisher — so SmartScreen shows *"Windows
protected your PC"* with the Run button hidden. Click **More info** →
**Run anyway**. You should be wary of unsigned executables in general; the honest
reassurance here is that every line of this one is in the repo and
`npm run pack:win` reproduces it on your own machine.

It uses Electron's default icon. A real one is an art task, and a placeholder
would be worse than none.

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
