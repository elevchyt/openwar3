# Reference projects & research sources

Open-source projects we lean on (see plan §3 for roles). **Rule of thumb: treat references as
hypotheses — verify format/behavior claims against the real game data in `Warcraft III/` before
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
| [TinkerWorX/warcraftIII](https://github.com/TinkerWorX/warcraftIII) | RE'd engine **class layouts** (`CAgent`→`CWidget`→`CSelectable`→`CUnit`, `CAbility`, `AbilityLevelData`) + IDA native/import scripts — ground truth for how the engine models units/abilities/orders | IDA dumps (mostly `field_XX`); use the **named** fields. Notes in [`reverse-engineering/tinkerworx-repos.md`](reverse-engineering/tinkerworx-repos.md). Don't lift code |
| [TinkerWorX/Blizzard.Net.Warcraft3](https://github.com/TinkerWorX/Blizzard.Net.Warcraft3) | C# model of WC3 **statistics/replay data** (`UnitInfo`/`HeroInfo`/`ItemInfo`/… + race/player/slot enums) | Cross-check for enum values & record shapes, not engine internals. Same notes doc |
| [Liquipedia Warcraft](https://liquipedia.net/warcraft/Main_Page) | **Primary engine-behavior reference** — attributes, XP, damage/armor, corpses, per-ability mechanics with exact numbers | Reachable via WebSearch; cross-check numbers against the MPQ SLKs |
| [warcraft3.info](https://warcraft3.info/) | Engine-mechanics articles (hero XP, damage, etc.) | JS-rendered — WebFetch returns only the title; read via WebSearch summaries |

## Researching game mechanics

For gameplay semantics that aren't in any file format (turn rate, damage timing, acquisition,
upkeep, …), **check [Liquipedia's Warcraft wiki](https://liquipedia.net/warcraft/Main_Page) and
Hive Workshop threads first** — both have empirically documented most mechanics. Example: turn rate
semantics came from
[How does Turn Rate work? (thread 129619)](https://www.hiveworkshop.com/threads/how-does-turn-rate-work.129619/)
— the object-editor value is radians per 0.03 s internal frame, capped at ~0.2 rad/frame.

**When the AI casts a spell** is documented in exactly one place, and it is an observation
thread rather than a file: [Base Abilities for Custom Spells used by AI Casters (thread
193280)](https://www.hiveworkshop.com/threads/base-abilities-for-custom-spells-cast-by-melee-game-ai-units.193280/)
by **Boris_Spider** (approved tutorial, eleven contributors, last updated 2014-08-16). It lists
~70 BASE abilities with the trigger the melee AI is observed casting each on — "Storm Bolt …
has preference to target heroes", "Blizzard/Rain of Fire … at least 2 to 3 units in a group",
"Divine Shield - Casts when attacked … the health of the unit isn't a factor", "Death Pact -
Never", "Farsight - Unused" — plus the one blanket exclusion (transform abilities) and the
observation that an autocast's AI use and its autocast are the same event. It is the whole
source behind [`src/ai/casting.ts`](../src/ai/casting.ts); see [`melee-ai.md`](melee-ai.md).
**Gotchas:** several entries are listed with no trigger recorded (a bare dash) and a few are
disputed in the replies (Frost Nova's "every cool down", Breath of Fire's cone quorum), so it is
weaker evidence than a data file — treat a rule from it as a hypothesis and say in the code that
it came from here.

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

**Weapon types and missile DISJOINTING** (verified 2026-09-01 from
[Liquipedia Weapon Types](https://liquipedia.net/warcraft/Weapon_Types)): a *Missile* shot "will miss
if one of the following conditions is met during any time of the missile's traveling" — the target
goes **invisible**, is **loaded into another unit** (Orc Burrow, Goblin Zeppelin, Devour), is
**teleported**, or **dies** — and "abilities with missiles follow the same behaviour as the Missile
weapon type", which is why Blink disjoints a Storm Bolt as readily as an arrow. An invulnerable target
takes no damage but the missile still arrives. **Distance is not on that list.** The *Range Motion
Buffer* (`RngBuff1/2`) is stated only under **Normal** and **Instant** — the two weapon types that put
nothing in the air — and decides whether the attack instance is created at all; hive
[thread 53615](https://www.hiveworkshop.com/threads/range-motion-buffer.53615/) says the same in one
line: *"Missile and Artillery-type attacks are unaffected by RMB."* So the widely repeated "a missile
dies at base range + RMB" is folklore — there is no flight-distance cap in the data, and none is
invented here. Implemented as `missileDisjointed` in `src/sim/world.ts`
(`tools/sim-missile-disjoint-test.cjs`).

**[warcraft3.info](https://warcraft3.info/) articles** are another solid engine-behavior source. Its
[Hero Experience](https://warcraft3.info/articles/232/hero-experience-in-warcraft-3-how-it-works)
article pins the XP-award side (verified 2026-07-03): a slain **level-1 unit grants 25 XP**, and a
level-L unit grants `XP(L-1) + 5·(L+1)` → 25/40/60/85/115… XP is **shared among the killing side's
heroes within 1200 range** of the dying unit (if none are in range it's awarded globally with no
distance loss); **summoned units give 50%**; creeps use the reduction table above.

Practical notes:
- hiveworkshop.com blocks direct fetching (403) — go through a web search engine and read cached
  summaries, or search for the thread title. Liquipedia pages are reachable via WebSearch too.
  **Workaround that works:** `curl` (or any fetch) with a real browser `User-Agent` header returns the
  full page — that's how the Game.dll thread below was archived.
- **Liquipedia now 403s that trick too** (Cloudflare Turnstile, as of 2026-09). Its MediaWiki API
  still answers, but only to a request that asks for gzip and names itself — the page's wikitext,
  which is what you want anyway:
  `curl -s --compressed -A "OpenWar3-research/1.0 (contact: …)" "https://liquipedia.net/warcraft/api.php?action=parse&page=Weapon_Types&format=json&prop=wikitext"`
  (without `--compressed` it returns *406 Gzip encoding is required for API requests*).
- Warsmash's source is the next stop: it encodes many of these findings as code.
- When a mechanic matters for gameplay feel, write the source (thread/repo) next to the constant in
  the code.

### Calibrate a screenshot reference on something you render identically

Most of our visual references are frames lifted from YouTube, and **a YouTube frame is soft**. Ours
is not. Compare the two directly and every textured surface in the reference reads as lower detail
than ours, which invites a hunt for a rendering fault that is not there.

Find something in the frame that both sides draw from the *same* art at the *same* size and use it
as a control. On the glue screens that is the sprite-layer chrome — the metal panel, its rivets and
its chains are one model rendered through an orthographic camera, so if our render is right they
should be identical.

Worked example, the main menu against the issue #107 reference (`?dev&menudebug`, headless Chrome at
1280×720). Detail measured as mean |Laplacian| ÷ the region's own standard deviation, which divides
out the fact that haze lowers contrast and so lowers |Laplacian| for free:

| region | reference | ours | ours after σ=0.6 blur |
| --- | --- | --- | --- |
| chrome (panel, quit panel, chains) | 0.271 | 0.451 | **0.273** |
| tower rock | 0.421 | 0.663 | 0.500 |
| island mass | 0.309 | 0.486 | 0.345 |
| left ice spikes | 0.278 | 0.264 | 0.197 |
| ocean | 0.147 | 0.213 | 0.174 |

The chrome fixes the capture's softness at **σ ≈ 0.6 px**, and once that same blur is applied to the
whole frame the scene lands on the reference too. So the entire "their scene is blurrier" gap is the
capture. What is left after it is the *haze*, which is a `MenuScene.tuning` question rather than a
renderer one.

Things that were checked and are **not** the cause, so nobody re-checks them: the scene's textures
are 256×256 (512 for the sky) with full internal mip chains — 7 to 10 levels, none of them BLP1's
"fake mipmaps" trick, all power-of-two — so `viewer/handlers/blp/texture.js` takes its
`LINEAR_MIPMAP_LINEAR` branch and we render trilinear, as the original does. `MainMenu3D_Exp` has no
second material layer and no second UV set anywhere in its 18 geosets, so there is no shading or
lightmap pass being skipped. The `*_mip1/2/3.blp` files sitting next to the textures in the install
look like a hand-authored LOD chain but are the artists' source files: `Chains_silver_mip1.blp` is a
standalone 32×16 BLP with its own 6-level chain, no MDX references it, and the chain that is actually
used is the one inside `Chains_silver.blp`.

### Specific threads / videos used

- **Engine internals / `Game.dll` structure.** The [Reverse Engineer Game.dll thread (268718)](https://www.hiveworkshop.com/threads/reverse-engineer-game-dll.268718/)
  — archived locally at [`reverse-engineering/game-dll-thread.md`](reverse-engineering/game-dll-thread.md).
  User **A Void** dumped the C++ source strings and the `Game.pdb` source tree out of `Game.dll`, exposing the real
  class names (`CUnit`, `CAbility*`, `CWidget`, `CGameUI`, the `frame`/`framedef`/`fdfile` FDF UI system, the `glue`
  menus) and the data-file/asset names the engine reads. Use it to name/shape our subsystems to match the original.
- **Map (`.w3m`/`.w3x`) internal file manifest.** [thehelper.net "Explanation of w3m and w3x files" (35292)](https://www.thehelper.net/threads/explanation-of-w3m-and-w3x-files.35292/)
  — a plain-language index of every chunk file inside a map MPQ (terrain `.w3e`, pathing `.wpm`, placed
  objects `.doo`, info `.w3i`, triggers `.j`/`.wtg`/`.wct`/`.wts`, the `.w3u`…`.w3q` object-data tables, etc.).
  Written up (cross-checked against the bundled maps, OpenWar3's parsers noted) in the **Maps** section of
  [`wc3-data-formats.md`](wc3-data-formats.md). Complements the `w3x-spec` byte-layout reference above.
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

## JASS scripting references

For the JASS side of the engine — the language the map's `war3map.j` is written in and the
`common.j`/`blizzard.j` libraries the engine runs (see the interpreter plan in
[`phase7-triggers-jass-plan.md`](phase7-triggers-jass-plan.md)). **Same rule as everywhere else:
the `Scripts\common.j` / `Scripts\blizzard.j` in the user's own install are ground truth** —
these third-party docs describe the *language and the standard API*, but where a native's exact
signature or a library function's body matters, read it out of the real MPQ. common.j pins the
canonical **1160 natives / 91 handle types** and blizzard.j the **923 library funcs** we measured
(see the plan doc); the docs below are for humans, the MPQ is for the parser.

| Source | What it is | Use it for / gotchas |
|---|---|---|
| [**JASS Manual** (jass.sourceforge.net/doc)](https://jass.sourceforge.net/doc/) | A semi-formal, unofficial **language reference** — global declarations, types (arrays, casting), functions, statements, expressions, and a **formal BNF grammar**, plus an API browser | The precise spec for our `lexer.ts`/`parser.ts` (§7.0): grammar edge cases, array-size cap (1024), type-coercion rules, operator/precedence quirks. Explicitly **not** a beginner tutorial. Unofficial — cross-check any interpreter-behaviour claim against the real script running in the game |
| [**Jassbot** (lep.nrw/jassbot)](https://lep.nrw/jassbot/) | A **Hoogle-style search engine over the JASS2 standard API** — indexes `common.j`, `blizzard.j`, `common.ai`; search by name *or by type signature* (`takes handle returns integer`) | Fast native/BJ lookup while implementing `natives/` — find a native by name, or discover all funcs of a given shape. Also has a CLI + open dataset on GitHub. It indexes **some** patch's scripts, not necessarily ours — confirm signatures against our mounted install before relying on them |
| [**thehelper.net "JASS: Basic Tutorial"** (view=25715)](https://world-editor-tutorials.thehelper.net/cat_usersubmit.php?view=25715) | A **beginner tutorial** — function calls, local/global variables (the `udg_` global prefix, `bj_`/`gg_` conventions), custom functions, comments (`//`), operators | Orientation for how hand-written and GUI-compiled map scripts are actually shaped (variable naming conventions we'll meet in `war3map.j`), not a spec. For depth defer to the JASS Manual above |
| [**thehelper.net World Editor / Triggers tutorials**](https://world-editor-tutorials.thehelper.net/triggers.php) — [tutorial index](https://world-editor-tutorials.thehelper.net/cat_usersubmit.php) · [FAQ](https://world-editor-tutorials.thehelper.net/faq.php) | The most complete catalogue of **GUI trigger *semantics*** — what each Event / Condition / Action actually does (floating text, regions, unit groups, waits, camera, cinematics), i.e. the human meaning of the natives our interpreter runs | The reference the trigger work ([`triggers.md`](triggers.md), issue #33) leans on for *behaviour*: when a native's job isn't obvious from `common.j`, this explains what the corresponding GUI action is supposed to do. Older pages assume the classic WE; the *effect* is what we mirror, cross-checked against the real script + game. Fetch with a real browser `User-Agent` if a plain fetch is blocked |
