# Creeps — how a Neutral Hostile camp behaves

Read this before touching `tickCreep` / `threatTier` / `creepScore` / `bestCreepTarget` in
[`src/sim/world.ts`](../src/sim/world.ts), the creep caster in [`src/ai/creeps.ts`](../src/ai/creeps.ts),
or the creep seeding in `RtsController.trySeed`. Almost nothing here is a tuning value: a camp's
behaviour is a handful of RULES that players have measured for twenty years, and each one is
quoted next to the code that carries it. The checks are `tools/sim-creep-sleep-test.cjs`,
`tools/sim-creep-spells-test.cjs` and `tools/sim-creep-behaviour-test.cjs` (`pnpm sim:test`), the
last two built from the install's own unit and ability rows.

## Sources

The game's own numbers first (`Units\MiscGame.txt` `GuardDistance` 600 / `MaxGuardDistance` 1000 /
`GuardReturnTime` 5 / `CreepCallForHelp` 600; `Units\MiscData.txt` `BuildingPlacementNotifyRadius`
600, `NeutralUseNotifyRadius` 900; `UnitData.slk canSleep`; `UnitAbilities.slk abilList`/`auto`).
For what no file states:

- **warcraft3.info, "Interacting With Creeps" (article 176, rechram)** — the aggro/threat rules
  and the five "triggered" creep abilities (Lightning Shield, Purge, Envenomed Weapons, Ensnare,
  Hurl Boulder). JS-rendered; fetch the article HTML with a browser `User-Agent`.
- **warcraft-gym, "A summary on creep mechanics and how to abuse them"** (barren, 2021) — the
  retargeting trick, level-7 targeting, Frost Armor, Shockwave/Slam counts, pulling.
- **Wowpedia, "Creep"** — the classic battle.net creep-basics text plus the 1.03/1.10 patch notes
  (level 6+ resistance, level 7+ intelligence, "creeps that are not in combat now ignore flying
  units"), the "500 or 200" acquisition note and the tower-retreat line.
- **Hive 15660 ("Creep Camp")** — the editor's "Camp (200)" setting; Hive 193280 (Boris_Spider)
  for when a caster presses a button, shared with the melee AI (docs/melee-ai.md).

## The rules, and where each lives

| Rule | Source | Code |
|---|---|---|
| A **Camp** creep stirs at **200**, a Normal one at its weapon's `acquire` (500 on nearly all). The .doo stores -1/-2/N; the 200 is the editor's label, never in the map. Camp creeps are also deaf to construction. | Wowpedia "500 or 200"; Hive 15660 | `CREEP_CAMP_ACQUIRE_RANGE`, `trySeed` |
| Once FIGHTING, a creep looks as far as its own weapon's acquisition, not the 200 it was pulled at. | (inference: the Riflemen at 500 are fought like anybody) | `creepFightRange` |
| **Threat ladder** (below level 7): a **summon** first, then whatever is **attacking the camp** (an Ancient of War included), then armed units, unarmed, buildings, and last workers/wards and **ensnared melee** units. Nearest within a tier. A unit told to attack its own side drops a rung and the camp walks off it. | 176; warcraft-gym; Grubby | `threatTier`, `attackingCreeps`, `creepScore` |
| **Level 7+**: summon > hero > **lowest hit points**, among what is in weapon reach; the ladder for the rest. The retarget trick does not work on them. | warcraft-gym; Wowpedia; 176 | `creepScore`, `CREEP_SMART_LEVEL` |
| **Level 6+** take a spell's HERO duration ("Hero magic resistance"). | patch 1.03 | `dur()` in spells.ts |
| A resting camp **ignores a flyer under a plain move**; one that stops overhead, or attack-moves, is fair game. | patch 1.10; Wowpedia | `bestCreepTarget(idle)` |
| A **poisoner** (Envenomed Weapons / Slow Poison / Poison Sting) turns to the nearest unpoisoned body after each victim wears its poison, before the ladder. | Wowpedia; 176 | `unpoisonedTarget`, tickCreep |
| A creep on a **tower** breaks off under **60 %** of its own health and does not return fire on it while walking home. | Wowpedia | `CREEP_TOWER_FLEE_HP`, tickCreep, `provoke` |
| **Ensnare** goes on non-heroes that ENTER its 500 after the fight began; what was already inside is exempt. | 176 | `SimUnit.ensnareSeen`, `trackEnsnareSeen`, `autocastWants` |
| **Lightning Shield** wants the wearer touching two others (three in `Area1` 160). **Purge** prefers a summon. **Hurl Boulder** prefers the hero. **Slam** wants three. | 176; warcraft-gym | `CAST_RULES` in casting.ts |
| **Frost Armor / Inner Fire / Bloodlust** (any friendly autocast that is not a heal) go on the ally under attack first. | warcraft-gym | `autocastTarget`, `targetedIds` |
| A creep **casts only while its camp is in a fight**; Heal is the one autocast it runs at rest. A casting creep counts as fighting. | (the whole reason a camp does not Cyclone passers-by) | `creepInFight`, `creepAggroed`, `tickAutocast`, `CreepView.engaged` |
| **Sleep**, **call for help**, leash and return, the placement and shop notifications. | MiscGame/MiscData; creep basics | `tickCreep`, `alertCamp`, `notifyCreepsOf*` — see the code |

## The three wiring bugs that made "creeps are missing their abilities"

None of the effects were missing — every creep ability is an alias of an implemented code
(`ACbb`/`ACbl` → `Ablo`, `ACen` → `Aens`, `ACvs` → `Aven`) except Hurl Boulder and Slam, which
have codes of their own (`ACtb`/`ACtc`, now handled). What was wrong:

1. **Map-placed creeps were seeded with no card at all.** `trySeed` built weapons and stats and
   passed no `abilities`; every other route into the sim builds them. So nothing on any melee
   map's creeps existed to cast — and no golem was spell-immune, since `recomputeStats` reads
   `Amim`/`Arsk` off the card.
2. **The `auto` column names the BASE CODE on a creep** (`nomg auto=Ablo`, `abilList=ACbb`) and
   the slot id on a player unit (`hmpr auto=Ahea`). Read as a slot id it armed no creep autocast
   (`autoArmed` in data/units.ts).
3. **The creep copies keep the racial `Requires`** (`[ACen] Requires=Roen`), and a neutral
   player researches nothing. A neutral owner meets every requirement (`SimWorld.techMeets`) —
   the same rule, seen from the other side, is the quirk that a charmed Trapper's Ensnare goes
   dark for a player without the upgrade.

And nothing pressed a creep's NON-autocast buttons: the melee AI casts for its seats and Neutral
Hostile has none. `src/ai/creeps.ts` is that caster — the same `AiCaster` and the same thread-
sourced rules, gated on the camp being in a fight, leaving through `issueCast` on the authority.

## Traps

- `creepInFight` walks the camp (`campFightTarget`); ask it on an edge or for the few creeps that
  need it (the trapper's snapshot), not per unit per tick.
- A creep's death ends the fight for its camp-mates; `ensnareSeen` resets and is re-taken when the
  next fight begins, with whoever is inside 500 THEN exempt. A test that lets the puller die reads
  as "Ensnare never fires".
- `t.building` is the BuildingState object, not a flag: a headless test that spawns a tower with
  `null` there has spawned a unit that happens to look like a tower.
- Reddit and YouTube are unreachable from the dev box (HTML shell / no data blocks); the video
  guides listed in the task (carsonnn's three-part creeping guide, Grubby's) overlap article 176
  by its own account.
