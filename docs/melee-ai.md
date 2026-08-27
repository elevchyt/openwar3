# The melee AI

> Read this before touching anything in [`src/ai/`](../src/ai/), the `MeleeStartingAI` path, or
> a computer player's behaviour. Issue #119.

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

## Night elf gold is a CAST, not a build order

`egol` (Entangled Gold Mine) is what `Aent` *creates*. It appears in no build array anywhere
and must never be handed to the placement code, so `MeleeAi.entangleMines` walks the player's
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
- **`SetPeonsRepair`, `SetHeroesBuyItems`, `SetHeroesTakeItems`, `SetSmartArtillery`** — the
  `StandardAI` behaviour switches.
- **`MergeUnits` / `ConvertUnits`** — Hippogryph Riders and Obsidian Statues → Destroyers.

## The difficulty spread

A slot picks one of three computers, from the same menu on both screens that build player rows
(`SLOT_OPTIONS` in [`src/ui/playerSlots.ts`](../src/ui/playerSlots.ts)). The labels are the
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

## Hero spells — not done, and what it would take

**The AI's heroes learn their spells and never cast them.** `SetHeroLevels(SkillArrays)` spends
the points down each race's own `set skill[N] = …` list, so an AI Archmage really does end up
with Blizzard at rank 3 — it simply never presses it. Deferred deliberately; this section is the
handover.

**There is no script to port, and that is the whole difficulty.** The four race files decide
what a hero LEARNS and then say nothing about using it. Casting is the engine's:
[`tinkerworx-repos.md`](reverse-engineering/tinkerworx-repos.md) has it as a `heroAbility`
object hung off `CUnit` beside `attackAbility`/`moveAbility`/`buildAbility`, i.e. C++ in
`Game.dll`. So this one has to be **designed**, which is exactly why it is not in yet — the
rest of `src/ai/` is a transcription with the file's own numbers behind every branch, and this
would be the first part with none.

What the sources do give:

- **`StandardAI` sets `SetTargetHeroes(not isNewbie)`** (common.ai 779–810). A computer above
  Easy aims at HEROES first. That is the only targeting preference the scripts state out loud,
  and it should be the one this obeys.
- **`SetSmartArtillery`, `SetIgnoreInjured`, `SetHeroesFlee`** sit in the same block and are the
  neighbours of the same behaviour. `SetHeroesFlee(true)` in particular pairs with any
  panic-cast rule — a hero that runs and a hero that shields are the same decision.
- **Everything about WHEN a spell is legal is already in the ability's row**, in the same terms
  `SimWorld.tickAutocast` reads them: `targs1` separates friend from foe (and `self` lets the
  caster be its own target), `Rng1` is reach, `Area1` is the patch, `Cost1` and `Cool1` are the
  gates. `tickAutocast` is the model to follow — it is a working, data-driven "should this unit
  cast right now" that hard-codes no ability list.

A sketch that got as far as compiling, kept here so the next attempt starts past it:

- Classify each learned ability from its own row rather than from a per-spell table (which
  would be a second copy of `KNOWN_ABILITIES` that could drift): `unitid1` set → a **summon**;
  `targs1` naming `dead` → a **raise** (Resurrection, Animate Dead — and these must count
  `SimWorld.corpses` through `corpseAdmits` first, or the ultimate is spent on empty ground);
  friend-only flags or a `POLARITY_SPELLS`/`HEAL_SPELLS` entry → a **heal**; an `Area1` with a
  non-unit target → an **AoE**; a unit target → a **nuke**; the rest → a **self-buff**.
- Gate the lot on an enemy actually being within the hero's own `acquire` — a hero crossing the
  map must not open with Avatar, and one standing at home must not summon wolves to watch it
  mine.
- **Skip a hero whose `order` is already `"cast"`.** Blizzard, Starfall, Tranquility and Death
  and Decay are CHANNELLED, and a fresh order is what cancels a channel: a chooser that runs
  twice a second would start Starfall repeatedly and finish it never. This is the trap.
- One cast per hero per pass, on a clock of its own (~0.5s) rather than the 2s build rhythm.

The two judgement calls with no data behind them, which is where it should be argued rather
than guessed: how many bodies an AoE wants under it before it is worth the mana, and how hurt a
hero has to be before it spends a Divine Shield on itself.

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
- A campaign chapter gets **no** melee AI. Its computers are the mission's, driven by its own
  triggers — handing them a build order would have Illidan's Naga putting up Moon Wells.

## Testing it

`?dev&map=EchoIsles` seats you against a computer. Advanced Options → Visibility → **Always
Visible** on the Custom Game screen (`src/ui/fdfSkirmish.ts`) turns the whole map on, which is
how you watch a base go up without scouting it.
