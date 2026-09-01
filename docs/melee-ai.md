# The melee AI

> Read this before touching anything in [`src/ai/`](../src/ai/), the `MeleeStartingAI` path, or
> a computer player's behaviour. Issue #119.
>
> This is **Blizzard's** melee AI, ported. OpenWar3's own second one — Computer+, seated by a
> checkbox in Advanced Options — is [`computer-plus.md`](computer-plus.md). The two share
> `aiPlayer.ts` (the library and the natives) and nothing else; a seat is in exactly one of them,
> and nothing in `src/ai/*.ts` imports from `src/ai/plus/`.

Warcraft III's melee computer players are not C++ with a difficulty slider. They are **JASS
scripts shipped in the game's own data** — `Scripts\human.ai`, `orc.ai`, `elf.ai`, `undead.ai`
— running on a library, `Scripts\common.ai`, that stands on about 150 engine natives. That is
three layers, and knowing which layer a thing lives in is most of what makes this tractable:

| Layer | In WC3 | Here |
| --- | --- | --- |
| Strategy — build orders, upgrade priorities, harvest splits, when to attack | `human.ai` / `orc.ai` / `elf.ai` / `undead.ai` (≈650 lines each) | [`human.ts`](../src/ai/human.ts), [`orc.ts`](../src/ai/orc.ts), [`elf.ts`](../src/ai/elf.ts), [`undead.ts`](../src/ai/undead.ts) |
| Library — the build array, `TownCount`, `OneBuildLoop`, `SingleMeleeAttack`, `PickMeleeHero` | `common.ai` (2582 lines) | [`aiPlayer.ts`](../src/ai/aiPlayer.ts) |
| Natives — `SetProduce`, `HarvestGold`, the captain, `GetCreepCamp` | C++ in `Game.dll` | [`aiPlayer.ts`](../src/ai/aiPlayer.ts) + [`index.ts`](../src/ai/index.ts) |

The scripts are in the install and are the source of truth for everything in the top row.
`pnpm data:extract` puts them at `Warcraft III/ExtractedData/merged/Scripts/`. **Read them
before changing a number here** — every threshold in the race files is transcribed, and a
"tuning tweak" is a divergence from the reference unless the reference says so.

---

## The build array is the whole strategy layer

A race script does not issue orders. It fills a list, once every pass, and the list is read
back by one loop. That is `build_sequence` → `OneBuildLoop`, and both halves matter:

```jass
call SetBuildUnit(  6, PEASANT      )   // "have at least 6 peasants"
call SetBuildUnit(  1, HUMAN_ALTAR  )   // "…and an Altar"
call SetBuildUnit(  7, PEASANT      )   // "…and then a 7th peasant"
```

Three rules, all of them easy to get wrong:

1. **`SetBuildUnit(n, X)` is "have at least n", not "make n more."** The count it compares
   against is `TownCount`, which includes structures under construction, jobs sitting in
   production queues, units finished but not yet born, and (our addition, because the original
   reserves inside `SetProduce` itself) build orders a worker is still walking to. Miss any of
   those and the AI re-orders the same Farm every pass and carpets its base in foundations.
   `SetBuildNext(n, X)` is the relative form: while short of `n`, ask for one more than is
   finished.

2. **The list is a PRIORITY ladder, and gold is reserved down it.** `OneBuildLoop` keeps a
   running `total_gold`, subtracts the full cost of every row it walks past whether or not
   that row actually got started, and **returns at the first unit row it cannot afford**. So
   nothing below the Barracks you are saving for can spend the Barracks' gold. An *upgrade*
   row that cannot be afforded is skipped rather than halting — `StartUpgrade`'s `false` is
   discarded by its caller — and that asymmetry is Blizzard's, not a port artefact.

3. **`TownCount` folds upgraded forms into their base.** A Castle satisfies "have a Town
   Hall"; a Berserker satisfies "have a Headhunter"; a Spirit Tower satisfies "have a
   Ziggurat". One direction only — see `TOWN_COUNT_EQUIVALENTS` in
   [`ids.ts`](../src/ai/ids.ts). This is also why `SetBuildUnit(1, KEEP)` must be read as
   "upgrade the hall" and not "found a Keep": `setProduce` tries the tier route first, and an
   AI that skips it never leaves tier 1.

## A dead hero is a build row, and it is priced as a REVIVAL

