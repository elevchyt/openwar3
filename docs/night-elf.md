# The night elf economy

Every other race in Warcraft III plays the same economic game with different art: a worker
walks to a resource, fills up, walks home, unloads, repeats; a building is a thing you put
down and leave alone. The night elf plays a *different game*, and almost none of the
difference is a tuning value — each piece is a rule, and each rule is stated by a row in
`Units\AbilityData.slk` or `Units\UnitBalance.slk`.

This is that list, so the next person does not have to rediscover which column says what.

Implementation: `tickHarvest` / `orbitTree` / `finishConstruction` / `tickEntangledMines` /
`tickReplenish` / `tickRenew` / `toggleRoot` / `issueEntangleInstant` / `issueDrink` in
[`src/sim/world.ts`](../src/sim/world.ts), the `Aent` / `Ambt` / `Adtn` / `Aeat` handlers in
[`src/sim/spells.ts`](../src/sim/spells.ts), the Wisp's profile in
[`src/data/races.ts`](../src/data/races.ts), `raiseEntangledMines` and the command card's
`ROOTED_ONLY` in [`src/render/mapViewer.ts`](../src/render/mapViewer.ts), and the two-form clip
picking in [`src/render/unitAnims.ts`](../src/render/unitAnims.ts) /
`RtsController.applyFormAnims`. Checked by `tools/sim-nightelf-test.cjs`,
`tools/sim-root-test.cjs` and `tools/sim-ancient-anim-test.cjs` (`pnpm sim:test`).

## 1. The Wisp does not haul

`Awha` "Wisp Harvest" is its own ability CLASS, not a re-costed `Ahar`, and the class is the
difference:

| column | value | meaning |
| --- | --- | --- |
| `DataA1` | 5 | lumber per interval |
| `Dur1` | 8 | the interval, seconds |
| `DataB1` / `DataC1` | 5 / 150 | field ids Wha2/Wha3 — **unspent**, no source names them |
| `Targetart` | `TargetArtLumber.mdl` | the glow on the worked tree |
| `Effectsoundlooped` | `WispHarvestLoop` | not a per-hit sound: a loop |

There is no depot leg at all. 5 lumber per 8 seconds — 0.63/sec — is credited straight to the
stash where the wisp is standing, which lands within a rounding error of a Peasant's
10-per-trip round trip. The wisp buys that parity by being *stuck in the tree*: it is not
walking anywhere, so it is not defending anything either.

`damagesTree: false` is literal. A wisp-worked tree never falls, so night elf lumber is bounded
only by how many wisps are in the forest. This is why `WorkerState.lumberCapacity` is 0 for the
wisp and why `Awha` has no capacity field that means anything: with no trip, there is nothing
to fill.

**The orbit.** WC3 shows a harvesting wisp circling the tree — there is no swing to animate, so
the motion IS the animation (`Wisp.mdx` authors exactly five clips: `stand`, `Birth`, `Death`,
`Stand Lumber`, `Stand Work`, and no attack of any kind; the harvest pose is `Stand Work`).
Two traps live in that orbit and both cost real time:

* It must be a **square**, traced just outside the tree's blocked footprint. A circle of the
  same reach cuts the corners and puts the wisp on blocked ground on every diagonal — and a
  unit standing on a blocked cell cannot start a path. Symptom: wisps recalled from a grove
  accept the order, play the walk, and never arrive.
* Arrival must be measured against the **orbit**, not against an axe's arm. Measured the
  chopper's way the wisp arrives, is judged out of reach, re-targets the nearest tree, orbits
  *that* one, is out of reach again — and drifts across the map one tree at a time.

Dense forest defeats both anyway (neighbouring footprints overlap the ring), so `popFromCanopy`
puts a wisp back on walkable ground the moment it is given any other order. That is the
belt-and-braces, not the fix.

### The Wisp's other two buttons

**Detonate** (`Adtn`) is the Wisp's last act, and what the blast carries is not damage:

