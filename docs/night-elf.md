# The night elf economy

Every other race in Warcraft III plays the same economic game with different art: a worker
walks to a resource, fills up, walks home, unloads, repeats; a building is a thing you put
down and leave alone. The night elf plays a *different game*, and almost none of the
difference is a tuning value — each piece is a rule, and each rule is stated by a row in
`Units\AbilityData.slk` or `Units\UnitBalance.slk`.

This is that list, so the next person does not have to rediscover which column says what.

Implementation: `tickHarvest` / `applyHarvestData` / `popFromCanopy` / `finishConstruction` /
`tickMineCrews` / `tickReplenish` / `tickRenew` / `toggleRoot` / `issueRootAt` /
`tickRootSettle` / `issueEntangleInstant` / `issueEntangleAt` / `entangleSite` / `tickEntangleAt` /
`issueDrink` in
[`src/sim/world.ts`](../src/sim/world.ts), the `Aent` / `Ambt` / `Adtn` / `Aeat` handlers in
[`src/sim/spells.ts`](../src/sim/spells.ts), the Wisp's profile in
[`src/data/races.ts`](../src/data/races.ts), `raiseEntangledMines` / `collectMoonWellWater` and
the command card's `UPROOTED_ONLY` in [`src/render/mapViewer.ts`](../src/render/mapViewer.ts), and the two-form clip
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
| `DataB1` / `DataC1` | 5 / 150 | Wha2/Wha3 — "Intervals Before Changing Trees" / "Art Attachment Height" (**unspent**) |
| `Targetart` | `TargetArtLumber.mdl` | the glow on the worked tree |
| `Effectsoundlooped` | `WispHarvestLoop` | not a per-hit sound: a loop |

There is no depot leg at all. 5 lumber per 8 seconds — 0.63/sec — is credited straight to the
stash where the wisp is standing, which lands within a rounding error of a Peasant's
10-per-trip round trip. The wisp buys that parity by being *stuck in the tree*: it is not
walking anywhere, so it is not defending anything either.

**And the wage is paid for the interval WORKED.** `Dur1` is eight seconds of work, so the tick
a wisp slips into the trunk pays nothing and the first 5 land eight seconds later — `workT` is
started at `chopPeriod` when it latches on (`tickHarvest`), not left at zero. Left at zero it
paid on arrival, which is not a rounding detail: it made *landing* the paid event, so a wisp
bounced from tree to tree earned 5 a hop and every fresh wisp's first tree paid instantly. A
chopper is the other way round and is left alone — its timer is the swing cycle and the wood
arrives WITH the blow (`chopSeq` plays the axe on that same tick), which is what WC3 shows.

**And none of those numbers is written in our code.** Units\UnitAbilities.slk names the harvest
ability each worker carries — Peasant and Peon `Ahar`, Ghoul `Ahrl`, Wisp `Awha`, Acolyte
`Aaha` — so `WorkerProfile.harvestAbility` carries the NAME and `SimWorld.applyHarvestData`
reads the rates off the row (`DataA` lumber per interval, `DataB` the load, `DataC` the gold a
trip is worth, `Dur1` the interval). The same reader corrected two hand-typed values while it
was at it: a Peasant chops every **1.1** seconds and a Ghoul every **1.35**, not the round 1
and 1.1 that had been transcribed.

`damagesTree: false` is literal. A wisp-worked tree never falls, so night elf lumber is bounded
only by how many wisps are in the forest. This is why `WorkerState.lumberCapacity` is 0 for the
wisp and why `Awha` has no capacity field that means anything: with no trip, there is nothing
to fill.

**One wisp to a tree.** A chopper works from outside and several Peasants may share a trunk, as
they do in the original; a wisp is *in* the tree, so an occupied one is not a queue you join but
a seat that is taken — WC3 sends the second wisp to a neighbouring tree, and five wisps told to
harvest one trunk end up in five. `SimWorld.treeWorkedBy` answers who has a tree and
`freeTreeNear` finds the nearest one nobody does; `issueHarvest` redirects at the order and
`tickHarvest` re-asks at the trunk, because a seat free when a wisp set out can be taken by the
time it lands (and two wisps sent at one free tree in the same breath both set out for it). The
order-time check counts a wisp *walking* to a tree as holding it — that is what splits a group
up on the way rather than at the end of it — while the arrival check yields only to a wisp
actually **working** it, so the one that got there first keeps its tree.

