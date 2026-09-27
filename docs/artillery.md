# Artillery

The Mortar Team, the Demolisher, the Meat Wagon, the Glaive Thrower (and the creep catapults,
the Cannon Tower's first slot): every weapon slot whose `weapTp` is `artillery` or `aline`
(`isArtillery`, `src/sim/world.ts`). What makes them different from every other ranged unit is
almost entirely DATA in the install, plus four rules that Liquipedia states and no file does.

Sources, in the order they win:

- **UnitWeapons.slk** — `weapTp`, `minRange`, the three rings `Farea`/`Harea`/`Qarea`, their
  shares `Hfact`/`Qfact`, and `splashTargs`.
- **UnitFunc.txt** (`Units\*UnitFunc.txt`) — `Missilearc`, a per-slot list like `Missileart`.
- **Units\CommandFunc.txt / CommandStrings.txt [CmdAttackGround]** — the button: `Art=
  CommandAttackGround` (war3skins `[Default]` → `BTNAttackGround.blp`; the four race twins are
  commented out), `Buttonpos=3,1`, `Hotkey=G`, and the Ubertip that defines the order: "fire at
  the targeted area of ground until they are told to stop or are given another order."
- **Liquipedia**, read through its API (see REFERENCES.md): *Weapon Types* (Artillery), *Mortar
  Team*, *Demolisher*, *Meat Wagon*.

## The shell flies at the GROUND

A shot is thrown at the spot its target stood on at the loosing (`SimProjectile.area`) and
bursts there, so the target can walk out from under it: "Artillery attacks can be actively
dodged, as they do not target units, but areas." A homing arrow cannot be dodged that way; a
shell can, and a LAN client's copy is sent the spot rather than the unit (`snapshot.ts`).

## The lob — `Missilearc`

`src/sim/missile.ts` is the one place a missile's height is computed, for every missile the sim
flies (and for a client's display copy between payloads). The peak above the straight
launch→impact line is `arc × distance`, on a parabola that is 0 at both ends; the plane speed
is `Missilespeed` whatever the arc, so a high throw costs no time. The file states the number
and not the curve — the curve is the community's model (the Hive missile systems' `4·h·x·(d−x)/d²`),
so if the real client is ever measured, that file is where the answer goes.

| Unit | `Missilearc` |
|---|---|
| Mortar Team, Demolisher, Cannon Tower, creep catapults | 0.35 |
| Meat Wagon | 0.3 |
| every bow (Archer, Guard Tower's arrow slot, …) | 0.15 |
| Glaive Thrower | 0.05 — the one siege shot that is fired rather than lobbed |

It applies to EVERY attack missile, not just siege: the arrows arc too, because the data says
they do. The renderer tilts the model along the curve (`SimProjectile.pitch`,
`yawPitchQuat` in mapViewer).

SPELL missiles take their own row's `Missilearc` (`AbilityDef.missileArc`, `amac` for a map's
edit; the key is spelled `MissileArc` on five rows and read case-insensitively) — every
unit-target spell that flies one (`spawnSpellProjectile`) and the picture missiles
(`spawnVisualMissile`): Acid Bomb 0.4, Hurl Boulder 0.3, Drunken Haze 0.15, and the Blood Mage's
spheres 0.05 (the renderer's sphere throw reads the row now too). Storm Bolt and Death Coil state
none and fly straight. Healing Spray (0.4) and Cluster Rockets (0.2) state one too, but those
point spells throw no sim missile yet, so there is nothing for it to bend. Two exceptions, both deliberate: a WAVE (Shock
Wave, Carrion Swarm) sweeps the ground and stays flat, and Mirror Image's renderer-only spread
keeps its small hand-drawn hop, because `[AOmi]` states no arc and a literal 0 would slide the art
along the floor.

## The burst catches BOTH sides

`splashTargs` is the burst's list, and it is also its ALLEGIANCE (`splashAdmits`). Every siege
row reads `ground,structure,debris,tree,wall` — no allegiance word — so the burst hits whatever
is in the rings, the thrower's own army included. Liquipedia's Mortar Team page: "Mortar Teams
will damage your own units so be careful to prevent them from killing your own army." The rows
that mean enemies say so (`enemy,neutral` on the Flame-Strike-shaped bursts, `enemy` on the
Gryphon's line). `notself` (the Cannon Tower) spares only the shooter.

The burst was enemies-only before this, which made every siege weapon safe to fire into a melee.

`tree` in the list is trees: each trunk in the rings takes its ring's share (`shellTrees`).

## What it kills SPLATTERS

"Units killed by Artillery attacks splatter and do not leave corpses behind" (Weapon Types).
The same death `SetUnitExploded` asks for — Art - Special, no corpse — keyed on the unit the
burst is striking (`splatterId`), never on a building or a hero.

## Minimum range — a dead zone, not a retreat

UnitWeapons `minRange` is 250 on the siege four: nothing nearer (hull to hull, like `range`) is
shot at. The Demolisher and Meat Wagon pages: they "cannot attack melee units or any units right
next to them. You will have to move them away." So the unit **stands**, it does not back off:

- `acquireTarget` / `bestCreepTarget` never PICK a target inside it;
- `engage` never swings at one — a fight the unit picked up itself is dropped so it looks for
  something it can hit, while an ORDERED target is waited on;
- Attack Ground into the dead zone stands and does not fire.

It applies to RANGED slots only (`deadZone`): the Corrupted Ancient Protector (`ncap`) states
200 beside a 128-reach melee slot, and read against that slot the row would be a unit that can
never strike at all.

## Attack Ground

`issueAttackGround` / `tickAttackGround`: walk into range of the spot, face it, and fire on the
weapon's own cooldown until the order is replaced — it never acquires anything meanwhile. The
shot is `spawnGroundShell`: an artillery shell with no unit behind it (no orb, nothing to
disjoint). Who has the command is `groundWeapon`: the first enabled artillery slot with
`showUI`. The button is on MOBILE units only (the Cannon Tower's card has none, as the hotkey
catalogue already says).

The Attack command pointed at a TREE by a unit whose only tree-capable weapon is its artillery
(a Mortar Team's `targs1` names `tree`) becomes Attack Ground at the trunk, ending when the tree
does (`treeId`).

JASS: `IssuePointOrder(u, "attackground", x, y)` is the same order (and fails for a unit
without it); `GetUnitCurrentOrder` answers `attackground` (851984).

## Tests

`tools/sim-artillery-test.cjs` pins the arc (a spell missile's too), friendly fire, the `enemy` exception, splatter,
dodging, Attack Ground (at a spot, from out of range, at a tree) and the dead zone.
