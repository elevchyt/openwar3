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
(`AiPlayer.enemyExpansion` is gated on `knows`). One worker, one tour, not replaced when it dies.

The tour goes **around** that base, never into it — `scoutRing`, three stops on a ring of
`SCOUT_STANDOFF` about the enemy's town centre, starting on the side the scout is already coming
from and stepping off it either way, then the gold mines nearest them. Aiming the first leg at
the town centre (which is what it used to do) marches a lone worker through the front door, past
the towers and into the army: it dies, `scoutDone` latches because nobody follows a scout that
did not come back, and that one walk is the whole of what the AI ever learns about the map. A
worker's day sight is 1400+ and a melee start's buildings sit well inside 900, so standing off
sees the same thing and comes home. It is also what a player does, and for the same reason.

And it comes home **walked**, not merely released. Dropping the scout out of `held` is what lets
the harvest plan have it again, but the plan assigns jobs, not journeys: a worker released
standing in the enemy's base was left standing in the enemy's base, idle, for the rest of the
match — one worker of an eleven-worker economy, thrown away every game. The move order is what
brings it back; the harvest plan then picks it up as an idle worker at home.

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
| hall tier | **1** | 2 | 3 |
| upgrade rank | 1 | 2 | 3 |
| first attack | 7 min | 5 min | 2½ min |
| army food that makes a wave | 10 | 14 | 16 |
| **first creep camp** | **never** | 2½ min | 1½ min |
| army food that makes a creeping party | — | 10 | 8 |
| retreats a broken army | **no** | at 35 % | at 40 % |
| focus-fires / creeps / raids workers | no / no / no | no / yes / no | yes / yes / yes |
| belt slots it shops for | **0** | 3 | 6 |
| gold it keeps back from the shop | — | 300 | 200 |
| keeps and replaces a Town Portal | no | **yes** | **yes** |
| builds its race's shop | no | **yes** | **yes** |
| accepts a lost game after | 35 s | 20 s | 12 s |
| spell roles it uses | heal, nuke, summon, morph | + panic, disable, buff | all nine |
| **aims at** | the **biggest body** (`naive`) | what a unit **is** (`sound`) | + what the **spell is for** (`expert`) |
| misclicks a cast | 35 % | 15 % | never |
| hero focus | 0.3 | 0.7 | 1 |
| builds it can roll | tier-1 only | tier ≤ 2 | all of them |

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

Read the Easy column as a description of a player: it makes eight workers and six food of
tier-1 soldiers, never expands, never towers, never leaves its Town Hall, comes to find you
after seven minutes, feeds its army in one piece, and takes fifteen seconds to notice you are in
its base. That is issue #124's brief — "must essentially be able to be beaten by players who have
played MOBAs" — written as numbers.

### The army ceiling is enforced at PRODUCTION

`armyFood` is the single most load-bearing number, and *where* it is applied is the whole point.
It is a budget spent down the race's unit mix inside `buildPlan`, so an easy computer **asks for
twelve food of soldiers and then stops asking**. Capping the size of the *wave* instead would
have produced an AI that builds twenty Grunts, attacks with six, and still has twenty Grunts
standing when you walk into its base — which is exactly what "must NOT mass armies at all" rules
out.

## Strategies: a race is a table of builds, not one build

Each race owns several named builds ([`races.ts`](../src/ai/plus/races.ts)) — Human plays
Footmen-and-Riflemen, Riflemen-and-Mortars, Knights, Sorceresses-and-Spell-Breakers or Gryphons;
Night Elf plays Archers, Huntresses-and-Dryads, Dryads-and-Druids-of-the-Claw, Talons-and-Hippos
or Chimaeras — and one is **rolled at seat time**, weighted, off the AI's own RNG stream. Two
Computer+ players on one map open differently; the same seat on the same seed opens the same way
twice.

A strategy is a **weighted unit mix** and two clocks, and nothing else is written down:

* the **buildings** it needs are derived from the units it names (`UnitRow.from` / `needs`);
* the **upgrades** it takes are whichever its buildings can research — so a Gryphon build takes
  the Aviary's upgrades and a Footman build does not, with no list to keep in step;
* the **hero** it opens with is the build's own where it states one (a Tauren build opens Tauren
  Chieftain, a Bear build opens Keeper of the Grove), the race's otherwise.