It is **derived, never stored**. A `takenBy` field on the tree would have to be cleared by every
path a wisp can leave one by (a new order, a Stop, Detonate, a death, a Moon Well, the tree
burning down), and the one that got missed would wedge that tree shut for the rest of the match
— the same shape of bug the gold mine's `busy` latch cost us once (`popFromMine`). Gated on
`deliversInPlace`, so it is the wisp's rule and nobody else's.

**The pose is `Stand Lumber`, and the two clips are not interchangeable.** `Wisp.mdx` authors
exactly five: `stand`, `Birth`, `Death`, `Stand Lumber`, `Stand Work`, and no attack of any kind
(a wisp does not hit the tree). `Stand Lumber` is the harvest; `Stand Work` is the hammering it
does to BUILD and to Renew — a repair, which is why `pickSequence` reaches it through
`u.repair.active` and not through the harvest branch. Wearing the work pose in the canopy is
what made night elf lumber look like an animation of our own invention rather than the one the
model ships.

**There is no Walk among those five either**, and that is not an omission: a wisp hovers, so its
idle IS its travel pose and WC3 plays exactly that when it flies. The picker has to say so —
`a.walk` is -1 here, and returning it left the caller with no sequence to apply and whatever was
already on the model still playing, so a wisp recalled off a tree flew the whole way there
still wearing `Stand Lumber`. A model with no walk clip travels in its stand, unrated (there is
no stride to match to a speed).

**And it holds still, INSIDE the tree.** A working wisp takes the trunk's own position and
hangs there — not a spot in front of it, and not a circle around it. (We did have it orbiting,
one lap per `Awha` interval, on the reasoning that "there is no swing to animate, so the motion
is the animation". It was our invention, and with the right clip playing there is nothing for
it to add.)

Standing there is only possible because a working wisp has already given up everything that
would forbid it — it holds no reservation and collides with nothing — and it is why
`popFromCanopy` exists: those are the tree's own BLOCKED cells, and A* cannot start from one.

Two more things survive the orbit's removal, because they were never about the motion:

* **Arrival is measured against the tree's BLOCKED footprint**, not against an axe's arm. A
  wisp never enters those cells at all — it stops against them, further out than a chopper
  stands. Measured the chopper's way it arrives, is judged out of reach, re-targets the nearest
  tree, is out of reach again, and drifts across the map one tree at a time.
* **A working wisp holds no cell** (`unsettle` + `noCollision`), or a body parked against the
  treeline would wall the forest off one wisp at a time. The cost is that where it stands can
  be inside a neighbouring trunk's block — a grove's footprints overlap — and A* cannot START
  from a blocked cell, so `popFromCanopy` puts it back on walkable ground the moment it is
  given any other order. Symptom without it: wisps recalled from a grove accept the order, play
  the walk, and never arrive.

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

Three rows, none of them on the wisp — and a fourth on the building it makes:

| ability | on | says |
| --- | --- | --- |
| `Aent` "Entangle" | Tree of Life | `Rng1` 500, `Cast1` 3s, `targs1` = `_`, **`UnitID1` = `egol`** |
| `Aenc` "Cargo Hold (Gold Mine)" | `egol` | `Car1` = 5 — the crew |
| `Aegm` "Entangled Gold Mine" | `egol` | `DataA1` 10 gold per `DataB1` 1 second |
| UnitBalance | `egol` | **`bldtm` = 60** — and `goldcost`/`lumbercost` 0 |

`targs1` being `_` is not an omission: Entangle takes **no target**. You press the button and it
wraps whatever un-entangled mine is inside 500 units, which is why a night elf expansion is a
Tree of Life planted at the mine. And it does not convert the mine — `UnitID1` says it *creates
a unit*, so the `SimMine` goes on being the gold and a building with 800 HP is raised over it.
`SimMine.entangledBy` is the seam. Knock the building down and the mine is a mine again.