| column | value | meaning |
| --- | --- | --- |
| `DataA1` | 50 | mana burned off every unit in the blast |
| `DataB1` | 225 | damage — to **summoned** units only |
| `Area1` | 300 | the blast |
| `targs1` | `air,ground,ward,invu,vuln,tree` | no allegiance flag at all |

Two things follow from that target list and both are the ability rather than an oversight.
There is no `enemy`, so Detonate burns FRIENDLY mana as readily as the enemy's — a wisp popped
in your own army's midst empties your own casters. And `invu` is listed, but only for the
dispel: "Since Patch 1.25b Detonate no longer drains mana from invulnerable units. The
dispelling effect still affects invulnerable units" (Liquipedia, Wisp). 50 is the 1.30-era
figure; it became 40 in 1.32.9, long after the version we are.

**Renew** (`Aren`) is repair. Repair is one ability wearing four skins — `Arep` (orc, and the
base the human `Ahrp` derives from), `Arst` (undead Restoration) and `Aren` — with the same two
numbers on every one of them: Rep1 "Repair Cost Ratio" 0.35 and Rep2 "Repair Time Ratio" 1.5, a
third of the building's price over half again its build time. A wisp mends at exactly a
peasant's rate and for exactly a peasant's money.

What is Renew's own is one missing flag. `Arep`/`Ahrp`/`Arst` all list **`nonancient`** in
Targets Allowed and `Aren` does not — so only a Wisp can mend an Ancient, which is half the
night elf's buildings. That flag is now real (`targetError`, refusing with the game's own
"Unable to target Ancients."), which means the rule holds in both directions without a special
case anywhere.

All four autocast (`Orderon`/`Orderoff`), and none of them is dispatched as a spell: repair is a
JOB that runs for as long as the building is hurt and the owner can pay. So the card's
`ability:<code>` arms the ordinary repair order and `tickRenew` hands out the autocast work — to
an IDLE worker only, because an autocast that pulled wisps off the economy every time a tower
took a hit would be worse than no ability at all.

## 2. A Wisp grows a building from inside it, and an Ancient eats it

Night elf construction is Orc construction — the worker vanishes into the site, one worker, no
assist, invulnerable while it is in there — with one extra rule that every night elf player
plans around:

> A Wisp that grows an **Ancient** is spent by it. A Wisp that grows anything else walks out.

The category is the data's own: `UnitBalance.slk`'s `type` column, which reads `Ancient` for
the Tree of Life/Ages/Eternity, the Ancients of War/Lore/Wind/Wonders and the Ancient Protector,
and `Mechanical` for the Moon Well, Hunter's Hall, Altar of Elders and Chimaera Roost. (The
game's own Targets Allowed carries a `nonancient` flag — the human Repair lists it — so this is
its idea of the category, not ours.) `SimUnit.ancient` carries it.

Three moments, three answers:

* **Completion** — an Ancient consumes the builder. `removeUnit`, not a kill: a merged Wisp
  does not die, it stops existing, and a death would hand a nearby enemy hero experience for a
  building you just finished.
* **Cancel** — always gives the Wisp back. Nothing was finished.
* **The shell is destroyed mid-build** — an Ancient takes the Wisp with it; a Moon Well lets it
  go (Warcraft Wiki, Wisp). Killed rather than removed here: that one *is* a death, and the
  credit belongs to whoever knocked the shell down.

## 3. Gold is a crew, not a queue

Three rows, none of them on the wisp:

| ability | on | says |
| --- | --- | --- |
| `Aent` "Entangle" | Tree of Life | `Rng1` 500, `Cast1` 3s, `targs1` = `_`, **`UnitID1` = `egol`** |
| `Aenc` "Cargo Hold (Gold Mine)" | `egol` | `Car1` = 5 — the crew |
| `Aegm` "Entangled Gold Mine" | `egol` | `DataA1` 10 gold per `DataB1` 1 second |

`targs1` being `_` is not an omission: Entangle takes **no target**. You press the button and it
wraps whatever un-entangled mine is inside 500 units, which is why a night elf expansion is a
Tree of Life planted at the mine. And it does not convert the mine — `UnitID1` says it *creates
a unit*, so the `SimMine` goes on being the gold and a building with 800 HP is raised over it.
`SimMine.entangledBy` is the seam. Knock the building down and the mine is a mine again.

