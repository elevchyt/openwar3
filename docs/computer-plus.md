# Computer+ — the improved melee AI

> Read this before touching anything in [`src/ai/plus/`](../src/ai/plus/), the Advanced Options
> pane's Computer+ switch, or the Gameplay panel's "Use Computer+ as default AI". Issue #124.
>
> Its sibling is [`melee-ai.md`](melee-ai.md) — Blizzard's own melee AI, which this does not
> replace, change or share a line of state with.

Warcraft III ships one melee computer, and we ship a port of it: four JASS scripts on a JASS
library on about 150 engine natives, transcribed function for function
([`melee-ai.md`](melee-ai.md)). It is the reference, and it is also — by every account since
2002, including issue #124's — an *unpleasant first opponent*: the easy computer still expands,
still towers, still masses, and still runs a build order a new player cannot answer.

**Computer+ is a second player sitting at the same controls.** Not a difficulty slider on the
first one: a different strategy layer, a different army manager, a different spell chooser and a
different set of manners, seated per slot by a checkbox in Advanced Options.

## What AMAI contributed, and what it did not

[AMAI](https://github.com/SMUnlimited/AMAI) is the reference issue #124 names, and being honest
about what was taken from it matters — it is **GPL**, and it ships as JASS inside a map, so the
standing rule in [`CLAUDE.md`](../CLAUDE.md) applies: *study, don't lift*. It was read; nothing
was copied. No AMAI code, no AMAI numbers.

Two of its **shapes** are here, and both are ideas rather than data:

* **A race is a weighted table of named builds, and each build owns its expansion clock.**
  AMAI's `TFT/<Race>/Strategy.txt` is where this is legible — one row per strategy ("I'm going
  gryphon riders", "I'm going mass crypt fiends"), each with its key units, the tier it aims at,
  a roll weight, and an `expansion time` / `second expansion time` pair. That last column is the
  insight worth having: *when you take a second mine is part of the build order*, not a property
  of how good the player is. Our `PlusStrategy` is that idea with our own builds and timings.
* **A beaten AI says so and leaves** — and the one thing issue #124 asks us explicitly *not* to
  copy, its demolishing its own base on the way out, is the section below.

Two of its ideas were deliberately rejected:

* **Personality profiles.** AMAI's `TFT/Profiles.txt` gives each bot a name, a taunt rate and a
  surrender value (Hunter, Crazy_Rusher, Xerox…). Issue #124 rules the whole idea out in as many
  words. A Computer+ player is anonymous: the build decides the play and nothing decides a
  personality.
* **Mid-game strategy switching.** See below.

One place we went further: AMAI names each strategy's key buildings by hand, which can disagree
with the units the strategy actually asks for. Here a strategy names units and weights only, and
its buildings and upgrades are derived — a build cannot be inconsistent with itself.

## The one-paragraph shape of it

| Layer | Classic melee AI | Computer+ |
| --- | --- | --- |
| Strategy | four transcribed scripts, one build order each | ONE build routine over a table of NAMED BUILDS per race, rolled per match ([`plan.ts`](../src/ai/plus/plan.ts), [`races.ts`](../src/ai/plus/races.ts)) |
| Countering | none | reads the scouted enemy composition off the game's own damage table ([`counter.ts`](../src/ai/plus/counter.ts)) |
| Difficulty | 40 `!= MELEE_NEWBIE` guards scattered across five files, plus two engine cheats | one table, [`profile.ts`](../src/ai/plus/profile.ts) |
| Army | `common.ai`'s captain: a muster list, one wave at a time | one group, food-capped at production, with defend/attack/retreat states |
| Spells | one hiveworkshop thread, transcribed ([`casting.ts`](../src/ai/casting.ts)) | roles + a priority ladder + target value ([`plus/casting.ts`](../src/ai/plus/casting.ts)) |
| Items | none | **builds a shop**, buys from it, and presses what it carries |
| Manners | none | glhf, gg, and it leaves |
| Library / natives | [`aiPlayer.ts`](../src/ai/aiPlayer.ts) | **the same file** |

The bottom row is the important one. `AiPlayer` is the census, the build array, `OneBuildLoop`'s
gold priority, structure placement, the harvest plan, town bookkeeping and hero skills — none of
which is a *strategy*, all of which both AIs need, and all of which is Blizzard's own design.
Computer+ keeps it and replaces everything above it.

## It does not cheat

The classic INSANE computer gets exactly two things, and neither is skill:

* it is **paid twice** for every load its workers carry home (`INSANE_HARVEST_FACTOR`);
* it **ignores the fog of war** (`AiPlayer.knows`).

Computer+ takes **neither, at any difficulty**. `ComputerPlusAi.add` sets
`AiPlayer.bypassFog = false`, and `RtsController.startMeleeAIFor` returns before the harvest
bonus for a Computer+ seat. Every difference between its three rungs is a number in
`PlusProfile`, and every one of those numbers is something a *human* varies.

That is also why Computer+ has a **scout** and the classic AI does not: with no fog cheat,
walking a worker past the enemy's base is the only way it can ever learn about an expansion
(`AiPlayer.enemyExpansion` is gated on `knows`). One worker, one tour, never replaced when it
dies.

### The tour is the enemy START LOCATIONS

`scoutWaypoint`. Three stops on a ring of `SCOUT_STANDOFF` (1000) about the **nearest enemy's
start location**, starting on the side the scout is already coming from and stepping off it by
`SCOUT_ARC` either way — then the **other enemy start locations**, each stood off the same way,
then home.

Every noun in that sentence was something else once, and each of them was a way the scout died.

- **The centre of the ring is a START LOCATION, not `enemyBase()`.** `enemyBase()` hands back the
  enemy structure nearest to *our* home — the near **edge** of their base, or a tower they put up
  facing us — so a ring drawn round it is a ring drawn round the doorstep: the stop on our own
  bearing is genuinely outside, and the two beside it are 1000 from an edge building and therefore
  well **inside** the base. That is "the scout walks too deep and dies", and it is geometry rather
  than tuning. A start location does not move and does not depend on what the enemy has built.
  Reading them is not a fog bypass — it is the same exemption `AiPlayer.knows` already states for
  the enemy main (*"every melee player is handed the start locations — that is what a melee map's
  start locations ARE"*), plumbed in as `PlusHost.startLocations`.
- **The later legs are start locations and no longer GOLD MINES.** A melee map's mines are
  *guarded*, every one of them, so the tour used to finish by aiming a lone worker at a creep camp
  — `standOff` kept it from walking all the way in, but a leg whose whole purpose is to approach a
  camp is a leg spent standing at the edge of one. They are also not what a scout is *for*: what a
  person wants out of the first worker is the opponents' bases, and on a melee map that is exactly
  the start locations. The expansion is read off the same walk anyway — an enemy hall standing
  where the map promised nobody is what `enemyExpansion` looks for, and the route between two
  start locations passes the ground between them.
- **`SCOUT_ARC` is 0.7 rad (about 40°), not 1.1.** Three stops 63° apart span 126°, which is not
  a look from three sides — it is a lap, and a melee main sits on a plateau with one ramp, so the
  walk from one stop to the next is routed by the pathfinder straight back through the base it was
  standing off.
- **`SCOUT_STANDOFF` is measured against the real sight radius.** A worker sees **800** by day and
  600 by night (`UnitBalance.slk` `sight`/`nsight`; a Wisp 1000/750) — *not* the 1400 an earlier
  comment in this file claimed. A melee main's buildings sprawl to roughly 600-1000 from the hall,
  so from 1000 the scout stands at the edge of the sprawl with its near half inside its own eyes,
  and the tech is read off the buildings it can see rather than off the hall it cannot reach.

Aiming the first leg at the town centre, which is what the very first version did, marches a lone
worker through the front door, past the towers and into the army: it dies, `scoutDone` latches
because nobody follows a scout that did not come back, and that one walk is the whole of what the
AI ever learns about the map.

### It runs at the first scratch

No amount of geometry covers this one, and it is the other half of "it goes too deep and dies": a
standoff ring says where the scout *meant* to stand, and an army that walks out to meet it or a
tower that goes up while it is looking says where it actually is. So two rules end the tour on the
spot, both in `scoutPass`:

- **Its health went down.** Read off the HP falling since last pass rather than off a damage event
  — *"am I being shot at"* is a question the order system cannot answer and a comparison can. What
  is left to look at is worth less than the worker, and a scout that walks home hurt has already
  delivered everything it saw on the way in.
- **A PLAYER's armed unit is within `SCOUT_DANGER` (700).** The enemy army walking out to meet it,
  a tower that went up while it was looking. Workers and unarmed buildings are not threats, or the
  tour would abandon itself on the first Farm it saw. 700 is just inside a worker's own daylight
  sight, so the rule fires on what the scout can genuinely see; it is still gated on `knows` so a
  later change to the radius cannot quietly turn it into a fog bypass.

  **Creeps are deliberately not asked about here**, and leaving them in made the whole tour
  pointless. A melee map's camps sit on exactly the ground between two bases, `safeLeg` gives them
  a 900 berth but hands back its *best attempt* rather than a guarantee, and 700 of best effort is
  a very ordinary result — so the scout turned round on the first camp it walked past, every game,
  usually before it had seen anything. Creeps already have the right two rules: the berth arcs the
  route round them, re-asked twice a second, and if one acquires the scout anyway its health drops
  and the first rule sends it home. What this rule is *for* is the thing no berth can be computed
  against — an army, which chose to be there.

Both are asked **only once the scout has left home** (`TOWN_RADIUS`), and that clause is not a
detail: `tourOver` latches `scoutDone`, so a rush standing in our own base at the sixtieth second
would otherwise end scouting for the whole match before the worker had taken a step. Being shot at
at home is `defendPass`'s business, not the tour's — the tour has not begun.

### …and it is thought about on its own clock

`SCOUT_PERIOD` (0.5 s), not `armyPeriod`. The pass used to run inside `armyPass`, whose period is
the difficulty's *reaction* time: three seconds on Easy, 1.5 on Normal. A worker walks 190-350 a
second, so on Easy the route was re-asked once every 600-1000 units of walking — **wider than
`CREEP_BERTH` itself**. Every arc round a camp was decided once and then walked blind, which is
most of "it still aggroes creep camps sometimes": the berth was never wrong, it was simply not
being re-asked while the scout crossed it. One unit and one distance check is cheap enough to ask
twice a second at any difficulty, and the difficulty has no business in it anyway — an easy
computer reacts to an *attack* slowly; it does not walk into trees more often.


### The walk home is a LEG, not a parting order

`headHome` / `release`. The tour used to end by firing one `safeStep` toward home and latching
`scoutDone` on the same line, and both halves of that were wrong in the same way — the tour
stopped being managed at the exact moment the scout still had the whole map to cross:

- **`safeStep` hands back a *step*, not a destination.** When a camp is on the way, that step is a
  detour waypoint thrown out *sideways* from the line home. So the order the scout was released
  with was never "go home": it was "walk to a point in the middle of the map", and that is where
  the worker stopped and where the harvest plan found it. That is *"they came back and started
  chopping miles from the hall"* — the scout never came back at all.
- **Nothing re-asked the route.** The way *out* was arc'd round camps twice a second and the way
  *back* was a straight line through them. That is *"scouts don't avoid creeps on the way home"*,
  and it is the more expensive direction: a scout that dies on the way out has at least looked.

So the walk home is a leg like any other. The scout stays `held` (the economy may not re-task a
worker halfway across the map), the step is re-aimed every `SCOUT_PERIOD` through the same
`safeLeg` arcs, and `release` hands the worker back standing at its own hall — where the harvest
plan is good at placing it. Two details the leg needs that the outward ones do not:

- **Arrival is measured by distance alone**, not by `lookedAt`. Looking at a place and getting to
  it are different questions: `lookedAt` counts *"the next safe step is nowhere"* as arrival,
  which is right for a leg whose whole purpose is the look and catastrophic for this one, where it
  would release the worker in the open the first time a camp stood between it and its base.
- **The creep veto does not apply**, and it must not. Refusing the step only terminates because
  there is a next leg to fall through to; on the way home there is none, so refusing meant
  refusing to move at all — and nothing in the position changes, because the scout is standing
  still and a guard camp is standing still, so the same refusal is re-decided for ever. That was
  *"all the scouts froze in the middle of the map"*, and the stuck watchdog cannot rescue it: it
  writes off a waypoint, and the waypoint was never the problem. Between walking past a camp and
  standing in the open until the match ends, a player walks past the camp — the back-off below is
  what keeps that honest, and if it costs a hit the retreat rule is already pointed at home.
- **A step of nowhere is not an order.** `standOff` clamps a goal that is itself inside a creep's
  berth back to *"do not move"*, which is honest for a leg whose whole purpose was to approach that
  goal — and is the answer for HOME too when a camp is parked near our own base. The walk was then
  ordered to the spot it was already standing on, completed instantly, and re-decided identically
  next pass. Under `SCOUT_STRIDE` (64) the order is aimed straight at the hall instead and the
  pathfinder deals with it.

Both retreat rules and the `SCOUT_TOUR` deadline all route through `headHome` (idempotent — they
re-fire every pass while it walks), and `SCOUT_HOME_BY` (60 s, one map crossing, measured from
when the *walk* started rather than from the tour's) is the backstop that lets the worker go where
it stands if the walk itself fails.

### Who gets sent

`freeWorker`: the **spare** worker first, then a lumberjack, and the **gold crew last** — a
preference rather than a filter, because a player with nothing but miners still sends one.

It used to be "the first worker this player owns that is not off the field", with a comment
claiming a scout comes off the trees. On three races that comment is true by accident: a gold
worker is inside the shaft or inside an Entangled Gold Mine, so `isOffField` had already skipped
it. **The undead breaks it completely.** An Acolyte does not go anywhere — it kneels in a ring in
the *open* around a Haunted Gold Mine (`Abgm`, [undead](undead.md)) — so it is on the field by
every test that rule had, and the first Acolyte in iteration order is Acolyte number one, a
member of the crew of five. The tour took a fifth of the undead's entire income, every game, and
the **sixth** Acolyte — the spare the build ladder trains for exactly this (`SPARE_WORKERS`:
*"the one a player keeps out of the mine to put up buildings with and to send to go and look"*) —
stood in the base for the whole match. `onGoldDuty` is what closes it, and it asks the question
the undead's way (`ringSlot`) as well as everybody else's.

**And the builder does not then take it back.** `AiPlayer.freeWorker` — the *other* one, which
picks who puts a structure up — never honoured `captainHeld`, and `applyHarvest` always had. That
hole has the same shape as the one above and shows up on the same race: the undead's spare Acolyte
is *both* the builder and the scout, so the moment the tour started using the spare rather than a
miner, the build loop pulled the scout off the map and walked it home to put up a Ziggurat —
observed as *"the Acolyte came home before it had finished scouting"*. Held workers are now a third
tier under "on the field" and "down a hole", still a preference rather than a ban: a player whose
every worker is spoken for must still be able to build.

**It walks round the creep camps, not through them** (`safeLeg`). A melee map's camps sit on
exactly the ground between two bases, so the straight line from home to the enemy's front door
usually runs through one — the scout was acquired, killed, `scoutDone` latched, and that walk was
again the whole of what the AI ever learnt. The route is re-asked at every step, so this does not
have to be a path: it has to be a next *step* that is not into a camp, and the pathfinder does the
rest. Only creeps still **alive** count — a cleared camp is ground.

Three things it does, and the first two are what the berth was missing when scouts were still
dying on the way out:

- **A camp is a CLUSTER, so the berth is measured from every creep in it** and never from the
  camp's centre. `CreepCamps` links guard posts up to `CAMP_LINK` (600) apart and hands back their
  *centroid* ([`minimapView.ts`](../src/game/minimapView.ts)), so a six-creep camp is a good 1200
  across: `CREEP_BERTH` (900) around the centre walked the scout **300** from the creep on the near
  edge — inside acquisition range, and one `CreepCallForHelp` shout from the whole camp. Asked of
  each creep in turn, 900 is the berth the constant always claimed to be.
- **The berth is an AMBITION; `CREEP_PASS` (750) is the requirement.** This split is what the two
  numbers are for, and collapsing them into one is what made the tour collapse with it. `safeLeg`
  returns its *best attempt*, not a guarantee, and against 900 "best" comes back under 900
  surprisingly often — a second camp beside the arc, a cliff on the roomy side. Every arc is still
  drawn *for* 900; when that one is not available the route is asked for again at 750, which is a
  far easier arc and is still outside the notice of every creep a melee camp is built from.
  750 is read off the game's own table: `SimWorld.acquireRange` gives a creep the map's placed
  `targetAcquisition` and otherwise its weapon's `acquire`, and that column across all of
  `UnitWeapons.slk` is **500 on 510 rows, 600 on 142, 650 on 24 and 700 on 21** — everything above
  is siege engines and towers, not camp creeps.
- **A goal that is itself inside a camp is stood off**, not walked into (`standOff`). The old
  routine only ever looked at camps the line ran *past* — a camp beyond the goal was "not on the
  way" — and the tour's later legs are **gold mines**, every one of which a melee map guards. It
  aimed the scout at the middle of the camp sitting on the expansion, every game. (Those legs are
  now the other start locations, which nothing guards — but this still earns its place: a base
  whose owner has walled a camp in, and a mine the *army* is sent to, are the same case.)
  `lookedAt` reads "the next safe step is nowhere" as *arrival*, so the leg completes there rather
  than stalling until `SCOUT_STUCK_AFTER` writes it off.
- **A waypoint has to be somewhere the scout could stand** (`standable`, handed in by the caller
  from the sim's own pathing grid — `walkable` for the terrain and everything stamped on it,
  **and** `playable` for the map's boundary, which is a separate bit and set on nothing else; see
  [unplayable area](unplayable-area.md)). Without it the geometry is happy to throw a detour clean
  off the edge of the world: the perpendicular it prefers is chosen by which side the *creep* is
  on, which says nothing about which side is *map*. Aimed at a point it cannot reach, the
  pathfinder walks the unit at the nearest thing to it that it can — and beside a camp pinned
  against a boundary, the nearest thing to "outside the map" is the strip of ground the camp is
  standing on. That is the Wisp that walked **into** a boundary camp on its way home instead of at
  its own Tree of Life. A rejected arc is simply not a candidate; with none left the straight line
  stands, and the pathfinder is a great deal better at going round a cliff than a perpendicular is.
  `backOffSpot` asks the same question and **sweeps** when the answer is no — the same distance,
  turned twenty degrees at a time up to eighty either way, taking the first bearing that is both
  standable and still an improvement, and giving up rather than ordering a walk into a wall.
- **Then it goes round.** The first creep within the berth is stepped around perpendicular to the
  line, preferring the side it is not on; the throw is then **widened a step at a time and the
  resulting leg re-measured against every creep**, both sides at each width, because one fixed
  push only ever cleared the creep it was computed from and the arc that missed the centre walked
  into a flank. A creep behind the scout or beyond its goal is not on the way at all — and one
  already *within* the berth of where the scout stands is excluded from the detour, since no
  waypoint avoids it and leaving it in scored every candidate equally badly and cancelled the
  detour round the camp it could still go round.

**And it backs out of what it is already inside** (`backOffSpot`). This is the hole the berth
never covered and it is worth being precise about: `safeLeg` *deliberately* drops creeps that are
within the berth of where the scout **stands** — no waypoint avoids them, and leaving them in
scores every candidate equally badly and cancels the detour round the camp it could still go
round. So a scout that has blundered inside a camp's notice is handed a step computed as though
that camp were not there, and walks straight on into it. That is the Wisp that *"hugged a creep
camp and died while returning home"*, and it is not a walk-home bug — the same hole is on every
leg. A player turns and walks **out**, and so does this: away from the **pooled** bearing of
everything inside the berth (pooled rather than nearest, or a scout between two of them alternates
between their two answers and goes nowhere), far enough to clear the worst by `CREEP_BACKOFF` — out past
`CREEP_BERTH`, at which point `safeLeg` can see the camp again and arcs round it properly. It
triggers on `CREEP_PASS` and exits past `CREEP_BERTH`, and that gap is the hysteresis: a graze of
the berth is not an emergency, or the scout would step out of routes it had just been given. Surrounded, the pool
cancels and there is no *away* to name, so it takes the bearing of home: not necessarily clear,
but a direction — standing still is the one thing that is certainly wrong.

**And only then does it take no for an answer — by WAITING, not by burning the leg.** A step that
cannot keep even `CREEP_PASS` is a step into a camp's notice, and the scout does not take it.

Giving the **leg** up there, which is what this did at first, made the whole tour evaporate.
Nothing about the position changes when the scout stands still, so the very next pass re-decided
the same refusal for the *next* leg half a second later, and the entire itinerary was spent in
about a second and a half. `SCOUT_STUCK_AFTER` is the right answer to *"this waypoint is not
happening"*: eight seconds of no progress writes off **one** leg, at a rate a tour survives.

Even eight seconds is only tolerable because the two-tier search above makes reaching here rare,
and that is the lesson of the last round of reports. With one bar at 900, refusals were common,
and a refused scout **stands still** — from which the only thing that can happen to it is the
watchdog writing legs off eight seconds apart until the tour is gone. Three legs, twenty-four
seconds, and a computer that turns for home from the middle of the map having seen nothing. That
was *both* remaining reports at once: the Wisp *"standing still in the enemy base"* was doing it
beside the camp guarding their expansion, and the Acolyte *"coming home half-way"* was doing it
beside the camp between the two bases. The Orc's route simply had no camp on it, which is why its
scouting looked fine — none of it was ever a difference between the races.

**One scout, and nobody follows it.** `scoutDone` latches the moment the scout dies. This briefly
allowed a second (*"a worker is 75 gold and the map is worth more than that"*) and the second
walked the same tour into whatever killed the first — so the AI paid twice and learnt once, and
the bill fell on whoever could least afford it: a **Wisp** is a 120-hitpoint lumberjack whose
lumber is credited in the tree it stands at ([night elf](night-elf.md)), so a night elf lost a
third of its forest crew to a walk it had already learnt nothing from, and its lumber stopped.
What the AI gives up by not looking again is countering, expanding and creeping running off an
older read — which is what `EnemyMemory` is for, topped up by a teammate's sightings through
[scouting intelligence](#scouting-intelligence-the-team-scouts-once).

**And the tour has a deadline** (`SCOUT_TOUR`, 150 s). Every other way out of `scoutPass` is an
*event* — it arrived, it got stuck, it died — so a tour whose events simply never came held a
worker out of the economy for the rest of the match with nothing to show for it. The deadline is
written as *"start walking home"* rather than as a special case, so it goes back to work exactly
as a finished tour does — and `SCOUT_HOME_BY` is the backstop under that.

**And a scout that stops is noticed.** The tour only ever advanced on *arrival*, and `scoutPass`
returned early while the order was still "move" — so a worker stopped by a cliff, wedged behind a
building or turned round by a creep it survived stood there holding a stale order for the rest of
the match, and nothing ever looked at it again. `SCOUT_STUCK_AFTER` (8 s with less than
`SCOUT_PROGRESS`, 300 units, of movement) writes the waypoint off and takes the next one, measured
against the last *position* rather than against the order — "has this order gone stale" is a
question no order can answer about itself.

## The difficulties, and what each one gives up

Everything below is in [`profile.ts`](../src/ai/plus/profile.ts). **None of it is Warcraft III's**
— nothing in the install describes an improved AI, so unlike the race scripts (where a number is
Blizzard's unless a comment says otherwise) every value here is ours.

| | Easy | Normal | Insane |
| --- | --- | --- | --- |
| build / army / spell pass | 3 s / 3 s / 2 s | 2 s / 1.5 s / 1 s | 1 s / 0.5 s / 0.35 s |
| notices a base attack after | **15 s** | 6 s | 1 s |
| waits this long into a fight before casting | 2.5 s | 1 s | 0 |
| workers per town | 8 | 11 | 14 |
| expansions | **never** | 1, after 10 min | 3, after 5 min |
| **army food ceiling** | **12** | 30 | 80 (`UPKEEP_TIER2`) |
| towers | **0** | 2 | 4 |
| heroes | 1 | 2 | 3 |
| hall tier | **1** | 3 | 3 |
| upgrade rank | 1 | 2 | 3 |
| first attack | 7 min | 5 min | 2½ min |
| army food that makes a wave | 10 | 14 | 16 |
| **first creep camp** | **never** | 2½ min | 1½ min |
| army food that makes a creeping party | — | 10 | 8 |
| retreats a broken army | **no** | at 35 % | at 40 % |
| **walks a wounded unit out of the fight** | **no** | at 25 % | at 25 % |
| focus-fires / creeps / raids workers | no / no / no | no / yes / no | yes / yes / yes |
| belt slots it shops for | **0** | 3 (6 when rich) | 6 |
| gold it keeps back from the shop | — | 300 | 200 |
| keeps and replaces a Town Portal | no | **yes** | **yes** |
| builds its race's shop | no | **yes** | **yes** |
| accepts a lost game after | 35 s | 20 s | 12 s |
| spell roles it uses | heal, nuke, summon, morph | + panic, disable, buff | all nine |
| **aims at** | the **biggest body** (`naive`) | what a unit **is** (`sound`) | + what the **spell is for** (`expert`) |
| misclicks a cast | 35 % | 15 % | never |
| hero focus | 0.3 | 0.7 | 1 |
| builds it can roll | tier-1 only | all of them | all of them |

**Normal reaches tier 3.** It used to stop at a Keep, which is a bigger handicap than it reads
as: `techTier` is also the filter on which *builds* may be rolled (`rollStrategy`), so a tier-2
ceiling shut a Normal computer out of most of its race's table — no Knights, no Bears, no Frost
Wyrms, no Tauren — and left it playing two or three openings for ever. A Normal player reaches
tier 3; they just take longer over it and stop short of the whole tree, which is what
`upgradeRank`, `expandDelay` and the clocks above already say. The **army food ceiling** is what
carries issue #124's "no unit massing", not the tech ceiling.

Note the creep row, because it is the one line in this table that was a *bug* rather than a
setting. `creeps: true` did not use to produce a computer that creeps: creeping was a rung of
`pickTarget`, and `pickTarget` sits behind the WAVE gates — `firstAttack`, `waveGap` and
`attackFood` — so a Normal computer's first creep camp came at **five minutes**, by which time a
ladder player has three camps and a level-4 hero. Creeping is not an attack: it is the early
game's other economy, it goes out with the hero and a couple of soldiers rather than with a wave,
and it starts about when the hero does. Hence `creepAt` and `creepFood`, which are its own.

The party never goes without the **captain**, either. A creep camp is experience and experience
goes on a hero, so `squadHero` gates the run, and the run ends the moment the hero is gone —
without that the army creeps on alone, trading soldiers for experience nobody is left to collect.
It also refuses to start on a hero below `CREEP_HEALTH`: a camp entered at a third life is a dead
hero, and a dead hero is the most expensive thing on a melee map.

### Which camp: the party is PRICED, not measured in food

The other half, and it is [`plus/power.ts`](../src/ai/plus/power.ts). *Which* camp the party may
walk into used to be four fifths of the army's **food** compared against a camp's combined creep
**level** — two different units of measurement that happen to be numbers. At thirty food that
reads "camps between 14 and 24", i.e. orange and red, and it sent whatever was standing around
into them: a real match ended with a Computer+ player that had fed three separate parties to the
same red camp and never reached the enemy at all.

**The camp colours are the game's and they are the whole scale.** WC3 clusters Neutral Hostile
creeps into camps and marks each with a dot coloured by the camp's combined level — green 1–9,
yellow/orange 10–19, red 20+ (the same table `game/minimapView.ts` paints from). A camp already
says how hard it is, in one number. What had to be invented is only what an army has to look like
for each colour, and that is stated in units because that is how a player thinks about it:

**FOOD IS NOT WHAT AN ARMY IS WORTH**, and that was the second lesson. The first version of the
bars said "ten food of fighters clears an orange camp" — and ten food is four Grunts (16 dps, 700
hp) or five Archers (11 dps, 245 hp), armies that lose to entirely different camps. So a party is
priced by what it can actually *do*, which is the developer's own suggestion:

> POWER = √ Σ (a unit's damage per second × its **current** hit points), × a hero factor of
> `1 + 0.35 × level`

That is the ordinary "effective health × output" figure a player is estimating when they look at
an army and decide. It is quadratic in the right way — twice the army is four times the power —
so the square root puts it back into readable "army size" units. Current hit points rather than
maximum is the developer's "current health must be taken into account". Worked examples, on the
game's own numbers:

| party | power | clears |
| --- | --- | --- |
| 4 Grunts + a level-3 hero | ≈ 434 | orange |
| 6 Footmen + a level-3 hero | ≈ 319 | orange, only just |
| 4 Archers + a level-3 hero | ≈ 217 | green only |
| 8 Grunts + a level-5 hero | ≈ 822 | red |

The bars are **power 120 / hero level 1** (green), **300 / 3** (orange) and **620 / 5** (red),
plus **75 % group health and 80 % hero health** for all three. Orange and red were *raised* off
the report "the AI is attacking orange creep camps with very weak armies".

**Green then came back down, 150 → 120**, off the opposite report: *"it sits too long in its base
while having a decent army instead of creeping."* 150 was not what a green camp costs, it was what
the FIRST camp of the game costs to reach, and nobody's opening party could pay it — a hero and
three Footmen price at ≈ 148, a hero and three Ghouls at ≈ 136, both refused — so every race stood
at home waiting for a fourth soldier and the undead, whose soldier is the weakest body in the
game, longest of all. It also disagreed with the profile asking the question: `creepFood` is 10 on
Normal, which *is* a hero and three small soldiers, so one gate called that a party and the other
did not. A green camp is levels 1–9 combined — two or three level-3 creeps — and a hero with a
couple of soldiers behind it is what clears one in the real game. Orange and red did not move with
it: the ladder out of green is the hero's own levels, and a green camp is most of one.

### Breaking off is a different question from starting

…and a much lower bar. Re-asking the starting bar mid-fight aborts every run on the first
scratch, because a party is always weaker once it has begun. `fightLost` asks the thing a player
asks — *is this going badly enough to leave?* — and there are two ways to answer yes: the
**group** is under 40 % of its hit points, or the **captain** is under 20 % *while what it is
fighting is still more than half up*. That second clause is what stops it running from a fight it
has all but won: a hero at 15 % standing over the last creep on a sliver finishes it, where the
same hero in front of a fresh camp is a dead hero.

"Still more than half up" is measured differently for the two kinds of opposition, because they
report themselves differently: a **creep camp** is a fixed roster, so `AiPlayer.campHealthAt`
measures it directly; a **player's army** is not (their dead units are simply gone), so it is
priced through the same `armyPower` metric — still outgunning us is what "still healthy" means
about an opponent. The same rule serves both, which is why `fightLost` is not `creepLost`.

**And the Scroll of Town Portal is only spent on one of the two.** `ItemCtx.portalWorthIt` is
false when what the army is running from is a creep camp and true when it is a player: creeps do
not chase, do not follow you home, and will still be standing there in two minutes, so a scroll
spent to leave one buys a few seconds of walking and is then not in the belt for the fight that
decides the game.

**The hero's own skin is not an exception to that — it has its own, much lower bar.** Reported:
the AI *"should never use its Scroll of Town Portal while fighting a creep camp"*, and it used
to, because the hero's half of the `escape` rung fired at `ESCAPE_HP` (40 %) whatever it was
fighting. A hero being worn down in a camp has two cheaper answers before the scroll, and both
already existed:

* it is **walked out of the camp** the way any other hurt unit is (`pullPass`) — and in a camp
  the hero gets the bar the scroll used to fire at (`pullBar` → `HERO_KILL_HP`) rather than a
  soldier's quarter, because the withdrawal is what *replaces* the scroll there;
* and if the fight itself has gone, `fightLost` breaks the party off and it **walks home**.

What is left is the case neither reaches: a hero already so low that the walk out is not going to
finish. That is `LAST_RESORT_HP` — **8 %**, a floor rather than a tactic — and it is the only
thing that still spends a scroll on creeps. The flag that says so is `ItemCtx.creeping`, and it
is deliberately *not* `portalWorthIt`: that one is a question about a retreat somebody has already
ordered, and so is false in every fight nobody has given up on yet, while the hero is standing in
the camp from the moment the party sets off at it.

A hero pulled out of a camp also carries its own pair of clocks (`HERO_PULL_HOLD`, 20 s for both
the hold and the see-saw guard). Twice a soldier's ten seconds out, so the walk back is not into
the same blows it left; and the guard is the same number rather than `PULL_BACK_AGAIN`'s
three-quarters of a minute, because a hero that rejoins still under the bar has to be able to step
straight back out — a forty-five-second lockout is the hero dying in the camp holding an unusable
scroll, which is the failure this replaced.

**Nearest camps first.** `creepTarget` steps its search radius out (3000 → 6000 → the whole map)
rather than sweeping once, so a camp beside the party is always taken before one across the map:
a party that is walking is neither creeping nor defending.

`maxCampLevel` turns the party into a ceiling and hands it to `GetCreepCamp` exactly as the old
food number did, so the AI still takes the **nearest** camp it can handle rather than shopping
around. Both places a camp is chosen (`creepNext` starting a run, `pickTarget` aiming a wave that
has no better idea) ask the same function, so they cannot disagree — which they did, and which is
how a party `creepNext` had refused to send was sent anyway a moment later.

None of these numbers are Warcraft III's; the *scale* they are stated against is.

### A run ends when the CAMP is dead — not when a radius is quiet

The report was "**Computer+ stays on empty creep camps for ever, especially orange ones — they
pretty much stay frozen there**", and the whole of it is that a creep run had no end condition of
its own. It ended the way an assault on a spot ends: *somebody is standing within 600 of the goal
(`atGoal`) and nothing hostile is within `CLEARED_RADIUS` (900) of it*. Two perfectly ordinary
situations make that sentence unsatisfiable for the rest of the match:

* **the camps next door.** Camps are clustered by linking creeps whose guard posts are within 600
  of each other (`CAMP_LINK`, `MiscGame` CreepCallForHelp), so two *different* camps need only be
  a little further apart than that — comfortably inside the 900 the wave was asking about. The
  neighbours sit outside their own 500 acquisition range and nobody walks at anybody: the party
  is neither fighting nor finished, for ever. That is why it is worst on **orange** camps — they
  are the big sprawling ones, and the ones a melee map puts beside a shop or an expansion camp.
* **a party that stopped short** of the centroid — a camp in a nook, a blocked captain with the
  cohesion rule holding the leaders behind it — so nothing is ever inside the 600 `atGoal` wants,
  however dead the camp is.

A creep run now ends on the thing it is actually about: `campHealthAt(target) <= 0`, the same
fixed-roster measure `oppositionHealthy` already prices the run by, so the two cannot disagree.

### …and nothing waits for ever

The deeper fault is that the wave had **no deadline of any kind**, which is the mistake
`GATHER_PATIENCE` fixed at the other end of the same walk. Any objective the group cannot reach
— a camp across a cliff, a target the pathfinder will not route to, a spot behind its own
buildings — froze the whole army, hero included, permanently.

`stalled` is that watchdog: the group fails to close `PUSH_PROGRESS` (300) on its objective for
`PUSH_STUCK_AFTER` (20 s), measured against where the group **is** rather than against its orders,
because "has this order gone stale" is a question no order can answer about itself. A group that is
**fighting** is not stuck and resets the clock — asked of the units' own swings (`inCombat` /
`targetId`, since an attack-move engages *without* changing a unit's order) rather than of what
is standing within a radius, because a standoff is precisely the case where something is nearby
and nobody is walking at it.

A group that is fighting resets the clock, and **"fighting" is contact, not proximity**. It used
to answer true for a live `targetId` and, failing that, for anything hostile within
`COHESION_COMBAT` of the anchor — and both of those are true of a *standoff*, which is the exact
thing this watchdog exists to catch. An army stopped at a treeline with the camp it was sent at
eight hundred units away through the trees acquires those creeps (nothing blocks sight), fails to
reach them, drops them, acquires them again half a second later: `fighting` said yes on every
pass, the clock restarted on every pass, and the wave was never written off at all. It now reads
`inCombat` (planted inside weapon range, the only state a WC3 unit swings from) or a swing in
flight, which is what the sim itself records at the blow. Nothing is lost — a group walking *in*
to a fight is closing, so the gap below already covers it.

**Progress is the GAP shrinking, not ground covered**, and that distinction is the whole of the
watchdog. It was ground covered, and there is one case that walks a great deal of ground and
arrives nowhere: a captain shuttling between the objective and the body it is held to (see *The
army moves as one body* below). It moved half a screen every pass, so the clock restarted for
ever, and the army followed it up and down the same stretch of map for the rest of the match —
reported as *"their captain is moving towards a spot and then goes back and keeps being stuck on
that loop while its army is trying to follow the captain"*. The sim's own `attackMoveStalled`
had already learned this lesson in the same words: *"a unit shuffling between two spots it can
reach covers plenty of ground and closes nothing"*.

`abandon` then writes the objective off, **remembers it** — a camp it could not get to is shunned
for `CAMP_SHUN` (120 s), or the watchdog is a loop rather than a decision: the wave gives up,
`massing` asks for the nearest camp it can handle, gets the same one back, and walks at it again
— and **walks the party home**.

Going home is the part that took two attempts. `abandon` used to call `endWave`, which drops the
party into `massing`, and `massing`'s muster point is **the captain's own feet** whenever the
party is out of town (`muster` → `afieldAt`; that is what makes creeping a tour). On a party that
has just been written off for going nowhere, it is a trap that closes on itself: the army gathers
on the very spot it could not leave, `gathered` goes true because everybody is standing on it,
another camp is chosen from there, the same ground is in the way, and the hero stands at the same
treeline for the rest of the match with its army parked around it. Writing the *objective* off
does nothing while the *muster point* is the stuck hero. So a stall retreats — `retreating` hands
every unit a move order to the town hall, which is ground the party demonstrably has a route to
because it walked out of it, and `REGROUP_PATIENCE` bounds even that. Its reason is its own
(`"stuck"`), because `ItemCtx.portalWorthIt` reads that field and a Scroll of Town Portal is for
leaving a fight, not for leaving a walk that did not work out.

### A wave is what SETS OFF, not what exists

The other half of *"the undead leaves its army at home and the hero goes out to creep by
himself"*, and it is not a race's bug at all — the undead simply hits it every game, because its
soldiers are also its lumberjacks and are therefore the one army routinely *not* standing at the
muster point.

`gathered` has a **deadline** (`GATHER_PATIENCE`, 12 s) and it has to: without one, a single
soldier that cannot reach the rally holds the whole army at home for ever, hero included. But the
size gates behind it — `creepFood` in `creepNext`, `attackFood` in `waveReady`, and the party
`creepTarget` prices a camp against — were still counting **everything in the squad, wherever it
happened to be standing**. So when the deadline fired, a hero whose ghouls were in the forest read
as *a hero and four ghouls*, cleared a `creepFood` of eight or ten on its own, and set off alone.

`mustered` is the fix and it is one line: the captain's own feet once the party is out on the map,
the home rally while it is at home — the same point `muster` sends everybody to. `squadFood` and
`creepForce` both take it and count only what is within `GATHER_RADIUS` of it.

This is **not** a second gate stacked on `gathered`. "Is enough of it here" and "is what is here
big enough" are one decision, and the bug was that the two could disagree. Nothing deadlocks on
it either, because `massing` re-orders everybody to that same point on every pass: the party
arrives, the food is met, and the run starts a pass later with an army behind it.

`creepForce` takes the muster point only where the question is *may this party set off*. `fightLost`
asks it without one — a party already in a camp is all present by definition, and pricing that by a
radius would write the stragglers off twice.

### The first ten minutes belong to the CAMPS

Reported: *"Computer+ seems to like to hit the enemy base very early with a really weak hero
(especially Orc and Human like to do that with a level 1 blademaster or level 1 archmage)"*.

The mechanism is not a preference for the base — `massing` asks `creepNext` **first**, and
`pickTarget`'s rung 1 is a camp. It is that both of those answer `null` the moment `maxCampLevel`
prices the party under even a green camp, and the rung underneath them is the enemy's base. So the
one state in which an AI has no business attacking anybody — a level-1 hero with two soldiers —
was precisely the state in which nothing was left *but* the attack.

`waveReady` says so directly: for `EARLY_GAME` (600 s) a party whose captain has not reached
`EARLY_HERO_LEVEL` (3) does not leave for a player's base at all. What it does instead is what a
ladder player does, and it falls out for free — `waveReady` is also the clock `creepNext` asks
before it lets the hero's level cap refuse a camp, so **a closed wave window is an open creep
window at any hero level**.

Level 3 is [`power.ts`](../src/ai/plus/power.ts)'s own ORANGE bar, and deliberately the same
number: a hero that has cleared its green camps is a hero at 3, so *"has it been creeping"* and
*"may it go and fight a player"* are one question asked once. After ten minutes the ordinary clocks
decide alone, because a hero still at level 1 then is not going to get there by waiting. Easy is
exempt through its own profile rather than through a test — it does not creep at all, so there is
nothing to prefer over the attack.

### An UNDEAD base needs a real army

The one race-specific bar in the file, and the developer's own ask: *"Computer+ AI should always
require a very strong army to attack an UNDEAD opponent's base"*. What is behind it is that an
undead base defends itself better than any other for the same gold — a Ziggurat is supply that
upgrades into a **tower** on the spot, the whole base stands on blight that heals what is on it,
and the Acolytes that would be a raid's easy kills are out in a ring rather than down a shaft
(docs/undead.md). The food that walks in has to beat the food already there *plus* what the ground
gives it.

`mayAssault` is asked once, in `massing`, after the target is chosen and before the wave commits:
`UNDEAD_ARMY` (1.75) × `attackFood`, ceilinged at `UNDEAD_CEILING` (0.8) × the difficulty's own
`armyFood`. The ceiling is not decoration — every difficulty caps its production, and 1.75 ×
`attackFood` is above what an Easy computer may ever own, so without it the rule would read *never
attack the undead at all*.

Two things it deliberately is not. It is a **food** bar rather than a power comparison, because
what the wave is short of is bodies and because the AI must not be asked to price a base it has
only half seen — Computer+ never bypasses the fog. And the race is read off the **building the
wave is aimed at** (`UnitDef.race`) rather than off the lobby, so what is being answered is *the
thing I am about to attack is an undead structure*, which is a fact about something it has seen. A
creep camp has no race and is never gated, and neither is a fight in the field — that is
`contactPass`'s, and it is symmetric, because both armies are in the open.

### …and it asks whether it can get there BEFORE it sets off

The watchdog is the backstop, not the plan. `creepCamp` answers off the map's fixed camp table
and a **straight-line** distance, and a straight line knows nothing about the river or the
forest between here and there — so the nearest camp on the list is quite often one no route
reaches, and twenty seconds of an army standing in a line facing a treeline is not something a
person does. `creepTarget` now asks `SimWorld.canWalkTo` of the party (the captain, and one
ordinary soldier behind it, since a flying hero would otherwise pass a camp the army has no road
to) and shuns anything it cannot reach — which both ends the search loop and stops the next
massing pass paying for the same A* again. Asked of the **terrain alone**, so a camp merely
screened by bodies right now is not condemned.

Two more things were walking at treelines, and both are ours rather than the pathfinder's. Every
destination the army manager *computes* rather than reads off the map is arithmetic — the centre
of mass a lost unit closes on, the spot `PULL_BACK_DIST` behind the line, the rally point
projected `RALLY_OUT` in front of the hall — and arithmetic lands wherever it lands: inside a
forest, on a cliff, in the water. A move order at such a point is not refused, it is answered
best-effort, and best-effort against a forest is *the forest*. `standSpot` snaps each of them
onto ground the unit could actually stand on first, in the unit's own domain and for its own
footprint.

The third was in the pathfinder itself and is the reason the symptom was so common: `findPath`'s
expansion cap was flat at 8192, which on a 384-cell melee map is a blob about 1600 world units
across — so an order given *around* anything bigger than that ran out of budget and came back
best-effort. The cap is now a floor, with the budget growing in proportion to the distance
actually asked for (`EXPANSIONS_PER_CELL`, ceilinged at `MAX_EXPANSIONS_FAR`): a search across
the street is unchanged, one across the map gets what going round something map-sized costs, and
a goal on an island is still bounded — merely bounded further out.

`retreating` got the same treatment (`REGROUP_PATIENCE`, 45 s). It ends when everybody is home
**and** the group has healed to `REGROUP_HP_FRACTION`, and there are two ways that never happens:
one unit that cannot path home holds `allHome` false for ever, and — the one that actually bites
— most of the game's units do not regenerate at all (heroes do, the undead do on blight, the
night elf does at night, a Footman does not), so a human or orc group that came home at half
health can sit in its own base until fresh production alone lifts the average.

### …and an ASSAULT it could not reach is written off too

The same rule, at the other end of the target list, and for most of this file's life the second
half of it was missing. `abandon` shunned a **camp** and nothing else, on the grounds that the
enemy's base is not somewhere an AI may decide to stop going — which is true of the *decision* and
says nothing about the *walk*. What happened instead was the loop the shun list exists to prevent,
one rung further down: the wave was written off for going nowhere, `massing` re-aimed at the same
base on the next pass because nothing had changed, and the party spent the match walking at the
same cliff. Reported as *"give up on trying to reach unreachable areas via pathfinding if not
possible and move to another task (e.g. pick another creep camp)"*.

So `writeOff` remembers **whichever kind** of objective it was: a camp on `Brain.shunned`
(`CAMP_SHUN`, 120 s, matched at `SHUN_MATCH` 200), an assault on `Brain.avoid` (`GOAL_SHUN`, 90 s,
matched at `GOAL_MATCH` 1200). The two numbers differ because the two objectives are different
shapes:

* an assault is aimed at whatever structure happened to be **nearest us** (`AiPlayer.enemyBase`),
  and that building can die or be overtaken by another — so a camp-sized match would hand the
  party the same unreachable base back under a different name on the very next pass. The match is
  a base's own width;
* and it is offered again **sooner**, because "I cannot reach that" is nearly always a statement
  about right now — a building in the way, a fight in the corridor — and an enemy main is not
  somewhere the AI may write off for good.

`pickTarget` reads the list at every rung, which is where *"move to another task"* actually
happens, and it grew a fifth rung underneath the enemy's base for it: **a creep camp at any hero
level**. The level cap (`CREEP_UNTIL_LEVEL`) is a *preference* between a camp and an attack, and
down here there is no attack to prefer — an island opponent, a base the march cannot reach, a base
already razed but for one building the pathfinder will not route to. The old answer was `null`,
which is an army standing at the rally point for the rest of the game. `creepTarget` still prices
the party against the camp and still refuses one it cannot walk to, so the new rung cannot send
anybody anywhere the rest of the file would not.

The rung at the **top** of the list got the reachability test it never had, too: `expansionFoe`
— what is sitting on the mine the build order wants, which on a melee map is a creep camp — is now
asked of `canWalkTo` like every other camp. `AiPlayer.takeExp` is deliberately left standing when
it refuses, since the expansion is still wanted and the question costs a region lookup; what the
refusal buys is the wave going and doing something it *can* do meanwhile.

### The last resort: a captain that has stopped moving takes the party home

Four watchdogs sit above this one — `stalled` asks whether the wave is closing on what it was
sent at, `gathered` whether the muster is filling, `REGROUP_PATIENCE` whether the retreat is
ending, `SCOUT_STUCK_AFTER` whether the tour is progressing. Each is the right question for its
own state, and each is blind outside it. So the freezes that actually reach a match are the ones
that happen **in the gaps between them, on an errand rather than on a wave**:

- a hero walking to a **drop** carries the order `getitem`, which `commit` and `massing` both
  skip *by name* so that the errand is not fought over;
- a hero walking to a **shop** is skipped the same way (`PlusItems.errand`).

Neither is a wave, so neither was watched. And because the army musters on its captain, one hero
that could not finish its errand parked the entire party around it for the rest of the match.
That is the freeze that was reported twice — *"the hero freezing in front of the treeline"* — and
its immediate cause was in the sim rather than here: `tickGetItem` was the one walk in the game
with **no give-up in it**, a bare `pathTo` whose failure it ignored, so a drop lying where no body
can reach it (a treeline, which is exactly where creeps die) held the walker on the spot re-running
A* every tick. It now follows issue #108's rule like every other walk — bodies move, so wait them
out; terrain does not, so the order ends — and `loot` asks `SimWorld.canWalkTo` before it sends a
hero at all, since being re-sent every `LOOT_PERIOD` is the same freeze at a slower rate.

`freezePass` is the watchdog that **does not care why**. It reads the one thing every freeze has
in common — the captain's feet have not moved `FREEZE_PROGRESS` (300) in `FREEZE_AFTER` (35 s)
and nothing is being swung at — and answers with the one destination the AI can always be sure of
a route to, which is the town hall it walked out of. The clock is reset by three different kinds
of legitimate stillness: it moved; it is *fighting* (the same contact-not-proximity reading
`stalled` uses); or it is **meant** to be still — healing (`recovering`, the whole point of a Moon
Well trip), walked out of the line on its own clock (`pullPass`), holding for the body to catch up
(`b.waiting`), mid-cast, or simply **at home**, where standing about is what an army between waves
does. The threshold sits comfortably above `GATHER_PATIENCE` (12) and `PUSH_STUCK_AFTER` (20) so
the specific answer always gets its turn first.

What it does is deliberately blunt. It cannot diagnose the order — the whole point is that the
cause is something nobody thought of — so it **stops** the hero (which ends whatever errand it was
on, `PlusItems.forget` releasing the shopping claim so the belt does not hand it straight back),
shuns the objective if there was one, and retreats.

### Creeping is a TOUR, not a series of round trips

The other half of "the army is constantly in the base": the muster point was always home. A party
that had just cleared a camp was walked all the way back to the rally point, re-gathered there,
and sent out again — so a Computer+ army spent most of its match commuting past its own front
door, and `creepTarget`'s "nearest camp" was measured from a base it had left five minutes ago.

Two changes, and they are the same idea:

* **`muster` follows the captain.** While the party is out of town (`afieldAt`) and `creepNext`
  has another camp for it, the army musters *where the captain is standing* and sets off from
  there. The gathering rule is unchanged — it just gathers around the captain instead of around
  the rally point, which is also how a straggler gets picked up on the way.
* **`creepCamp` takes a `from`.** Distance is measured from the party rather than from town 0
  (the classic scripts still pass nothing and still measure from home, because they only ever
  creep out of a base and back).

**The muster pass has to be able to REACH a straggler, and for a long time it could not.** Its
skip list read *"leave anything already carrying a move or an attack order alone"*, flat,
wherever that unit happened to be standing — and that is a stranded soldier by definition: the
muster is the one pass that gathers the army back up, and it was the one pass blind to exactly
the units that had come apart from it. A Grunt that picked something up on the walk home, a
straggler that walked into the camp beside the road, anything left standing in a base the wave
has finished with: each fights on alone and is never asked to come back, because a fight in the
sim *ends with the unit still carrying its attack order*. Two lines instead:

* an **attack** is left alone only within `GATHER_RADIUS` of the muster point — fighting where
  the army is, is fighting *with* it; fighting anywhere else is a body to be recalled;
* a **move** is left alone only when it is aimed at about the muster point (`moveGoal`). That
  point *moves* whenever the party musters on its own captain, so a unit still walking to where
  the captain stood a minute ago is walking at nothing.

`moveGoal` is worth its own line: it reads `chaseX`/`chaseY` — the goal the sim re-paths towards
— and **not** the end of the current `path`, which is only as far as the search got. They differ
exactly where it matters, because a route round a crowd stops short and the unit *parks* on the
order it is still carrying. Read off the path end, every such guard in the file decides the order
is stale and re-issues it every pass, which is a straggler re-pathing instead of walking.

Home is the **fall-back**, which is what the developer asked for: the party goes back when the
captain is hurt (`CREEP_HEALTH`), when it is not strong enough for anything left on the map
(plus/power.ts), or when there is nothing left to take.

**And the level cap is a preference, not an ability.** `CREEP_UNTIL_LEVEL` used to end creeping
outright, so a level-6 hero stood at the rally point behind `waveGap` with three camps still on
the map and nothing at all to do for two minutes. It now only applies when there is actually an
attack to prefer over the camp — `waveReady`, the wave's own three clocks, asked in one place so
that `creepNext` and `massing` cannot drift apart.

One bug fell out of writing that down: `massing` cleared `Brain.creeping` on the line *after*
`pickTarget`, and `pickTarget`'s rung 1 sets it — so a wave aimed at a camp was priced, ended and
retreated from as though it were an assault on a player, Scroll of Town Portal included. The
reset goes before the ask.

### The army moves as one body

Cohesion, and without it a wave is only a list of units that were all given the same destination.
A Grunt walks at 270 and a Meat Wagon at 190 (`UnitBalance.slk` `spd`), a hero that stopped to
kill something falls a screen behind, and what arrives at the camp — or at the enemy's base — is a
file of ones and twos being killed in the order they turn up. It is the same mistake as chasing a
hero, made by nobody in particular.

Two rules, one at each end of the walk:

- **Nothing leaves until the army is together.** `gathered` measures the wave at the muster point
  in *food* (`GATHER_SHARE`, four fifths) rather than demanding everybody, so one straggler cannot
  hold the army at home for ever. It gates the creep run as well as the wave, and the creep run is
  where its absence actually hurt: `creepFood` is eight food on Insane, which is reached the moment
  the fourth soldier is *trained* — so the party set off from the production line rather than from
  the muster point, with the hero somewhere behind it.
- **On the road, the army follows its CAPTAIN.** The anchor is the hero rather than a centre of
  mass, because the centroid of a hero at a creep camp and six soldiers at home is a point in the
  middle of the map that nobody is standing on. Two radii off it: past `COHESION_RADIUS` (600) a
  unit *nearer the objective than the captain is* waits — only the leaders, since a straggler is
  already being carried the right way by the same order — and past `FOLLOW_RADIUS` (1400) it
  closes on the captain outright, whichever side of the objective it is on. That second one is
  the answer to "army units stuck at base while the hero is out creeping alone": a Grunt trained
  after the party set off is a straggler by every measure, and the objective's own attack-move
  walks it into the camp the party is already fighting in, one at a time. Never a unit with an
  enemy within `COHESION_COMBAT` — pulling one out of a fight is not cohesion — and defence is
  exempt in full: something is in the base, and a soldier that got there first should be swinging.
- **LOST is asked BEFORE fighting, and that ORDER is the rule.** The two tests above are stated
  as one function (`cohesionCall`, pinned in `tools/ai-plus-army-test.cjs`) precisely because
  which of them runs first is the whole answer: a unit past `FOLLOW_RADIUS` is **not in a fight**
  — there is no fight where it is standing, only itself and whatever found it — so the rule that
  leaves a soldier in a battle must not be allowed to reach it. Asked the other way round, which
  is how it was asked, one Grunt that aggroed a creep on the walk was pinned out there for as
  long as anything hostile stayed within 500 of it, which on a melee map is *until it dies*.
  Reported as *"there are a lot of stranded units during the mid to late game which are not
  sticking to their captain"*, and it is most of that report.
- **A unit out in FRONT stands still; it is never walked BACK.** The two strays want opposite
  orders, and folding them into one was what made the army shuttle. The anchor is itself walking
  forward under the same commit, so a leader ordered *onto* it turns round, meets it, is
  re-pointed at the objective, out-walks the group again and turns round again — a loop that
  covers ground in both directions and arrives nowhere. Standing still costs the group nothing,
  because the body is closing anyway. Only the genuinely lost (past `FOLLOW_RADIUS`) has
  somewhere to walk to.
- **…with hysteresis, or the halt is a stutter.** `COHESION_RESUME` (350) is how close the body
  has to get before a waiting unit walks on — not the same 600 that stopped it. Released on the
  same radius, the hero (the fastest thing in the group) is outside it again before the next
  pass, so it jogs forward and stops, forward and stops, and the army starts and stops with it.
  It is the see-saw guard `PULL_BACK_AGAIN` is, stated in distance rather than in time.
- **…and the CAPTAIN is not exempt from its own rule.** The anchor *is* the captain, so
  "how far is this unit from the anchor" is zero for the captain and cohesion held back every
  unit in the army except the one whose death loses the game. It is also the unit most likely to
  be out in front, because it is usually the fastest thing in the group — and a Blademaster under
  **Wind Walk** is 10-70 % faster again (`[AOwk]` DataB). Reported exactly that way: *"the
  Blademaster seems to be using Windwalk to leave its army and go and fight another creep camp
  while its army is currently fighting another one."* The captain is measured against the
  **body** — the rest of the squad, with itself left out — so the same two radii can be asked of
  it. With no body left to hold it to (a hero alone) it is held to nothing.
- **…and the BODY is what is WITH it, not the mean of the squad.** `bodyCentre`, and the
  difference is a deadlock. The hold ends when the body is inside `COHESION_RESUME` of the
  captain; measured over the whole squad, a single soldier left across the map — one trained
  after the party set off, one that stopped to fight, one behind a treeline — drags the
  arithmetic mean hundreds of units from where every other soldier is actually standing, so the
  mean never arrives, so the captain never walks again. The army then parks around a frozen hero
  while its stragglers are walked in one at a time. So the body is the squad members inside
  `FOLLOW_RADIUS` — the same line that separates *trailing* from *lost* — and the lost are not
  ignored by it, they are the ones already being ordered onto the captain, and they join the
  body by arriving. Only when nothing at all is with it does the captain fall back to the whole
  squad's centre, which holds it for an army that is coming rather than marching it further away.
- **…and a HOLD HAS A DEADLINE** (`HOLD_PATIENCE`, fifteen seconds), for the reason `gathered`
  and `REGROUP_PATIENCE` do: every state in this file without one eventually deadlocks. Standing
  still regroups an army only while the body is actually closing, and when it is not the unit
  stood in a field for the rest of the match — invisible to every watchdog, because `freezePass`
  deliberately does not count a waiting unit as *still* (standing about is what it was told to
  do). When it expires the answer is **follow**, never *carry on*: ending up beside the army is
  the whole point, and walking on is what put the unit out here.
- **…and the gate GIVES UP WAITING.** A gate with no deadline is a deadlock, and this one
  deadlocked in the way that costs most: a single soldier that cannot reach the muster point held
  the whole army at home, hero included ("the AI is moving the hero to its base and locking it
  there instead of going out to creep"). `GATHER_PATIENCE` is twelve seconds, after which it
  leaves with what came.
- **A MARCH IS WALKED, NOT FOUGHT.** Reported: *"some army units are distracted by creep camps
  and they stop following their captain."* Cohesion cannot answer that one, and deliberately
  refuses to: a unit with an enemy inside `COHESION_COMBAT` is *in a fight*, and every rule above
  leaves it there. The lure is the ORDER rather than the cohesion — a column under an attack-move
  fights whatever its outside rank can reach, which on a melee map is every camp the road runs
  past, and `marchAim` walking the party *around* a camp then asks the army to attack-move along
  a detour drawn to avoid that very camp.

  So while the party is **travelling** (`marching`) every member gets a plain `move`, and that
  single word is the whole of it: a move order does not auto-acquire — the sim runs
  `tickAttackMove` for an attack-move and nothing of the sort for a move — so a camp cannot reach
  into the column, and a soldier one has already taken is put back on the march by the same
  order. It is what a player does: you A-move when you arrive, not while you walk.

  Three clauses say when a walk is a walk, and the third is the one that keeps this from being an
  army that strolls through its own battles: not while **defending or retreating** (a defence is
  a fight by definition, and a retreat already walks under its own orders); not once the
  objective is inside **`MARCH_DIRECT`** (900 — the same "practically there" bound `marchAim`
  stops detouring at, so the two rules change over on the same line); and not while a **player's
  army** is within `CONTACT_LOOK` of the anchor, measured with `contactPass`'s own filter. Creeps
  are pointedly not in that last one — they stand where they stand and they leash home — and that
  is the entire point. What the AI gives up is the free hits on whatever it walks past, which is
  exactly what it should be trading for arriving as one body. Both directions are pinned in
  `tools/ai-plus-army-test.cjs`.

### Engage, or go home — but never walk past an army

Reported: *"when the AI sees their enemies' army they must either engage or fall back to their
base instead of ignoring them and letting them pass"*. Ignoring is exactly what it did, and the
reason is that **every rule the manager had about an enemy army was about a PLACE.** `defendPass`
only ever looks inside our own towns (`isInvader`, `TOWN_RADIUS`); `fightLost` only ever asks
whether a fight *already joined* is going badly. An army met in the middle of the map on the way
to a creep camp was in neither, so the wave walked past it under its attack-move and the two
groups slid by each other.

`contactPass` ([`plus/index.ts`](../src/ai/plus/index.ts)) is the missing question, asked in four
states:

* **At home** — nothing. `defendPass` owns the base and has already run above it. That order
  matters: a party that turns to fight in the field while its own hall is being killed has made
  the wrong call.
* **Nothing in front of us** — the clock is cleared, which is what makes the dwell below a
  *reaction* rather than a cooldown.
* **Already going for them** — the aim is kept fresh on their centre and `attacking` is left to
  run. This branch is what stops the rule fighting itself: a decision re-taken every pass would
  call `setMode` every pass, which zeroes the re-issue clock, which re-paths the whole army twice
  a second (see `recommit`).
* **A decision.** Both sides are priced by `armyPower` ([`power.ts`](../src/ai/plus/power.ts))
  over the bodies each actually has in the field, and the party commits at `CONTACT_ENGAGE` (0.9)
  — deliberately **below even**, because an even fight taken is a fight and a party that runs from
  every even fight never has one. Outgunned, it retreats as `"player"`, which is the one retreat
  the hero's Scroll of Town Portal is on the table for (`ItemCtx.portalWorthIt`).

Two things it is careful about. The pricing is `powerOf`, not `creepForce`: that one holds the
hero out of the fighters and multiplies the rest by its level, which is the right shape for *can
this party clear a camp* and the wrong one for comparing two armies — the enemy's hero is a body
on the field like ours, and `heroFactor(0)` would price an army with no hero at nothing at all.
And the decision waits `PlusProfile.defendDelay`, so **a difficulty is exactly as slow to notice
an army in front of it as it is to notice one in its base** — fifteen seconds on Easy, one on
Insane.

Creeps are deliberately not in it, and neither are illusions. A camp on the way is what the march
walks round (below) and what `creepTarget` prices; this is about the other *player*, whose army
chases, reinforces, and is the reason a wave is out at all.

**Contact is measured against the whole COLUMN, not against the captain.** The rule above was
right and still let an army walk through one, because *near* was a distance from the anchor — and
the anchor is the captain, one point at the head of a column that on a long march is strung out
`FOLLOW_RADIUS` and more behind it. An enemy standing beside the road met the **tail** of the wave
while the hero was already `CONTACT_LOOK` past it: nothing registered as contact, `marching` stayed
true, and a march is walked under plain `move` orders, which do not auto-acquire (see below) — so
the rear of the column walked through them under orders not to fight back. Reported as *"they must
change their mind and commit to fighting the opponent that they just met instead of trying to pass
through the opponent's army"*.

`armyFrame` is the answer and it is deliberately shared: `contactPass` (which turns the march into
a fight) and `armyInReach` (which turns the march off) read the same frame, because a body one of
them can see and the other cannot is a column that stops walking without ever deciding anything.
The frame is every body in the wave plus the anchor, with a bounding box round the lot — the box
is what keeps it cheap, since contact is asked of every unit in the world on every army pass and
almost everything fails it in O(1). `inContact` is pure and exported, and pinned by
[`tools/ai-plus-army-test.cjs`](../tools/ai-plus-army-test.cjs) for the same reason `marching` is.

### A march goes ROUND the camps on the way

The army's half of the arc the scout has always walked (`safeLeg`, and see [the scouting
section](#the-tour-is-the-enemy-start-locations) for the geometry). A wave sent at a camp on the
far side of the map takes the straight line, and on a melee map the straight line runs through two
other camps — so the party arrives at the objective it was *priced* for having already fought the
ones it was not.

`marchAim` routes every attack-move destination in `commit`, and the walk home in `retreating`,
through the same `safeLeg` the scout uses: a next **step** that clears every live creep's berth
rather than a route, re-asked on each re-issue. The objective itself is untouched — `attacking`,
`atGoal` and `stalled` all still read the real target — so a detour can delay an objective and can
never lose one.

**The developer's own condition was that it must never freeze**, and three things carry that:

* **The creeps AT the destination are not obstacles.** `liveCreeps` takes an `except` point and
  drops everything within `MARCH_GOAL_CAMP` of the goal — a berth plus a camp's own spread, since
  `creepCamps` links guard posts up to 600 apart and hands back their *centroid*. Without it
  `standOff` pulls the destination
  back out of the very camp the wave was sent to clear — every pass, for ever — and an assault on
  a base guarded by a camp never reaches it. (The scout passes nothing and is unaffected: nothing
  sends a scout *at* a camp.)
* **A detour that does not move the army is discarded.** `safeLeg` can hand back a point on top of
  us — `standOff` clamps to zero when the party is already inside a berth — and an army ordered
  onto its own feet is precisely the freeze this rule may not cause. Under `MARCH_STEP` (200) the
  straight line stands.
* **And there is a watchdog.** If the anchor fails to cover `MARCH_PROGRESS` for `MARCH_STUCK`
  seconds while a detour is in force, detours are switched off for `MARCH_IGNORE` (30 s) and the
  original logic runs — creep camps and all. `MARCH_STUCK` is **ten** seconds and has to be well
  under the two watchdogs that would otherwise fire first (`PUSH_STUCK_AFTER` 20, `FREEZE_AFTER`
  35), or lifting the net is a thing that only ever happens after the wave has already been
  written off.

Cohesion is measured against the **waypoint** rather than the objective, because "who is out in
front" is a question about the direction the army is actually walking. Judged against the
objective on a detour, the whole army reads as trailing and the leaders are never held at all.

### The captain is the FIRST hero, then the second, then the third

`squadHero` used to return the highest-level hero, and that is wrong twice over. The AI's own
hero order (`heroId`/`heroId2`/`heroId3`, rolled at seat time) is the order they were *trained*
in and therefore the order they are levelled and equipped in, so the first one is the one that is
ahead — and picking by level lets the captaincy **change hands mid-run** every time a second hero
dings, which makes nonsense of `creepNext` (which gates on the captain's health) and of
`attacking` (which ends the run when the captain is gone). When the first dies the second takes
over, and when that dies the third.

**A dead captain is a fall-back, not a shrug.** `attacking` now puts the party into `retreating`
rather than merely ending the wave: `endWave` drops it into `massing`, whose rally order is
skipped for anything already fighting (`u.order === "attack"`), so the soldiers stayed in the
camp and died in it one by one.

Read the Easy column as a description of a player: it makes eight workers and six food of
tier-1 soldiers, never expands, never towers, never leaves its Town Hall, comes to find you
after seven minutes, feeds its army in one piece, and takes fifteen seconds to notice you are in
its base. That is issue #124's brief — "must essentially be able to be beaten by players who have
played MOBAs" — written as numbers.

### …and the SECOND one comes with the Keep

`extraHeroes` sits **below the expansion** on purpose: a hero row halts the build loop while the
AI saves four hundred gold for it, and above the expansion that halt is what stopped an insane orc
ever founding a second town. That reasoning is about the first five minutes, when a second hero is
a luxury and a second mine is the game. At **tier 2** it is the other way round — the army is out,
the income is running, and the second hero is the next thing a ladder player buys. Reported as
*"make the Computer+ AI (Normal and Insane only) be more keen towards training a second hero when
it reaches tier 2"*; Easy is excluded by its own `heroes: 1` rather than by a difficulty test.

So the row is asked **twice, at two different heights**, and the tier decides which of the two ever
fires (`tierTwoHero`). Where the tier-2 copy sits is the whole of whether it happens: the first
attempt put it just above the expansion, and that measured as no change at all —
[`tools/ai-plus-ladder-test.cjs`](../tools/ai-plus-ladder-test.cjs) had ten of the twenty builds
reaching ten minutes at tier 2 with **one** hero, halted on the second hero's own row for a third
of their passes. **A row does not have to be unreached to be unaffordable**: `OneBuildLoop` spends
a running budget, so the tech buildings, the upgrades and the Castle above it took the gold before
the hero row was read, every pass, for ever. It goes above all three, and below `army(coreArmy)` —
the one thing that must never be saved through, because a base with no army does not need a second
hero, it needs an army. With it there, all twenty builds field both heroes inside ten minutes and
every other ladder check is unchanged.

The halt is bounded in both directions besides: it is **one** purchase (nothing re-asks once the
hero is queued — `ai.count` counts a job in a queue), and `releaseStall` lets the ladder past a row
that has stopped getting nearer its price. Only the second hero moves; the third is a luxury at any
tier and stays where it was.

### The army ceiling is enforced at PRODUCTION

`armyFood` is the single most load-bearing number, and *where* it is applied is the whole point.
It is a budget spent down the race's unit mix inside `buildPlan`, so an easy computer **asks for
twelve food of soldiers and then stops asking**. Capping the size of the *wave* instead would
have produced an AI that builds twenty Grunts, attacks with six, and still has twenty Grunts
standing when you walk into its base — which is exactly what "must NOT mass armies at all" rules
out.

## Strategies: a race is a table of builds, not one build

Each race owns several named builds ([`races.ts`](../src/ai/plus/races.ts)) — Human plays
Riflemen-Priests-and-Mortars, the double Arcane Sanctum, Riflemen-and-Priests, the tier-3
Knight build or Gryphons; Night Elf plays Archers-and-Huntresses, Dryads-and-Druids-of-the-Claw
out of two Ancient of Lores, mass Dryads, Archers-and-Talons or Chimaeras — and one is **rolled
at seat time**, weighted, off the AI's own RNG stream. Two Computer+ players on one map open
differently; the same seat on the same seed opens the same way twice.

The builds are the ones a person would name, which is the point of them: an orc that reaches
tier 2 is not "going Shamans", it is Head Hunters with Shamans and a Kodo behind them, or Grunts
and Head Hunters enriched with Raiders and Wind Riders. A build that is worth rolling names an
ARMY and the support that goes with it.

A strategy is a **weighted unit mix** and two clocks, and nothing else is written down:

* the **buildings** it needs are derived from the units it names (`UnitRow.from` / `needs`);
* the **upgrades** it takes are whichever its buildings can research — so a Gryphon build takes
  the Aviary's upgrades and a Footman build does not, with no list to keep in step;
* the **hero** it opens with is the build's own where it states one (a Tauren build opens Tauren
  Chieftain, a Bear build opens Keeper of the Grove), the race's otherwise.

Two optional clauses go beyond a unit list, because a real build order says things a list of
units cannot:

* **`factories`** — the copies of a producer the build is *named after*: two Arcane Sanctums, two
  Ancient of Lores, two Crypts. It is the only place a strategy names a building, and it may only
  say *how many* of something the mix already implies (rule 2 survives). One Sanctum makes one
  caster at a time, so a build whose army IS casters arrives at half speed with one of them.
  `plan.ts` buys the second once the first is STANDING.
* **`thenAt3`** — the build this one GROWS INTO when a tier-3 hall lands. A rifle opening that
  reaches a Castle is the classic Knights-Priests-Mortars-Flying-Machines army; a mass-Grunt
  build that reaches a Fortress is the Tauren one. It is not the mid-game strategy switch below:
  nothing reacts to anything, the clause is part of the build the seat rolled at the start, and a
  build with no `thenAt3` never moves. What the earlier build already put on the field goes on
  standing in the army — the successor only decides what is TRAINED from now on.

**Spellcasters are a share of the army, never the army** (`UnitRow.caster`, `plan.ts`'s
`CASTER_SHARE`). No build asks for an army of nothing but Shamans and it was still reachable,
because the counter re-weighting can only push one way: `counterScore` leaves a weaponless caster
at a flat 1.0 — the damage table says nothing about a spell — while it moves everything with a
weapon around it, so a bad matchup quietly promotes the casters it could not judge. Half the army
is the cap, set where it does not argue with a build that MEANS to be caster-heavy: the double
Sanctum keeps its Priests and Sorceresses exactly where its own weights put them.

**The tavern is not a hero shop yet.** Several of these builds are played in real games with a
Naga Sea Witch or a Dark Ranger as the second or third hero; `AiPlayer` only ever produces heroes
at an ALTAR, so the tables name altar heroes throughout and a tavern hero is a thing no Computer+
player can buy. Worth knowing before reading a build's `heroes` list as the whole of the build.

**Difficulty picks which builds are on the menu.** A strategy declares the hall tier it aims at,
and one above the difficulty's `techTier` is never offered — so an easy computer only ever rolls
its race's simplest openings, and where a race's builds ALL aim higher than its ceiling it rolls
among the lowest-tier ones rather than being handed a single build for every match it plays (its
`techTier` caps the mix at tier 1 either way, so what it fields is that build's tier-1 half). Normal and Insane can both roll anything, which is what raising
Normal to tier 3 was mostly *for*: at tier 2 it was shut out of most of every race's table.

We roll ONCE and hold it. AMAI switches strategy mid-game once its `strat_minimum_time` has
passed; we do not, because a switch abandons half-built production and nothing here yet measures
whether it was worth it. Countering (below) and the build's own `thenAt3` are the two things that
move, and neither is a change of plan: one re-weights the mix the build already named, the other
is a clause the build wrote down before the match started.

### Losing the buildings a build is made of

A build order is only a plan while its producers are standing. When they are not — a raid, a
razed expansion — `buildableMix` falls back on **everything the race's opening building can still
make**: Footmen *and* Riflemen for a human whose Sanctums are gone, Grunts and Head Hunters for an
orc that has lost its Beastiary. It is the same row that gets a tier-3 build order out of its
opening (below), asked from the other end, and it yields the moment one row of the build itself
comes back online. With no barracks standing it asks for nothing at all, which is correct: a row
for something we cannot make starves every row under it.

### Expanding is part of the BUILD ORDER

Each strategy carries `expandAt` and `expandAgainAt`. A ranged line that holds ground takes its
second mine at four minutes; a Raider build that intends to be somewhere else takes it at eight;
an air build later still. **This is not a difficulty setting** — all the difficulty contributes
is a ceiling on how many towns it will ever hold, and `expandDelay`, seconds added to whatever
clock the build set.

Three gates sit on top of the clock, and each answers a different question: *can it* (the
difficulty's cap; a free mine; the gold; and creeps on the spot, which the attack ladder clears
first — see rung 0 of `pickTarget`), *should it now* (the strategy's clock, **or** the ore in the
mines it already owns running out — a build order is a plan, not a promise), and *is it safe*
(never while something hostile is standing in one of its towns).

The expansion row sits above the tier-up **and above the second hero** in the ladder, because
both are things the AI SAVES for and a saved-for row halts everything under it. With the second
hero above it, an insane orc past its own expansion time never founded a second town at all.

### The answer to AIR is a transition, not a re-weighting

`PlusRaceTable.antiAir` and `plan.ts`'s `antiAir` — the Flying Machine off one Workshop, the
Troll Batrider, the Gargoyle, the Hippogryph.

Re-weighting the mix is the right answer to "they have a lot of Footmen" and **no answer at all**
to "they have Gryphons": a Grunt build re-weighted for air is still a Grunt build, and the air
penalty merely tells it that everything it owns is worthless. So this is the one row in the whole
ladder that puts up a producer the build order never asked for — and it is deliberately BOUNDED:
one building and four bodies, on top of whatever is being played, never a switch to an anti-air
army. Each race's row names its DEDICATED answer rather than its best flyer (a Flying Machine and
a Hippogryph shoot air and nothing else), which is what makes it safe to bolt onto any build.

It obeys the same three gates as the rest of the countering, so it can never become a fog bypass
or a free upgrade: only what has been SEEN, only off a sample this difficulty believes, and never
at a difficulty that does not counter at all — an Easy computer builds what it opened with,
whatever is flying over its base. The "the enemy went air" bar is `counter.ts`'s own `AIR_HEAVY`,
shared rather than re-stated so the row and the re-weighting cannot disagree about it.

## Countering: the damage table, read off what it has scouted

> In a TEAM game the "what it has scouted" is the **team's**, not this player's alone — see
> [Scouting intelligence](#scouting-intelligence-the-team-scouts-once) below.


Warcraft III's rock-paper-scissors is a table — `Units\MiscGame.txt`'s `DamageBonus*` lists, the
same numbers Liquipedia's *Armor and Attack types* page and classic.battle.net's
`armorandweapontypes.shtml` render. Piercing does 2.00 into Light and 0.35 into Fortified; Magic
does 2.00 into Heavy; Siege does 1.50 into Fortified and 0.50 into Medium.

So [`counter.ts`](../src/ai/plus/counter.ts) contains **no counter chart**. It reads
`DAMAGE_TABLE[attackType][armorType]`, computed from the game's own raw lists, which means a
custom map that re-tunes the matrix moves the AI with it.

How it works:

1. **It only counters what it has SEEN.** Every hostile *player* unit under this computer's own
   eyes is remembered, with a timestamp — creeps are excluded, because a creep camp is not a
   build order to answer (reading them in made Echo Isles look like a seventy-unit Heavy-armour
   army before either player had made a soldier). Sightings age out, so the read is of the
   army the enemy has *now*.
2. **A couple of units is noise; a third of an army is a fact.** A share below the difficulty's
   `counterShare` is dropped from the read entirely.
3. **The mix is re-weighted, not rewritten.** Each candidate unit gets a score: its attack type
   against the armour shares seen, plus a large premium or penalty for being able to shoot up at
   all when the enemy is air-heavy — that second half is what turns "the enemy went Gryphons"
   into "build Dragonhawks", and no damage multiplier expresses it. The score moves the
   strategy's own weight by `1 + (score − 1) × counterWeight` and never below a floor, so the
   computer is still visibly playing the build it opened with.

**Easy never counters at all** — it builds what it opened with, whatever walks into its base.
Normal wants a dozen units seen and half its army to be one thing before it believes it, moves
its mix a third of the way, and forgets in ninety seconds. Insane reacts at six units and a
quarter share, moves fully, and remembers four minutes.

## The build ladder: one routine, one table per build

A melee opening is the same game in four vocabularies, so [`plan.ts`](../src/ai/plus/plan.ts) is
one routine and [`races.ts`](../src/ai/plus/races.ts) is four tables of ids, weights and gates.
The block ORDER in `buildPlan` is the strategy, because `OneBuildLoop` reserves gold down the
list **and returns at the first unit row it cannot afford**:

> **gold crew** → **forest crew** → *(undead: haunt the mine)* → hall → food → **altar** →
> **first hero** → barracks → the rest of the workers → **shop** → **core army** →
> **tier 2, from 3:00** → tech buildings → **upgrades** → always → **expansion** → extra heroes →
> tier → towers → **the rest of the army**

Seven of those positions were moved after a live match said so, and each is worth stating:

- **The gold crew is first and the lumberjacks are right behind it.** `workers` used to be one row
  asking for the profile's full number (14 on Insane), and because it is a `SetBuildNext` row it
  asks for one *more* every pass — so the ladder spent its gold a peon at a time, for ever, and
  the altar underneath was reached with nothing left. Measured: an **Insane orc at 2:30 with
  fourteen peons, no hero and no army**, its Blademaster finally out at nearly five minutes. So
  `mineCrew` (five per mine, plus one for building and scouting) went to the very top — it is also
  the **dead-worker replacement, at the highest priority there is**, since a worker killed off a
  mine is income that has stopped — and everything else moved below the hero.

  **…and "the very top" has to mean it literally.** Reported later: *"when its town gets
  raided/attacked and workers die, it doesn't replace them by producing new ones"*. The row was
  always ASKING — the crew target is absolute, so a dead miner makes it short on the very next
  pass — but two rows still sat above it, and both are priced at a **building**:
  `meleeTownHall`, which asks for a hall on any town of ours that has a mine and no hall (a razed
  expansion — 385 gold and up), and `mineBuildings`, which asks for a Haunted Gold Mine (225 gold
  and **210 lumber**) the moment an undead player holds an unhaunted rock. A raid is precisely
  when the bank is smallest, so those rows are certain to halt the loop then — and with the crews
  underneath them **the halt is permanent by construction**, because the shortfall would be
  cleared with gold out of a mine nobody is standing in. A ladder player replaces the worker
  first and rebuilds the hall out of what it earns. Nothing is written above the two crew rows
  now, at any difficulty: an Easy computer economises on how big its army and its economy *grow*,
  not on whether its mine is crewed.

  **The rate matters too, and that is `crewRow`.** `SetBuildNext` reserves one worker's gold —
  which is what keeps a crew row from starving the ladder — but it also means exactly **one**
  worker in flight in the whole base, however many are missing and however many halls are idle,
  since `trainUnits` puts one job in a building and moves on. A raid that kills five workers was
  then repaired one at a time through a single hall while the expansion's hall did nothing. The
  crew rows now ask for the absolute target **capped at one in flight per hall**: identical to
  `SetBuildNext` on one base, both queues filled on two, and never the whole shortfall — which is
  the `SetBuildUnit(12, PEON)` trap the row was moved out of in the first place.
- **…and then the forest crew had to come back up, because "after the hero" is a DEADLOCK.** With
  the mine's five and one spare, `harvestPlan` leaves exactly **one** worker in the trees. The
  next row the ladder cannot pay for is the hero — 425 gold and **100 lumber** — and
  `OneBuildLoop` returns at a row it cannot afford, so everything under it stops, *including the
  row that would have hired a second lumberjack*. Measured on Echo Isles: a Normal **night elf
  stood in its base from 0:30 to 4:45** with six wisps, no hero, not one further building and
  **two and a half thousand gold banked**, while one wisp chopped its way to a hundred wood.
  `forestCrew` (`LUMBER_OPENING`, four more) now sits with `mineCrew` at the top. It is safe there
  precisely where the old `workers` row was not: it is a **bounded** target — ten workers and then
  it stops asking — rather than a row that asks for one more every pass for ever. Same match with
  the row moved: **hero at 3:01 instead of 5:46, Ancient of War at 2:01 instead of 4:46, shop at
  2:31, tier 2 reached at all.**
  For the **undead** the same row means the Crypt and its first two Ghouls, because an Acolyte
  cannot chop (docs/undead.md) — an undead opening that buys the altar first spends 50 of its 150
  starting lumber on the altar and 100 on the hero and then owns nothing that can earn another
  stick.
- **The shop is with the opening, not with the tech.** It was below `techBuildings` and
  `upgrades` on the argument that a shop is a want rather than an opening — and a row is only
  "lower priority" if the ladder ever gets to it. Measured: a Normal orc at **8:30 with three
  Grunts, no Stronghold, no upgrade and no Voodoo Lounge**, because a 200-gold Grunt row had
  halted the loop every pass since the third minute. A Voodoo Lounge is 130 gold and 30 lumber,
  less than one Grunt, and what it sells is what keeps the party alive through the creep camps the
  next ten minutes are made of. `SHOP_AFTER` is now a hero's own food (5), which is to say: as
  soon as there is somebody with a belt to fill.
- **The hero outranks the Barracks.** A Barracks is 160 gold reserved out of the 425 the altar is
  saving for; measured, an Insane orc with its altar standing at 1:17 did not queue its
  Blademaster until past 3:30. A ladder player buys the hero the moment the altar finishes.
- **Upgrades sit with the tech buildings, above the tier-up.** An upgrade row cannot *halt* the
  loop (only a unit or expansion row can) but it can be **unreachable**, and it was: `tierUp` and
  `extraHeroes` halt the loop while the AI saves for a Castle or a second hero, and everything
  below them goes unread for minutes. That is the whole of "the AI never upgrades anything".
  Forged Swords is a hundred gold and makes the army you already have better; a Castle is a
  thousand and makes nothing until it lands. (`startUpgrade` now also *reserves* what it spends,
  which every other row already did.)
- **…but the tier-up has a CLOCK, and at three minutes it stops waiting its turn.** The rule
  above is right and it is also how a computer stays at tier 1 for ever: there is always another
  upgrade, and a `SetBuildNext` army row asks for one more soldier every pass, world without end.
  So `tierUpDue` asks for the tier-2 hall a second time, high in the ladder, from `TIER2_CLOCK`
  (180 s) — which is when a ladder player has their hall going up, and is the developer's own
  "tier 2 transition starts at around 3-4 mins for all races". Asking twice in one pass is free:
  the first ask starts the upgrade and `TownCount` counts a job in a queue, so the second is
  already satisfied; and if the first could not afford it, the loop never reaches the second.
  Tier 3 keeps its old place at the bottom — at ten minutes there is an army to spend on, and
  what loses games there is teching past what you can defend.

### The food headroom is the SUPPLY BUILDING's, not a Farm's

Reported: *"the Computer+ AI for Night Elf sometimes does not build enough moon wells, rendering
it unable to produce more army units."*

`supply` had two numbers in it and **both of them were the Human's**. It kept a flat six food of
headroom and allowed exactly one supply building in flight (`countDone + 1` is already satisfied
by one under construction, since `SetBuildUnit` counts what is going up). That is a fair
description of a player putting up **Farms** — 80 gold, 20 lumber, **35 seconds**, six food — and
it describes no other race in the game. A **Moon Well is 180 gold, 40 lumber, 50 seconds and ten
food** (`UnitBalance.slk`): the most expensive supply building there is, half again as slow as a
Farm, and the night elf is paying one food per Wisp out of the same cap. Six food of warning is
most of a Farm's build time and about a third of a Moon Well's — so the elf hit the cap while its
one well was still going up, and stopped producing.

Both numbers are now asked of the building itself:

* **the headroom is one of these buildings' worth of food** (`GetFoodMade`) — ten for a Moon
  Well, a Burrow and a Ziggurat, six for a Farm, which leaves the Human exactly where it was;
* **two may be in flight once the cap has actually been REACHED**, and only then. Blocked is a
  different position from nearly-blocked: nothing below this row can be trained at all until the
  cap moves, so the gold a second building reserves is gold that had nothing else to buy. Below
  the cap it is still one at a time, which is what keeps the row from carpeting the base.

…and a **third** number was wrong in a way only one race could see. The row is *relative* ("one
more than I have"), so it has to count what `startUnit` will count — and what `startUnit` counts
is **`TownCount`**, the id with its **upgraded forms folded in** (`TOWN_COUNT_EQUIVALENTS`). One
race's supply building upgrades, and it is the one whose supply building is also its **tower**: a
Ziggurat becomes a **Spirit Tower** (`PlusRaceTable.tower` = `uzg1`) and goes on making its ten
food. Asked of the plain Ziggurat alone, the row said *"I have none, give me one"*; `startUnit`
folded the Spirit Towers back in, answered *"you have three"*, and **the undead never built
another supply building for the rest of the match**. A raid is what brings it on, because
`towers` fires the moment a town is threatened — a Normal computer turns two Ziggurats per town
into Spirit Towers, an Insane one four, and each of those was a supply building the AI would
never replace. `supply` now asks `townCountDone`, so both sides of the comparison speak the same
language.

### Razed buildings: what makes them come back

Nothing, and that is the design. The farm/supply row is the only one of them that is relative;
the **altar, the barracks, the shop, the support buildings and the towers are all absolute asks**
(`setBuildUnit(1, …)`, `guardSecondary(t, n, …)`), re-emitted from scratch on every pass by a
plan that is rebuilt from the world each time. A razed building simply makes its row short again
on the very next pass, and the ladder buys it back in ladder order as the gold arrives — which is
also why nothing here needs to notice a *death*. `ai-plus-ladder-test.cjs` razes each of those
five types at the five-minute mark of the headless economy run, for every race, and pins that all
of them are back under way (worst case ≈ 180 s, the smith behind a rebuilt Barracks) and that the
player is not left food-blocked.

The fixture is also what caught the one thing that was *stated* here and implemented one screen
lower: the race's own smith belongs **above the tier-up** ("a Forge is two hundred gold and makes
the army you already have better; a Stronghold is three hundred and fifteen and blocks everything
under it while the AI saves"), and it was emitted inside `techBuildings`, which sits below the
three-minute tier row. So from `TIER2_CLOCK` onward the smith was in fact bought after the hall —
and a razed Graveyard, which is where the undead's Crypt Fiends, its Gargoyles and every one of
its armour and attack upgrades come from, was queued behind a Tomb of Relics and a Halls of the
Dead and took over five minutes to come back. `supportBuildings` is that row in the place the
paragraph always claimed for it; every race's worst rebuild dropped by a third to a half.

One building, **one row**. A support building is quite often also a `needs` of something in the
mix (the undead's Graveyard is the Crypt Fiend's and the Gargoyle's; the orc's War Mill is the
Head Hunter's and the Kodo's), and a building asked for twice in one pass is not merely untidy:
`startUnit` prices each row separately off the same running budget, so an unsatisfied duplicate
reserves the price twice over for a payment that is only ever made once.

### A build order names the army it INTENDS; the opening soldier is derived

A strategy is a weighted unit mix, and a mix is a statement about the army this build wants to
*end up with*. Five of the twenty builds in `races.ts` name nothing that exists at tier 1 — the
night elf's `bears` (Druids of the Claw, Dryads, Mountain Giants) and `chimaeras`, the human's
`gryphons`, the undead's `aboms` and `gargoyles`. `buildableMix` narrowed the mix to what could
be produced *now*, that came back empty, and the army rows asked for nothing.

**That is not a quiet opening, it is a deadlock**, and the reason is that every "don't tech with
nothing on the field" gate in the plan is stated in ARMY FOOD: `TIER2_ARMY` wants 8 before the
hall goes up, a `SupportRow` wants its own `after`, `TECH_AFTER` wants 12 before a tier-2
producer. With nothing trainable the only food on the field is the hero's five, for ever — so the
buildings waited on the army and the army waited on the buildings. Reported from a real match: a
Normal **night elf training no Archers** and a Normal **orc training no Grunts**, while the
undead — reported as fine, and it *was* fine — played normally for a reason that gives the game
away: **its Ghouls come out of the economy, not out of the mix.** `lumberUnits` sits with the
workers near the top of the ladder, so `aboms` and `gargoyles` had an army in spite of themselves.

The fix is what a player does in that position, and what every real Bear or Gryphon build order
writes down: **open with the race's basic soldier and tech behind it.** When the strategy's own
mix can produce nothing, `buildableMix` falls back on the race's OPENING SOLDIER — and derives it
rather than naming it on the table, like every other building and upgrade here (rule 2 in
`plan.ts`): the lowest-tier thing `table.barracks` makes that **needs nothing else standing** and
is neither siege nor air. That is the Footman, the Grunt, the Archer and the Ghoul.

Two clauses in that carry weight:

- **"needs nothing else standing"** is what keeps the fallback out of the same trap. The human's
  Rifleman is a tier-1 unit too — and it waits on a Blacksmith, which is a support row gated on
  six army food. Falling back onto it would be the identical circle one building further out.
- **"when the mix can produce nothing"** is what keeps it a fallback. The moment one row of the
  build order comes online the opening soldier stops being offered, and the ones already bought
  simply stand in the army: an elf on `bears` opens on Archers and stops the instant its Ancient
  of Lore can make a Dryad. Without that, every build would quietly become "the basic soldier,
  and tech".

Behind it sits one more brace, `starved()`: if there is genuinely nothing to train *even with the
fallback* — a razed producer, a custom race table with no basic soldier — the army-food gates on
the support buildings and on the tier-up are lifted, because in that state they are the thing
keeping the field empty rather than a discipline about it. It is unreachable in a stock game, and
that is the point of it.

`tools/ai-plus-plan-test.cjs` pins all of it: every build of every race has something to train at
tier 1 with only a hall and a barracks standing, the fallback is the right unit, it is offered
only while the mix is empty, and nothing is ever asked for with no producer up.

### A tier-up is priced as the UPGRADE it is

The other half of "way too long at tier 1", and it was a plain bug in the library rather than a
question of strategy — so it slowed the **classic** melee AI exactly as much, since both AIs
spend down the same build array.

A structure upgrade is charged the **difference** between the two buildings, in WC3 and in our own
authority (`authority.ts` "upgradebuilding": a Stronghold at 700/375 over a Great Hall at 385/185
is 315/190). `OneBuildLoop` priced it at the new building's whole row — **705 gold and 415 lumber
for a Keep**, against the 320/210 the player is actually charged. So every computer of every race
sat waiting to bank rather more than twice the money the tier-up costs; and because a unit row
*halts* the loop while it cannot afford itself, everything below it in the ladder starved for the
whole of that wait too.

`AiPlayer.rowCost` now prices the row off **`upgradeSources`** — our standing buildings that
upgrade into its id, busy or not — so with nothing of ours that upgrades into it, `setProduce`
will FOUND the building and the full row is the right price.

**…and "busy or not" is the second half of the same bug.** The price used to be asked of the
idle-only `upgradeCandidates` scan, and a hall with a worker in its queue is a hall for most of
the opening: the worker rows sit above the tier row in every build order there is
(`mineCrew`/`forestCrew`/`workers`, plus/plan.ts), and they re-fill the queue on every pass. So
the Stronghold was priced at 700/375 again for four passes in five over the first two minutes,
and the ladder stopped there — with the Barracks, the tech, the upgrades and the army rows all
underneath it. That is the developer's report exactly: *"stuck not building an initial army of
grunts and/or headhunters and is also not teching up"*, one halt producing both halves.

**And priced right it still could not start**, because `upgradeExisting` needs that hall idle and
the worker rows kept it busy. `runBuildLoop` now takes a `holdForUpgrades` pass first: a building
some row in this list means to upgrade, and which we can afford to upgrade, is held out of
`trainUnits` for that pass. It costs one worker a few seconds. Without it a computer sits at tier
1 for as long as it still wants workers — which, with `PlusProfile.workers` counted per MINE, is
most of a match that expands.

Pinned in [`tools/ai-build-cost-test.cjs`](../tools/ai-build-cost-test.cjs).

### …and nothing halts the ladder for ever

`OneBuildLoop` returning at the first row it cannot afford is common.ai's own rule and it is what
makes a build order an order. It quietly assumes the shortfall **shrinks**. It does not always: a
row short of LUMBER on a player with nobody in the trees is short of it for ever, and everything
below that row is never read again — including the rows that would have hired a lumberjack, put up
the farm that lifts the food cap, or trained the soldier that pays for itself. A raid that kills a
few workers is enough to walk into it: `harvestGold` is cumulative and comes first, so five
workers left alive all go back on the mine and the forest is empty.

Two things, a brace and a belt:

* **`harvestPlan` never leaves the forest empty**, and the way it does that is the race scripts'
  own — see [*The harvest split is INTERLEAVED*](#the-harvest-split-is-interleaved-not-gold-then-wood)
  below. The `LUMBER_DRY` floor (one axe before the mine's crew while the bank is under 100)
  survives underneath it, for the base reduced to fewer workers than the main mine alone would
  take.
* **`AiPlayer.releaseStall` lets one pass through.** The halt stands for as long as it is
  *earning*: the smallest shortfall seen ratchets down, and any pass that beats it resets the
  count. Only a row that has spent `STALL_PASSES` (20) passes without once getting nearer the
  price is let past, for that single pass, and only the first such row in the list. Nothing is
  abandoned — the row is asked for again on the very next pass.

### The harvest split is INTERLEAVED, not gold-then-wood

Computer+ read *five per mine, and then everybody left over goes to the trees*. That is a
plausible sentence and it is not what any race script says. All three whose worker can chop write
the same four lines — human.ai 623-626, orc.ai 628-631, elf.ai 688-691:

```jass
call HarvestGold(T,4)
call HarvestWood(0,1)
call HarvestGold(T,1)
call HarvestWood(0,1)              // elf.ai asks 2 here
if <a second mine> then call HarvestGold(T+1,5) endif
call HarvestWood(0,15)
```

The slices are cumulative and ORDERED, so what those lines actually say is: **the fifth miner is
worth less than the first lumberjack, and the second town's entire crew is worth less than the
second lumberjack.** Collapsed into gold-then-wood, the priority is inverted, and it costs exactly
the two players who can least afford it:

- **An EXPANDED computer chopped nothing at all.** Three towns is fifteen gold seats against an
  Insane profile's fourteen workers (`PlusProfile.workers`), so the trailing lumber slice swept up
  *nobody*. Every row the ladder halts on early is priced in wood, and a lumber shortfall with no
  lumber income never shrinks.
- **A RAIDED one chopped nothing either**, for as long as it was short of five workers per mine —
  which is precisely while it is rebuilding and needs lumber most.

So `harvestPlan` now opens the main mine's crew up and puts the two lumberjacks through the gap,
then crews every other town, then sweeps the rest into the forest.

**The undead is the exception, and undead.ai says so too** (647-652): `harvest_gold(0..3)`, and
only then `HarvestWood(0, WG)`. There is nothing to interleave, because an Acolyte cannot chop
(`uaco` `lumber: false`) — its gold is Acolytes kneeling at the Haunted Gold Mine and its lumber
is Ghouls out of the Crypt, so the two are not bidding for the same bodies at all and the trailing
wood slice picks up whatever ghouls the wave did not take. Asked as `PlusCtx.workerChops` — a
question about this player's WORKER — rather than as a race, so a custom map that hands its
Acolytes an axe gets the interleave with no list of races anywhere.

### …and nobody stands about: the fallback under the plan

The harvest plan is a **list of slices** — five on the main mine, an axe, the fifth miner, another
axe, five on every other mine, and forty in the trees — and a worker no slice reached is a worker
with no job at all. There are four ordinary ways to be one, and the first is the one that shows:

* **it cannot chop.** The catch-all last slice is the *forest*, which for the undead is nobody: an
  Acolyte past its mine's fifth mark is a worker the plan has no row for, and it stands where it
  was trained for the rest of the match;
* **there is no tree** within `sendToWood`'s reach of the town it was assigned to (a base backing
  onto water, a forest already chopped out), so no order was ever issued;
* **it just finished something** on a pass where every slice was full;
* **the plan itself was short**, because the mine it would have crewed is dead, unhaunted or held
  by somebody else (`mineWorkable`).

`AiPlayer.workIdleWorkers` is the floor under all four, and it is the developer's own rule: *"the
Computer+ AI should never leave workers idle, its fallback must be to send them to gather lumber
or fill their gold mine if it doesn't have 5 workers inside it already"*. Gold first, because gold
is what every row on the build ladder is bought with and because "is that mine at its five" is the
one question a mine answers by itself (`MINE_SEATS`; a mine's crew is counted four different ways,
since it is a different shape in three of the four races — down the shaft, inside an Entangled
Gold Mine, kneeling in a Haunted one's ring, or simply walking there); otherwise the trees, trying
every town rather than only town 0.

It runs **below** `applyHarvest` rather than instead of it, so it can only ever hand work to
somebody the plan left with none: the only unit it can see is one whose order is literally
`"idle"`, and anything harvesting, hauling, building, repairing, walking or held by the army
(`captainHeld` — the scout and the wave) is passed over untouched. Computer+ calls it; the classic
AI is unchanged.

### It repairs, and the hall outranks everything

`SetPeonsRepair(true)` is unconditional in `StandardAI` (common.ai 792), so this is one of the few
places Computer+ has nothing to improve on Blizzard's computer: it sets the same flag at seat
time, at every difficulty. The pass behind it lives on the shared library layer where the native
belongs (`AiPlayer.applyRepairs`) and is described in
[`melee-ai.md`](melee-ai.md#setpeonsrepair--every-melee-computer-repairs-at-every-difficulty) —
hall first (off `UnitBalance`'s own `TownHall` class, not a race list), **two workers ever**, and
an idle worker before a lumberjack before a miner, because gold is what every other row on the
ladder above is bought with.

### A second Barracks is bought with the BANK, not with army food

`techBuildings` gated another copy of the main producer on `armyFood >= 40 && gold > 800`, and the
first half is **above the army ceiling of two of the three difficulties** (`PlusProfile.armyFood`
is 12 on Easy and 30 on Normal) — so neither could ever build one. It was circular besides: one
building trains one thing at a time (`AiPlayer.trainUnits`), so a single Barracks becomes at most
a Grunt every thirty seconds however rich the player is, and "get a big army, then buy a second
Barracks" says "buy one once you no longer need one". Measured headless
([`tools/ai-plus-ladder-test.cjs`](../tools/ai-plus-ladder-test.cjs)): a Normal computer of every
race at ten minutes with thousands of unspent gold and a handful of soldiers.

The gold threshold is the file's own 800, unchanged; what went is the army clause it was ANDed
with. Up to `FACTORY_MAX` (3) copies, one more per 800 banked, and only while the army is still
short of what the difficulty allows.

### The core army GROWS with the tier

`CORE_ARMY_FOOD` is the only army row above the tier-up, and everything below a tier-up stops
while the AI saves for it — the towers, the expansion and above all `army(profile.armyFood)`,
which is the bulk of the army. Sixteen food is a reasonable floor to hold while saving 315 for a
Stronghold. It is not a reasonable one to hold while saving a **thousand** for a Fortress, and a
computer that stood at sixteen food from the sixth minute to the ninth is the same "not building
an army" report seen at the other end of the game. So the floor is 16 / 24 / 32 by the tier
standing (`CORE_ARMY_PER_TIER`), capped by the profile throughout — an Easy computer's twelve-food
ceiling is never quietly raised by it.

### The undead's lumber comes out of its army

`recruit` takes everything that fights, and a **Ghoul is not `isPeon`** — so it is a fighter by
every test in the sim, and the wave claimed every ghoul the moment it was trained. `captainHeld`
then kept `applyHarvest` off it, and an undead Computer+ chopped **no lumber for the entire
match**. It is the one race whose lumber comes out of its army, and it has to say so.

The BANK's half of the rule and both its numbers are Blizzard's — undead.ai 205–219, ported at
`UNDEAD_AI.waveGate` in [`src/ai/undead.ts`](../src/ai/undead.ts): *the forest keeps 10
lumberjacks minus one per 120 lumber in the bank, and everything left over attacks.* It
self-regulates, which is why it is worth taking whole rather than picking a constant: by the time
there is 1200 lumber standing every ghoul fights. `recruit` states both directions against one
number, so a crew that has gone short takes ghouls back **out** of the wave (newest first) rather
than only refusing to add more.

Which race this applies to is asked of the DATA, never of a race list: if this player's ordinary
workers can chop (`WorkerState.lumber` — a Peasant, a Peon, a Wisp) nothing is held back at all.
Only the Acolyte (`uaco`, `lumber: false`) reaches the formula.

**But that decay is a LATE-game rule, and read onto an opening it means the opposite.** undead.ai
has *two* branches and only the second one is the decay: in the OPENING the wave takes its six
ghouls **first** and "the rest keep chopping" — the split is stated from the wave's side, and the
forest gets the remainder. Computer+ has no opening branch, so it ran the decay on the opening: a
melee undead's first ghouls arrive with 150 lumber banked, where the decay asks for **nine**
choppers and there are five, so every ghoul chopped. The hero was then the only thing in the
squad — five food against a `creepFood` of eight or ten — and the symptom was the reported one:
*the undead hero stands in its own base for minutes while every other race is out creeping*, until
the bank has grown to about 600 lumber and the decay finally releases a party.

So there is a second ceiling and it is **ours**: the forest never takes more than a **third** of
the ghouls, whatever the bank says (`LUMBER_SHARE`), and the lower of the two ceilings wins. Two
thirds of them are the army — this is the one race whose soldiers and whose lumberjacks are the
same body, and a rule that lets the forest bid for them by the bank alone is a rule that puts the
army in the trees. It scales the way a player's hand does: two on the trees behind a four-ghoul
opening, three behind seven, four behind ten, never the whole crypt.

The same pass removed the *other* cap, which was the older shape of the same idea: a chopper used
to be taken into the wave only while the squad was under `attackFood`. Left in beside `lumberCrew`
it capped the undead's **army** at a wave — every ghoul past fourteen or sixteen food went back to
the trees, so the one race that pays for its army out of its forest was the one race that could
not attack with what it had built, which is also the rule this file says Computer+ does not have
(the ceiling is at production).

### …and WHICH ghouls: the hurt ones go back to the trees

How many the forest keeps is one question; which BODIES are on each side of that line is another.
A hurt ghoul is worth more on the trees than in the line twice over: the party it leaves is priced
off **current** hit points ([`power.ts`](../src/ai/plus/power.ts)), so the wave is stronger the
moment the exchange is made rather than in the minute and a half a Ghoul takes to heal itself —
and it heals while it chops, since a Ghoul regenerates **2 hp/s on blight and not one point off
it** (UnitBalance `regenType`, [undead](undead.md)) and the blight is where its base is.

So the two sides are sorted before anything moves: the choppers **outside** the wave freshest
first, the ones **inside** it most hurt first. Every move is then between the two ends —
returning a chopper to the crew takes the most hurt, filling the wave takes the freshest, and on
top of both there is a one-for-one **relief** (`reliefCount`): a ghoul under 50 % is exchanged for
one at 90 % or better, and the loop stops at the first pair not worth exchanging. The gap between
those two numbers is the whole of "it must not go back and forth" — one threshold would swap a
ghoul out at 49 % for one at 51 % and swap it back on the next pass.

Relief happens at **home** only (`massing`, not `afield`). In the field it is two lone ghouls
walking in opposite directions across a melee map, one of them wounded, and the camp between them
eats both.

**And the forest never takes a ghoul that is out with the wave.** `serving` — the choppers the
crew may recall — is built only from squad members standing inside `TOWN_RADIUS` of home, and
without that clause the forest bids for the wave *mid-run*: `lumberCrew` moves whenever the lumber
bank does, and the bank moves every time the build order spends. The recall does two things at
once, both bad. It drops the ghoul out of the squad, so `commit` stops moving it and the party it
was in fights one body short; and the harvest plan then walks it home **alone** across a melee map
— `serving` is sorted worst-health first, so it is always the ghoul in the thickest of it that
gets picked. That is half of the reported *"the undead leaves its army at home"*. The forest simply
waits: everything above the crew is handed to it the moment the party comes home, which is when a
player does the same thing.

That split decides how ghouls are *used*. Two more things follow from the same fact and both are
in `plan.ts`:

- **The forest has to be BUILT.** `lumberCrew` divides the ghouls a player has; it does not make
  any. Two of the five undead builds (`aboms`, `gargoyles`) name no Ghoul in their mix at all, and
  under those the race chopped nothing whatever — so `PlusRaceTable.lumberUnit` names the chopper
  and `workers` puts up `LUMBER_UNITS` of them beside the workers, as economy rather than as army.
  `LUMBER_UNITS` is **six**, and the sixth is the creeping party rather than the forest: with a
  third of them chopping, six ghouls is two on the trees and four behind the hero. A Ghoul is 340
  hit points and 13 damage over a 1.3-second cooldown (UnitBalance `realHP`, UnitWeapons
  `avgdmg1`/`cool1`), so behind a level-1 hero three price at √(3 × 10 × 340) × 1.35 ≈ 136 and
  four at ≈ 157 against [`power.ts`](../src/ai/plus/power.ts)'s green bar of 120 — and the margin
  is the point, because the power is read off CURRENT hit points, so a three-ghoul party stops
  being one the moment anything scratches it.
- **An Acolyte is not a lumberjack, so five is the number.** Every worker past a mine's crew of
  five is 75 gold standing in a queue — for three races the sixth goes to the trees, for the
  undead it goes nowhere. `PlusProfile.workers` (11 on Normal, 14 on Insane) is an *economy's*
  worth of workers and only means that where a worker can chop; a race that cannot gets
  `MINE_CREW × towns + 1`, the plus one being the builder and the scout. Measured before the fix:
  an undead Computer+ at nineteen minutes with **thirty-eight Acolytes**.

### The undead altar is `uaod`, not `utod`

A one-word row in `races.ts` that cost the undead its entire hero game, and it is worth writing
down because the two names read alike in English: **`uaod` is the Altar of Darkness** (where a
hero is bought) and **`utod` is the Temple of the Damned** (where Necromancers and Banshees are
trained). The table named the second as its `altar`.

Nothing about that fails loudly. `basics` put up a Temple of the Damned believing it was the
altar; `firstHero` saw one standing and asked for a Death Knight; `SetProduce` had no altar to
make one at — and because **a hero row halts the build loop while the AI saves for it**, every row
below it starved for the rest of the match. The undead Computer+ never built an altar, never
fielded a hero, and never fielded an army; what it did instead was spend the whole game on the one
row above the hero, which is workers.

### An expansion is founded by ONE worker, and crewed by NEW ones

"When an orc expands it takes **all** its peons to the expansion" — and it did. A new town's gold
slice found five workers already crewing the main mine, they were the nearest able bodies, and
`applyHarvest` moved every one of them: the main base's income stopped dead so the expansion's
could start.

A player never does that. They send **one** worker to put the hall up (that is `AiPlayer.freeWorker`,
a different question), and the new mine is crewed by workers **trained at it** — which now happens
by itself, because `plan.ts`'s `mineCrew` asks for five per mine *owned* and a new town raises
that target the moment its hall lands. The rule that makes it true is one filter in
`applyHarvest`: **a miner is never taken off another mine** (`onAnotherMine`, which also knows
about a Wisp inside an Entangled Gold Mine, since its whole crew is cargo and shows no harvest
order at all). Lumberjacks and idle workers are still fair game — they are not income that is
already flowing, and walking one over is exactly what a player does while the hall goes up. It
holds for all four races.

### …and an UNDEAD expansion is the MINE, not the Necropolis

Reported: *"when undead is expanding, it doesn't use its acolyte to turn the gold mine into a
haunted gold mine, rendering the expansion useless."* It did exactly that, and the town it
founded earned nothing for the rest of the match.

The undead is the one race whose expansion is not a hall beside a rock. Its Acolytes kneel in a
**ring** that does not exist until the mine is haunted — `SimWorld.issueGoldWork` refuses a gold
order outright while `hauntedMine` is null (`[Errors] Blightminefirst` = *"Must haunt gold mine
first."*, [`undead.md`](undead.md)) — so a Necropolis on its own is a building, not an economy.
Worse, it *looks* like one from above: `AiPlayer.townHasHall` counts any depot in range, so
`minesOwned` read the dead town as a working mine and `expand`'s own cap then stopped the AI
taking another.

`PlusRaceTable.mineBuilding` names the building (`ugol`, and nobody else has one), and
`plan.ts`'s **`mineBuildings`** asks for it at every town that holds a mine and has not got one.
Four things about it are the decision rather than the plumbing:

* **the expansion is FOUNDED with it.** `expand` passes `table.mineBuilding ?? table.halls[0]` to
  `basicExpansion`, which is `undead.ai`'s own rule stated four times over — every one of its
  expansion sites reads `ai.basicExpansion(mines < N, UNDEAD_MINE)`, never the Necropolis
  (undead.ai 179/215/302/322, ported in [`src/ai/undead.ts`](../src/ai/undead.ts)). That also
  settles the order for free: `startExpansion` calls `nextExpansion()` — which *registers* the
  town — before it asks whether the row can be paid for, so the town exists from that pass on and
  `mineBuildings` picks it up at the top of the ladder whether or not the 225/210 was affordable
  that second;
* it sits **above `meleeTownHall` at the very top of the ladder**, which is undead.ai's own order
  (undead.ai 299–302) and was the bug: a Necropolis is 225 gold and **no lumber**, a Haunted Gold
  Mine is 225 and **210** — the most lumber of any undead building (`UnitBalance.slk`). Under the
  hall rows the cheap half of an expansion was bought first every pass and the half that earns
  anything was left underneath competing for wood the rows below kept spending, which is exactly
  the developer's *"it only builds a necropolis"*. Above them, `OneBuildLoop`'s own halt does the
  saving: nothing under this row spends a stick until the 210 is banked. Whichever of the two
  finishes first still satisfies `townHasHall` and retires the other, which is authentic either
  way: an undead expansion in a real game is quite often the haunted mine and a Ziggurat with no
  Necropolis over it;
* it is counted with `townCountTown`, so a haunting already under way is not asked for twice;
* **the night elf is deliberately not in it.** An Entangled Gold Mine is what the `Aent` CAST
  creates, not something a worker builds, and it is issued from the library layer both AIs share
  (`AiPlayer.entangleMines`, [`night-elf.md`](night-elf.md)). A `mineBuilding` row for the elf
  would be a build order asking for a unit id that no worker can found.

The classic AI has always done this — `undead.ai`'s `undead_mine(townid)` is one line per town —
so what was missing here was the row, not the idea. Placement is the library's and already knew:
`AiPlayer.siteFor` puts a mine-standing building **on the mine and nowhere else**.

Two things in the library had to change with it, and both are the same fact arriving from
different directions — that for one race an expansion is a **lumber** purchase:

* **`AiPlayer.startExpansion` prices lumber**, like every other row (`startUnit`) always did. It
  asked about gold alone, which is harmless while an expansion is always a Town Hall and wrong
  for a 225/**210** Haunted Gold Mine: the row declared itself affordable, the authority then
  refused the build for want of the wood, and the failure came back as a halt with a stale
  shortfall behind it.
* **`harvestPlan` does not crew a mine nobody can work** (`mineWorkable`). `townHasHall` says yes
  to a Necropolis standing beside a bare rock, because a Necropolis is a gold depot by its own
  row — so the plan sent five Acolytes to kneel at nothing for as long as the haunt took, and the
  slices are cumulative, so those five were counted before anybody was sent anywhere else. It is
  asked of `countAt(…, done)` rather than `townCountTown`: a haunt still going up is a mine that
  still cannot be worked, whatever the build array thinks of it.

### It picks things up

The whole point of creeping, and the AI did not do it at all: it cleared a camp, walked away, and
left the Tome of Strength and the Claws of Attack on the grass for the other player. `PlusItems.loot`
sends the nearest hero with room, on the belt's own clock. Two kinds of thing, one rule:

- a **powerup** (`ItemDef.powerup` — tomes, runes, a bag of gold) is consumed on contact and never
  stored, so a full inventory is no obstacle and it is worth walking for whatever the hero carries.
  It is also permanent, which is worth more than most of what a shop sells;
- an ordinary **item** needs a free slot, so it is only worth the walk if the hero has one.

Heroes only (only a hero has an inventory in melee WC3), bounded by `LOOT_WALK` (2200 — wider than
a creep camp, so the loot of the camp just cleared is always inside it), and **never while
something hostile is within `LOOT_DANGER` of the item**: a hero that walks into a live camp for a
Ring of Protection is a hero that dies for one. That last test also means a camp's own drops are
simply collected once the camp is dead, with no special case. The order is `getitem`, the ordinary
right-click, and a unit walking to a drop is left alone by the rally and by `commit` exactly as a
shopping hero is.

### Obsidian Statues: one on life, one on mana

The undead's only healer, and unlike a Moon Well it walks with the army — without one an undead
force has to go home between fights, which on a melee map *is* the fight. Three of the five undead
builds name no statue at all, so it is a `PlusRaceTable.always` row: **two, in every undead build
there is**, and `mixBuildings` reads that list too, which is how "the undead always builds a
Slaughterhouse at tier 2" is stated *nowhere* — it falls out of wanting the unit, like every other
building here.

Two data fixes came with it. `uobs` was listed at tier 3, and the undead's own tier-3 clock is past
ten minutes, so the race's only healer arrived after the game was decided; its real gates are
`[uslh] Requires=unp1,ugrv` (Halls of the Dead + Graveyard) and `[uobs] Requires=utom`, the Tomb of
Relics — which is also this race's shop and was going up anyway.

**Both abilities live on every statue and both draw on the same mana pool**, so a statue with both
switched on does neither job well. `statuePass` walks the statues in a stable order and gives
**life to the first** — `Arpl` Essence of Blight is what keeps an army alive, where `Arpm` Spirit
Touch only shortens the wait for the next spell — mana to the second, life to the third. It runs
every army pass rather than only at home, because a statue's job is to heal the fight it is
standing in.

Neither ability existed in the sim (`uobs` UnitAbilities is `"Arpl,Arpm,Aave"`, and they are *not*
the Moon Well's `Ambt` — that is a battery a unit walks up to and drinks from). Both are now
ordinary unit-target autocasts in `spells.ts`: `Arpl` joins `HEAL_SPELLS`, so the game's own rule
applies and a heal that would restore nothing is refused rather than wasted, and `Arpm` joins
`MANA_TARGET_SPELLS` under the game's own `Targetmanauser` string, without which an autocasting
statue empties its pool topping up Ghouls.

### Moon Wells: the well has to be ARMED

`Ambt` is on plus/casting.ts's `HAND_AUTOCAST` — the short list of autocasts that file deliberately
does not switch on for itself — which left the decision to the army manager, and the army manager
never made it. So a night elf's wells poured into nobody but the units `wellPass` explicitly walked
to them. It now arms every replenisher it owns, which lets `tickReplenish`'s third rung top up
whoever is standing at the well already — most of what a Moon Well does for a player, and all of
what it does for an army that has just walked home. The walk itself now sends **the hero first**: a
well's mana is finite, and squad order gave the hero whatever the soldiers in front of it had not
already drunk.

### Who builds it: not the worker down the hole

`AiPlayer.freeWorker` picks the nearest worker that can raise the structure, and it used to stop
there. A worker that is **off the field** — a Wisp inside an Entangled Gold Mine, a Peasant in a
shaft, a Peon in a Burrow — stands at its host's own coordinates, which for a gold mine is the
middle of the base and therefore nearer almost any build site than the workers actually free. So
it won the distance test every time: every structure the plan placed pulled a miner out of the
mine while free wisps stood in the trees beside it, `applyHarvest` sent one back on the next pass,
and a night elf computer spent the whole match putting wisps in and out of its mine.

It is now two passes rather than a distance penalty — on the field strictly beats closer — with
the sunk workers still eligible last, so a player whose every worker is down the mine can still
build. `ComputerPlusAi.freeWorker` (which picks the scout) had the same hole and asked only about
`inMine`; both now ask the sim's own `isOffField`.

Four rules run through it. The first two are the library's own behaviour; the last two are what
that behaviour does to a naive ordering, and both were found by watching a match rather than by
reasoning about the code:

1. **Nothing is asked for that cannot be built.** A row's gold is reserved whether or not the row
   could start, so a row whose producer is missing silently starves everything under it. Every
   army/tech row is therefore gated on its producer *standing*.
2. **Counts are absolute** (`SetBuildUnit(n, X)` is "have at least n"), which is what lets the mix
   re-balance itself as tech opens up: the Footman row that asked for six at tier 1 asks for
   three once Knights are in the mix, and the six standing Footmen satisfy it.
3. **Workers and army rows use the RELATIVE form** (`SetBuildNext` — "one more than is
   finished"). `SetBuildUnit(12, PEON)` on a player who owns five reserves *seven peons' worth*,
   nine hundred gold, and starves everything under it: measured, an orc Computer+ reached three
   minutes with twelve peons, no hero and one Grunt.
4. **The bulk of the army goes LAST, and a small core goes high.** There are always more army
   rows than gold, so army rows in the middle mean nothing below them ever runs — measured, an
   insane orc reached seven minutes with no Stronghold and eleven hundred unspent lumber. The
   support buildings also come *before* the tier-up, because the tier-up is the row the AI
   genuinely saves for and a saved-for row blocks what is under it: a Forge is two hundred gold
   and makes the army you already have better, a Stronghold is seven hundred. This is the same
   shape `human.ai` has — "minimum melee defense" near the top, the tech tree in the middle, and
   "full up with more troops in general" at the bottom.

The ids are Blizzard's (`src/ai/ids.ts` is `common.ai`'s own globals block) and so is every
research location (`Researches=` in `Units\<Race>UnitFunc.txt`). The *composition* — which units,
in what proportion, in what order — is ours, following the standard ladder openings.

## Spells: roles, not a table of abilities

The classic caster refuses any ability its source thread does not describe, and names the
transform family as its one blanket exclusion. Issue #124 asks for the opposite — "it must
utilize ALL abilities, especially things like Bear Form" — so
[`plus/casting.ts`](../src/ai/plus/casting.ts) is built the other way up:

1. every ability has a **role** (`panic`, `heal`, `morph`, `disable`, `nuke`, `summon`, `buff`,
   `debuff`, `utility`), from a table for the melee races and **derived from the ability's own
   row** for anything else — so a custom map's spells are played rather than ignored;
2. the roles are a **priority ladder**, and a caster presses its most valuable legal button
   rather than the first one on its command card. A Paladin with a dying Footman in range heals
   before he stuns;
3. **targets are valued**, not counted — by a ladder that is *shared with the army*
   ([`targeting.ts`](../src/ai/plus/targeting.ts), the next section): a spellcaster is worth two
   and a half soldiers, a nuke goes on the one it can finish and a disable on the healthiest
   one; an area spell lands where the most *value* is, not where the most bodies are;
4. a **reaction delay** keeps a spell from landing before a human could have pressed it, a
   smaller role vocabulary keeps a novice from using half the card at all, and a worse **read**
   of the fight keeps it from aiming the half it does use.

Legality is still the sim's — `castUseError` / `castError`, the click-time gates — so Computer+
can never be more permissive than the button a player presses.

The Night Elf **Dryads and Druids of the Claw** build is the one that makes issue #124's named
ability reachable in a normal game: `[Abrf]` is gated on `Redc` at rank TWO, so a build has to
actually want Druids of the Claw for the AI to research far enough to have Bear Form at all.

**Bear Form was not implemented at all**, which is how issue #124's example turned into a sim
change: `[Abrf]` (and `[Arav]`, Raven Form) were missing from `KNOWN_ABILITIES`, so
`buildInitialAbilities` dropped the row, the button never appeared, and a Druid of the Claw could
not reach the body it exists to fight in. Both are the ordinary morph shape — `DataA1` names the
normal unit, `UnitID1` the alternate — so enabling them was two table rows and two handlers over
the `morphToggle` that already existed. See [`spell-fx.md`](spell-fx.md) for the presentation
side and `SimWorld.morphToggle` for the mechanism.

### A wave is aimed off its OWN columns — Impale is not Shock Wave's row shape

Reported: *"the Computer+ AI usage of Cryptlord doesn't really like to use the Impale ability"*.
It was arithmetic, not policy, and it lived in the one helper both casters share
(`waveDistance` / `waveHalfWidth`, [`src/ai/casting.ts`](../src/ai/casting.ts)).

`Units\AbilityMetaData.slk` declares **three** wave groups, and they do not number their `Data`
columns alike (see `NO_AOE_CURSOR` in [`data/abilities.ts`](../src/data/abilities.ts)):

| group | members | distance | width | damage |
| --- | --- | --- | --- | --- |
| `Osh1..4` | `AOsh`, `ACsh`, `ACst` | `DataC` 800 | `Area1` 125 = **half**-width | `DataA` |
| `Ucs1..4` | `AUcs`, `ANbf`, `ACbc`, `ACbf`, `ACca`, `ACcv` | `DataC` 800 | `Area1` 100 = half-width | `DataA` |
| `Uim1..4` | `AUim`, `ACmp` | **`DataA`** 600 | `Area1` 250 = the **whole** width | **`DataC`** |

Read down the Shock Wave column, Impale's reach comes back as **75** — which is its *damage* —
so no enemy was ever inside it, no direction was ever a candidate, and the Crypt Lord never
pressed the button at all. In *both* casters, because both take the reach from the same helper.
`sim/spells.ts`' own `AUim` handler reads `d(lvl, 0, 600)` and `(lvl.area || 250) / 2`, and these
two now mirror it exactly: the corridor a caster scores is the corridor the wave sweeps.

The other half of the developer's fix — *treat Impale like Shock Wave* — is its **role**. It was
graded `disable` beside War Stomp and Thunder Clap; it is now a `nuke` beside Shock Wave and
Carrion Swarm, which is what its own tooltip leads with (*"dealing `<AUim,DataC1>` damage and
hurling enemy ground units into the air in their wake"* — the air time is one second and rides
the damage). That also puts it back on the novice's card: `rolesFor` gives Easy `heal`, `nuke`,
`summon` and `morph` only, so an easy Crypt Lord had no offensive button at all while an easy
Tauren Chieftain Shock Waved.

### Mana Burn is aimed at a BAR, not at a body

Reported: *"the Computer+ AI is not utilizing the Demon Hunter's Mana Burn at all"*. Two causes,
and the first is Impale's exactly.

**It was in a vocabulary almost nobody has.** `AEmb` was graded `debuff`, and `rolesFor` gives
`debuff` to **Insane alone** — an easy or a normal Demon Hunter could not press it in its life.
That is not a marginal button either: `AEmb` is the *fixed* half of both night elf skill builds
(the table above), so every Demon Hunter this AI fields learns it at hero level 1 and has rank 3
by level 5. It is now a `nuke`, which is what its handler and its tooltip both say it is —
`sim/spells.ts` burns up to `DataA` and then deals `spellDamage` for exactly what it took, and
`NightElfAbilityStrings [AEmb]` leads with *"Burns mana … Deals damage equal to the amount of mana
burned"*. `Units\AbilityData.slk`: `Rng1` 300, `Cost1` 60, `Cool1` 7/6/5, `DataA1` 50/100/150.

**And a nuke's aim is the wrong aim for it.** A nuke goes on the body it can finish; a Mana Burn
is worth exactly what it TAKES — `min(DataA, mana)` — so the target is whoever has been *saving*
their bar, whatever their hit points say. `manaBurnValue` is therefore its own ladder, two terms
wide:

| | |
| --- | --- |
| **who holds the mana** | a hero `MANA_BURN_HERO` = 4× anybody else; a summon 0.5× (it is leaving on its own clock) |
| **how much of the press lands** | the share of this rank's own burn the pool can actually pay |

which is the developer's own rule — *primarily enemy heroes, enemy casters when there is no
hero* — falling out of one number rather than out of a list. A hero's bar is the Storm Bolt, the
Frost Nova and the ultimate the fight turns on, and it is the only bar on the field that does not
walk away and come back full: a hero keeps what it is left with. At 4× a hero stops outbidding a
full Sorceress only once it is under a quarter of what the rank can take — which is the button
working rather than an exception to it, because there is nothing left on it to burn.

The hero premium is deliberately **not** scaled by `heroFocus`, which every other hero preference
in this AI is (`bodyValue`). That dial is the ANTI-CHASE rule — how far the army may be pulled
onto a hero it cannot finish — and this is not a chase: Mana Burn is a 300-range press at whoever
is *already* in front of the Demon Hunter. What a difficulty still changes here is how late the
press comes (`castDelay`) and how often it lands on the wrong body (`castMistake`).

**The floor under it is the target's own cheapest button.** The sim already refuses any target
with no mana POOL (`MANA_TARGET_SPELLS`, the game's own `Cantmanaburn` — a Demon Hunter may not
pick a Footman at all), but a pool with nothing *in* it is legal and useless, and 60 mana spent
taking 4 off a drained Sorceress is what makes an AI look like it is pressing buttons for the sake
of it. `manaBurnWorthIt` keeps burning while the target can still afford one of its OWN abilities
and stops when it cannot — read off `Cost1` on whatever the target is carrying, so it needs no
constant of ours, and it is exactly what the spell is *for*: a hero below its cheapest spell is
already out of the fight's magic. It is applied at legality rather than as a penalty on the score,
so the misclick cannot land there either.

### Skill builds: a hero's ten levels are ROLLED, not fixed

`PlusRaceTable.skills` carries a **list** of ten-level builds per hero and `pickHeroes` rolls one
per seat, off the AI's own random stream like the build order and the hero order. Before that it
was one build each, so every Computer+ Blademaster on every map spent its levels identically.

Each build takes the same shape, and it is the shape the hero-level rules force rather than a
style — **A B A B A · ultimate · B · C C C** — because a rank costs hero level 2n−1 (rank 2 at 3,
rank 3 at 5) and the ultimate unlocks at 6. So the first two entries name the pair the hero
actually plays with, and everything from index 7 is the skill it left behind.

Half the melee heroes have more than one real answer on the card, and they are the four with
alternatives:

| hero | the builds |
| --- | --- |
| Blademaster | Wind Walk + Critical Strike · Mirror Image + Critical Strike |
| Tauren Chieftain | Shock Wave + Endurance Aura · War Stomp + Endurance Aura |
| Demon Hunter | Mana Burn + Immolation · Mana Burn + Evasion |
| Mountain King | Storm Bolt + Thunder Clap · Storm Bolt + Bash · Thunder Clap + Bash |

The other eight carry a list of ONE rather than a second field, so there is a single shape to read
and nothing to keep in step. A Death Knight opening Death Coil and a Lich opening Frost Nova are
not a lack of variety — they are the answer.

### Immolation is the one button with an OFF

Every other ability a hero presses is spent once and then costs nothing. `AEim` is the exception,
and its own row says so: `Cost1` 25 to light it, then **`DataB` "Mana Drained per Second" = 7**
for as long as it burns, until `DataC`'s 10-mana buffer snuffs it out. A Demon Hunter that lit it
for a creep camp and never pressed it again reached the next fight with an empty bar — no Mana
Burn, no Metamorphosis. The Ubertip is written for exactly this, from both sides: *"Drains mana
until deactivated." / "Deactivate Immolation to stop draining mana."*

`douseImmolation` is a pass of its own rather than a rung on the ladder, because `tryCast` only
ever answers *what is the best thing to press at something* and this is the opposite: there is
nothing to aim at, which is precisely the condition. It puts the flames out once nothing hostile
has been in reach for `IMMOLATION_HOLD` (4 s, ours) — a dwell, or a hero chasing the last Ghoul
out of a camp douses the moment it steps outside `MIN_LOOK` and pays the 25 again a second later.
The two halves cannot fight: `wants` needs `engaged` to re-light a `buff`, and `buffFree` sees
`BEim` while it burns.

### Wind Walk is TWO buttons, and pressing it as one wastes it

`[AOwk]` is the exception to "a role per ability", and it earned the exception by being visibly
broken: *"the Blademaster hero is not using its Windwalk ability correctly — it seems to like to
use it and just stay in the fight invisible."* Its own `Data` columns say why (AbilityMetaData
names them Owk1/2/3, and [`spells.ts`](../src/sim/spells.ts) spends all three):

| | | |
| --- | --- | --- |
| DataA | Transition Time | 0.6 s — the beat before he fades |
| DataB | Movement Speed Increase (%) | 0.1 / 0.4 / 0.7 |
| DataC | Backstab Damage | 40 / 70 / 100 |

The backstab is **not a standing bonus**. It rides on the ONE blow that breaks the invisibility
(`SimWorld.breakInvisibility`), so the ability is an **opener** at least as much as it is an
escape — and grading it as nothing but a `panic` button is what produced the reported behaviour:
a hero pressing the top of its ladder the instant anything scratched it, and getting a 40-damage
swing out of a cooldown it should have opened a fight with. So `windWalkRole` decides which
button this is, every pass:

* an **EXIT** (`panic`, top of the ladder) when the hero is actually leaving — at `HERO_KILL_HP`
  (40 %), the same share of its life at which this AI's own targeting starts treating a hero as
  a kill, and **only with no Scroll of Town Portal to leave with**. The scroll is the better exit
  by every measure (instant, invulnerable for the whole channel, and it ends in the base), and it
  is the one the belt will press a beat later at that very threshold — so the spell is the escape
  for a hero that has not got one. `PlusItems.holdsEscape` is the question, asked through
  `CastCtx`, because an item ability is not in `SimUnit.abilities` at all.
* an **OPENER** (`buff`) otherwise. `buff` puts it **below the ultimate** on the ladder, which is
  where it belongs: a Blademaster with Bladestorm off cooldown presses Bladestorm.

**And both halves need an order after the press**, which is the part that was missing entirely.
`AOwk` is IMMEDIATE (`SimWorld.castImmediate`): it fires on the spot and *leaves the caster's
current order completely alone*. That is exactly right for the real client — the Blademaster
fades mid-stride, which is the escape micro the ability exists for — and it is precisely why a
cast on its own changes nothing about what the hero does next. A hero that was swinging keeps
swinging, and spends the invisibility breaking it on whatever was already in front of it.

* The opener therefore **aims the blow**: the hero is put onto the body worth the backstab, by
  `killValue` — the army's ladder rather than a spell's, because this is one swing and what it
  buys is a body closer to dead. The 0.6 s fade costs nothing, since a swing landed before the
  fade is simply not the one that breaks it. No target worth hitting, no cast.
* The exit therefore **walks**. The move goes out at cast time (an army pass one to three seconds
  later is far too late — the hero would have swung and revealed itself), and
  `ComputerPlusAi.escapePass` then holds it there through the army's own withdrawal channel,
  `pulls`: `commit` skips a withdrawn unit, `squadFood` does not count it, `pullPass` keeps it
  walking, and `armyAnchor` refuses to anchor the army on a captain that has withdrawn — so the
  army holds its ground instead of following its hero home. `WINDWALK_OUT` (18 s) sits inside the
  ability's own shortest `Dur1`, so the hero is still invisible when it arrives.

### Aiming: one ladder for the casters and the army, three ways of reading a fight

[`targeting.ts`](../src/ai/plus/targeting.ts) is the answer to "who do I hit", and **both**
callers use it — `plus/casting.ts` asks it which unit a button goes on and `plus/index.ts` asks
it which unit the squad kills first. They have to be the same ladder or the AI fights itself: a
Mountain King who stuns the Tauren while every Footman beside him swings at the Shaman is worse
than either decision taken alone.

`castDelay` already models how fast a player **reacts**. `castTargeting` models how well they
**read**, which is a different axis and the one that makes a difficulty feel like a person:

* **`naive`** (Easy) — the biggest body on the screen is the important one, and that is very
  nearly the whole rule: value is `maxHp / 500`, plus a flat premium for a hero being a hero
  (a novice notices the hero; what they cannot do is tell a killable one from a healthy one).
  So Storm Bolt goes on the Tauren, Death Coil on the Abomination, and the Shaman behind them
  keeps casting. It also does not hold an area spell
  for a clump (`quorum` 1), so its Blizzard lands on one Footman. One rule produces every
  mistake, rather than a list of hand-written mistakes.
* **`sound`** (Normal) — values what a unit **is**: a caster over a soldier, a summon over
  almost nothing, the wounded for a heal or a nuke, the healthiest for a disable.
* **`expert`** (Insane) — also prices what the **spell** is for. A nuke is scored on hit points
  *remaining* rather than on percent, because 40 % of a Tauren is more hit points than a whole
  Footman and "lowest bar" and "one I can actually kill" are different units. A disable is
  scored on the target's damage per second, off its own weapon roll. And a disable aimed at a
  hero is discounted by the game's own **`herodur1 / dur1`** — Storm Bolt is 5 s on a soldier
  and 1.5 s on a hero, Hex 15 s / 5 s, Sleep 20 s / 10 s — which is why a good player saves the
  Hex for the Shaman. (Those two are the only numbers in the file that come off the install;
  everything else is ours, like the rest of `PlusProfile`.)

On top of the read sits `castMistake`, plain sloppiness: a chance the cast lands on a random
*legal* target (or a random legal spot) instead of the best one. Drawn off the AI's own RNG
stream, so a match replays identically. Heals are exempt — a player who means to heal somebody
heals somebody.

### It does not chase heroes

The most-complained-about habit of Blizzard's own melee AI is that it drops everything to swing
at the enemy hero, follows it out of the fight, and loses the army to the units it walked past.
Computer+ answers that in two places, and neither is a difficulty setting:

1. **The hero premium is conditional.** A hero at full health is worth `HERO_HEALTHY` = 1.15 —
   barely more than a Footman. Only below `HERO_KILL_HP` (40 %) does it ramp, up to
   `HERO_KILLABLE` = 5, because a hero that can actually be *finished* is the best target on the
   field: a dead hero is off the map for a minute and a half. `PlusProfile.heroFocus` scales the
   part of that **above a soldier**, so 0 means "a hero is a unit" rather than "never hit a
   hero" — an AI that refuses to touch heroes is as broken as one that touches nothing else.
2. **The army will not walk after one.** `focusTarget` drops any hero it cannot finish that has
   pulled more than `HERO_CHASE` (700) from the squad's own centre — measured from where the
   *army* is standing, not from the wave's objective, because "has it pulled away from us" is a
   question about the army. A hero that is standing in the fight is still a target; one that is
   kiting is bait.

This is a Computer+ rule only. `src/ai/casting.ts` and `src/ai/index.ts` are a transcription of
Blizzard's AI, warts included (`docs/melee-ai.md`), and this is one of the warts — fixing it
there would be un-fixing the port.

### A nuke is never spent on a worker it cannot finish

Reported from a real game and stated in the developer's own words: *"the AI must not use nuke
spells like Death Coil and Frost Nova on worker units if it cannot instakill them with that
spell (as wasting two Frost Novas on a peon would be a huge waste of mana)."*

The arithmetic is one a player does without thinking, and the game's own numbers make it stark.
A Peasant has 220 hit points, an Acolyte 230, a Peon 250 and even a Wisp 120
(`UnitBalance.slk`); Death Coil's `DataA` is 200 at rank 1 and **Frost Nova's `DataB` — the share
the unit the missile hits takes — is 100 at every one of its three ranks** (the scaling 50/100/150
in `DataA` is the ring around it). So neither spell finishes a healthy worker of any race, at any
rank, and what a cast buys is a hurt peon that walks back to the mine while the caster stands
there with no mana and a cooldown.

`nukeWorthIt` ([`plus/casting.ts`](../src/ai/plus/casting.ts)) is the whole rule and it is
deliberately narrow:

* **Only workers.** It says nothing about a soldier, a caster or a hero — those are the ladder's
  business (`plus/targeting.ts`), which already prefers what a nuke can finish at `expert`.
* **Only single-target casts.** An area or line nuke is aimed at a *spot* and priced by the sum of
  what its circle catches (`pickSpot`), where a peon is one more body in the pile and no waste at
  all: a Blizzard dropped on six Peasants is the play, not the mistake.
* **At LEGALITY, not in the score.** It drops the target out of `pickTarget`'s legal pool, so the
  misclick (`castMistake`) cannot land there either — a "mistake" that spends the same mana on the
  same peon is not sloppiness, it is the bug wearing a different hat.
* **At every difficulty.** This is not a skill a player acquires; it is one nobody ever lacked.

`NUKE_BURST` prices the burst off **the same columns the sim's own handlers read**
(`src/sim/spells.ts`), and it has to: the question is *will the blow that is about to land finish
it*, so the two must agree about the size of that blow. Two entries look wrong and are not —
Frost Nova's is `DataB` (`DataA` is the ring), and Shadow Strike's is `DataE`, because its `DataA`
is a dot spread over fifteen seconds and cannot finish anything *now*. **Transmute** is the one
entry that is `Infinity`: it takes any non-hero body outright, so turning a Peasant into gold is
one of the few things a nuke aimed at a worker is unambiguously worth doing.

Anything not in that table scores 0 and is therefore never spent on a worker, which is the right
way round for a rule phrased as *unless it can finish it* — Soul Burn, Life Drain and Acid Bomb
are damage over time and remove nothing from the fight this second, and an ability a later patch
or a custom map adds is not something to guess about. Magic immunity and `magicReduction` are
netted off exactly as `SimWorld.spellDamage` nets them, so the rule cannot promise a kill the sim
will not deliver.

### A dispel is spent on what a dispel does

Reported: *"make Computer+ only use Purge against enemy Summoned units and enemy units that have
positive buffs/effects like Bloodlust, Inner Fire and Unholy Frenzy"*, then *"apply the same
dispel rules to Dispel Magic and Abolish Magic (dryads etc.)"*, *"…and to the Disenchant ability
(spirit walkers)"*, and *"mark friendly units under the effect of Entangling Roots as valid
dispel targets, so that they can save friendly units that are entangled"*. That is one rule, and
it now lives in one function.

A dispel is the only kind of spell in the game that does *nothing whatsoever* to a target with
nothing on it, which is why "is it legal" was never enough of a gate for one. Purge is graded
`disable` — its slow is real — and a disable's only gate is the target search, so it went out at
whatever stood nearest: 75 mana for a three-second slow. Dispel Magic's quorum was "three enemy
bodies", i.e. every fight. And a Dryad's Abolish Magic hunted the nearest enemy and fired at it
whether or not it carried anything.

`worthDispelling` lives in [`sim/spells.ts`](../src/sim/spells.ts) — the **sim** owns it, because
it is a fact about what these handlers do rather than an opinion of the AI's, and because the
Dryad's autocast is the sim's own decision (below). `DISPEL_CODES` is the family, and it is three
codes because the aliases collapse: `Aprg` (Purge — the Shaman's `AOpg`, the Spirit Walker's
`ACpu`, the purge orbs), `Adis` (Dispel Magic **and Disenchant**, whose `Adcn` row's *code* is
`Adis`, so it dispatches to the same handler and is covered by anything keyed on the code), and
`Aadm` (Abolish Magic).

Both halves are read off the handlers themselves, so the AI cannot promise something the cast
will not do:

* **A summon is destroyed or damaged.** The handlers' test is `summonLeft > 0`, so that is this
  one's test too — a permanent body is not a summon to a dispel however it was made.
* **An effect is stripped — and *whose* effect decides.** Nothing in `AbilityBuffData.slk` says
  which buffs are the good ones (its only flag is `isEffect`, and it is `0` for Bloodlust, Inner
  Fire, Unholy Frenzy, Slow and Cripple alike), so polarity is **not in the data to be read**.
  What *is* knowable is who put it there: a buff hung by the bearer's own side is one they
  wanted, one hung by the other side is one they did not. `team` is the same comparison the sim's
  own area effects make (`areaEffectAffects`).

**`ours` is what makes it one function rather than two.** A dispel cuts both ways and the
handlers say so — `Adis` clears every unit in its circle without asking allegiance — so the same
line that reads Bloodlust as a *buff* on their Grunt reads **Entangling Roots as a debuff on our
Huntress**: `AEer` hangs a `root` and a `dot` carrying the enemy Keeper's own `sourceId`. No
table of "bad buffs" is needed, and none exists. The one asymmetry: a summon is only ever a
reason to cast on *their* side. Ours is something a dispel would **kill**.

Two exclusions, both because the cast would achieve nothing: an `undispellable` buff (Doom —
`dispelUnit` keeps exactly those), and an **aura**, which is a buff with `timeLeft` Infinity and
is therefore back the tick after the dispel lands. A buff whose source is *gone* — a Bloodlust
from a dead Shaman — cannot be placed and does not count, which is the safe direction: the cost
of missing one is a dispel not cast.

Three places ask it:

1. **The single-target cast** (`pickTarget`, Purge). At LEGALITY rather than in the score, like
   `nukeWorthIt` and for the same reason: a `castMistake` that lands on a unit with nothing to
   strip is not a mistake, it is a dropped cast.
2. **The area cast** (`pickSpot`/`counts`, Dispel Magic and Disenchant). The pool is **both
   sides** — the circle is worth drawing over their Bloodlusted pack *and* over our own rooted
   Huntress — and the quorum drops to **one** body, which is the classic caster's own argument
   for its `count: 1` ([`src/ai/casting.ts`](../src/ai/casting.ts)): one summoned unit is already
   worth a Dispel. The quorum was standing in for "is anything here worth it"; the predicate
   answers that directly. A spot that would also catch one of **our** summons is vetoed outright
   — a dispel is blind, and the Water Elemental we paid for is worth more than a buff coming off
   a Grunt.
3. **The Dryad's autocast**, which is the sim's (`dispelAutocastTarget` in
   [`sim/world.ts`](../src/sim/world.ts)). `tickAutocast` decides friendly-versus-hostile off the
   ability's allegiance flags — right for every other autocast in the game, and unable to
   describe this one: `[Aadm] targs1` is `air,ground,ward,invu,vuln,tree`, no allegiance flag at
   all, because the ability genuinely goes both ways. Read as "not friendly" it made the Dryad a
   hunter: mana spent on nothing, and an entangled ally left standing in the roots beside her.
   The caster is deliberately *not* excluded — a Dryad rooted by an enemy Keeper freeing herself
   is the cast working as intended, and the flags permit it. This half is a **sim** change, so it
   is the player's Dryads too, which is the point: it is how the ability behaves.

The classic Blizzard-transcription caster keeps its own coarser reading (`dispellable`: a summon
or any timed buff, quoted from the observation thread) — it reproduces that AI, warts included.

### A fight has to be worth the mana

Reported: *"it feels like the AI is spending too much mana on small creep camps"* — a Death
Knight that Coils two Gnolls, a Far Seer whose Chain Lightning goes into a three-body green camp,
a Tauren Chieftain that War Stomps a pair of Murlocs. Every one of those casts is legal and none
of them is wrong on its own; the sum of them is a hero that arrives at the fight that decides the
game with an empty bar.

`worthTheMana` ([`plus/casting.ts`](../src/ai/plus/casting.ts)) is the answer and it has exactly
two moving parts:

* **It is rolled ONCE PER ENGAGEMENT, not per pass.** That is the whole difference between a
  chance and a delay. The caster walks its units two to three times a second; re-rolled there,
  any chance short of zero fires within a second or two and nothing has been lowered at all. The
  decision is taken when `fightSince` is first set and held for as long as that fight lasts
  (`offense`, cleared with `fightSince`).
* **It is priced by what the fight is AGAINST.** One hostile *player's* body in reach and the
  answer is always yes — a spell held back in a real fight is wasted far more expensively than
  one thrown at a Gnoll. Against creeps alone it is `CREEP_SPELL_SMALL` (0.25) for a small camp
  and `CREEP_SPELL_BIG` (0.7) from `CREEP_SPELL_BODIES` (4) up, which is about where an orange
  camp starts.

It gates the `nuke` and `disable` roles — the developer's own list ("death coil, frost nova,
impale, carrion swarm, war stomp, shockwave") is exactly those two — and nothing else. A heal, a
panic button, a morph and a summon are answers to something that has already happened and are
never held back.

**Death Coil needs the rule stated twice**, and that is the trap in it. `AUdc` is graded `heal`
on the ladder (see below), and a heal is never delayed — so the gate in `ready` cannot see it.
The same test is therefore applied inside `pickTarget` to the target's *nuke half*, which is why
the one nuke the developer named first would otherwise have been the one nuke the rule missed.

### Holy Light and Death Coil are two spells on one button

Both were half-broken, silently, for the same reason: `friendlySpell` reads the `targs1` flags,
and **neither row carries an allegiance flag at all**. `AHhb`'s is
`air,ground,organic,notself,invu,vuln,nonancient`. That is precisely why the engine hardcodes
their rule and ships each one its own error string (`Holybolttarget` / `Deathcoiltarget`, see
`POLARITY_SPELLS` in [`sim/spells.ts`](../src/sim/spells.ts)) — the data cannot say *"a friendly
living unit or an enemy Undead one"*.

So `friendlySpell` answered **false** for both, the target pool was the enemy list alone, and the
result was a Paladin who could only ever smite enemy Undead and a Death Knight who could only
ever burn enemy living. Neither ability had a healing half. That is most of a Paladin, and it is
the *whole* of the undead's only heal.

`pickTarget` now builds the pool from **both sides** for a polarity spell and decides which half
each candidate is the same way the sim does — `hostile`, which is what `SimWorld.wouldHeal` asks
once `polarityOk` has vouched for the race. Three things fall out of it:

* **Each half is scored on its own ladder.** A friendly candidate is priced as a `heal` and a
  hostile one as a `nuke`, and the healing half carries `POLARITY_HEAL_FIRST` (2×) so the two can
  be compared at all — putting a body back on its feet is worth more than hurting one, and
  without the thumb on the scale a Death Knight with a Ghoul at a fifth of its life still coils
  whatever is standing in front of it.
* **Death Coil's heal is held later than an ordinary one.** `COIL_HEAL_HP` is 0.3, the
  developer's own number, against `HURT`'s 0.75 for everything else: the coil's other half is the
  undead's opening nuke, so every one poured into a lightly scratched Ghoul is a burst that was
  going to finish something. Holy Light competes with nothing (its other half only ever reaches
  enemy Undead) and keeps the ordinary bar.
* **An illusion is never healed.** It deals no damage, arrives at full health and is meant to die
  ([`docs/illusions.md`](illusions.md)) — mana spent on one is mana spent on a picture.

### A friendly spell reaches an ALLY's units

`CasterView.allied` is the other half of the same fix. The caster's pools used to be *ours* and
*hostile*, so every friendly spell in the game — Holy Light, Heal, Rejuvenation, Bloodlust,
Healing Wave, Tranquility — was confined to this player's own units, and a Paladin stood beside a
dying allied Footman doing nothing. `castError` never minded: the polarity rule and `targs1`
alike ask about *allegiance*, not about ownership.

It is `coAllied` and a real seat, never merely "not hostile" — a Goblin Merchant and a critter are
neither ours nor an enemy's, and a Paladin has no business spending mana on either. The same
question the chat router asks ([`src/game/chat.ts`](../src/game/chat.ts)), so "my ally" means one
thing across the whole AI.

**Heroes have priority**, and that is a deliberate inversion of the ladder rather than a
by-product of it. `bodyValue` prices a *healthy enemy* hero at barely more than a soldier — the
anti-chase rule — and read as-is that says heal the Footman at 40 % before your own Archmage at
45 %, which is nobody's play at any level. `HEAL_HERO` (1.5×, in
[`plus/targeting.ts`](../src/ai/plus/targeting.ts)) is the correction, and it is a *preference*
rather than an override: the wound multiplier reaches 3× at a sliver of health, so a soldier
under about a fifth of its life still outbids a hero that is merely scratched. At 2× it would be
a rule, and no soldier could be healed while a hero anywhere in range was one point down. The
`naive` read is exempt — it aims by bulk, so a hero's own hit points already put it in front.

**The BELT is the same rule**, and it was missing the same half. `[AIrl] targs1` (the Healing
Salve) is `air,ground,friend,self,organic,vuln,invu`, the Scroll of Regeneration, the Scroll of
Healing, the Scroll of Protection and the Scroll of the Beast all say `friend` too, and the sim
answers `friend` with `hostile` rather than with `owner` — `targetAllowed` and `itemAreaTargets`
between them mean an **ally's units have always been inside the circle a scroll draws** and have
always been a legal press for the salve. `itemUseError` would have allowed it all along; the only
thing that left them out was [`plus/items.ts`](../src/ai/plus/items.ts)'s own candidate list. It
now keeps the two pools the caster keeps, for the same reason: `own` is who this player gives
*orders* to (whose belt may be pressed, who may walk to a shop), `friends` is who a press may
*land* on. The Wand of Illusion's `ground,air,friend,self` is read the same way — an ally's
Tauren is as good a thing to copy as our own, and the copy is ours however it was made.

### A row that names no side is not a row aimed at the ENEMY

Reported: *"the Computer+ AI seems to like to cast Unholy Frenzy on enemy units."* It did, and
the pool is why. `friendlySpell` reads `targs1`'s **allegiance flags**, which is the right
reading and the same one `SimWorld.tickAutocast` makes — but a beneficial row is not obliged to
carry one, and three in the melee game carry none at all:

| row | `targs1` | what it is |
|---|---|---|
| `Auhf` | `air,ground,organic` | Unholy Frenzy |
| `Aams` | `air,ground,vuln,invu` | Anti-magic Shell |
| `Ahwd` | `_` | Healing Ward |

The sim reads them exactly as the engine does — `targetAllowed` allows **any** allegiance for a
row that names none — so the click is legal on either side and nothing downstream objected. With
the flags silent, `pickTarget` fell through to the enemy pool and a Necromancer spent its mana
giving the other player's Grunts a 75 % attack-speed buff.

What settles it when the data does not is what the button is FOR — its `Role`. `friendlyAim` is
that rule, and it is deliberately narrow, because a wrong answer here aims a spell at the wrong
army: a **polarity** spell keeps its own two-halves branch; an `enemy` flag is the last word
(Lightning Shield says `friend,enemy` and is played at the enemy); a `dead` row is aimed at
corpses, which neither pool describes; and only a `unit` or `point` cast is aimed at anybody at
all — a bare self-cast (Berserk, Mirror Image) lands on the caster whatever is standing around,
and for those the pool is a reading of the FIGHT. Everything else keeps the flags' own answer, so
a custom map's flagless spell is still derived (`roleOf` reaches `nuke`/`disable` for one, never
`heal`/`buff`) and still aimed at the enemy exactly as before.

One thing is **not** inferred along with the polarity: whether the CASTER is a candidate. Every
row that is meant for the presser says `self` in its flags (Divine Shield, Berserk, Mana Shield)
and `friendlySpell` is true the moment it does — so a row that says neither `friend` nor `self`
has not said it is for the caster, and inferring that as well would have a Necromancer put Unholy
Frenzy's three-hit-points-a-second on its own 220-hp body.

The **Healing Ward** is the third row in that table and needed one thing more: `roleOf` would
grade it `summon` off its `UnitID1`, and a summon is aimed at the enemy — which is where the ward
was being planted. It is named `heal` in `ROLES` instead, because what it summons *is* a heal
(`[ohwd]` carries `Aoar`, the same regeneration aura the Fountain of Health has). And because
`[Ahwd] Cool1` is **zero**, the heal role also asks `summonStanding` first: nothing in the data
stops a Witch Doctor planting a second 200-mana ward inside the first one's reach every pass for
as long as somebody nearby is hurt.

### Items: buying them, and pressing them

Computer+ shops and drinks. It lives in [`plus/items.ts`](../src/ai/plus/items.ts), separately
from the caster, and the reason it has to is the first of the two gates this section used to warn
about: **item abilities are not in `SimUnit.abilities`**. They hang off the inventory slot and
dispatch through `useItem`, so the caster's ability walk cannot see one — it is a second walk, not
more rows in the caster's table.

#### The alias/code trap, which broke almost the whole belt

Reported from a real game: *"orc is not able to use healing salves (it buys them though)."* It was
not the salve. `USE_OF` maps an ability to what pressing it is FOR, and `useOf` looks a card up by
**`AbilityDef.code`** — the same thing `SimWorld.applyItemAbility` dispatches on — but the table
had been written with `AbilityData.slk`'s **`alias`** column. For most of the potions those are
different rows:

| the item's `abilList` says | its real `code` is |
|---|---|
| `AIh1` / `AIh2` / `AIh3` — Potion of Healing, Greater Healing, Essence of Aszune | `AIhe` |
| `AIm1` / `AIm2` — Potion of Mana, Greater Mana | `AIma` |
| `AIvl` — Potion of Lesser Invulnerability | `AIvu` |
| `AIdv` — Potion of Divinity | `AHds` (it *is* Divine Shield) |
| `AIrr` — Scroll of the Beast | `Aroa` (it *is* Roar) |
| `AIrl`, `AIsl`, `AIpr`, `AIpl`, `AIp1`–`AIp6` — Salve, both Clarity Potions, Scroll of Regeneration, the whole Replenishment family | `AIrg` |

So the table matched almost nothing: of the shopping list, only the Town Portal, the Scroll of
Healing and the Scroll of Restoration were ever pressable. A hero could carry a healing potion, a
mana potion, a salve and a clarity potion and use none of the four.

`AIrg` is the one that cannot be fixed by re-keying alone, because it is one code covering four
different items — and that is [`docs/items.md`](./items.md)'s own headline example. `regenUse`
splits them the way the sim already splits them when the button is pressed, off the row itself:
`Area1` > 0 is an area heal, `Rng1` > 0 is one you point at somebody, and neither means the
drinker — with `DataA`/`DataB` saying whether that drink is hit points or mana. The test stub in
`tools/ai-plus-items-test.cjs` had encoded the same mistake (`code` set to the alias), which is
why it passed the whole time; it now carries the real pairs.

#### A regeneration item is never spent inside a fight

The two rungs aimed at somebody ELSE — `healArea` and `healOther` — are the only two gated on
there being **no** fight at all, and the reason is in the item rather than in the tactics.
Reported from both races that open with one: *"the Orc AI must avoid using healing salve during
fights and fighting with creeps … same thing for human's Scroll of Regeneration"*.

`AIrg` hangs a HOT — 400 hit points over **forty-five seconds** — and **the sim cancels it the
moment its bearer is hit** (`ITEM_REGEN_GROUP`, [`items.md`](items.md)), which is the real game's
own rule. So a salve poured on a Grunt that is being swung at is not a heal racing the damage, it
is a hundred gold and a charge thrown away on the next blow. The moment they are worth is the
moment the camp is dead and the party is about to walk to the next one, which is the job the
shopping list says it bought them for.

This paragraph used to state that intention and no gate implemented it. It is now two tests, and
it needs both:

* **the PRESSER is not engaged** — nothing hostile within `LOOK` (900), creeps included, which is
  the same reading everything else here calls "this fight";
* **and neither is the BODY the charge is poured into** (`underFire`, asked inside `hurtest` and
  `armyHeal`). The presser can be nine hundred units from the fight its own army is standing in,
  and a Scroll of Regeneration is an AREA — the units it covers are not the unit pressing it.

The same reasoning sets **how hurt is hurt enough**: `ALLY_HP`, the bar a Healing Salve is poured
at, is **65 %** — one bar *above* `HURT_HP` (55 %, where a hero drinks its own potion) rather than
below it, and level with `ARMY_HURT`. A potion is an emergency and heals at once; a salve pours
over forty-five seconds between fights, so waiting for half health on a three-charge, hundred-gold
item leaves most of an army walking to the next camp hurt with the charges still in the belt.

#### It sells the duplicate

Reported: *"heroes that carry multiple Cloak of Shadows must try to sell them at shops (or goblin
merchant/marketplace) and keep only 1"*. It is the natural consequence of a hero that picks up
everything it walks over (`loot`) on a map whose creep camps drop from the same tables — two
cloaks, two Rings of Protection +1, two Talismans — and a six-slot belt with two slots spent on
nothing.

**Which duplicates is not a list of items**, it is the question *does the game add the second one
to the first*, and the game answers that in exactly one place: the `switch` in
`SimWorld.itemBonuses`, plus the orb rule beside it (an orb's flat damage bonus is *"a carried
stat, it stacks"* — [`orbs.md`](orbs.md)). `STACKS` in [`plus/items.ts`](../src/ai/plus/items.ts)
mirrors those codes and says so; anything else an item grants is an **ability** or an **aura**, and
a second copy of an ability the hero already has does nothing at all. A hero carrying two Cloaks
of Shadows melds exactly as well as one carrying one. Note the two damage-reduction items are
deliberately absent from `STACKS`: the sim takes `Math.max` of them, so a second Runed Bracers is
worth nothing either.

Being wrong the "it stacks" way costs a slot; being wrong the other way **throws an item away**.
So `sparePermanent` refuses three whole classes before it even asks about duplication — anything
`usable`, `charges > 0` or `perishable` (two Potions of Healing are two heals whatever their
ability does), anything `powerup` (never in a belt at all), and anything the shops will not take
back (`pawnable`). It sells the **later** slot, so the hero keeps the copy an aura or ability is
already being granted from and nothing blinks off.

The sale is the sim's own gesture end to end. `issueSellItem` walks the hero to the shop's near
edge and pawns on arrival, and it sets the hero's order to `"getitem"` — which is precisely the
order the army manager already leaves alone (`massing`, `commit`), so the trip needs no errand
flag of its own. `canPawnAt` is what makes a **Marketplace** or a **Goblin Merchant** a valid
destination and a Tavern not one: it asks for the `Apit` ability rather than for a ware list,
which is the whole reason a Marketplace with empty shelves still buys. Gated on `mayShop` like the
shopping trip and for the same reason — it is a walk, and a walk is not something to start while
there is a wave in the field.

#### …and the junk

`STACKS` answers *is a **second** one worth a slot*. `JUNK` beside it answers the blunter question
*is the **first** one*, and it is a short argued list rather than a rule, checked before the
duplicate test because a junk item is a dead slot at any count.

One item is on it. The **Wand of Lightning Shield** (`wlsd`) is not stocked anywhere — no
`Makeitems` or `Sellitems` row in the install names it — so it reaches a Computer+ hero exactly
one way, as a level-2 creep drop that `loot` walked over. Its ability `AIls` is Lightning Shield
(`Alsh`) with the item's numbers on it: an offensive buff cast on an **enemy**, worth what the
body it lands on is packed around, which is a targeting question the item ladder does not ask.
There is no `AIls` card in `USE_OF`, so `press` never reaches for the wand and it rides the belt
for the rest of the match holding a slot a Potion of Healing wants. Pawned it is 75 gold
(`PawnItemRate` 0.5 of 150) towards the next row of `LIST`.

The general rule — *pawn anything whose ability is not on the ladder* — is deliberately NOT what
is implemented: it would pawn the next item somebody writes a handler for, in the window before
they add its card.

#### The rest of it

Everything goes through the doors a player's click goes through, and there is no item path here a
human does not have:

| What | The door |
| --- | --- |
| buy | `Command` `{ c: "buyitem", shopId, itemId }` → `SimWorld.purchaseItem` |
| use | `Command` `{ c: "useitem", unitId, slot, targetId, x, y }` → `SimWorld.useItem` |
| may it | `SimWorld.itemReadyError` / `itemUseError` — the click-time gates, exactly as `castUseError` / `castError` are for a spell |
| what is in stock | `TechRegistry`'s `makeitems` / `sellitems`, plus `SimWorld.shopStock` and the shop's own `building.stock` (a Marketplace's shelf is the map's, not the game's) |
| may this hero take delivery | `SimWorld.shopReaches` — the same test `purchaseItem` applies, exposed so a caller can walk somebody into range first |

**What it presses** is a `Use` ladder in the shape of the caster's `Role` one — *escape, panic,
healSelf, healArea, healOther, mana, illusion, buff* — and it is keyed on the item's **ability code**, never
on the item id, because an item's behaviour is not in the item ([`items.md`](./items.md)). One
entry therefore covers a Potion of Healing bought at a Vault and the same potion picked up off a
dead ogre. Anything unlisted is carried and never pressed, which is the safe direction to be wrong
in.

**Aiming is not a table.** It is the item's own ability `target`, read exactly as
`RtsController.useInventorySlot` reads it to decide whether your click needs a second one: a
Healing Salve wants a unit, a Town Portal wants a point, and every potion in the game fires on the
press with its row's `Area1` deciding who it reaches. That is the same three-way split the items
doc opens with.

**The Town Portal is the retreat, in one press**, and it saves two different things. It fires
either on the army manager's own `losing` read — `mode === "retreating"`, so the scroll and the
walk home are one decision instead of two that disagree — or on the **hero's own skin**, when it
is about to die in a fight the army has not given up on. That second case is the same conclusion
reached about a smaller group, and it is why a Computer+ hero does not die to a gank it could
have walked out of. Never from the doorstep of its own base, where it would be spent to travel no
distance.

It leaves at `ESCAPE_HP` (40 %) **against a player** — against creeps it leaves at
`LAST_RESORT_HP` (8 %) and not a point above it, for which see *the fight that is lost* above —
and 40 % rather than the panic line, for a reason that is easy to get backwards: once the scroll is *pressed* the hero is invulnerable for the whole five seconds and
**cannot die mid-channel**. The only window in which a hero holding one can be killed is the
window *before* it presses, and the width of that window is the AI's own reaction — the belt is
walked once per `castPeriod`, a whole second on Normal. A hero at 30 % with an army on it does not
reliably survive a second, so a threshold set at the panic line is one that is sometimes read for
the first time after the hero is already dead. 40 % is `HERO_KILL_HP`: the point the AI's own
targeting would start treating this hero as a kill.

It is aimed at **the hero itself**, which is the **double-click** — `itemTownPortal` resolves to
the hall nearest the clicked point, so clicking the hero is "the user's own nearest hall"
([`items.md`](./items.md) § the one item that is not instant). Aiming at the main base instead is
the one-click form and is worse for an escape in the case that matters: a hero fleeing beside its
own expansion would run *past* the hall that could save it. The five-second channel is the sim's,
and the hero is invulnerable for all of it — the units standing around it are not.

**Normal and Insane both keep one and replace it**, at their **own** shop by preference and at a
Goblin Merchant only as a fallback: a race shop is in the base (so the errand is seconds rather
than a trek) and its shelf cannot be emptied by the other player. `keepPortal` is what makes the
replacement prompt — it puts the scroll at the top of the shopping list, so the next trip after
one is spent buys another before it buys anything else.

#### The replacement outranks the OPENING buy, and the belt ceiling does not apply to it

Reported: *"heroes don't seem to ever re-buy a scroll of town portal. this should be their number
one priority after they use their scroll of town portal!"* Two separate rules were stopping it and
neither was `keepPortal`:

* **`RACE_FIRST` led the list, and its rows re-satisfy themselves.** A Healing Salve is 100 gold
  against the scroll's 350 and it is drunk every fight, so the orc's two salve rows came back
  round faster than the portal row was ever reached. `PlusItems.hadPortal` is the latch that
  splits the two halves of the match: the **opening** is the race's (`RACE_FIRST` first, and the
  section above is why), a **replacement** is the first thing on the list. It is set the first
  time a pass sees a scroll in any of this player's belts and never cleared — spending one does
  not stop being a player who carries one, which is `keepPortal`'s own wording.
* **`PlusProfile.shopping` is a HABIT, and it counted the replacement.** It is how much of a belt
  this player bothers to fill, and it is counted against *everything the hero is holding, drops
  included* — three slots on Normal is two potions and one thing picked up off a creep, at which
  point `shopper` returned nobody at all and the AI stopped shopping for the rest of the match
  with the gold still in the bank. So `shop` now asks **what** to buy before **who** fetches it,
  and a Town Portal is exempt from the ceiling: a free *slot* is the only thing that may stop it.
  Nothing else is exempt — the control is pinned in `tools/ai-plus-items-test.cjs`.

Neither of those changes the opening: `pick` does not *save*, it skips a row it cannot afford and
buys the next one down, so at two minutes there is no 350 gold above the reserve and the salve is
what gets bought — which is exactly what the tests for the orc's and the human's first buys pin.

**The shopping list** is [`items.ts`](../src/ai/plus/items.ts)'s `LIST`, and it belongs beside the
strategy rather than in the difficulty for the same reason the expansion clock does: *what* to buy
is what a melee player buys, not how good they are. Every id on it was read off a real shop row —
`[ngme] Sellitems` for the Goblin Merchant, `Makeitems` for the four race shops — and all four
race shops sell `phea`/`pman`/`stwp`, which is why those anchor it. (Watch the near-homographs:
`pinv` is Potion of *Invisibility*, `pnvu` Potion of Invulnerability, and `pnvl` the *Lesser* one
that is what the Merchant actually stocks.)

**A race opens with its own buy** (`RACE_FIRST`), in front of everything on that list — the Town
Portal included. This is arithmetic before it is preference: `pick` walks the list in order and
stops at the first row it can afford, and `shopping` is only **three slots** on Normal, so
anything below the first two or three rows is decoration that is never reached. Two races have
one, and they are the same idea in two vocabularies — *the item that puts the army back together
between creep camps*:

- the **orc's two Healing Salves**. `[ovln]` (the Voodoo Lounge) is the one race shop that stocks
  `hslv`; it is 100 gold for three charges, the best hit points per gold in the game; and — the
  part that makes it a *first* buy rather than a cheap potion — its row is a `healOther`
  (`Rng1` 500, no `Area1`), so it goes on whichever soldier came out worst. Two, because the
  first camp spends one.
- the **human's two Scrolls of Regeneration**. `[hvlt] Makeitems` *opens* with `sreg`; it is the
  same 100 gold; and `[AIsl]` is the AREA version of the same effect — `Area1` 600, 225 hit
  points over 45 seconds into everything standing in the circle. So the human's captain heals the
  whole party at once, which is why the `healArea` rung asks a different question of it (below).
- the **undead's Rod of Necromancy**. `[utom] Makeitems` *opens* with `rnec` exactly as the
  Vault's opens with `sreg`; it is 150 gold for **four** charges; and what each charge buys is not
  hit points at all but two more bodies — see *The Rod of Necromancy* below. Its shelf starts
  **empty** (`stockStart` 0 against a `stockRegen` of 60), so the AI waits for the first one the
  way a player does: `pick` asks `shopStock` and moves on down the list until it is there.

The night elf opens on the potions `LIST` already starts with, so it gets no invented habit.

**An opening buy is not discretionary spending** (`Want.opening`). Everything else on the list is
bought out of the surplus above `itemReserve`; these are bought out of the purse. That is what the
reserve is for, read honestly: 300 gold of headroom on a Normal computer means it never shops at
all — measured on Echo Isles, a Normal orc's gold sat between **2 and 162 for a whole match**
while it paid for peons and Grunts, so `gold − 300` was never once positive at the moment the
five-second shopping pass looked. A hundred-gold salve it can never reach is a 130-gold Voodoo
Lounge built for nothing; a player buys the salves out of the same pocket the build order comes
from, because at that price they are part of the build order.

A purchase needs the buyer **standing at the shop**, and the sim adopts whoever is in range as the
patron by itself (`tickShopBuyers`) — so the whole of "select this hero as the buyer" is walking it
there, exactly as it is for a player. That walk only ever starts while the army is massing, so the
errand never pulls the captain out of a fight.

**The difficulty grades it** the way it grades everything else, and those numbers are **ours**:
`shopping` is how many belt slots it fills (Easy 0 — a novice knows the shop is there and forgets
about it), `itemReserve` is gold it will not part with, and `keepPortal` is whether it plans around
having a scroll (Insane only, which puts the Town Portal at the top of its list rather than the
bottom).

`itemReserve` is also the answer to the second gate this section used to warn about — item gold is
gold `OneBuildLoop` was going to spend. A floor is the only way a separate pass can honestly give
the build ladder first call: the shop sees the surplus and nothing else. It is not a rung in the
ladder and does not pretend to be one. The one exception is the race's opening buy, above, and it
is an exception for a stated reason rather than a leak.

#### …and when the gold is just SITTING there (`RICH`, `SURPLUS`)

The reserve answers *may I spend at all*, which has to be a low bar or a Normal computer never
shops. It says nothing about the other state a computer spends half a long game in: production
capped at `armyFood`, tech finished, and a thousand gold in the bank. That was the state in which
the Goblin Merchant went unvisited for a whole match — a hero carrying one Potion of Healing,
because `shopping` said three belt slots and the general list had already used them on drops.

So `SURPLUS` (500 above the reserve — more than the dearest row, the 350-gold scroll) turns on two
things and nothing else:

- the **`RICH` rows**, which are the same items wanted deeper (a second Scroll of Healing, a third
  Potion of Healing) appended *after* the whole core list, so reaching them means everything above
  is already satisfied;
- **the belt ceiling comes off**. `shopping` is a habit — how much of a belt this player bothers
  to fill — and it is counted against everything the hero holds, drops included, so a Normal
  computer that walked over two tomes and a Claws of Attack stopped shopping for the rest of the
  match with the gold still in the bank. Rich, it fills the six slots it has.

**A race's surplus habit leads those rows** (`RACE_SURPLUS`), and there is one: the **undead's
Potions of Mana**, three of them. It is the one race whose army *is* mana — a Necromancer pays per
Raise Dead, a Banshee per Curse, an Obsidian Statue's Spirit Touch is a mana bar spent on other
mana bars, and Death Coil is the race's heal — and `[utom] Makeitems` stocks `pman`, so that is
what a banked undead computer's gold turns into.

**Boots of Speed** (`bspd`, the Merchant's, 250) is on the core list rather than the rich one, and
it is the only PERMANENT item either list carries. It is never pressed — `[bspd]` is not `usable`,
so `useOf` answers null — and it does not need to be: a Computer+ hero creeps, walks between camps
and runs home from lost fights, and all three are faster for the rest of the match. It sits below
the consumables, because a potion wins the fight in front of you and boots win the next one.

#### When an area heal is spent: is the army hurt, and is the army HERE?

`armyHeal` is the `healArea` rung, and it asks three questions rather than counting hurt bodies
the way it used to:

1. **Is it reaching a group?** `CLUSTER` (3) inside the circle, or the scroll is doing a potion's
   job and the potion is one rung down.
2. **Is more than HALF the army in the circle?** This is what makes it an army item rather than a
   bigger potion — a 100-gold scroll poured over the two units that arrived first is 100 gold
   spent on two units. Measured against the whole army, not against whoever happens to be beside
   the hero. Nothing here *walks* the hero anywhere: the Computer+ army moves as one body anchored
   on its captain, so "wait until the party is around you" is a condition the army manager
   satisfies by itself a few seconds later.
3. **Is the army hurt?** **Pooled** — one fraction over the hit points and maxima of everybody the
   circle covers, the hero's own included, which is a different question from counting heads.
   Five soldiers at 90 % are not an army that needs a scroll; three at 15 % beside three whole
   ones are. `ARMY_HURT` is two thirds, and it is ours.

The circle is the **item's own** `Area1` (`areaOf`), never a constant of this file's: a rule
written against `LOOK` (900, "this fight") would promise to heal units standing 300 units outside
the 600 the Scroll of Regeneration actually draws.

**The two pools in question 2 and 3 are not the same pool**, and the asymmetry is the point. What
the circle *covers* is every friendly body inside it, an **ally's included** (see below); the
*party* it is measured against is ours alone, because that is the body the hero travels with, and
an ally's army standing across the map is not a reason this hero's scroll is being wasted. Put
them in the denominator and a computer with a busy ally could never reach the half.

Still not touched: **Kelen's Dagger of Escape** (`AIbk`), a point-target blink that needs a
decision about *where* the aiming above does not make — it is a drop, never shop stock, so it
waits. And there is one button on a BUILDING which is very human: **Call to Arms**. `Amic` is the
Human town bell, and it is already rung by [`plus/casting.ts`](../src/ai/plus/casting.ts)
`townBell` — the answer to "something is in my base and my army is somewhere else", and never on
Easy.

#### The Rod of Necromancy: two more bodies out of something already dead

Reported: the Computer+ undead should *"buy and also use Rod of Necromancy on corpses to get
skeletons that can help it creep and fight better, especially at the start of the game"*.

**It is not item behaviour at all — it is Raise Dead.** `[AIrd]` keeps its own `code` (the trap
[`sim/corpses.ts`](../src/sim/corpses.ts) warns about: `ACrd` collapses onto `Arai` and `AIrd`
does *not*) but it carries the whole `Rai1..Rai4` field group, so `SimWorld.useItem` runs the
spell's own handler with the item's numbers: **two Skeleton Warriors** (`DataA` 2, `DataC` `uske`)
out of **one** body within `Rng1` = 600, for `Dur1` = **65 seconds** rather than the Necromancer's
45. Four charges (`[rnec] uses`), a 22-second `Cool1`, 150 gold.

**The corpse question is the sim's, at both doors.** `itemUseError` asks `corpseRefusal` — the
same query at the same radius the handler will take its body from — so a rod waved over bare
ground is refused before the press and keeps its charge. Nothing in [`plus/items.ts`](../src/ai/plus/items.ts)
restates it; the `raise` rung only answers *when a hero reaches for it*:

- **While the camp is still standing.** The corpses a rod spends are made by the fight it is spent
  in — a camp with two of its five down is two skeletons' worth of bodies on the floor and three
  creeps left to swing at. Waiting for the fight to end would be waiting until the thing the
  skeletons were for has finished.
- **On the walk between camps**, with the last camp's dead underfoot and the next one already in
  sight (`LOOK * 2`, the same "a fight is about to start" reading the `mana` rung uses).

One real fighting body is enough, where the wand asks for `CLUSTER`: a charge costs no food, no
mana and nothing the next fight wants back, so there is no trade to weigh — only the four charges,
which the row's own cooldown already rations. A lone worker scouting past is still not a fight.

On the ladder it sits **above the Wand of Illusion** — these bodies actually swing, where an
illusion deals no damage — and **below `mana`**: a hero with an empty bar has lost the spells the
fight is being won with, which is worth more than two skeletons.

#### The Wand of Illusion: the doubles go in FIRST

A **Wand of Illusion** (`will`, `[AIil]`, three charges) makes a body that walks, is swung at and
**deals no damage at all** — `DataA "Damage Dealt (%)"` is empty, which is the 0 that makes it
harmless, and `DataB` is the 2 that makes it take double ([`illusions.md`](./illusions.md)). So
the whole of what a charge buys is *blows that land on a copy instead of on the party*, and that
makes it two presses rather than one:

- **In a fight** — the ladder's own `illusion` rung, gated exactly as `buff` is (a real fight,
  `CLUSTER` bodies that can hit back; one scout walking past is not one).
- **Before an ORANGE or RED creep camp** — `PlusItems.makeIllusions`, called by the army manager
  ([`plus/index.ts`](../src/ai/plus/index.ts) `vanguardPass`) rather than reached from the ladder,
  because by the time the belt can see a fight the creeps have already picked their targets and
  the hero is one of them. A green camp gets none: it is priced at a hero and a soldier or two
  ([`power.ts`](../src/ai/plus/power.ts)) and the wand has three charges for the whole match.

**Who it copies** is the biggest body in reach (`toCopy`), not always the hero: the copy arrives at
**full** hit points however hurt the original is (`initIllusion`), so the only thing worth reading
is `maxHp`. A Tauren's double outlasts a Tauren Chieftain's. Its own copies are excluded — a copy
of a copy is the same body at a further remove — and so is anything outside the wand's `Rng1` of
500, which `itemUseError` would refuse anyway.

**How many**: `ILLUSION_CAP` is 2, and it is stated in *doubles alive* rather than in presses, so
it self-limits without a clock — the third charge is only ever spent once one of them has popped,
which is the fight that is still going. Nothing in the data would stop a hero emptying the wand in
one second: `[AIil] Cool1` is **0**.

**The vanguard**, in order:

1. The party is walking at an orange or red camp and the captain comes within `VANGUARD_RANGE`
   (1200 — outside the camp's own `AcquisitionRange` of 500, with room to get in front). The wand
   is pressed here rather than at the muster point because a double lasts **sixty seconds**
   (`Dur1`) and one conjured at home spends most of that walking.
2. The body is **stopped where it stands**. Merely leaving it out of the commit is not enough — it
   would walk on under the attack-move it is already carrying, which is the party arriving *with*
   the copies instead of behind them. Anything already swinging is left alone.
3. `commit` walks only the copies, straight at the camp and **exempt from cohesion** (`strayed`
   returns false for an illusion) — being out in front of the anchor is the entire job.
4. `VANGUARD_LEAD` (3 s) later the body follows and the fight is joined normally.

The lead is measured from the moment the copies **set off**, not from the press. They do not exist
yet when the wand is pressed — spawning is asynchronous, the request is drained by the renderer —
so the pass that throws them cannot also order them, and a lead counted from the press would be a
different lead per difficulty (three seconds of `armyPeriod` on Easy, half of one on Insane) and on
the slow one would be spent before the copies had taken a step. The hold is therefore armed for
the lead **plus** `VANGUARD_SPAWN_GRACE`, and set-off brings the deadline **in** — `min`, never
`max`, so a copy that reaches the camp, idles and is re-ordered cannot push the deadline out in
front of itself and stand the whole army still for the rest of the match. One attempt per run, marked done
whether or not anything was pressed, so a hero with no wand is not re-asked every pass and one with
a wand does not dribble a fresh double into the walk every few seconds.

#### An illusion is a PICTURE of the army, not part of it

The copies join the squad — they have to, or nothing gives them orders — and belong in **none** of
the arithmetic the squad is judged by (`isCopy`, [`plus/index.ts`](../src/ai/plus/index.ts)). Each
of these was wrong in a way that matters, and all of them were already reachable through the
Blademaster's Mirror Image:

| reading | what counting a copy does |
| --- | --- |
| power (`creepForce`, `oppositionHealthy`) | prices `dps × hp` on a unit whose damage is zero — the party walks into a camp on strength it has not got, which is the exact failure [`power.ts`](../src/ai/plus/power.ts) exists to prevent |
| health (`creepForce`, `readiness`) | copies arrive at full hit points and are **meant** to die, so the vanguard popping reads as the army breaking and `fightLost` marches it home from a camp it has not started fighting |
| food (`squadFood`, `gathered`, `armyFood`) | a double occupies no food and lasts a minute — a wave believes it is big enough on bodies that are about to vanish, and the production ceiling stops training the real ones |
| the line (`squadCentre`, `pullPass`) | the copies are deliberately in front, so they must not drag the anchor forward; and one on its last quarter is doing exactly what it is for and must not be walked out of the fight |

One sim fix came with this. `[AIil]` filed its double under **the presser** rather than under what
it copied (`SimUnit.illusionOf`, whose whole job is the link back to the original — the two
coincide for Mirror Image and only for it). `levelUp` walks that link to level a hero's images with
him, so a double of a Grunt made with the hero's wand would have dinged, flashed and stood there as
a level-6 Grunt.

### The wounded walk out of the fight, and go back in

The one piece of micro a player picks up long before they learn to focus a target, and the one
this AI had no notion of at all: a Grunt on its last quarter is **one blow** from being 200 gold
and 2 food spent on nothing, and it is standing in the line taking that blow. `pullPass`
([`plus/index.ts`](../src/ai/plus/index.ts)) walks it out, holds it there, and lets it back in.

It is **not** `retreatHp`, and the difference is the whole point. `retreatHp` is the *army* giving
up on a fight; this is one soldier stepping back out of range while the fight goes on winning
without it. The two are independent and both run.

| | what it is | why that number |
| --- | --- | --- |
| `PlusProfile.pullOutHp` | 0.25, and **0 on Easy** | the developer's bar. Easy gives an order and watches it happen |
| `PULL_BACK_DIST` | 900 | the developer's "around 800-1000". A ranged soldier acquires at 500 and a caster casts at 700–800, so it is out of everything that was about to land |
| `PULL_BACK_HOLD` | 10 s | how long it stays out |
| `PULL_BACK_AGAIN` | 45 s | **the see-saw guard** — from when the pull *started*, so the cooldown is the whole cycle |

Three gates, and each one answers a different way of getting this wrong:

* **The difficulty does this at all.** `pullOutHp` 0 on Easy, and the map is cleared as well as
  read, so a rung that does not micro never leaves a soldier standing out of play.
* **It has to be IN a fight.** A hurt unit walking home across an empty map is not micro, it is
  desertion — without this every soldier that ever dropped below the bar would spend the rest of
  the match at the back. The radius is `COHESION_COMBAT` (500), which is the same radius the
  cohesion rule means "this unit is in the battle" by; the two say opposite things about the same
  unit on purpose (*do not drag a fighting unit back into formation* / *drag exactly those out*)
  and they must not disagree about which units they are talking about.
* **It must not see-saw.** `PULL_BACK_AGAIN` is the developer's "some sort of internal unit
  timer". A unit released at a hair under the bar wants pulling again on the very next pass, and a
  rule with no memory is a soldier that walks in and out of the line for the rest of the battle
  instead of fighting in it. `pullDue` is pure and both directions are pinned by
  `tools/ai-plus-army-test.cjs` — the FALSE one matters most, as it always does here.

**Where it goes is measured from the ARMY, not from the unit's feet** (`pullBackSpot`, also pure
and pinned). That is what makes it *behind the owner's army* rather than merely *away from the
enemy*: a soldier that had run out in front walks all the way back past the line, and one already
at the back does not walk another nine hundred units for nothing.

Two consequences that are not obvious from the rule and each of which is a bug if missed:

* **A withdrawn captain is not an anchor.** `commit` holds the army together on its hero
  (`armyAnchor`), so a hero pulled out of the fight would drag the whole army back after it —
  turning one hurt hero into a general retreat nobody ordered. A withdrawn hero falls through to
  the centre of mass, and the centre of mass itself only counts the units still in the line.
* **A general retreat supersedes it.** `retreating` is already walking everybody home and
  `massing` is already walking everybody to the rally, so both clear the map outright: a second
  destination for the same unit is two orders undoing each other, and a stale entry would hold
  that soldier out of the next wave (it does not count toward `squadFood` while it is out, for the
  same reason a healing one does not).

### The wounded, and where they heal

A unit that is HEALING is not sent to fight. Three sources, one rule (`recovering`): a **Healing
Salve** or a **Scroll of Regeneration** hangs a regeneration buff (`ITEM_REGEN_GROUP`, one prefix
so a single filter catches the family), and a **Moon Well** pours into whoever it has been sent
(`drinkWellId`). All three pour over *time* — 45 s for the two scrolls — so a soldier dosed and
marched straight back out spends the effect being hit for more than it regains, which is the same
as not having healed it. It is released when the effect ends **or** at `RECOVER_TO` (65 %),
whichever comes first, and it does not count toward `squadFood` while it is out: counting a unit
`commit` will not move is how a wave of four sets off believing it is a wave of ten.

The **Moon Well** needed two separate things and had neither. Replenish (`Ambt`) is an autocast on
a **building**, and the caster's `canAct` refuses a building out of hand — so a night elf's wells
poured into nobody, all game, every game. Arming is now asked through `canArm`, a much shorter
list (arming is a toggle, not an action). That is only half of it: `Ambt`'s `Area1` is 400, so a
well pours into whoever is *standing at it*, and an army waiting at the rally point is not. The
other half is `wellPass` — the ordinary right-click on a friendly well (`{ c: "drink" }`), issued
only while **massing**, because a well trip replaces whatever the unit was doing and running it
mid-fight walks a Grunt out of the battle line rather than healing it.

### Burrows: the town bell the orcs have instead of a bell

A Burrow with peons in it shoots, which makes it the one structure in the game a worker turns into
a tower. So when something is in the base, the workers go in — and **only the lumber ones**.

**A burrow is asked for by its HOLD's ability code, not by "has a cargo hold".** `Abun` is Load
(the Orc Burrow). The other worker-only hold in the game is `Aenc` — the **Entangled Gold Mine**,
five wisps' worth of `garrisonCap` sitting on a finished building of yours ([`night-elf.md`](
./night-elf.md)) — and `burrowPass` used to sweep it up as a burrow. Its un-threatened branch then
stood the whole mine crew **down** every army pass, `applyHarvest` put them back on the next build
pass, and a night elf computer spent the entire match marching its wisps in and out of its own
gold mine every two or three seconds. That is not cosmetic: it is most of the race's income, since
a wisp that is walking is not mining.

That is why it is done a peon at a time (`{ c: "garrison" }`) rather than through the building's
own Battle Stations button: `battleStations` gathers whatever workers are *nearest*, which on a
threatened base means the gold crew, and a mine that stops paying for the fight it is funding is a
bad trade for a few arrows. `SimUnit.resKind` is the sim's own answer to "what is this worker on",
and it outlives the trip home, so a peon walking a load of lumber back still counts as a
lumberjack. They come back out through `standdown`, which is the door that *remembers* the job
(`unloadBurrow(id, true)` → `resumeGarrisonJob`), so a peon that went in chopping comes out
chopping at the same tree.

### It does not park on a hero it cannot finish

The anti-chase rule applies to the whole army, not only to the focus-fire path. `focusTarget` was
the only thing that knew about heroes and it does not run below Insane, so on **Normal** nothing
whatever stopped the group parking on a hero it could not kill while the army that came with it
did the killing. `commit` now breaks a unit off a healthy enemy hero — `heroKillable`, the same
`HERO_KILL_HP` line the targeting ladder uses — and **re-aims it at a body**. Re-aiming matters:
an attack-move would be answered by the sim's own acquisition, which takes the *nearest* enemy,
and the hero it just walked away from is standing right there.

### A building is not a target while anything is defending it

Reported: *"the Computer+ AI has a tendency to attack buildings first when sieging/attacking/
raiding an enemy's town."* Two separate causes, and both had to be fixed.

**The ladder had no price for a building at all.** `focusTarget` simply skipped them, so the only
thing that had ever *decided* between a Farm and a Footman was the sim's own auto-acquisition,
which takes the nearest. `plus/targeting.ts` now prices one: `BUILDING` = 0.15, below a WORKER
(0.4), which is the comparison that matters — a Peasant runs away and repairs, a Farm does
neither, so of the two things standing in front of an army only one of them gets more expensive
to kill. The `naive` read is **not** exempt this time (it is for the heal and the hero premium):
it aims by bulk, a Town Hall is three Tauren of bulk, and an easy computer left alone would be
the worst offender of the three.

The one exception every player makes is the building that *is* the fight: `isTower` — an armed
building, the same reading `AiPlayer.isTowered` already used — is priced at `TOWER` = 1.5, above
a soldier and below a caster. That is the developer's own *"army units and towers first"*.

**The correction had to be asked of the ORDER-LESS units.** An attack-move does not change a
unit's order when it engages — `tickAttackMove` swings with `order` still `"attackmove"` — so
nearly every soldier in a base is a unit whose order says "attackmove" and whose `targetId` is
the building it is hitting. The existing anti-hero rule was written as `u.order === "attack" &&
u.targetId`, and read that way it never saw the army it was written for; both rules now key on
`u.targetId` alone. (That is most of why *"the AI units still focused the hero quite a lot"*
survived the first fix.)

**…until the defence is broken.** `RAZE_EDGE` (2.5) is the developer's *"until their army is
noticeably larger"*, stated as a ratio: below it `holdTheLine` keeps the discipline on and
anything that has wandered onto a Farm is re-aimed at something with a pulse; above it the fight
is over in all but name and the wave gets on with the razing. Priced with `armyPower` on both
sides — the same √Σ(dps × current hp) as every other comparison here, so 2.5 in those units is
about six times the raw fighting weight. It is a ratio and not a count for the same reason
everything else here is: one Tauren left standing is not one Peasant left standing.

### …and the siege units do the opposite

*"Things like siege units (mortar teams, demolishers, glaive throwers, meat wagons etc.) should
focus buildings whenever possible."* `isSiege` answers it, and it is read off **UnitWeapons.slk**
rather than off a list of ids — but the list it has to produce is the game's own and is written
down: `AddSiege` in `Scripts\common.ai` names MEAT_WAGON, MORTAR, TANK (the Siege Engine),
BALLISTA (the Glaive Thrower) and CATAPULT (the Demolisher). Two columns name exactly those:

* **`weapTp` = `artillery` / `aline`** — a shot that flies at the GROUND and splashes. That is
  the whole artillery roster: Mortar Team, Demolisher, Meat Wagon, Glaive Thrower and the creep
  Catapult, and nothing else. Their `targs1` does not even list `structure`; a building is caught
  by the burst's `splashTargs`, which does.
* **a STRUCTURE-ONLY slot** — `targs` admitting `structure` and neither `ground` nor `air`. A
  weapon that can hit nothing but buildings is a weapon the unit was given *for* buildings: the
  Siege Engine's cannon, the Chimaera's Corrosive Breath (which is why that slot is switched off
  until the upgrade is bought), and the second slot the Mortar Team, Demolisher and Meat Wagon
  each carry precisely because their ground shot cannot reach a wall.

**The trap this avoids is `atkType1`.** A Raider does *siege damage* and is not a siege unit; so
does a Troll Batrider. Keyed on the attack type, half the orc army would have walked past your
Grunts to punch a Farm.

`siegeTarget` picks **one** building for the whole wave off `razeValue` (a tower first — it is
shooting at the army while the army works — then whatever is nearest the objective and closest to
falling), because siege is slow and splashes: four Demolishers on one Barracks bring it down in
the time one of them spends walking between four different ones. `commit` checks the sim's own
`weaponVs` before ordering, so a gun with no slot that admits a structure falls through to the
ordinary rules rather than being ordered at something it can only stand next to.

## Manners: glhf, gg, and leaving

Two things the classic AI never does, both asked for by the issue, and both deliberately plain —
AMAI gives its bots invented names and a joke book, and issue #124 rules out both in as many
words. Lines of anonymous ladder shorthand, drawn off the AI's own RNG stream, spoken by whatever
the lobby already calls that slot.

The lines go out through the **ordinary chat path** (`RtsController.onChatSaid` →
`MapViewerScene.deliverChat`), so a computer's "glhf" is routed, tagged, coloured, logged and
relayed to LAN clients exactly like a typed one, and a map with a chat trigger sees it.

**Both the line and the moment are drawn.** `GREETINGS` is eight openers rather than three: three
shared between a lobby's worth of computers is not a draw, it is a rotation, and on a four-player
map two of them said the same word every game. **None of them address a ROOM** — "gl all", "hf
all" and "glhf all" were in the list and came out again: a seat draws the same line whatever the
lobby is, and most lobbies are a 1v1, where greeting "all" is greeting one person as if they were
four. And *when* each one speaks is drawn per seat into
the window `GREET_AT`…`GREET_AT + GREET_SPREAD` (2-8 s, `Brain.greetAt`) instead of being
`GREET_AT + GREET_STAGGER × slot` — which is a metronome: every seat spoke, in ascending slot
order, exactly a second apart, every match. Two computers landing on the same beat and then a
pause is what a lobby actually sounds like. It is still deterministic *per seed*, like every other
Computer+ decision. `GREET_STAGGER` survives because the **ally openers** are still staggered by
it (`openerTalk`), where a fixed beat is right: those are sentences rather than two-letter words,
and reading them wants them apart.

### Conceding, without demolishing the base

`hopeless()` is deliberately conservative — five clauses, and the position has to *stay*
hopeless for `concedeAfter` seconds (35 on Easy, 12 on Insane: a weaker player takes longer to
accept it). Then it says gg, waits five seconds, and **leaves**.

The first three each mean "there is no route back from here" and are about **what is left
standing** — no hall and no way to put one up; raiders in the base with no army and no workers;
raiders in the base with no army and no hall to make one from. The fourth reads the **fight**
instead: *our heroes are dead, theirs is not, and theirs is in our base.* A hero is the piece a
melee army is built around, and being heroless against a live enemy hero already inside your
base is the position people type gg in long before the last building falls — so this one says
nothing about buildings or gold on purpose, and it is the loosest of the four. What makes that
safe is `concedeAfter` rather than the clause: it un-latches if the raiders die or leave, if
their hero dies or walks out, or the moment one of ours is back on the field.

**Clause 5** is clause 4 with the enemy hero taken out and the **army** put in instead: *our
heroes are dead, our army is gone, and they are in our base*, whoever is doing the standing. It
exists because clause 4 turned out to be reachable only by accident — in a real game the player's
hero is usually off somewhere else at the moment the rest of their army is razing the base, so
`invaderHeroes` was 0 and nothing fired. Both are kept rather than one replacing the other: the
enemy hero in clause 4 is what makes a position lost **early**, while an army of ours is still on
the field.

Two terms keep clause 4 honest. It asks `heroesLost > 0` as well as `heroes === 0`, because "we
have no hero" is also true of every player who has not built one yet — without it an early hero
rush reads as a lost game, which is the mistake `CONCEDE_NOT_BEFORE` exists to prevent. And a
hero already on an altar's revival clock counts as one we *have*: it is coming back at full
strength inside the minute, which is a move from here, and the AI does revive
(`AiPlayer.reviveFallen`). "Part of the group that is attacking" is not a separate notion —
`invaderHeroes` is counted off the very same `isInvader` predicate as `invaders`, so it can
never exceed it.

The third clause — *raiders in the base, no army, and no hall to make one from* — is the one
that makes the first two reachable, and it is worth knowing why it had to exist. Those two
are both vetoed by a surviving **worker**: clause 1 by "somebody could still put a hall back
up", clause 2 by `workers === 0`. A worker is the last thing a player kills, so two Peons in a
corner with gold banked held the concession open for the whole game and you had to raze the base
building by building to win one that had been decided minutes earlier. Note what clause 3 still
refuses to say: a razing is **not** lost while a hall stands — that position can genuinely
rebuild, and the AI plays it out. And it un-latches on its own, because `hopelessSince` resets
the moment the raiders leave (`invaders`) or anything at all goes into production (`armyFood`).

`tools/ai-plus-concede-test.cjs` pins both directions, and the "plays on" half is the half that
matters: an AI that concedes a game it could still play is worse than one that never concedes.

Leaving is `EVENT_PLAYER_LEAVE`, raised on the map's own script:

```
ComputerPlusAi → PlusHost.leave → RtsController.onPlayerLeft
                → MapViewerScene → interp.firePlayerEvent(player, EVENT_PLAYER_LEAVE)
                → Blizzard.j MeleeTriggerActionPlayerLeft
                   ├ ShareEverythingWithTeam  (if an ally is still alive)
                   └ MakeUnitsPassiveForTeam  (otherwise — units go to Neutral Passive)
                   → MeleeDoLeave → MeleeCheckForLosersAndVictors
```

This is the one thing issue #124 explicitly asks us **not** to copy from AMAI: "when the AI
leaves it destroys its buildings, which shouldn't be happening in our case". AMAI has no choice —
a JASS script's only way to end its own player is to satisfy the defeat condition, and the defeat
condition is *your team owns no structures*. We are not constrained that way, because the engine
is ours: raising the event runs Blizzard's own leave path, which hands the units over rather than
killing them, and the victory that follows is the map's own ruling rather than ours.

Note what this depends on: `MeleeInitVictoryDefeat` must have run, i.e. it is a melee map with a
melee init trigger. On a map that never registered the event the concession is still said and the
AI still stops playing — it simply stands there, like a player who alt-tabbed.

## Team games: talking to your allies, and scouting once

[`src/ai/plus/teamchat.ts`](../src/ai/plus/teamchat.ts). All of it is **inert in a 1v1** — every
branch reads the ally list first, and in a free-for-all it is empty — and all of it goes out on
the **allies channel** (Ctrl+Enter's, `ChatScope` `"allies"`), through the same
`PlusHost.say` → `RtsController.onChatSaid` → `MapViewerScene.deliverChat` path the manners use.
There is no second channel: the line is routed by `chatRecipients`, tagged `[Allies]`, coloured,
logged, relayed to LAN clients and raised to the map's own chat triggers exactly like a typed one.

An ally is asked of the **alliance matrix** (`coAllied`, PASSIVE in both directions), never of a
team number — a one-way passive grant is not an alliance, and `src/game/chat.ts` explains at
length why that distinction is load-bearing.

### What it says

**Nothing before the greetings are done.** `OPENER_AT` is a fourteen-second floor, and
`greetingsDone` is the rest of it: each seat's "glhf" lands at a moment it drew for itself
(`Brain.greetAt`), so the last one is later than any fixed floor can know, and the openers used to
interleave with them into one wall at the start of the match. It is read off the moments actually
drawn rather than off the window's ceiling, so a 1v1 — and a lobby whose computers all rolled
early — does not hold its openers back for greetings nobody is still going to say.

* **Its OPENING, once, near the top of the game** — *"i'm going footmen"*. What it is about to
  train, which at fourteen seconds is tier 1 and nothing else: `openingUnits` takes the
  strategy's own tier-1 rows, heaviest first, and falls back on the race's **opening soldier**
  (`openingUnit`, plus/plan.ts) for the fourteen builds of twenty that name nothing buildable at
  tier 1 — the same two answers `buildableMix` will give once a Barracks is standing. Named by
  the **game's** own `UnitDef.name` so a localized install says what it says; only the
  pluralisation is ours (`plural`, teamchat.ts — "-man" → "-men" for the compounds the roster
  really ships, Rifleman and Footman, with `ROOT_MAN` holding back the word that merely *ends*
  that way: the Shaman is a shaman, and Orc08's own `war3map.j` writes "shamans").

  It used to announce the **strategy** here instead, and that was the developer's own bug report:
  an ally was told *"i'm going tauren"* on minute one, watched four minutes of Grunts, and the
  next line out of that computer was *"switching to grunts"* — a switch to the opening, in every
  single match. The opening is what it is opening with; the build is stated when it is real.
* **The build it is switching to, from tier 2 on** — *"switching to knights"*, *"going
  hippogryphs to counter their air units"*. Be precise about what this is: not a strategy switch
  (Computer+ holds the build it rolled for the whole match) but the two things that genuinely
  move production — the tech tree opening up, and the counter re-weighting. `STRATEGY_TIER` is
  the floor and is where the strategy gets stated at all: below a Keep the top of the mix *is*
  the opening that was already announced, so the only line this could produce down there is the
  one above. It is a floor rather than a moment — the line lands with the first row of the
  strategy `buildableMix` can actually produce, so what goes out is what is being trained rather
  than what is intended. `switchReason` only blames the enemy when this difficulty is actually
  countering and off a sample it believes, because a computer that blamed the enemy for a switch
  caused by its own Castle finishing is a computer talking nonsense. `SWITCH_MARGIN` is real
  hysteresis and is not optional: `buildableMix` is a continuous re-weighting, so two near-equal
  rows trade places constantly and every trade would be a line.
* **"help me"**, on either of two conditions. **More than one opponent** has units in its towns
  at once (`isInvader`, so a creep camp next door is not an invasion) — two at once is an
  emergency by arithmetic. Or **one of them is overrunning it** (`overrun`): the number of
  attackers is not what makes a raid an emergency, and one opponent in your base is an ordinary
  melee game right up until what is standing there cannot answer what walked in. That is a
  comparison rather than a count, so it is priced with `powerOf` — the same √Σ(dps × current hp)
  both sides of every other fight this AI decides are weighed with — against everything of ours
  standing in a town, with `OVERRUN_EDGE` (a half again) as the bar. `OVERRUN_BODIES` is the
  floor under the ratio and does real work: a player whose army is out creeping has *no* home
  defence at all, so without it one Ghoul strolling past a Ziggurat outweighs the base by any
  margin you like.
* **Who it is about to hit** — *"im going to hit blue"* — when the wave sets off at a **player**.
  Not a creep run, and not a field battle the wave was dragged into (`contactPass`'s target
  carries `id` 0): a teammate cannot join something that is already happening somewhere the
  announcer did not choose, so the objective has to name a unit whose owner is a seat we are at
  war with. The opponent is named by **colour**, which is the only name an opponent has — it is
  what both players read off the minimap, and "player 4" is not something anybody types.
  `COLOUR_NAMES` is the install's own list in the install's own order (`UI\TriggerData.txt`'s
  `playercolor` enum, `Color00=…PLAYER_COLOR_RED…` through `Color11=…PLAYER_COLOR_BROWN`), and
  the colour is asked of `PlusHost.playerColor` rather than taken as the seat number, because
  `SetPlayerColor` can move one. `attackSaid` holds the *player* rather than a flag, so re-aiming
  at a different enemy is a fresh announcement while the same one inside `ATTACK_TELL_GAP` is
  not — `attacking` re-picks its objective as buildings die under it.
* **"im coming with you"**, and then it comes: the promise is kept by pointing its own wave at
  that player, because anything less would make the line a lie. **Silence is the other answer.**
  An ally that is not interested says nothing at all — nobody types "no" every time a teammate
  announces an attack, and one announcement is heard by every allied computer at once, so a
  spoken decline here would be the loudest thing on the channel. Not interested means exactly the
  states `busyLines` already names, plus the wave's own clocks (`waveReady`): a computer that
  walked out with three soldiers because a teammate asked would be attacking with less than it
  has itself decided an attack takes.
* **An answer to somebody else's call** — *"omw"*, *"coming, tping to you"*, or a decline that
  says **why**: *"i can't come there right now, i'm under attack too"*. The decline is as much of
  the feature as the relief wave: an ally told that nobody is coming can play the fight
  accordingly, where an ally told nothing waits for an army that never arrives.

### What it hears

`readAllyCall` folds the text to lowercase and turns every non-letter into a space, then matches
on **words**, so "HELP!!", "Help me.", "help-me" and "i'm dying" are one message and "helped",
"helping" and "helpful" are not messages at all.

**The order of the readings is the whole parser**, and every step of it is a line this file itself
says being kept out of the reading below it:

1. `joining` before `coming`, because every one of `JOIN_LINES` contains the word "coming" — so
   without it "im coming with you" is heard by the third teammate as somebody answering a call for
   help that nobody made;
2. the **declines**, because every one of them contains the word a request is recognised by ("i
   can't help right now" is not a request for help);
3. the **attack announcement**, which is additionally gated on a **colour** being named — that
   gate is what keeps it from eating the file's own `HELP_CALLS`, one of which reads *"i'm under
   attack from multiple sides, need help"*. A request for help names no colour; an announcement
   always does, because naming who is the point of it. `namedColour` matches **longest first**,
   or every call to hit light blue is heard as a call to hit blue — a different player, usually
   on the other side of the map;
4. and only then `help`.

Without that ordering two computers answer each other's answers for the rest of the match, which
is why `tools/ai-plus-teamchat-test.cjs` runs the file's own vocabulary through its own parser and
requires none of the answers to read as a call.

A call is acted on only if it was **addressed to this computer** (the recipient list `deliverChat`
already computed — it cannot read chat it was not a recipient of any more than it can see through
the fog) and only from a player it is actually **co-allied** with: an enemy typing "help" on the
all-channel is taunting. Nothing is *done* inside `heard` — the call is parked on the brain and
answered by the manners pass, because `heard` is called from the middle of chat delivery and
answering there would re-enter `deliverChat` from inside its own routing.

### Coming to help

**It goes to the ally's ARMY.** Three answers, in order, and the first two are both "where their
units are" — because that is what "help me" means. **The fight**, if there is one to see: the ally
unit with the most enemies around it, which is where the help is needed rather than merely where
the ally is. Otherwise **their army**: the centre of mass of their fighting units, workers and
buildings left out. Only when they have nothing on the field at all does it fall through to
**their base**, at which point their base genuinely is where they are.

The middle rung is new and the ordering used to be just fight-then-base, which was wrong far more
often than it was right: `allyFight` needs enemies of theirs that *we* can see, which across a map
usually means null — so the army walked to a base the ally was not standing in and the rescue
arrived nowhere. A person asked for help walks to the friendly units on the minimap, not to the
friendly buildings.

All of it is asked of `AiPlayer.knows`, which in a melee team game usually says yes with no
cheating at all, because a force grants `ALLIANCE_SHARED_VISION` and the computer is already
looking through its teammate's units. Enemy *players* only: a creep camp an ally chose to walk
into is not what "help" means. Where an ally's *base* is is public — a melee player is shown their
teammates' start locations from the first frame.

**The scroll is for one thing: the ally's BASE being attacked.** It walks unless two things are
both true — the walk is longer than `PORTAL_WALK` (5400; a Footman's `spd` is 270, so about twenty
seconds of open ground, and a fight that has been going twenty seconds has been decided) *and*
`baseUnderAttack` can see a fight at one of that ally's town halls. That second gate is not a
policy, it is what the item is: a Town Portal's destination is a **town hall**
([`items.md`](./items.md)), so a scroll spent on a field battle drops the army somewhere near the
fight at best and is simply gone at worst — and gone is exactly when the base call comes.

The press itself needed one fix in the sim: `SimWorld.nearestHall` accepts an **allied** hall,
which is the item's stated behaviour rather than a convenience — Blizzard's own page says the
scroll *"will automatically select the highest (allied) Town Hall as a transport destination"* —
and without it the trip landed back in our own base. `PlusItems.portalTo` is called by the army
manager rather than reached from the belt's ladder, because it is not a reading of the hero's
danger at all: the `escape` rung is a retreat aimed at the hero's own feet, and this is the same
item aimed at a place the whole army needs to be.

**A rescue can be CALLED OFF.** It used to be a one-way commitment: the wave walked to where the
fight had been, stood there until `attacking` decided the spot was clear or `HELP_TIMEOUT` (90 s)
ran out, and only then remembered it had a game of its own. `helpWave` now re-asks
`allyInDanger` — anything hostile *we can see* near any of that ally's units or halls — and two
clocks keep it a decision rather than a twitch: `HELP_GRACE` (20 s), because the danger is judged
through our own eyes and there is nothing to see for the first part of the walk, and `HELP_CLEAR`
(8 s), because a fight ebbs. When it is called off, `dropHelp` puts the wave **back on the
objective it was walking to when the call came** — a creep camp, an expansion, the enemy's base —
rather than leaving it standing in the middle of the map. A wave pulled home to *defend* is the
exception: `defendPass` has already given it a new job and must not have an old one pushed back
onto it.

**Every computer answers in its own turn.** One "help" reaches every allied Computer+ player on the
same frame, and each of them typed "omw" onto that frame — three identical lines stacked on top of
each other, which reads as one player with a stuck key rather than as a team. `heard` now parks the
call with an `HELP_ANSWER_STAGGER` (2.5 s) offset per computer that actually heard it, so they
answer in order — and the second one decides whether to come while the first one's army is already
walking, which is also the honest order to decide in.

### Scouting intelligence: the team scouts once

Not chat, and it lives at the sighting instead (`ComputerPlusAi.scoutEnemy` / `teammates`): every
hostile unit a Computer+ player sees is written into **every allied Computer+ player's**
`EnemyMemory` as it is seen. Without it each computer on a team pays for the same scout — three
of them walk a worker into the same base to learn the same thing, and the one whose scout dies
(which latches `scoutDone`) plays the whole match against an opponent it never looked at.

This is not a fog bypass either, and it is the same distinction as above: the sighting being
passed on was made through somebody's **own** eyes (`knows`, and Computer+ never sets
`bypassFog`), so what travels is a fact one player *learned*, exactly as a typed "they're going
gryphons" would be. Each receiver still judges the pooled sightings by **its own** difficulty —
its own `counterSample`, `counterShare` and `counterMemory` — so an Insane ally reacting to what
a Normal ally saw still reacts like an Insane player. Easy neither shares nor receives, because it
does not counter at all and has no memory to pour into.

A **human** teammate's scouting reaches an AI ally by the engine's own route rather than this one:
a melee force grants `ALLIANCE_SHARED_VISION`, so `AiPlayer.knows` is already looking through the
human's units as well as its own.

### The numbers

None of them are Warcraft III's — nothing in the install describes a computer that talks — so
every one is ours, which is this whole directory's standing rule. `TALK_GAP` 25 s between any two
lines (a team game with three computers is three of these at once and the message area is small),
`HELP_CALL_GAP` 60 s, `HELP_ANSWER_GAP` 30 s (a second "help" inside it is the same emergency and
the army is already walking), `HELP_TIMEOUT` 90 s, `SWITCH_MARGIN` 1.25, `HELP_CALL_FOES` 2,
`OVERRUN_EDGE` 1.5 and `OVERRUN_BODIES` 2, `ATTACK_TELL_GAP` 45 s, `JOIN_STAGGER` 2.5 s,
`JOIN_TIMEOUT` 75 s.

The one thing here that *is* the install's is `COLOUR_NAMES` — twelve words, in twelve places,
straight off `UI\TriggerData.txt`'s `playercolor` enum.

## The UI, and the overrides layer

Two new controls, neither of which the 2003 UI has a frame for. They are **not** added by editing
the install — `UI\FrameDef\` is the player's and OpenWar3 ships zero Blizzard assets — but by a
layer of our own FrameDef files in [`src/overrides/`](../src/overrides/), applied at mount through
`mountFdfScreen`'s `overrides` option. Read that directory's README before adding a third.

* **Custom Game → Advanced Options → "Computer+ (Improved AI):"** — one switch for the whole
  match. Flipping it also swaps what every computer row's NAME menu offers, so the slots read
  "Computer+ (Easy) / (Normal) / (Insane)" (`slotOptionsFor` in `ui/playerSlots.ts`).
* **Options → Gameplay → "Use Computer+ as default AI"** — the remembered default of that switch.
  It arrives in the row vacated by **Game Port** and **Chat Support**, both of which are retired
  by the same override: there is no port to set (a LAN game here is a WebRTC relay) and no
  Battle.net chat gateway to choose.

The LAN game lobby keeps the classic three. It has no Advanced Options pane, and the choice is
the match's rather than the row's.

## Where it runs, and how to reach it

Authority-side only, from `RtsController.tick`, inside the branch a frozen LAN client never
enters — and every decision leaves as a `Command` through `RtsController.execute`, the same door
and the same ownership/cost/tech/food judgement a human player's click gets.

It is seated at exactly the same seam as the classic AI: `MeleeStartingAI` → `StartMeleeAI` →
`RtsController.startMeleeAIFor`, which reads the seat's own `plus` flag and hands it to one of the
two objects. So the map still decides who plays and as what; a campaign chapter and a
use-map-settings map get no Computer+ for the same reason they get no classic AI.

```
?dev&map=EchoIsles&ai=plus-easy       # …&ai=plus-normal, &ai=plus-insane
```

…or the real screen: Custom Game → pick a map → **Advanced Options** → tick **Computer+**.