Every race script's "always rebuild heroes for defense" branch asks for the hero by id, exactly
as it would for a fresh one — `GetUnitCountDone(hero_id)` reads 0 for a corpse — and the engine
turns that request into a revival. `setProduce` does the same (`reviveFallen`). Two things about
that row are not obvious from the call site, and getting either wrong produces the same symptom:
*the AI never revives its heroes.*

1. **A revival in progress has to COUNT.** A revive job carries the hero's own type id in
   `unitId`, but its `kind` is `"revive"` — so the census's queue walk skipped it, `count(hero)`
   read 0 for the whole minute an altar was bringing one back, and the ladder asked for the hero
   again on every pass. `reviveFallen` then refuses (the corpse is already spoken for, the altar's
   queue is full), `trainUnits` refuses too (WC3 offers you the revive button, never a second copy
   at full price), and the row spends the entire revival reserving gold for a hero already on its
   way — starving everything below it.

2. **It is not priced at what a hero costs.** A revival is priced off the hero's **level** —
   `originalCost × (ReviveBaseFactor + ReviveLevelFactor × (level−1))`, capped at
   `HeroMaxReviveCostGold` (`heroReviveCost`,
   [`gameplayConstants.ts`](../src/data/gameplayConstants.ts)). For a 425-gold hero that is **170
   at level 1**, 255 at level 3, 425 at level 7 and 552 at level 10. So `rowCost` reserving the
   *base* cost was wrong in **both** directions, and each way produces the same symptom:

   * *Below level 7 it over-reserves.* A unit row the loop cannot afford **halts** it, so the
     whole ladder waited for 425 gold to buy something that costs 170 — and every row under the
     hero starved for the length of that wait.
   * *Above it, it under-reserves.* The row is declared affordable, the rows below spend the
     difference, the `revive` command is refused by the authority for want of the real price, and
     `startUnit` reports success either way — so the altar stands empty and the ladder never
     notices.

   Priced honestly, `OneBuildLoop` saves for a revival exactly as it saves for anything else.

Both fixes are in the shared library ([`aiPlayer.ts`](../src/ai/aiPlayer.ts)), so the classic
melee AI and Computer+ get them together.

## A town is a gold mine

The scripts address towns by index — `HarvestGold(T+1, 5)`, `GuardSecondary(1, 2,
WATCH_TOWER)`, `MeleeTownHall(0, TOWN_HALL)`. Town 0 is the start location; every other town
is a mine `GetNextExpansion` has picked, in the order it picked them. `TownHasHall` asks for a
finished DEPOT rather than a hall, because for two races the thing that makes a mine yours is
the mine building itself (a Haunted Gold Mine pays its Acolytes where they kneel; an Entangled
Gold Mine pays the wisps inside it).

## Harvest slices are cumulative and ORDERED

```jass
call HarvestGold(T,4)      // four on the mine…
call HarvestWood(0,1)      // …then a lumberjack…
call HarvestGold(T,1)      // …then the fifth miner…
call HarvestWood(0,15)     // …then everyone else into the forest
```

They add up, and the order is the priority: the fifth miner is worth less than the first
lumberjack and the script says so by where it sits. Anyone already doing the right job counts
against a slice before anybody is moved — the plan is a target, not an order, or every miner's
trip resets once a second.

**"Go and work that mine" is a different order for each race.** Three walk into the shaft
(`harvest`); the night elf climbs INSIDE an Entangled Gold Mine (a `garrison`); the undead
kneels in a Haunted one's ring (a `harvest`, but only once the mine is haunted). The AI mirrors
`SimWorld.issueGoldWork` rather than guessing.

## `SetPeonsRepair` — every melee computer repairs, at every difficulty

```jass
call SetPeonsRepair(true)          // common.ai 792, inside StandardAI
```

It sits in `StandardAI`'s flag block beside `SetGroupsFlee` / `SetHeroesFlee` /
`SetIgnoreInjured`, with **no difficulty test on it**, and `StandardAI` is what all four race
scripts call. So a melee computer mending its buildings is not a Hard-and-above behaviour: both
AIs set `AiPlayer.peonsRepair` at seat time. The flag is GRADED in *campaigns* instead, which is
the only reason it is a flag at all — `CampaignAI` asks for it only at `MAP_DIFFICULTY_HARD`
(common.ai 2414), and individual chapters turn it on for themselves (`u08x05.ai`, `n07_red.ai`,
`h05x07.ai`, …).

**What the flag switches on is Blizzard's C++ and is in no file in the install**, so
`AiPlayer.applyRepairs` is ours and so is every number in it. Three decisions:

- **What.** Anything of ours that is FINISHED and under `REPAIR_AT` (90 %) of its life. A
  building still going up is *built*, not repaired — it already has a worker on it, and a
  structure hurt on the way up finishes hurt and is mended afterwards like any other.
- **In what order. The hall first, always** — sorted on *is it the hall* BEFORE *how hurt is
  it*, so a Farm at a tenth of its life never outranks a Town Hall at four fifths. No race list
  says which building that is: `UnitBalance`'s own `type` column carries **`TownHall`** on all
  twelve of them (`htow`/`hkee`/`hcas`, `ogre`/`ostr`/`ofrt`, `etol`/`etoa`/`etoe`,
  `unpl`/`unp1`/`unp2`) and on nothing else. It is the same column `siteFor` already picks a
  hall's building site by.
- **With whom. Two workers, ever** (`REPAIR_MAX`), the hall being the only thing allowed both.
  A raided base is damaged *everywhere*, so a per-building crew with no ceiling over it walks
  the whole economy into the rubble — and a computer that has stopped earning cannot pay for the
  repairs it has ordered, since `tickRepair` charges gold and lumber per hit point restored and
  abandons the job when the bank empties. Within that two, an IDLE worker is taken before a
  lumberjack before a **miner**: gold is what every other row on the build ladder is bought with.

Two things it deliberately does not decide for itself:

- **Whether this worker may mend that building.** Every repair row lists `nonancient` except the
  Wisp's Renew, so only a Wisp mends a Tree of Life; a Ghoul carries no repair row at all
  (`ugho` `abilList` = `Acan,Ahrl,Aiun`), so the undead mends with Acolytes or not at all. Both
  fall out of `SimWorld.repairRefusal`, which the pass asks per (worker, building) and does not
  second-guess.
- **When to stop.** The sim ends the job itself at full health or an empty bank, and the worker
  falls back to idle — where the next harvest pass picks it up. A worker already on a repair job
  is never re-tasked here, or the walk would restart every pass.

It runs BEFORE the harvest split in both AIs' build passes, so a worker sent to mend something is
already spoken for when the slices are filled (`applyHarvest` skips a worker on a repair job) and
the rest of the crew is redistributed around it. Pinned by
[`tools/ai-repair-test.cjs`](../tools/ai-repair-test.cjs).

## Night elf gold is a CAST, not a build order

`egol` (Entangled Gold Mine) is what `Aent` *creates*. It appears in no build array anywhere
and must never be handed to the placement code, so `AiPlayer.entangleMines` walks the player's
own rooted Trees each pass and casts Entangle on a free mine within `Rng1` = 500. That bound is
why `EXPANSION_HALL_RANGE` is 460: a Tree of Life planted further from its mine than that can
never wrap it. See [`night-elf.md`](night-elf.md).

## The captain

`common.ai` forms one attack group at a time. `SetMeleeGroup(id)` asks for three quarters of
what you have of a type (the hero, one, always), `FormGroup` musters them at home until every
row has its minimum, and `SingleMeleeAttack` picks what the wave is FOR, in this order:

1. town threatened → don't attack at all;
2. `needs_exp` → kill whatever is squatting on the next expansion;
3. deny an enemy expansion — gated on `IsTowered` and on an `exp_seen` patience counter that
   is 3 passes for an easy computer and 0 for a hard one;
4. siege available (and it is *daytime*, unless you have air) → the enemy's main base;
5. a creep camp whose total level is inside the window `force_level` opened;
6. failing all that, a minor camp (`GetCreepCamp(0, 9, false)`).

`CaptainRetreating()` is real and load-bearing: every race script's attack loop stalls on it,
and a group below 35% of its hit points goes home and stays "retreating" until it has healed to
70%.

## What is deliberately NOT ported

Each of these is engine machinery rather than a line of script, and each is marked at its site:

- **`GetMegaTarget` / `GetEnemyPower`** — an all-out attack keyed on the engine's running
  estimate of an opponent's army strength.
- **`SetAllianceTarget` / `GetAllianceTarget`** — allied computers agreeing on one target over
  a channel we have no equivalent of.
- **Zeppelins** (`PurchaseZeppelin`, `LoadZepWave`) — buying a Goblin Zeppelin and airlifting a
  wave into a base.
- **`SetHeroesBuyItems`, `SetHeroesTakeItems`, `SetSmartArtillery`** — the rest of the
  `StandardAI` behaviour switches. (`SetPeonsRepair` is no longer among them — see below.)