**Difficulty picks which builds are on the menu.** A strategy declares the hall tier it aims at,
and one above the difficulty's `techTier` is never offered — so an easy computer only ever rolls
its race's simplest openings, and Insane can roll anything.

We roll ONCE and hold it. AMAI switches strategy mid-game once its `strat_minimum_time` has
passed; we do not, because a switch abandons half-built production and nothing here yet measures
whether it was worth it. Countering (below) is the adaptive part instead.

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

> hall → workers → food → altar & barracks → **first hero** → **core army** → tech buildings →
> **expansion** → extra heroes → tier → towers → upgrades → **the rest of the army**

### The undead's lumber comes out of its army

`recruit` takes everything that fights, and a **Ghoul is not `isPeon`** — so it is a fighter by
every test in the sim, and the wave claimed every ghoul the moment it was trained. `captainHeld`
then kept `applyHarvest` off it, and an undead Computer+ chopped **no lumber for the entire
match**. It is the one race whose lumber comes out of its army, and it has to say so.

The rule and both numbers are Blizzard's — undead.ai 205–219, ported at `UNDEAD_AI.waveGate` in
[`src/ai/undead.ts`](../src/ai/undead.ts): *the forest keeps 10 lumberjacks minus one per 120
lumber in the bank, and everything left over attacks.* It self-regulates, which is why it is worth
taking whole rather than picking a constant: with nothing banked every ghoul chops, and by the
time there is 1200 lumber standing every ghoul fights. `recruit` states both directions against
one number, so a crew that has gone short takes ghouls back **out** of the wave (newest first)
rather than only refusing to add more.

Which race this applies to is asked of the DATA, never of a race list: if this player's ordinary
workers can chop (`WorkerState.lumber` — a Peasant, a Peon, a Wisp) nothing is held back at all.
Only the Acolyte (`uaco`, `lumber: false`) reaches the formula.

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

The two rungs aimed at somebody ELSE — `healArea` and `healOther` — are also the only two not
gated on being in a fight, and that is deliberate. A Healing Salve and a Scroll of Regeneration
pour over **forty-five seconds**; spending one while the blows are still landing is spending it
into the damage. The moment they are worth is the moment the camp is dead and the party is about
to walk to the next one, which is the job the shopping list says it bought them for.

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
healSelf, healArea, healOther, mana, buff* — and it is keyed on the item's **ability code**, never
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

It leaves at `ESCAPE_HP` (40 %) rather than at the panic line, and the reason is easy to get
backwards: once the scroll is *pressed* the hero is invulnerable for the whole five seconds and
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

**The shopping list** is [`items.ts`](../src/ai/plus/items.ts)'s `LIST`, and it belongs beside the
strategy rather than in the difficulty for the same reason the expansion clock does: *what* to buy
is what a melee player buys, not how good they are. Every id on it was read off a real shop row —
`[ngme] Sellitems` for the Goblin Merchant, `Makeitems` for the four race shops — and all four
race shops sell `phea`/`pman`/`stwp`, which is why those anchor it. (Watch the near-homographs:
`pinv` is Potion of *Invisibility*, `pnvu` Potion of Invulnerability, and `pnvl` the *Lesser* one
that is what the Merchant actually stocks.)

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
ladder and does not pretend to be one.

Still not touched: **Kelen's Dagger of Escape** (`AIbk`), a point-target blink that needs a
decision about *where* the aiming above does not make — it is a drop, never shop stock, so it
waits. And there is one button on a BUILDING which is very human: **Call to Arms**. `Amic` is the
Human town bell, and it is already rung by [`plus/casting.ts`](../src/ai/plus/casting.ts)
`townBell` — the answer to "something is in my base and my army is somewhere else", and never on
Easy.

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

## Manners: glhf, gg, and leaving

Two things the classic AI never does, both asked for by the issue, and both deliberately plain —
AMAI gives its bots invented names and a joke book, and issue #124 rules out both in as many
words. Six lines of ladder shorthand, drawn off the AI's own RNG stream, spoken by whatever the
lobby already calls that slot.

The lines go out through the **ordinary chat path** (`RtsController.onChatSaid` →
`MapViewerScene.deliverChat`), so a computer's "glhf" is routed, tagged, coloured, logged and
relayed to LAN clients exactly like a typed one, and a map with a chat trigger sees it.

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