**Taking a mine costs a minute, and the last row is where that lives.** Because `Aent` creates
a *unit*, the mine it makes is CONSTRUCTED like any other structure: `egol` carries a `bldtm`
of **60**, and it serves it the way a Moon Well serves its 50 — up from a tenth of its 800 hit
points to all of them, paying nothing until the bar fills. So the true cost of an expansion is
that minute and no resources at all, which is the trade the race is built on: gold that arrives
with no round trip, bought with a town hall standing exposed at the mine while the roots close.
(`Cast1` = 3s never runs in normal play — Entangle is the walking card's button and the errand
it starts throws the roots as the tree plants, with no cast in front of it. See §4.)

Nothing builds it. `egol` costs nothing, there is no Build order that makes one, and no Wisp is
consumed — the *Tree's* roots are what raise it. It is therefore the one structure in the game
that advances its own construction with nobody hammering it: `BuildingState.selfBuilds`, which
`attachEntangled` sets and `tickBuildings` reads before it goes looking for a builder.

The exception is the melee opening, and again it is the ORDER that says so rather than a
special case: `entangleinstant` is instant in both senses — no 3s cast, and no 60s build — so
a night elf game opens with a finished mine its five Wisps walk straight into.

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

**It arrives on the interval, in whole gold.** `DataB1` = 1 second is a CLOCK, not a unit to
divide by: paying a fraction of a coin every frame put a running `656.5666666` in the treasury
and made the counter creep where WC3's steps. `SimUnit.workT` on the mine building is that
clock, and the crew is read when it comes round — so a crew that changes mid-interval simply
changes what the next payout is worth, and marching wisps in and out cannot buy an early one.

**The crew is visible from the map.** WC3 floats a second bar under a garrisoned building's
health bar, cut into one division per slot — five for the mine (`Aenc` `Car1`), four for an Orc
Burrow (`Abun`) — and shows it only while somebody is inside. It is a COUNT, not a fraction:
`BarSpec.garrison` carries `filled`/`slots` and `worldOverlays` builds one little track per
slot, so four-of-five reads at a glance the way it does in the original.

While the roots are on it the mine is closed to *everyone*: a night elf cannot classic-mine its
own entangled mine and an enemy peasant cannot mine it at all without knocking the roots down.

**"Go work that mine" is one order and two different jobs.** Rallying the Tree of Life onto its
own mine is the standard night elf opening, and the caller that carries it out (`applyRally`)
does not know whose worker it is holding. `issueHarvest` refuses an entangled mine on purpose —
correctly, twice over: there is no shaft, and a wisp has no pick — so a rally that asked for a
harvest got a refusal and fell through to a plain *move*, and every new wisp walked to the rock
and stood beside it. `SimWorld.issueGoldWork` is the one door both jobs go through: entangled →
`issueGarrison` into the building (this crew), bare → `issueHarvest` (everyone else).

The plain **right-click** is the other caller, and it reaches the same place from two directions:
the building covers the rock, so most clicks land on the `egol` and go through `orderOnBuilding`,
while one on the rim of the footprint finds the mine and follows `SimMine.entangledBy` to the
same host. Both go through `RtsController.manHold`, and both mean it while the roots are still
CLOSING — the crew walks over and waits at the door (1.10, above). What `manHold` adds is the
**cap**: `Aenc` `Car1` = 5, so a click with eight wisps selected sends five and leaves the other
three doing what they were doing. Ordered in regardless they would all walk over, wait out the
whole 60 seconds, and then be turned away by the five who got there first.

None of them is IDLE while any of that is happening, and the badge on the left has to agree.
A worker walking to a job carries the job as its `order` (`garrison` here) for the whole walk,
and standing at the door of a mine that has not finished is a wait rather than an idleness — but
a worker that is INSIDE a hold is parked on `idle`, because in there there is no order to have.
So `isIdleWorker` tests `isOffField`, not just `inMine`: a wisp mining inside an entangled mine
and a peon manning a burrow are working, and the badge that offers to fly the camera to them
would otherwise be offering to select a unit that is not on the map.

