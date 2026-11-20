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
none and fly straight. Healing Spray (0.4) and Cluster Rockets (0.2) are THROWN FIELDS
(`SpellFieldInit.thrown`, `spawnSpotMissile`): each wave's bottles or rockets are real missiles
from the caster to spots in the circle, and the wave heals or hurts when they land — its
distance over the row's `Missilespeed` after the throw — so a rocket wave can be walked out from
under. Healing Spray heals per wave (its Ubertip: "each wave heals <DataA> … to all friendly units
in an area"), with DataD as the spray's budget, a wave's share of it split past that. Two exceptions, both deliberate: a WAVE (Shock
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

## A miss still BURSTS

Liquipedia's *Miss* page splits a miss by weapon: "Missed single target attacks deal no damage",
while "Missed splash attacks deal … reduced damage". So a cursed Mortar Team (or one aimed at a
Demon Hunter who evades) still drops its shell on the same ground; every ring just takes less.
The miss is the ATTACK's and is rolled ONCE, at the burst (`applyAreaSplash`): the shooter's
`miss` buffs (Curse, Drunken Haze) and the Evasion of the unit it was aimed at, if the burst
still catches it. A body in the rings is never rolled for on its own (`applyDamage`'s `splash`),
so nobody evades the ground under them.

How much a miss loses is `MissDamageReduction` = **0.5** in both `Units\MiscGame.txt` and
`Units\MiscData.txt`. Liquipedia says 75%; the game data wins. Before this, every body in the
rings rolled the shooter's Curse and its own Evasion separately and a miss took its share to 0,
so a 100% Curse made a siege weapon harmless.

The third way to miss is HIGH GROUND (issue #291, `shootsUphill` in `src/sim/world.ts`):
`Units\MiscData.txt` `ChanceToMiss` = **0.25**, "missile chance to miss if target is moving or on
high ground". The condition is the official basics page's
([combat.shtml](https://classic.battle.net/war3/basics/combat.shtml), "High Ground"): "Ranged
units (Missile) will miss a lot (25% chance to miss) when trying to shoot up to higher ground …
charge up the hill to the same level as the enemy." So it is a CLIFF LEVEL (the sampler the fog
and `meleeApart` use — rolling ground is not high ground; more than half a level, so one ramp is
one level), any RANGED weapon, and a building is exempt at neither end (the same paragraph is
about towers at the top of a ramp). A flyer at either end is exempt — that one is OURS: no source
we could reach states it. For a shell it is the GROUND aimed at that is measured, so Attack Ground
up a cliff misses too, and like every splash miss it still bursts at half.

Every miss — an evade, a Curse, a cliff — floats the game's red "miss" (`MISS` in
GlobalStrings.fdf, styled by the `MissText*` row of `UI\MiscData.txt` and `MissTextHeight`) over
what was shot at: `CombatText` kind `miss`, whose word the client fills in.

## Artillery (Line)

`aline` is in the 1.30.4 tables (the Glaive Thrower) and nowhere else: the 1.31.0 patch made the
Glaive Thrower plain `artillery` (src/patches/data/1.31.0.json), and the game always runs the
latest patch. Liquipedia: "Artillery Line deals damage to units behind the target area instead of
dealing damage to an area around the target area". We still burst it in the rings and add the
`spill` corridor behind the struck unit once Vorpal Blades (`rasd` 200) opens it. The shape of
the line before that is not stated in any file or reference we have, so it is left alone; it only
matters on a rolled-back patch, a Reign of Chaos client or a custom table set.

## Missile (Splash) is NOT artillery — it homes, then bursts

`msplash` (the Chimaera's slot 2, the Frost Wyrm, the Phoenix, Metamorphosis, the Ancient
Protector's slot 2, Serpent Ward 4, the Destroyers, every dragon — 45 slots state rings, 26
more state none and are plain missiles) is the other weapon type that reads `Farea`/`Harea`/
`Qarea`, and the difference is the whole of it: the missile keeps its TARGET and homes, so it
cannot be walked out from under, and where it lands it bursts around the unit it struck
(`SimProjectile.splash`, `applyMissileSplash`). The struck unit takes the blow in full with
everything a homing hit carries (orb, Freezing Breath, Liquid Fire); everybody else in the rings
takes their ring's share through the same `burstRings` the shell uses.

The rings, the shares, `splashTargs` as kind AND allegiance, the trees and the once-per-attack
miss are all the shell's rules. Most of these rows DO name `enemy`, so a Frost Wyrm spares its
own Ghouls; the ones that name nobody (`[nadr]` = `ground`, the creep dragons) burn whoever is
there. Three things are NOT carried over: no splatter (that line is about the Artillery type),
no Attack Ground, and no dead zone. Keyed on `weapTp`, never on "has rings" — twelve plain
`missile` rows carry stray rings and do not splash.

## Missile (Bounce) — the glaive goes on

`mbounce` is two rows, the Huntress (`[esen]`) and Naisha (`[ensh]`), and four columns that mean
something else here than on a splashing slot (issue #279 — the glaive used to stop at one body):

| column | Huntress | reads as |
| --- | --- | --- |
| `targCount1` | 2 (Naisha 5) | bodies ONE attack strikes, the aimed one included |
| `Farea1` | 400 | how far a bounce may reach, from the body just struck |
| `damageLoss1` | 0.5 | what each hop sheds: 100 %, 50 %, 25 % |
| `splashTargs1` | `ground,structure,debris,enemy` | who a bounce may land on — kind AND allegiance |

Each hop is a missile of its own (`SimWorld.bounceOn`): it leaves from the struck body for the
NEAREST one it may still hit, homes as the first did, and never returns to a body this attack
has struck. Upgrade Moon Glaive (`Remg`) is the upgrade effect `ratc` "Attack Target Count",
base 1 — a third body — added to the slot's count in `recomputeStats` as Long Rifles adds to
range. The hop carries the damage only: no orb, no strike passive.

2.0.3 stops the glaive at buildings with a passive of its own, the Bouncing Missile Filter
(`Amgi`, `targs1 = structure`): a bounce goes neither TO nor FROM a kind it names
(`SimWorld.bounceFilter`, read off the unit TYPE's ability list — the row has no button).

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

So a PLAYER moves the gun away, and Computer+ does the same (plus/index.ts `siegeTooClose` /
`siegeBackOff`): a building inside the dead zone is never picked as a gun's aim when another in
reach is not, and a gun left with only that one walks straight away from it to `SIEGE_BACKOFF`
past its minimum range and fires from there. Reported: a Demolisher ordered at the building it
had walked up against stood beside it doing nothing for the rest of the fight.

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

`tools/sim-artillery-test.cjs` pins the arc (a spell missile's too), the thrown fields, friendly fire, the `enemy` exception, a missed shell's burst, splatter,
dodging, Attack Ground (at a spot, from out of range, at a tree) and the dead zone.

`tools/sim-bounce-test.cjs` pins the bounce: the count, the halving, `ratc`, the reach, the
allegiance and the 2.0.3 filter.