* **Its build, once, near the top of the game** — *"i'm going footmen and riflemen"*. Off the
  `PlusStrategy` it rolled at seat time rather than off what it has produced, so at twelve
  seconds it is a plan rather than a report. The two heaviest units in the mix, named by the
  **game's** own `UnitDef.name` so a localized install says what it says; only the pluralisation
  is ours.
* **When the top of that mix moves** — *"switching to knights"*, *"going hippogryphs to counter
  their air units"*. Be precise about what this is: not a strategy switch (Computer+ holds its
  build for the whole match) but the two things that genuinely move production — the tech tree
  opening up, and the counter re-weighting. `switchReason` only blames the enemy when this
  difficulty is actually countering and off a sample it believes, because a computer that blamed
  the enemy for a switch caused by its own Castle finishing is a computer talking nonsense.
  `SWITCH_MARGIN` is real hysteresis and is not optional: `buildableMix` is a continuous
  re-weighting, so two near-equal rows trade places constantly and every trade would be a line.
* **"help me"**, when **more than one opponent** has units in its towns at once (`isInvader`, so
  a creep camp next door is not an invasion). One opponent in your base is a melee game.
* **An answer to somebody else's call** — *"omw"*, *"coming, tping to you"*, or a decline that
  says **why**: *"i can't come there right now, i'm under attack too"*. The decline is as much of
  the feature as the relief wave: an ally told that nobody is coming can play the fight
  accordingly, where an ally told nothing waits for an army that never arrives.

### What it hears

`readAllyCall` folds the text to lowercase and turns every non-letter into a space, then matches
on **words**, so "HELP!!", "Help me.", "help-me" and "i'm dying" are one message and "helped",
"helping" and "helpful" are not messages at all. The **declines are tested first**, because every
one of them contains the word a request is recognised by — and so does every line this file
itself says. Without that ordering two computers answer each other's answers for the rest of the
match, which is why `tools/ai-plus-teamchat-test.cjs` runs the file's own vocabulary through its
own parser and requires none of the answers to read as a call.

A call is acted on only if it was **addressed to this computer** (the recipient list `deliverChat`
already computed — it cannot read chat it was not a recipient of any more than it can see through
the fog) and only from a player it is actually **co-allied** with: an enemy typing "help" on the
all-channel is taunting. Nothing is *done* inside `heard` — the call is parked on the brain and
answered by the manners pass, because `heard` is called from the middle of chat delivery and
answering there would re-enter `deliverChat` from inside its own routing.

### Coming to help

The destination has two answers, in order, and the split is what keeps it honest about the fog.
**The fight**, if there is one to see — a teammate whose army is dying somewhere is not asking you
to go and stand in their base — asked of `AiPlayer.knows`, which in a melee team game usually says
yes with no cheating at all, because a force grants `ALLIANCE_SHARED_VISION` and the computer is
already looking through its teammate's units. Enemy *players* only: a creep camp an ally chose to
walk into is not what "help" means. Otherwise **the base**: *where* an ally's base is is public — a
melee player is shown their teammates' start locations from the first frame — and their message is
the news that something is wrong with it, while *which* of their halls is in trouble is `knows`
again. With nothing visible it simply sends the army to the ally's nearest base and lets it find
the fight there, which is what a person does.

It walks, unless the walk is longer than `PORTAL_WALK` (5400 — a Footman's `spd` is 270, so about
twenty seconds of open ground, and a fight that has been going twenty seconds has been decided).
Then the hero presses its **Scroll of Town Portal** aimed at that spot. That needed one fix in the
sim: `SimWorld.nearestHall` now accepts an **allied** hall, which is the item's stated behaviour
rather than a convenience — Blizzard's own page says the scroll *"will automatically select the
highest (allied) Town Hall as a transport destination"* — and without it the trip landed back in
our own base. `PlusItems.portalTo` is the press, and it is called by the army manager rather than
reached from the belt's ladder, because it is not a reading of the hero's danger at all: the
`escape` rung is a retreat aimed at the hero's own feet, and this is the same item aimed at a
place the whole army needs to be.

The relief wave is an ordinary `attacking` wave with the ally's base as its objective, so it ends
the way every other wave does — the group standing on the objective with nothing hostile near it —
and `HELP_TIMEOUT` (90 s) is the other end: an ally whose base fell while we were walking is an
ally we cannot help, and standing in the wreckage is how the second base is lost too.

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
the army is already walking), `HELP_TIMEOUT` 90 s, `SWITCH_MARGIN` 1.25, `HELP_CALL_FOES` 2.

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