The wisp it pushes out is born a couple of cells from the rock, which is close enough to bite on
two pathing details, and both are fixed where they belong rather than in the rally. `hostApproach`
now snaps the door onto a block the passenger actually *fits* on (`nearestWalkable` clears one
cell, and a one-cell door is no door to a two-cell wisp — the same trap `mineStandSpot` documents
at length), and `issueGarrison` no longer reads one blocked A* as "the way is shut": bodies in the
way park the walk and take it up again when they move (issue #108's rule), only terrain ends it.

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
that number can be so small). `DataA1` 0.8 and `DataB1` 2.5 are "Rip Delay" and "Eat Delay"
(AbilityMetaData `eat1`/`eat2` through `UI\WorldEditStrings.txt`) — the two beats of the
animation, not of the heal — and stay unspent.

An uprooted Ancient trains and researches nothing — WC3 halts the queue rather than cancelling
it, so it resumes where it stopped when the Ancient plants.

**Its CARD says which way up it is**, and that is not decoration. WC3 hands a walking Ancient
the ordinary mobile order set — Move, Stop, Hold, Attack, Patrol — and takes the whole building
card away, because most of what is on it wants roots: the queue is halted and there is no rally
point to place. So `buildCommandCard` simply lets an uprooted Ancient fall through to the
movable-unit branch, and the ability rows that belong to one stance are filtered by name:

* `UPROOTED_ONLY` — **Eat Tree** (`Aeat`) and **Entangle Gold Mine** (`Aent`, see below).
  For Eat Tree the DATA says why rather than intuition:
  `[Aeat] Buttonpos=0,2` collides head-on with `[Reib] Buttonpos=0,2` (Improved Bows), with
  Sentinel at 1,2 and Vorpal Blades at 2,2 filling out that line. Two buttons cannot share a
  cell, so the planted card's bottom row belongs to the upgrades and Eat Tree is not on it —
  which is also how it is used: an Ancient eats a tree by walking to one.

**And a walking Ancient's right-click on a tree IS Eat Tree**, the same way a walking Tree of
Life's right-click on a gold mine is Entangle. Shift-queueable like any other order — four
clicks are four trees, eaten in the order they were clicked — which took a `cast` member in
`QueuedOrder`: without one, `c: "cast"` went straight to the sim past the queue entirely, so
each click replaced the last and the Ancient walked past three trees to eat the one clicked
most recently.

Two things about a tree make the aim harder than it looks, and both are about the same fact —
**a tree is a BLOCKED 4×4 (or 2×2) square on the pathing grid, and the order names its middle**:

* `Rng1` = 32 is measured to that middle, and nothing can ever stand within 32 of it. So the
  approach waits at a range it can never make and the cast never fires. `SimWorld.aimedBlockRadius`
  adds the block's own half-extent to the pending cast's range — a property of the thing aimed
  at rather than of the ability, which is why it is added at issue rather than in the data.
* The stuck watchdog asks "is that destination reachable terrain?" of the point the walk was
  aimed at, and for a trunk the answer is always no — so a walk long enough to trip the
  watchdog had the order CANCELLED mid-stride (`holdOrGiveUp`), which on a queued line of trees
  silently skipped one and moved to the next. `checkStuck` now leaves a `cast` order alone for
  the same reason it leaves an `attack` one alone: tickCast's approach owns it.

(Walking at a computed spot on the range ring instead is the fix that does NOT work: the ring
around a trunk is where the rest of the grove is, so the goal lands on a blocked cell, the path
"arrives" a body short, and the Ancient stands there with the spell never cast.)

**A ROOTED Ancient is a TOWER, and the sim has to agree.** It carries a walker's `baseSpeed` in
both stances — it is one unit, and the walk is what it uproots for — so anything that asks "can
this thing come to me?" off the speed field alone gets it wrong. `SimWorld.canPursue` is where
that question lives, and it excludes an Ancient whose roots are down; everything hanging off it
then falls out for free: an ordered attack outside weapon range refused at the click with
[Errors] `Notinrange`, a target that walks out of range let go instead of held, and a right-click
on the ground that is not a move order at all. The last one was the visible bug — an Ancient
Protector pivoted to face every click on the terrain, and left a green move arrow behind.

**The root gesture turns twice as fast as it settles.** The last stretch of the walk onto the
site is spread across the whole 2.5s transition (`SimUnit.rootSettle`), but the turn back to
`builtFacing` runs at `ROOT_TURN_SPEEDUP` = 2 — square with the base by the half-way mark. A
tree still swinging round while its roots are already in the ground reads as being dragged into
place rather than planting itself.