- **`MergeUnits` / `ConvertUnits`** — Hippogryph Riders and Obsidian Statues → Destroyers.

## The difficulty spread

A slot picks one of three computers, from the same menu on both screens that build player rows
(`SLOT_OPTIONS` in [`src/ui/playerSlots.ts`](../src/ui/playerSlots.ts) — which since issue #124
holds Computer+'s three as well, and `slotOptionsFor` picks which trio a screen shows). The labels are the
game's own — `UI\FrameDef\Glue\GlobalStrings.fdf` writes `COMPUTER_NEWBIE "Computer (Easy)"`,
`COMPUTER_NORMAL "Computer (Normal)"`, `COMPUTER_INSANE "Computer (Insane)"` — and the value
that rides through the lobby to `MeleeAi.add` is `MeleeDifficulty()` itself: common.ai's
`MELEE_NEWBIE` 1 / `MELEE_NORMAL` 2 / `MELEE_INSANE` 3.

**The interesting part is where each difficulty actually lives, because it is not one place.**

**Easy is entirely in the SCRIPT**, and it is the only one that is. `MeleeDifficulty()` is called
40 times across the five files (common.ai 7, human.ai 7, orc.ai 10, elf.ai 10, undead.ai 6) and
**every single one of them tests `MELEE_NEWBIE`**. What they buy:

| what an easy computer gives up | where |
|---|---|
| `SetGroupsFlee` / `SetHeroesBuyItems` / `SetSmartArtillery` / `SetTargetHeroes` / `SetUnitsFlee`, all of them `not isNewbie` | `StandardAI`, common.ai 781. The switches themselves are [not ported](#what-is-deliberately-not-ported), so this row is the one place easy is not yet a difference |
| every upgrade past rank 1 — `SetBuildUpgr` drops the row outright | common.ai 1024 → `AiPlayer.setBuildUpgr` |
| its second hero, until a Keep/Stronghold/Castle/Tomb stands (and, night elf, four Moon Wells) — plus the night elf's third hero | the `heroId2`/`heroId3` rows of all four race files → the `newbie` flag in [`human.ts`](../src/ai/human.ts) and its three siblings |
| its towers, its tier-2/3 production and its extra barracks — the bulk of the 40, each a `!= MELEE_NEWBIE` around a build row | the same four files |
| denying an expansion promptly: it must see one three times first (normal-with-allies once; everyone else acts immediately) | common.ai 2220 → `MeleeAi.pickTarget` |
| its opening four minutes, and a minute between every wave after | common.ai's `Sleep(240)`/`Sleep(60)` → `NEWBIE_FIRST_WAVE_DELAY`/`NEWBIE_WAVE_GAP` |

**Insane is entirely in the ENGINE.** `MELEE_INSANE` appears exactly ONCE in all five files —
the line that declares the constant (common.ai 664). Nothing ever tests it. That is the tell: an
insane computer runs the same build order and the same attack ladder as a normal one. Everything
it gets is outside the script, and there are two things — both long documented by the community
rather than by any file in the install (see the citations at
[`INSANE_HARVEST_FACTOR`](../src/ai/ids.ts)):

1. **It is paid double.** A load its workers carry home is credited twice over —
   `SimWorld.setHarvestBonus`, applied at the DEPOSIT. Not at the pickup: the mine gives up its
   usual ten gold and runs dry on everyone's schedule. An insane computer is paid double for the
   same digging, it does not dig faster.
2. **It ignores the fog of war.** `AiPlayer.knows` is the gate, and an insane player passes it
   unconditionally while everyone else must have the spot under their own viewpoint's eyes right
   now. Two questions go through it: *has an enemy hall appeared somewhere the map never
   promised one* (`enemyExpansion`) and *is that hall under towers* (`isTowered`). What is
   **not** gated is not an oversight — the enemy's MAIN base and the creep camps are map data
   every melee player is handed, which is why every computer creeps from the first minute and
   why its waves have always known where to walk.

**Normal is the absence of both**, which is why it is the middle rung and why it was the only one
seated for so long.

## Spells — the one part with no script to port

**A computer's units cast.** [`casting.ts`](../src/ai/casting.ts) is the chooser, on its own
half-second clock beside the 2s build pass and the 1s attack pass, and it is the one thread of
`src/ai/` that is **not** a transcription — because there is nothing to transcribe. The four
race files decide what a hero LEARNS (`set skill[1] = HOLY_BOLT`, spent by `SetHeroLevels`) and
then say nothing about using it. Casting is the engine's:
[`tinkerworx-repos.md`](reverse-engineering/tinkerworx-repos.md) has it as a `heroAbility`
object hung off `CUnit` beside `attackAbility`/`moveAbility`/`buildAbility`, i.e. C++ in
`Game.dll`.

So it is reconstructed from OBSERVATION of the real client, and there is one systematic record
of that observation:

> **Boris_Spider, "Base Abilities for Custom Spells used by AI Casters"** —
> <https://www.hiveworkshop.com/threads/base-abilities-for-custom-spells-cast-by-melee-game-ai-units.193280/>
> (approved tutorial, last updated 2014-08-16, eleven named contributors)

Every row of `CAST_RULES` quotes the line it came from. **This is a weaker source than the rest
of `src/ai/`** — a thread of careful observations rather than Blizzard's own file — and the code
says so at each site, so a later correction knows what it is correcting.

### What the thread establishes, and why the file is shaped the way it is

1. **The AI casts a BASE ABILITY, not a spell.** That is the thread's whole subject: a custom
   map's "Thunderwrath" based on Carrion Swarm is cast exactly when Carrion Swarm is, because
   the engine only ever sees `code`. So `CAST_RULES` is keyed on `code` — the same seam
   `SPELL_HANDLERS` and `KNOWN_ABILITIES` already use, and the reason a custom map gets AI
   casting for free.
2. **An ability the engine has no rule for is never cast** — "the AI will never cast spells
   based on Channel-Special". A code that reaches `classDefault` with nothing to derive is left
   alone rather than guessed at.
3. **Autocast is the same code path.** "Autocast spells have the same 'event for firing' for
   their autocast and for their AI use (which means their autocast doesn't have to be enabled
   for IAs)" (post 20). We already have that path — `SimWorld.tickAutocast`, a working,
   data-driven "should this unit cast right now" — so the AI **arms** every autocast it owns and
   lets the sim run them. That is Heal, Inner Fire, Slow, Bloodlust, Curse, Faerie Fire, Frost
   Armor, Abolish Magic, Ensnare, Web, Raise Dead, Get Corpse and every arrow orb, with none of
   it restated here. Three are held back and each says why in `HAND_AUTOCAST`/`NEVER`.
4. **Transform abilities are the one blanket exclusion** — "except for transform abilities like
   Destroyer Form/Bear Form/Crow Form", and post 44 gives the reason: a morph is a different
   unit type and the AI "would think he lost a unit".

### The traps, all of them real

- **A unit already casting is skipped.** Blizzard, Starfall, Tranquility and Death and Decay are
  CHANNELLED, and a fresh order is what cancels a channel — a chooser running twice a second
  without this would start Starfall forever and finish it never.
- **A buff already in force is not re-applied**, to the caster (Immolation, Divine Shield,
  Avatar, Mana Shield) or to anybody else (Shadow Strike, whose thread entry states the rule
  outright). This is the sim's own autocast doctrine (`autocastWants` → `findBuffFrom`), matched
  on the ability's own `buffid` list. **Immolation is why it matters on the caster**: `AEim` is
  a TOGGLE, so re-pressing it puts it out.
- **Force of Nature is aimed at the TREES.** `[AEfn] targs1` is **"tree"** and nothing else —
  the one point spell in the game whose target is not a body. Scored like an area nuke it went
  down on whichever ENEMY caught the most bodies, which is a spot with trees in it only by luck:
  `SimWorld.fellTrees` raises one Treant per felled trunk, so a point with no tree inside `Area1`
  (150) summons nothing at all and still spends `Cost1` 100 and `Cool1` 20. `treeAim`/`treeSpots`
  are the answer, and they are shared with Computer+ (`src/ai/plus/casting.ts`) because the
  ability's shape is the same for both: a treeline within `Rng1` 800, and of those the one
  nearest the FIGHT — Treants last `Dur1` 60 seconds and spend it walking if they are raised in
  the forest behind the hero.
- **Workers are the economy's.** `isPeon` and anyone mid-harvest/build/repair is left alone.
- **Legality is asked of the sim.** `castUseError`/`castError` — the click-time gate — decide
  mana, cooldown, the upgrade requirement, Targets Allowed, spell polarity and "is there even a
  corpse". The chooser only decides WHICH of the legal targets, so it can never be more
  permissive than the button, and every cast still leaves through `RtsController.execute`.

### The two judgement calls, argued rather than guessed

- **How many bodies an AoE wants: 2** (`CLUSTER`). The thread states it for every area spell it
  describes and never varies — "at least 2 to 3 units in a group", "2+ enemies standing in the
  AoE", "2 or more enemy units close". The LOW end, because the same thread reports single-target
  casts slipping through ("I've had breath of fire casted when I was fighting 1 unit vs 1 unit").
- **How hurt a caster has to be to panic: it doesn't.** "~Divine Shield - Casts when attacked …
  The health of the unit isn't a factor for it's casting", so the trigger is *taking damage*, not
  a health bar. The one health number the thread does give is Cannibalize's "usually around 50%
  HP or less", and that is `NEAR_DEATH`, shared with Wind Walk's "near death". Heals use a
  separate `HURT` = 0.75, which IS ours — the thread says only "significant/moderate damage".

### What is deliberately not cast

`NEVER` lists them with a reason each: the transforms, Far Sight ("Unused") and Death Pact
("Never"), the economy errands that belong to other parts of `src/ai/` (Entangle is
`AiPlayer.entangleMines`', Renew is the worker's job), and — flagged as OUR call rather than the
thread's — the abilities that trade a whole unit for one cast (Kaboom!, Unstable Concoction) and
the army-logistics spells the thread records nothing about (Blink, Mass Teleport, the staves).

### Verifying it

[`tools/ai-casting-test.cjs`](../tools/ai-casting-test.cjs) (`pnpm sim:test`) drives the chooser
over a real `SimWorld` — the legality gate has to be the real one or the test tests nothing —
and each case quotes the thread line it checks. Live, `?dev&map=EchoIsles&ai=insane` plus a
staged fight shows Purge, Sentry Ward, Shock Wave, War Stomp and Feral Spirit going off inside
the first seconds, and every caster dry a few seconds later: **mana is what paces this**, not the
clock.

## Who seats a computer: the MAP does

Nothing in the engine decides that a slot plays itself. `MeleeStartingAI` — the seventh action of
a melee map's *Melee Initialization* trigger — walks the twelve slots, keeps the ones that are
`PLAYER_SLOT_STATE_PLAYING` **and** `MAP_CONTROL_COMPUTER`, and hands each one its race's script
through `PickMeleeAI` → `StartMeleeAI(p, "orc.ai")`. That native is our seam
([`natives/melee.ts`](../src/jass/natives/melee.ts) → `EngineHooks.startMeleeAI` →
`RtsController.startMeleeAIFor`), and the **filename names the race** — `elf.ai`, not
`nightelf.ai` — because our four race files are ports of those four files.

The lobby still owns what the script cannot know: where the seat starts, at what difficulty, off
which match seed. `RtsController.prepareMeleeAI` records that during match setup and seats
nobody; the script does the seating.

This is not bookkeeping. It is what makes the melee AI a **melee** rule instead of an engine
rule: a map that leaves the action out of its init trigger gets no computer opponents, a custom
(use-map-settings) map — which runs none of the melee library — gets none either, and a campaign
chapter gets none because its script never asks. We used to start the AI from `beginMatch` for
every non-campaign map, so a custom map's computer slots were handed a melee build order the real
game would never have given them. The one place that still seats a computer without a script is
`MapViewerScene.startMeleeFallback`, and only because it stands in for a melee map's missing
script wholesale (roster, purse, hero caps and all).

## Where it runs, and why it cannot cheat

`RtsController.tick` drives `MeleeAi` inside the branch a frozen LAN client never enters, so
the AI thinks once per match rather than once per machine, and its decisions reach clients as
ordinary snapshot state. **Every decision leaves as a `Command` through
`RtsController.execute`** — the same door, and the same ownership/cost/tech/food judgement, a
human player's click gets. There is no route by which a computer could buy something it cannot
afford or build something it has not teched to, because there is no second route at all.

Two consequences worth keeping:

- The AI never touches `SimWorld.random()`. That stream is part of the match's identity; an AI
  drawing from it would advance it on the host and nowhere else. It has its own Park–Miller
  stream, seeded from the match seed plus the slot index.
- A campaign chapter gets **no** melee AI — and now for the game's own reason rather than ours:
  its script never calls `MeleeStartingAI` (see above). Its computers are the mission's, driven by
  its own triggers; handing them a build order would have Illidan's Naga putting up Moon Wells.

## Testing it

`?dev&map=EchoIsles` seats you against a computer. Advanced Options → Visibility → **Always
Visible** on the Custom Game screen (`src/ui/fdfSkirmish.ts`) turns the whole map on, which is
how you watch a base go up without scouting it.
