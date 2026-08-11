# The night elf economy

Every other race in Warcraft III plays the same economic game with different art: a worker
walks to a resource, fills up, walks home, unloads, repeats; a building is a thing you put
down and leave alone. The night elf plays a *different game*, and almost none of the
difference is a tuning value — each piece is a rule, and each rule is stated by a row in
`Units\AbilityData.slk` or `Units\UnitBalance.slk`.

This is that list, so the next person does not have to rediscover which column says what.

Implementation: `tickHarvest` / `orbitTree` / `finishConstruction` / `tickEntangledMines` /
`tickReplenish` / `toggleRoot` in [`src/sim/world.ts`](../src/sim/world.ts), the `Aent` and
`Ambt` handlers in [`src/sim/spells.ts`](../src/sim/spells.ts), the Wisp's profile in
[`src/data/races.ts`](../src/data/races.ts), and `raiseEntangledMines` in
[`src/render/mapViewer.ts`](../src/render/mapViewer.ts). Checked by
`tools/sim-nightelf-test.cjs` and `tools/sim-root-test.cjs` (`pnpm sim:test`).

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

An uprooted Ancient trains and researches nothing — WC3 halts the queue rather than cancelling
it, so it resumes where it stopped when the Ancient plants. And its ground decal travels with
it: lifted when it uproots, re-laid where it plants. It is the only building in the game that
moves, so that is the only place a splat is ever re-sited.

## 5. The Moon Well is a battery

"Mana Battery" is `Ambt`'s own comment in `AbilityData.slk`, and the word is exact. `emow` holds
300 mana (`manaN`), refills only after dark, and pours what it has into whoever needs it:

| column | value | meaning |
| --- | --- | --- |
| `DataA1` | 2 | hit points per point of the **well's** mana |
| `DataB1` | 0.5 | mana per point of the well's mana |
| `DataC1` | 10 | mana spent per second — the pour is a drink, not an instant |
| `Area1` | 400 | how close the drinker has to be |
| `DataD1` / `DataE1` | 30 / 1 | **unspent** — see below |

The split between life and mana is the part no column states and every night elf player knows:
half the spend is offered to each, and the half nobody wants **spills into the other**. A
full-health hero therefore drains a well entirely into its mana bar, and a mechanical unit gets
nothing at all (`targs1` says `organic`).

`Rng1` = 99999 is deliberately not used as a range. A range of "the whole map" is the engine's
way of never refusing the order; what bounds the drink is `Area1`, and treating the 99999 as
real would let a well heal across the map. A unit ordered to drink from a distant well keeps the
order and gets nothing until it walks in.

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

## Not done yet

* The Wisp's own abilities — Detonate (`Adtn`), Renew (`Aren`, which is free: its `Rep3`/`Rep4`
  cost factors are 0 where the human Repair's are 0.15/0.6) and Ultravision (`Ault`).
* Eat Tree (`Aeat`) on the Ancients, and the Tree of Life's own `Atol`/`Arlm`.
* Well Spring (`Rews`, +125 max mana on the Moon Well) is parsed as an upgrade but its effect on
  the well is untested.
* `Aenc`'s Load button on the mine's card. Loading is a right-click today; only Unload All is
  drawn, at that row's own art and slot (`Unart=BTNUnload`, `Unbuttonpos=0,2`).