**Entangle Gold Mine is on the WALKING card, and only there.** It reads like a rooted ability
and it is not: a Tree of Life is uprooted for precisely as long as it takes to reach an
expansion, which is the entire time you want to press this. The game's own refusal line is the
proof rather than the counter-argument — `Mustroottoentangle` = "Must root adjacent to a gold
mine to entangle it." is an error the *walking* card has to be able to raise, because a button
the walking card never showed could never produce it. So `Aent` joins `Aeat` in `UPROOTED_ONLY`
and a planted Tree of Life's card is Train Wisp / Nature's Blessing / Backpack / Well Spring /
Tree of Ages / Uproot, with nothing at 1,2.

Pressed on a walking tree it is not a cast at all but an ERRAND, and so is the right-click:

* **Right-click a free gold mine** with an uprooted Tree of Life → `{kind:"entangleat"}`.
  `SimWorld.issueEntangleAt` picks the site, `issueRootAt` walks it there, and `tickEntangleAt`
  throws the roots the moment it plants. A planted tree is not asked at all (its right-click
  never gets past `acceptsRally` anyway).
* **Pressing the button** is the same errand with no mine named: `issueCast` hands `Aent`
  straight to `issueEntangleAt`, which applies the ability's own no-target rule and takes the
  nearest free mine inside `Rng1` = 500. Nothing in reach is the refusal the error line
  describes.
* **The site's only requirement is that the ability can be cast from it.** `entangleSite`
  sweeps rings around the MINE — the answer has to be a whole free 12×12 on the build grid, and
  around a rock there are only a handful — but it scores them by distance to the TREE and takes
  the nearest, out to `Rng1` + the mine's radius (exactly how `entangleMine` measures). A tree
  already standing inside that range therefore has nowhere to go and roots where it is: walking
  one that could already reach the rock would be the order overriding the ability's own range.
* **There is no cast in front of it.** The mine starts closing on the same tick the tree starts
  lowering itself onto the site — not after the 2.5s root transition, and not after `Cast1`.
  `tickEntangleAt` calls `entangleMine` directly rather than going through `issueCast`, which
  is also what lets it name the mine the player clicked instead of re-deriving "the nearest
  one". (`Cast1` = 3s survives on the raw cast, which is what a JASS `entangle` order aimed at
  a planted tree still gets.)
* **"Free"** is checked on the smart order, not on the ability: un-entangled (and un-haunted,
  which is free for now — we do not model a Haunted Gold Mine) *and* not being worked by
  another player. That last one is not a rule of `Aent` — Entangle is perfectly happy to wrap a
  mine an enemy peasant is walking out of — it is a rule of the CLICK, which must not silently
  march your town hall into somebody's base.

"No rally point" then has to be enforced past the card as well, and `SimWorld.acceptsRally` is
where: the rally flag, the rally button, the hero-portrait rally **and the plain right-click**
all read it, or a walking Ancient answers "go there" by planting a flag and standing still.

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

**The transition takes 2.5 seconds and the Ancient is neither thing for them.** `Aroo`'s own
`Dur1` says so and the models author the pair of clips for it. The stance flips at once —
everything derived from `uprooted` (the live weapon slot, the walk speed, which half of the
model shows) has to be consistent from one instant — and the unit is then LOCKED for the
clip's own length: `SimUnit.morphT` counts it down, `castLocked` refuses orders through it and
`recomputeStats` zeroes the speed. Without the lock a just-uprooted Ancient slid across the
ground through its own morph, and a planting one was a building before it had sat down.

