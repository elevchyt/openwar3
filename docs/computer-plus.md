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
| retreats a broken army | **no** | at 35 % | at 40 % |
| focus-fires / creeps / raids workers | no / no / no | no / yes / no | yes / yes / yes |
| spell roles it uses | heal, nuke, summon, morph | + panic, disable, buff | all nine |
| **aims at** | the **biggest body** (`naive`) | what a unit **is** (`sound`) | + what the **spell is for** (`expert`) |
| misclicks a cast | 35 % | 15 % | never |
| hero focus | 0.3 | 0.7 | 1 |
| builds it can roll | tier-1 only | tier ≤ 2 | all of them |

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

### Items: not yet, and what goes here when they land

**Computer+ does not touch items at all today**, and that is a deliberate hole rather than an
oversight: the item side of the sim is still being filled in, and an AI built against a
half-implemented inventory would encode the half. Nothing in `src/ai/plus/` reads
`SimUnit.inventory`, buys from a shop, or presses an item — a Computer+ hero picks up what it
walks over and never drinks it.

The *effects* half has since landed (issue #130, [`items.md`](./items.md)): every item ability
in the game is now dispatched, a pressed item reaches whoever its own `Area1` says it reaches,
and a carried one feeds the passive derivations. What is still missing here is the AI's own
half — going to a shop, choosing, and pressing.

The seams it will use already exist and are the same ones a player's click goes through, so when
the items land this is additive:

| What | The door |
| --- | --- |
| buy | `Command` `{ c: "buyitem", shopId, itemId }` → `SimWorld.purchaseItem` |
| use | `Command` `{ c: "useitem", unitId, slot, targetId, x, y }` → `SimWorld.useItem` |
| may it | `SimWorld.itemReadyError` / `itemUseError` — the click-time gates, exactly as `castUseError` / `castError` are for a spell |
| what is in stock | `TechRegistry`'s `makeitems` (a race shop: Arcane Vault, Voodoo Lounge) and `sellitems` (a neutral one: Goblin Merchant, Marketplace), plus `SimWorld.shopStock` |
| who may hold it | `SimWorld` patron rules — a patron needs an inventory, which in melee means a hero |

What it should do, in the order it matters:

* **Buy from a Goblin Merchant / Marketplace when one is on the map**, and from its own race shop
  once that is up. The Goblin Merchant's stock is not a guess — it is one line of
  `Units\NeutralUnitFunc.txt`, `[ngme] Sellitems=stwp,bspd,dust,tret,prvt,cnob,stel,pnvl,shea,spro,pinv`
  — so a shopping list is a preference order over *that*; the Marketplace's stock is the map's
  rather than the game's (`[nmrk]` carries no `Sellitems` at all) and has to be read off the shop
  at run time. The list itself is the standard ladder one and belongs beside the strategy table
  rather than in the difficulty: a **Scroll of Healing** (`shea`) early, a **Scroll of Town
  Portal** (`stwp`) as soon as it can afford one, **Boots of Speed** (`bspd`) on the hero that
  needs to be somewhere, a **Potion of Lesser Invulnerability** (`pnvl`) for a hero it expects to
  lose, and the tomes with gold it cannot spend. (Watch the near-homographs: `pinv` is Potion of
  *Invisibility*, `pnvu` Potion of Invulnerability, `pnvl` the Lesser one the Merchant actually
  stocks.)
* **Press them.** A healing potion is a `panic`/`heal` role and slots straight into the caster's
  existing ladder; a Town Portal is the retreat the army manager already decides on
  (`mode === "retreating"`); a Scroll of Healing is an area heal aimed by the same `pickSpot`.
* **Difficulty grades it the way it grades everything else** — Easy buys almost nothing and
  drinks late, Insane keeps a Town Portal on every hero. Those numbers go in `PlusProfile`
  beside `castTargeting`, and like every number there they are **ours**.

Two gates to check before writing any of it: item abilities are **not** in `SimUnit.abilities`
(they hang off the inventory slot and dispatch through `useItem`), so the caster's ability walk
will not find them; and gold spent on items is gold `OneBuildLoop` was reserving, so a shopping
list needs a place in the build ladder rather than a side budget.

There is one button on a BUILDING, and it is very human: **Call to Arms**. `Amic` is the Human
town bell, and it is the answer to "something is in my base and my army is somewhere else" —
which is the situation an AI is worst at. Rung only when the raiders outnumber whatever is home,
and never on Easy.

## Manners: glhf, gg, and leaving

Two things the classic AI never does, both asked for by the issue, and both deliberately plain —
AMAI gives its bots invented names and a joke book, and issue #124 rules out both in as many
words. Six lines of ladder shorthand, drawn off the AI's own RNG stream, spoken by whatever the
lobby already calls that slot.

The lines go out through the **ordinary chat path** (`RtsController.onChatSaid` →
`MapViewerScene.deliverChat`), so a computer's "glhf" is routed, tagged, coloured, logged and
relayed to LAN clients exactly like a typed one, and a map with a chat trigger sees it.

### Conceding, without demolishing the base

`hopeless()` is deliberately conservative — three clauses that each mean "there is no route back
from here" — and the position has to *stay* hopeless for `concedeAfter` seconds (45 on Easy, 20
on Insane: a weaker player takes longer to accept it). Then it says gg, waits five seconds, and
**leaves**.

The third clause — *raiders in the base, no army, and no hall to make one from* — is the one
that makes the other two reachable, and it is worth knowing why it had to exist. The first two
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
