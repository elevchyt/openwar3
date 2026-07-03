# Reference projects & research sources

Open-source projects we lean on (see plan §3 for roles). **Rule of thumb: treat references as
hypotheses — verify format/behavior claims against the real 1.27a MPQs in `Warcraft III/` before
building on them** (the cliff-ramp naming scheme is the cautionary tale: HiveWE's code was
incomplete; the MPQ file list settled it).

| Project | What we use it for | Notes / gotchas |
|---|---|---|
| [mdx-m3-viewer](https://github.com/flowtsohg/mdx-m3-viewer) | Rendering + all WC3 parsers (our base, patched via `patches/`) | No ramps, no tileset cliff/tree textures, MPQ header search bug — all fixed in our patch |
| [HiveWE](https://github.com/stijnherfst/HiveWE) | Terrain/cliff/ramp/pathing reference (`src/base/terrain.ixx`) | Best ramp reference, but misses 2-layer (X/H) ramps and hardcodes the CliffTrans dir — cross-check with MPQ data |
| [Warsmash](https://github.com/Retera/WarsmashModEngine) | Behavioral reference for sim, orders, JASS natives | Java; ≥1 GPL dep — study, don't lift |
| [war3-model](https://github.com/4eb0da/war3-model) | Alternative TS MDX parser/renderer | Oracle for MDX parsing diffs |
| [w3x-parser](https://github.com/voces/w3x-spec) | `.w3m/.w3x` format reference | |
| [StormLib](https://github.com/ladislav-zezula/StormLib) / [CascLib](https://github.com/ladislav-zezula/CascLib) | MPQ/CASC correctness reference | CASC only matters for §9 |
| [Nowar-Sans-War3](https://github.com/nowar-fonts/Nowar-Sans-War3) | Multi-language game font (Friz Quadrata replacement), OFL 1.1 | Bundled at `public/fonts/NowarSans.ttf` |
| [Liquipedia Warcraft](https://liquipedia.net/warcraft/Main_Page) | **Primary engine-behavior reference** — attributes, XP, damage/armor, corpses, per-ability mechanics with exact numbers | Reachable via WebSearch; cross-check numbers against the MPQ SLKs |
| [warcraft3.info](https://warcraft3.info/) | Engine-mechanics articles (hero XP, damage, etc.) | JS-rendered — WebFetch returns only the title; read via WebSearch summaries |

## Researching game mechanics

For gameplay semantics that aren't in any file format (turn rate, damage timing, acquisition,
upkeep, …), **check [Liquipedia's Warcraft wiki](https://liquipedia.net/warcraft/Main_Page) and
Hive Workshop threads first** — both have empirically documented most mechanics. Example: turn rate
semantics came from
[How does Turn Rate work? (thread 129619)](https://www.hiveworkshop.com/threads/how-does-turn-rate-work.129619/)
— the object-editor value is radians per 0.03 s internal frame, capped at ~0.2 rad/frame.

**[Liquipedia Warcraft](https://liquipedia.net/warcraft/Main_Page) is a top-tier source for how the
engine behaves** — attributes, experience, damage/armor tables, upkeep, day/night, and per-ability
mechanics are all documented with exact numbers. Especially useful pages:
[Hero](https://liquipedia.net/warcraft/Hero) · [Experience](https://liquipedia.net/warcraft/Experience)
· [Corpse](https://liquipedia.net/warcraft/Corpse) · [Abilities index](https://liquipedia.net/warcraft/Abilities).
Verified from it (2026-07-03): each Agility point = +0.30 armor & +attack speed; each Intelligence
point = +15 mana & +0.05 mana-regen/sec; each Strength point = +25 HP & +0.05 HP-regen/sec; a hero's
primary attribute also adds +1 base damage/point. Hero XP to **reach** level L = `100·(L(L+1)/2 − 1)`
(200/500/900/1400/2000…; increment to next level = 100·(L+1)); creeps grant reduced XP via the
`[80,70,60,50,0]%` reduction table indexed by the killing hero's level.

**Auras** (verified from the MPQ `AbilityData.slk` + [Liquipedia Aura](https://liquipedia.net/warcraft/Aura),
2026-07-03): all are passive, affect the caster + nearby allies in `area1` (900), non-stacking (highest
wins). Codes → effect (dataA per level): **Devotion `AHad`** +armour (1.5/3/4.5); **Brilliance `AHab`**
+mana-regen/sec (0.75/1.5/2.25) — note the Archmage's aura is `AHab`, `AHbn` is *Banish*; **Endurance
`AOae`** +move & attack speed % (0.1/0.2/0.3); **Trueshot `AEar`** +ranged attack-damage % (0.1/0.2/0.3,
ranged units only); **Unholy `AUau`** +move speed % (dataA) & +hp-regen/sec (dataB 0.5/…); **Vampiric
`AUav`** melee life-steal % (0.15/0.3/0.45); **Command `AOac`** +attack-damage % (0.1); **Thorns `AEah`**
returns melee damage % to the attacker (0.1/0.2/0.3). Implemented via the generic `AURA_BUFFS` table
(`src/sim/spells.ts`) + `applyAuras`/`recomputeStats` (`src/sim/world.ts`).

**[warcraft3.info](https://warcraft3.info/) articles** are another solid engine-behavior source. Its
[Hero Experience](https://warcraft3.info/articles/232/hero-experience-in-warcraft-3-how-it-works)
article pins the XP-award side (verified 2026-07-03): a slain **level-1 unit grants 25 XP**, and a
level-L unit grants `XP(L-1) + 5·(L+1)` → 25/40/60/85/115… XP is **shared among the killing side's
heroes within 1200 range** of the dying unit (if none are in range it's awarded globally with no
distance loss); **summoned units give 50%**; creeps use the reduction table above.

Practical notes:
- hiveworkshop.com blocks direct fetching (403) — go through a web search engine and read cached
  summaries, or search for the thread title. Liquipedia pages are reachable via WebSearch too.
- Warsmash's source is the next stop: it encodes many of these findings as code.
- When a mechanic matters for gameplay feel, write the source (thread/repo) next to the constant in
  the code.

### Specific threads / videos used

- **Unit selection = collision shapes, not the mesh.** WC3 picks a unit by its model's
  **CollisionShape** (box/sphere), sized from the pathing/collision value — clicking the mesh is
  wrong. Our picker uses the unit's collision + selection-scale radius projected to screen.
  - [Collision Shapes — how to make your model selectable](https://www.hiveworkshop.com/threads/collision-shapes-how-to-make-your-model-selectable.156930/)
  - [Collision Size](https://www.hiveworkshop.com/threads/collision-size.309631/)
  - [Pathing/collision size values into real values](https://www.hiveworkshop.com/threads/pathing-collision-size-values-into-real-values.271205/)
- **Orders / command system** overview: [WC3 basic commands & orders (YouTube)](https://www.youtube.com/watch?v=EehNLL7yYng)
- **Core game rules (buildings, workers, rally, upkeep, etc.)** — the official
  classic WC3 "basics" pages are the ground truth for how the game actually works;
  consult them (and update code/docs to match) when building gameplay systems:
  [Buildings](https://classic.battle.net/war3/basics/buildings.shtml) ·
  [the whole basics index](https://classic.battle.net/war3/basics/). Notes captured from these:
  rally points send trained units to a set location (or a resource, for workers);
  buildings under construction can be paused (Human) by pulling the worker off;
  the command card's bottom row is reserved for a hero's learned abilities.
- **Order-feedback + cursor models** (verified via Warsmash + the stock
  `Scripts\SharedMelee.pld` preload inside War3.mpq): the move/attack-move marker is
  `UI\Feedback\Confirmation\Confirmation.mdx` (one model, green-tinted for move,
  red for attack-move); rally flags are `UI\Feedback\RallyPoint\*RallyFlag.mdx`; the
  cursor is `UI\Cursor\<Race>Cursor.blp/.mdx` with "Normal"/"Target" states. Building
  models reveal all geometry only at the END of their "Birth" clip (each building has
  `Birth`[0,60000] then `Stand`) — the build-placement ghost scrubs Birth to its last
  frame so it shows fully built. Start-location props use `Objects\StartLocation\
  StartLocation.mdx` and are hard-coded by the viewer with an undefined data row.
- **Melee tech tree rawcodes** (which building trains/builds what) verified against the
  [wc3edit rawcode list](https://forum.wc3edit.net/viewtopic.php?t=2648) + StrategyWiki building
  pages. Encoded in `src/data/techtree.ts` (curated — WC3 stores these in ability object-data
  that's costly to parse). Corrections found: Human Workshop is `harm` (trains hmtm/hgyr/hmtt), Orc
  Raider `orai` is at the Beastiary, the NE hero altar is `eate` (Ancient of War `eaom` trains
  archer/huntress/glaive).