**A planted Ancient with anything in its queue cannot pull itself up at all.** WC3 greys Uproot
out for as long as it is training or researching, and `SimWorld.rootRefusal` is the one place
that says so — the card reads it to grey the button and `toggleRoot` reads it before it acts,
so the two can never disagree. (It is the mirror of "a walking Ancient's queue is halted rather
than cancelled": the halt only has to cover work that was already under way.)

**And it settles square.** A building has ONE facing in WC3 (`bj_UNIT_FACING`, 270°), so an
Ancient that plants keeps nothing of the direction it happened to be walking in: it turns back
to `SimUnit.builtFacing`, the angle it was RAISED at. Per unit rather than a constant, because
a map may place a building at any angle and that is the angle it should return to.

**…and the two directions are not the same GESTURE.** Uproot is instant: the Ancient hauls
itself up where it stands. **Root is a placement** — pressing it hands the player exactly what
a worker's Build button hands them, the finished building's silhouette riding the cursor over
a green/red footprint grid, and the click chooses the SITE. The Ancient then walks there and
settles on it.

So Root is an order with a destination (`{kind:"rootat"}`, `SimWorld.issueRootAt`), not a
toggle, and it rides the build-placement machinery whole: `MapViewerScene.placement` grows a
`rootUnitId`, and with it set the click skips the worker, skips the price and issues the order
to the Ancient itself. The site is asked for twice — once at the click, so the player is told
("Unable to root there.", the game's own `Cantroot`), and again by `toggleRoot` on arrival,
because the ground can be taken while a tree walks 500 units at speed 40.

**Every site is walked to, including the one under its own feet.** There is no "close enough,
plant now" shortcut, and the reason is that the shortcut's reach was a body's width: an Ancient
of War is 144 across, so *most of the ground a player actually aims at* was inside it and the
tree snapped into its rooted pose on the click — which also meant a player who wanted the root
flow had to place the ghost further away than they meant to. `issueRootAt` now always issues the
move; a site it is already standing on is refused by `issueMove` alone (`MOVE_MIN_DIST`), which
is not a refusal of the ORDER — the tree simply roots from where it is on the next tick.

**And the plant is a gesture, not a jump.** A move stops within a body of the point it was aimed
at and facing whatever way it travelled; a building has to end up ON its site and square with the
base (`builtFacing`). Both are therefore spread across the transition itself
(`SimUnit.rootSettle`, `tickRootSettle`): the last stride and the turn play out over `Aroo`'s own
2.5 seconds while the root animation runs, and both ends are pinned so the clock cannot leave a
building half-way anywhere. The ubersplat is the one thing that does NOT wait — it is laid where
the FOOTPRINT went down (`pathStamp`), which is the site, not where the unit has got to this
frame.

Two details that are easy to get wrong. The grid the player aims with is the stamp the Ancient
**lifted** (`SimUnit.rootedStamp`), not a fresh read of the pathing texture — they agree, and
this cannot drift. And the arrival tolerance has to include the unit's own RADIUS: an Ancient
of War is 144 across and a walk aimed at a point stops about a body short of it, so a flat
one-cell test lost the order every time and the tree just stood there. (The tolerance is what
lets the order SURVIVE the walk; the settle above is what closes the gap it leaves.)

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
* **The work pose has to be matched by TOKENS, not by the phrase "Stand Work."** The Ancients
  spell theirs `stand work alternate`; the Tree of Life spells its
  `stand birth alternate work upgrade first second`. A substring test finds the first and not
  the second, which is why a Tree of Life training a Wisp or teching up simply held whatever
  clip it was already playing.
* **A state prop is EXCLUSIVE where a tier prop is inclusive**, and TreeOfLife.mdx is one file
  serving all three tiers, so both of its stands carry the same tier tokens:
  `Stand Upgrade First Second` and `Stand Alternate Upgrade First Second`. `isMine` is a
  superset test ("my tokens are all present"), which is right for tiers — one
  `Birth Upgrade First Second third` serves three towers — and claimed BOTH of those for a
  Tree of Ages, which then fidgeted between its walking pose and its planted one while it
  walked. A clip carrying an `alternate` I do not have is the other form's, whatever else it
  carries.
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

The art is all on the row, one model per place it belongs — and only two of the three are cast
effects:

```
[Ambt]  Casterart  = …\NightElf\MoonWell\MoonWellCasterArt.mdl   flashes on the WELL
        Specialart = …\Human\Heal\HealTarget.mdl                 flashes on the drinker
        Effectart  = …\NightElf\MoonWell\MoonWellTarget.mdl      IS the water. See below.
```

`Specialart` being the Priest's own Heal model is not a mix-up — it is where the green heal
sparkle over a drinking unit comes from, and the sound rides with it: WC3 keeps
`HealTarget.wav` in that model's own folder, which is exactly what `playSpellSound` resolves off
an effect's art.

### The water in the basin IS the mana bar

`Effectart` is a five-entry list and the row's own comment says what the five are: "One for each
normal race, and a special one for demons and their corrupted moon well." That is a list of
WELLS, not of drinkers. `MoonWellTarget.mdl` is a flat hexagon of rippling blue water — the pool
standing in the basin — and its **level is the well's mana**.

The level is a HEIGHT, and it is the engine's to set: there is no clip to park a playhead in.
The model is one bone ("PoolSurface") with **no animation tracks at all** over six vertices
lying flat at z = 7.28; the only things its two sequences move are a texture rotation on a
global sequence and the `ElderPond01` emitter's drift. Reading it as a loading bar
(`docs/loading-screens.md`) — mana fraction along `Stand`, `timeScale` 0, `forced` — therefore
moved nothing: the well brimmed at every mana. It was worse than a no-op, because the frozen
clock stopped the ripple and the particles too; both ride `dt * timeScale`.

So it is not played at a cast at all. It is a persistent model on the building, riding the same
pool as buff art (`collectMoonWellWater`), and what varies is where the plane is PUT: linear in
the mana fraction between `MOON_WELL_WATER_LIFT_DRY` and `MOON_WELL_WATER_LIFT`, so a full well
brims, a drained one shows bare stone, and a well refilling through the night visibly climbs.
Read as a cast effect instead, the water flew to whoever drank and evaporated a few seconds
later.

**A gauge may not be read through the fog.** The well itself keeps its image once explored — WC3
leaves the last thing you saw standing on the ground — but this model's height is the well's
LIVE mana, so drawing it from that memory told you, second by second and from across the
map, how much healing an enemy night elf had banked and exactly when a unit had just drunk.
`collectMoonWellWater` now takes live sight of the well (`pointVisible`), like everything else
that moves; the pool tidies itself away and the next look re-fills it at whatever level it has
really reached.

Two placement traps, both of which look like "the water is missing":

* It must be **centred on the well and lifted into the basin**, not hung from a bone. The model
  carries its own height above wherever it is put, so at the unit's feet it sits inside the
  stone — drawn, and invisible. The artist's own answer is the well's `Sprite First Ref`, which
  is at the right height and on the RIM, so riding it puts the pool half off the rock;
  `MOON_WELL_WATER_LIFT` is that height without the offset, and it is measured rather than
  read, because no column states it. `MOON_WELL_WATER_LIFT_DRY` — the bottom of the ramp — is
  measured off the geometry instead of by eye: raycast `MoonWell.mdx`'s body straight down over
  the pool's own footprint and the basin is a DISH, stone at z = 11.2 dead centre and z ≈ 17.5
  out at the hexagon's rim, and a flat plane can only rest on the shallowest part of a dish.
  Minus the pool's own 7.28 that is 10 — the last puddle before zero mana takes the model away
  entirely.
* The reference height is the BUILDING's, not the terrain's. A structure is seated above the
  ground it stands on, so its water has to rise with it.

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
* The four races' repair rates are still written out at the call site (`0.35` / `1.5` in the
  authority) rather than read from Rep1/Rep2. The numbers are right; the source is not.

## The Moon Well has to be ARMED, and a Burrow is asked for by its ability code

Two bugs that both came from treating a night-elf building as something else, and both cost the
race a lot:

- **`Ambt` is on Computer+'s `HAND_AUTOCAST` list** — the short list of autocasts plus/casting.ts
  deliberately does not switch on for itself — which left the decision to the army manager, and
  the army manager never made it. So a night elf computer's wells poured into nobody but the units
  it explicitly walked to them. `ComputerPlusAi.wellPass` now arms every replenisher it owns.
- **The Entangled Gold Mine has a `garrisonCap`** (`Aegm` Car1 = 5), so any code that asks "does
  this building have a cargo hold" rather than "is this an Orc Burrow" (`Abun`) picks it up.
  Computer+'s burrow pass did, and stood the whole mine crew *down* every army pass — the wisps
  went in and out of their own gold mine every two or three seconds, all match. Ask the hold's own
  ability code; see [`computer-plus.md`](./computer-plus.md).