**The mine is already wrapped when the match starts**, and that is not a special case in the
melee opening — it is an ORDER the opening gives. `Blizzard.j`'s `MeleeStartingUnitsNightElf`
plants the Tree beside the nearest mine and immediately issues

```jass
call IssueTargetOrder(tree, "entangleinstant", nearestMine)
```

`entangleinstant` is a second order string on the same `Aent` row — `UI\TriggerData.txt` lists
it (and an `autoentangleinstant` twin that takes no target) while `NightElfAbilityFunc` names
only `Order=entangle`, so the ordinary "match the order string against the unit's abilities"
lookup cannot find it and it has to be recognised by name. It is Entangle with the cast time
dropped and the mine NAMED, which matters where there is more than one in reach: six night elf
campaign chapters open with the same line. Ours is intercepted in `authorityHooks`, the one
seam where a gold mine is still a unit (`MINE_ID_BASE`), and lands in
`SimWorld.issueEntangleInstant`.

**An Ancient that pulls itself out of the ground lets the mine go.** The roots are the *Tree's*
— `SimUnit.entangler` is the link, set when the building is raised — so uprooting a Tree of
Life collapses its Entangled Gold Mine, turns the crew out (`unloadBurrow`, not a burial) and
leaves a plain mine anybody can work. Planting again does not hand it back: entangling is a
button you press. Killing the Tree does not release it either — the Entangled Gold Mine is its
own building with its own 800 hit points, and knocking it down is a separate job.

The crew rides the same cargo-hold machinery as the Orc Burrow (`cargoHold` matches `Abun`,
`Aenc` and `Acar`); what tells them apart is that a burrow's and a mine's passengers must be
*workers*, while a transport takes anyone.

**10 gold a second is the FULL mine's rate, not one wisp's.** Nothing in the data states the
scaling in so many words; the parity between the four races' mining rates does. Five wisps in
an entangled mine must earn what five peasants earn out of a classic one, and a peasant's cycle
is `Agld`'s 1s inside plus the walk — about 2 gold/sec each, 10 for the line. So the payout
scales with how much of the capacity is actually aboard, which makes one lone wisp worth
2 gold/sec and a full mine worth 10.

While the roots are on it the mine is closed to *everyone*: a night elf cannot classic-mine its
own entangled mine and an enemy peasant cannot mine it at all without knocking the roots down.

**Renderer.** `EntangledGoldMine.mdx` is a whole mine wrapped in roots, not a decoration to lay
over one, so the plain gold mine's map widget is hidden while the building stands and shown
again if it falls. Its `NGOL` foundation decal comes up with it (`egol` paints `EMDB` in the
same place, and two ubersplats in one spot blend to a dark smear).

## 4. An Ancient is a building that can walk

Root / Unroot (`Aroo`, aliases `Aro1`/`Aro2`) — `Order=root` / `Unorder=unroot`, one ability,
two directions. Almost everything about the two states is *derived*: `recomputeStats` reads
`uprooted` for the walk speed and for which weapon slot is live (`DataA` "Rooted Weapons",
`DataB` "Uprooted Weapons" — the Ancient Protector's `Aro2` has them the other way round, which
is why planted it is a 700-range tower and uprooted a 128-range melee unit).

What cannot be derived is the physical transition, and the part that bites is which footprint
is meant. A structure blocks a **stamped `Footprint`** on the grid (`setPathStamp`) — the
Ancient of War's is 12×12 — and that stamp is not part of the reservation system at all. The
4-cell body an uprooted Ancient walks around with is a different thing. An Ancient that kept its
stamp while it walked was inside its own wall: every path out failed and planting again was
refused by the hole it had left, so it pulled its roots up and then stood there forever. So
uprooting lifts the stamp and carries it (`SimUnit.rootedStamp`), and planting lays it back
down — snapped to the build grid, where a fresh building would go.

