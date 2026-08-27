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
- **The difficulty spread.** Every `MeleeDifficulty()` branch is ported and the whole ladder
  works, but the Custom Game screen only offers "Computer (Normal)", so `MELEE_NORMAL` is what
  every slot is seated at today.

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