Planting also has to **stop and let go first**. An uprooted Ancient holds a mover's reservation
and, mid-step, a claim on the tile ahead; asking `footprintBuildable` while it still holds them
is asking whether it can plant in a spot it is itself standing in. The answer is no, every time.

**Eat Tree** (`Aeat`) is the other thing every Ancient can do: pull a tree up and eat it for
`DataC1` = 500 hit points over `Dur1` = 30 seconds. That is a heal over TIME and not a heal —
"Eating trees now gives a constant, non-stacking healing effect" (1.03), raised to its present
500/30s in 1.13 — and non-stacking is why the buff is grouped on the ability's own `BuffID1`
(`Beat`): a second tree eaten mid-heal replaces the first rather than doubling the rate. The
tree is the cost: it is destroyed outright and nobody gets its lumber.

It is aimed at a POINT here rather than at a tree handle, because a tree is not a unit in this
sim; the handler eats the nearest one to the click that the Ancient can actually reach
(`Rng1` = 32, measured from its hull — which for a 12×12 Ancient of War is most of the reason
that number can be so small). `DataA1` 0.8 and `DataB1` 2.5 have field ids of their own and no
source that names them, so they stay unspent.

An uprooted Ancient trains and researches nothing — WC3 halts the queue rather than cancelling
it, so it resumes where it stopped when the Ancient plants.

**Its CARD says which way up it is**, and that is not decoration. WC3 hands a walking Ancient
the ordinary mobile order set — Move, Stop, Hold, Attack, Patrol — and takes the whole building
card away, because every button on it wants roots: the queue is halted, there is no rally point
to place, and Entangle Gold Mine has nothing to hold with. So `buildCommandCard` simply lets an
uprooted Ancient fall through to the movable-unit branch, and the one ability that would still
show in both stances is filtered by name (`ROOTED_ONLY` — `Aent`, and the game's own
`Mustroottoentangle` = "Must root adjacent to a gold mine to entangle it."). Eat Tree stays on
both cards: an Ancient eats trees walking or planted.

`Aroo` itself is the button that must appear in BOTH, wearing opposite faces — one row, two
directions, and `NightElfAbilityFunc` spells out the pair:

```
[Aroo]  Art=BTNRoot    Order=root      Tip="Root"     Buttonpos=3,2
        Unart=BTNUproot Unorder=unroot  Untip="Uproot" Unbuttonpos=3,2
```

A toggle shows what it can do NEXT, so a PLANTED Ancient wears the `un` half (BTNUproot,
"Uproot") and a walking one wears the plain half. Those `Un*` columns are parsed now
(`AbilityDef.unIcon`/`unTip`/…) — every Order/Unorder pair carries them, and so does every
autocast toggle's on/off art.

**The two states are two halves of one MODEL**, and which half is showing is `SimUnit.altModel`
(`recomputeStats`: planted = alternate). The Ancients carry no static `Animprops`, so nothing
else would choose for them, and the mapping is the reverse of the obvious guess: the PLAIN clips
are the walking form (`Walk` has no alternate twin — only an uprooted Ancient walks) and the
`* Alternate` ones are the planted tree. That is why the training pose is **"Stand Work
Alternate"**: an Ancient trains only while planted. A non-Ancient night elf building — the
Chimaera Roost, the Hunter's Hall — has no alternate half at all and simply plays "Stand Work".

Two traps live in that, and both are the kind you only see on screen:

* A clip whose name still says "alternate" by the time the picker looks at it belongs to the
  form the unit is **not** in. `applyAnimProps` renames or blanks them when the alternate props
  are on, so an unanchored `/stand work/` match with the props OFF finds the planted tree's
  working pose — which is what an uprooted Ancient played while it walked, its queue merely
  halted. Hence `AnimSet.standWork`, excluded by name like the carry/swim variants beside it.
* **`Morph` is the clip a form plays to LEAVE that form.** "Morph Alternate" is the planted
  Ancient hauling its roots up; the plain "Morph" is the walking one settling back down. So the
  transition is read off the state being moved FROM while the new stand/work set is built for
  the state being moved TO (`RtsController.applyFormAnims`). Read both off the destination and
  each direction plays the other's clip: an Ancient visibly uproots itself as it plants.

And its GROUND DECAL travels with it. The ubersplat is the mark the roots leave, so it belongs
where the roots are: removed the moment the Ancient pulls up, and painted afresh wherever it
plants — a new spot, since planting snaps to the build grid. An Ancient is the only building in
the game that moves, so this is the only place a splat is ever re-sited, and it is worth knowing
that a map-PLACED Ancient's decal is keyed by its `.doo` index rather than its sim id and has to
be found by the id it was tracked against (`liftedSplats` in mapViewer).

## 5. The Moon Well is a battery

"Mana Battery" is `Ambt`'s own comment in `AbilityData.slk`, and the word is exact. `emow` holds
300 mana (`manaN`), refills only after dark, and pours what it has into whoever needs it:

| column | value | meaning |
| --- | --- | --- |
| `DataA1` | 2 | hit points per point of the **well's** mana |
| `DataB1` | 0.5 | mana per point of the well's mana |
| `DataC1` | 10 | **unspent** — the drink is a burst, see below |
| `Area1` | 400 | how close the drinker has to be |
| `DataD1` / `DataE1` | 30 / 1 | **unspent** — see below |

The split between life and mana is the part no column states and every night elf player knows:
half the spend is offered to each, and the half nobody wants **spills into the other**. A
full-health hero therefore drains a well entirely into its mana bar, and a mechanical unit gets
nothing at all (`targs1` says `organic`).

**The drink is one step.** A unit that reaches a well flashes and its bars jump while the well's
mana drops by what that cost — it takes everything it can use in a single transaction and stops
early only when the well runs dry. Being able to see at a glance whether a well has another
unit's worth left in it is most of how the race is played, and a metered pour does not read that
way, so `DataC1` stays unread rather than trickling it out at ten mana a second. The spend is
still bounded at both ends: by what the drinker can absorb (`(maxHp − hp) / DataA1` plus
`(maxMana − mana) / DataB1`, in the well's own currency so the halves are comparable) and by
what the well has left.

`Rng1` = 99999 is deliberately not used as a range. A range of "the whole map" is the engine's
way of never refusing the order; what bounds the drink is `Area1`, and treating the 99999 as
real would let a well heal across the map. A unit ordered to drink from a distant well keeps the
order and gets nothing until it walks in.

**You order the DRINKER, not the well.** `Ambt` is the one ability in the game whose button is
on one unit and whose order is given to another: you select a unit, right-click a Moon Well —
your own or an **ally's** — and the unit walks over and drinks. So the order lives on the unit
(`SimUnit.drinkWellId`, a `{kind:"drink"}` QueuedOrder) and the well reads it when the drinker
arrives. It has to be an explicit order rather than a side-effect of autocast, because the well
ships with autocast OFF: `emow`'s `UnitAbilities.slk` `auto` column is `_`. Three ways a drinker
is chosen, in the order the player's intent runs — the unit the well was aimed at by hand, then
whoever was right-clicked onto it and has arrived, then (autocast only) the neediest friendly
standing nearby.

The art is all on the row, one model per place it belongs:

```
[Ambt]  Casterart  = …\NightElf\MoonWell\MoonWellCasterArt.mdl   on the WELL
        Effectart  = …\NightElf\MoonWell\MoonWellTarget.mdl      on the drinker
        Specialart = …\Human\Heal\HealTarget.mdl                 on the drinker
```

`Specialart` being the Priest's own Heal model is not a mix-up — it is where the green heal
sparkle over a drinking unit comes from, and the sound rides with it: WC3 keeps
`HealTarget.wav` in that model's own folder, which is exactly what `playSpellSound` resolves off
an effect's art. (`Effectart` is a five-entry list, one per race plus the corrupted well; the
first is taken, as everywhere else.)

`DataE1` = 1 is the one column that differs from the Obsidian Statue's otherwise identical
`Amb2` (which is 0), in the same place the two units differ — the statue refills its mana at any
hour and the well does not. "Night-only regeneration" is the obvious reading. So is "can restore
mana" (`Amb2`'s `DataB` is 0). Two equally good readings is not a reading, so the well's night
rule is keyed off its own ability row instead and cited to the unit's own tooltip
("Regenerates mana at night", `NightElfUnitStrings [emow]`). `DataD1` = 30 against the statue's
−1 is likewise unread.

Non-hero mana regeneration comes off `UnitBalance.slk`'s `regenMana` now rather than one flat
constant — a Sorceress 0.667, a Priest 0.72, a Spirit Walker 1, a Moon Well 1.5. An absent
column and a stated zero look the same to a parser, so 0 means "the row says nothing" and falls
back to `UNIT_MANA_REGEN`.

### It has no mana until it is finished

A structure still going up has no mana AND no mana bar — a Moon Well you have half-built is not
one you can drink from. Withheld by zeroing the CEILING rather than the current value, because
the bar is drawn off the ceiling: leaving `maxMana` up and `mana` at 0 shows an empty blue bar
where WC3 shows none at all.

What arrives with the finished building is **`mana0`**, not the pool. That column is a real
per-type number and it is short of `manaN` for 40 of the game's rows — every caster you have to
wait on: a Priest trained at 75 of 200, a Sorceress at 75, a Moon Well finishing construction at
100 of 300 ("Initial Mana: 100", Liquipedia).

### Well Spring (`Rews`)

| effect | value | |
| --- | --- | --- |
| `rmnx` | 125 | mana ceiling, 300 → 425 |
| `rmnr` | 0.52 | mana per second, on top of the well's own 1.5 |

Nothing in the upgrade names the Moon Well: the link is the other way round, from `emow`'s own
`upgrades` column (`Rews,Rgfo`), which is why the whole thing works through the ordinary
`upgradesUsed` path with no night-elf code in it.

`rmnr` is a FLAT rate and not a percentage, despite the tooltip rendering it as `<Rews,base2,%>%`
— Liquipedia lists it as "0.52 mana per second" and, better, explains where the number comes
from: the bonus mana is meant to refill over exactly one night, and 125 ÷ 240 seconds of night
= 0.52. (The present patch's +100 gives its 0.4167 by the same division, which is the check.)

The mana it already held rises with the ceiling — `recomputeStats` preserves a unit's fill
FRACTION through any ceiling move — so a fresh upgraded well opens at 141.67 rather than 100.
And the night rule covers the whole rate, upgrade included: a well that trickled by day would
defeat the thing it is an upgrade to.

## Not done yet

* **The uproot animation takes time — in the SIM, not just on screen.** Liquipedia lists
  Root/Uproot's "Animation Duration" as 2.5 seconds, which is `Aro1`'s own `Dur1`. The clip is
  played and held for its own length now (the right one in each direction, see §4), but the sim
  side is still instantaneous: the Ancient is a walker on the very tick you press the button,
  and in the original it is neither thing for those 2.5 seconds.
* **An uprooted Ancient should be HEAVY armour, not fortified.** `Aroo` `DataD1` = 2 is an index
  into the game's own defense-type ordering and the 1.30 tooltip says the answer outright:
  Root "gives the Ancient Fortified armor", Uproot "gives the Ancient Heavy armor" (and 1.06's
  patch note, "Ancients temporarily lose their fortified armor when they uproot"). The column is
  read but not spent — an Ancient stays `fort` in both stances.
* Wisp Healing (`Awhe`) and Ultravision (`Ault`) — both upgrade-gated, and Wisp Healing is a
  campaign ability (`Requires=Rewh`).
* The Tree of Life's own `Atol` / `Arlm`.
* `Aenc`'s Load button exists on the mine's card now, and so does Unload All; what is missing is
  the RALLY case — 1.10's "Wisps rallied to an incomplete Entangled Gold Mine will automatically
  begin to mine once the structure is completed".
* The four races' repair rates are still written out at the call site (`0.35` / `1.5` in the
  authority) rather than read from Rep1/Rep2. The numbers are right; the source is not.
