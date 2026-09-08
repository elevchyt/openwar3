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
| **Threat ladder** (below level 7): a **summon** first, then whatever is **attacking the camp** (an Ancient of War included), then armed units, unarmed, buildings, and last workers/wards, **ensnared melee** units and anything whose **aggro has been dropped**. Nearest within a tier. | 176; warcraft-gym; Grubby | `threatTier`, `attackingCreeps`, `creepScore` |
| **The aggro-drop trick**: a unit ordered to attack ITS OWN SIDE is no threat, and it STAYS no threat after the order is cancelled — only a deliberate attack order back onto an enemy ends it. And a camp in a fight only ever moves UP a rung: it does not re-decide, so the dropped unit is not picked back up. | 176; warcraft-gym; Grubby's video | `SimUnit.aggroDropped`, `issueAttack`, `threatTier`, the re-pick in `tickCreep` |
| **Level 7+**: summon > hero > **lowest hit points**, among what is in weapon reach; the ladder for the rest. The retarget trick does not work on them. | warcraft-gym; Wowpedia; 176 | `creepScore`, `CREEP_SMART_LEVEL` |
| **Level 6+** take a spell's HERO duration ("Hero magic resistance"). | patch 1.03 | `dur()` in spells.ts |
| A resting camp **ignores a flyer under a plain move**; one that stops overhead, or attack-moves, is fair game. | patch 1.10; Wowpedia | `bestCreepTarget(idle)` |
| A **poisoner** (Envenomed Weapons / Slow Poison / Poison Sting) turns to the nearest unpoisoned body after each victim wears its poison, before the ladder. | Wowpedia; 176 | `unpoisonedTarget`, tickCreep |
| A creep on a **tower** breaks off under **60 %** of its own health and does not return fire on it while walking home. | Wowpedia | `CREEP_TOWER_FLEE_HP`, tickCreep, `provoke` |
| **Ensnare** goes on non-heroes that ENTER its 500 after the fight began; what was already inside is exempt. | 176 | `SimUnit.ensnareSeen`, `trackEnsnareSeen`, `autocastWants` |
| **Lightning Shield** wants the wearer touching two others (three in `Area1` 160). **Purge** prefers a summon. **Hurl Boulder** prefers the hero. **Slam** wants three. | 176; warcraft-gym | `CAST_RULES` in casting.ts |
| **Frost Armor / Inner Fire / Bloodlust** (any friendly autocast that is not a heal) go on the ally IN THE FIGHT — the one under attack first, then one that is swinging — and **never on the caster while there is anybody else**: an Ogre Magi buffs the Ogres and takes its own Bloodlust as the last one standing. A buff already worn is not work, so the second cast finds the second body. | warcraft-gym; maintainer vs. the real client | `autocastTarget`, `fightSides`, `autocastWants` |
| A creep that is **HIDING gets up when its camp is attacked** — the meld is lying in wait, and so is the Hold Position it parked the unit on. | Liquipedia (Hide); maintainer | `unhideCreep`, `tickCreep`, `alertCamp`, `provoke`, `tickAutoMeld` |
| **Ensnare's net is picked per target**: the AIR buff row or the GROUND one (`Bena`/`Beng`, told apart by their `EditorSuffix`), and the Birth/Stand/Death set for the SIZE of the body it landed on. | `[Aens] buffid1`; the models' own clip names | `netFx` in spells.ts, `bodySize`, `AbilityRegistry.domainBuff`, `sizedSeq` |
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

## The creep abilities themselves

[Wowpedia's "Warcraft III creep abilities"](https://wowpedia.fandom.com/wiki/Warcraft_III_creep_abilities)
is the archive of the sixty-odd abilities a creep can carry, with the numbers on each. Fetch it
through the wiki's own API (`api.php?action=parse&prop=text`) — the rendered page is behind
Cloudflare, and the wikitext is nothing but template transclusions.

Every ability on it is now implemented. Most were already there as ALIASES (a creep row whose
`code` is a racial ability's: `ACbb`/`ACbl` → `Ablo`, `ACen` → `Aens`, `ACvs` → `Aven`). The
ones that were not fell into two groups, and both are worth recognising again:

**A creep row with a code of its OWN, twinning something we had.** Invisible from the call site,
because the effect exists and the id simply never reaches it.

| Creep row | Twin | What was missing |
|---|---|---|
| `ACtb` Hurl Boulder | `AHtb` Storm Bolt | The golems threw nothing. Same shape: `Ctb1` 100 damage, `Dur1` 2 s stun, `Rng1` 800, `Cool1` 8, `BPSE`. |
| `ACtc` Slam (`ACt2` on the Thunder Lizard) | `AHtc` Thunder Clap | 70 damage, 0.25/0.25 slow, `Area1` 250, `Dur1` 4 s, `BCtc`. |
| `ACdv` Devour | `Adev` Kodo Devour | The dragons, the Dragon Turtle and the Salamander Lord swallowed nobody. |
| `ACrn` Reincarnation | `AOre` Tauren Chieftain's | The Centaur Khan, Ancient Sasquatch and Ancient Wendigo never got up — and `tryReincarnate` also required a HERO, which no `ACrn` carrier is. |
| `ANin` Inferno | `AUin` Dreadlord's | The creep/Pit Lord row summoned nothing. |

**Abilities with no implementation at all**, each now reading its own named columns
(`Units\AbilityMetaData.slk` field groups through `UI\WorldEditStrings.txt` — never inferred):

- **Frenzy** `Afzy` (quillbeasts). Bloodlust's own field group: `Blo1..Blo3` is declared
  `useSpecific = "Ablo,ACbl,Afzy"`, so DataA 0.4 attack speed and DataB 0.25 movement are
  Bloodlust's columns. It is a SELF-target autocast (`targs1` "air,ground,self", no `friend`),
  a shape `tickAutocast` did not have: the friendly search looked for somebody else and found
  nobody. It fires with the buff not already up and a fight on — the fight half is ours.
- **Hardened Skin** `Assk` (Mountain Giant; `Ansk` on the Dragon Turtle, same code).
  `Ssk1..Ssk5` = chance 100 %, **Minimum Damage 3**, **Ignored Damage 12**, include ranged 1,
  include melee 1. It lives in `applyDamage` and nowhere else, which is what confines it to
  ATTACKS — a spell reaches `landDamage` directly.
- **Permanent Immolation** `ANpi` (the Infernal; `Apig` is the same code). Immolation with the
  toggle taken off — `Cost1` and DataB "Mana Drained per Second" are 0 — so it is the existing
  machinery ALIGHT FROM BIRTH (lit in `recomputeStats`) rather than a second copy. The one
  guard it needs: the buffer-mana test would read "mana ≤ 0" and douse a unit that has no mana
  pool at all.

**Two column reads that were wrong or missing**, both found by asking the metadata rather than
the behaviour:

- **Devour's digest rate is not on the Devour button.** `Dev1` is **"Max Creep Level"** for
  `useSpecific = "Adev,ACdv"` — DataA on both — and the damage lives on the HOLD that carries
  the prey, `Advc` "Cargo Hold (Devour)", whose `Dev2` is "Damage per Second" (DataB). Both read
  5, so reading DataA gave the right number off the wrong column; the creep's own Ubertip cites
  `<Advc,DataB1>` and settles it. (The Kodo's says `DataC1`, which is `Dev3` "Maximum Creep
  Level" — Blizzard's typo, invisible because both are 5.)
- **The Max Creep Level was never enforced**, so a Kodo Beast could swallow a level 10 Dragon.
  It is the second member of `CREEP_LEVEL_CAP`, which is now a map of code → column because
  Transmute keeps its cap in DataC and Devour in DataA. The refusal is the game's own
  `Creeptoopowerful` line. (A dragon is refused for magic immunity before the level is asked.)

## Three abilities that were half there

- **Inferno** (`AUin`, and `ANin` under the creep code) never applied its STUN, which is most
  of what the ultimate is for: `Dur1`/`HeroDur1` 4/2 with `BuffID1 = BNin` are the stun, and
  the handler read them as nothing at all. It also landed everything at the press, where
  `Uin3` **"Impact Delay"** = 1 s says the meteor is in the air first — so the damage arrived
  a second before the picture of it. `SimWorld.startInferno` now plays `Effectart`
  (`InfernalBirth.mdl`, once) at the press and lands the damage, the stun and the demon
  together a second later. The Infernal that stands up is the Permanent Immolation carrier
  above, so the two arrived in the same pass.
- **Reincarnation** revived INSTANTLY, which left `Ore1` "Reincarnation Delay" (5 s on the
  hero row, 7 on the creep's and the Ankh's) unspent and the effect with nothing to mark. The
  unit is now DOWN for that window — `vanished`, the state a Blademaster spends mid-Mirror-
  Image and a hero spends inside a Soul Gem, so it is off the field, untargetable and
  unorderable — and `ReincarnationTarget.mdl` stands over the spot: Birth, then Stand held for
  the window, then its DEATH clip as the unit rises. That lifecycle is the new `"hold"`
  `EffectAnim` (world.ts) and its handling in `spawnEffect`/`updateEffects`. The Ankh of
  Reincarnation goes through the same door with its own three columns (`AIrc` DataA delay 7,
  DataB restored life 500, DataC restored mana −1 = keep).
  **The trap:** an invulnerability buff plus a stun is NOT the way to hold a unit down — an
  invulnerability RISING strips status effects (Divine Shield's own rule), so the stun comes
  off in the same breath it goes on.
- **Hide** (`Ashm`) was a button nobody pressed. It takes itself now: a unit that can meld and
  is simply STANDING THERE — `idle` or `hold`, not moving, not swinging, not casting — melds
  by itself at night, which is how the ability is actually met (nobody clicks Hide on every
  Archer every night). The FADE is the row's own `Shm1` **"Fade Duration" = 1.5 s**, which
  Liquipedia's Hide page prints and which was already the buff's `delay`. The Cloak of Shadows
  (`[clsd] abilList = Ashm`) is the same row carried, and on 1.30.4 it is night-only too — its
  own Ubertip says "invisibility at night", and the daytime version is a 1.31 change.

  **…and it GETS UP when the camp is attacked.** A meld breaks on what the melded unit DOES —
  it moves, it swings, it casts — and a creep lying in wait does none of those, so nothing
  that happened to somebody ELSE could reach it: the camp died around an invisible Murloc
  Nightcrawler. `SimWorld.unhideCreep` is the break, called from the two places a camp learns
  it is in a fight (`alertCamp`'s shout and `tickCreep`'s standing check) and from `provoke`
  for the ambusher somebody has found and hit — before `provoke` reads `passive`, since a
  cloaked unit never returns fire. It takes the HOLD back off with the meld (melding is what
  parked the unit there), or the camp's own cohesion and `tickAcquire` cannot move it; and
  `tickAutoMeld` refuses to re-meld a creep whose camp is fighting, or it would vanish again
  on the next tick it stood still. Creeps only: a night elf player's melded Archer is not
  roused by her neighbours being shot at.

## The aggro-drop trick, and why it kept wearing off

"You do this by issuing an attack with the attacked unit onto one of your other units. Your
initial unit will no longer be viewed as a threat and the creeps will therefore change their
target" (warcraft3.info 176; warcraft-gym and Grubby's video say the same). The order is then
CANCELLED a fraction of a second later — a Stop, a step, or a Hold — so the blow never lands
on your own Peasant.

Two things were wrong, and each on its own put the camp straight back on the unit the player
had just saved:

- **The drop was read off the LIVE order** (`attackingCreeps`), so it lasted exactly as long
  as the player held the order down. The cancel is not an afterthought in this trick, it is
  step two of it. `SimUnit.aggroDropped` remembers it instead, and only a DELIBERATE attack
  order back onto an enemy clears it — never a swing the unit takes by itself, because the
  cancel the guides recommend is often a HOLD, and a holding unit goes on striking whatever
  walks into its range. (The engine's own reading agrees from the other side: what puts a unit
  on the "attacking us" rung is having an attack ORDER on a creep, and a holding unit has no
  attack order at all.)
- **The half-second re-pick was a re-decision rather than an upgrade.** It compared the full
  `creepScore`, which carries the within-tier tie-break `- gap` — right for choosing a target
  out of a crowd, wrong for re-opening a fight already joined, because the unit a camp is
  chewing on is nearly always the closest thing to it. So any equal-rung neighbour that
  drifted a few units nearer took the camp off its target, twice a second, and the tricked
  unit — back on the ordinary armed rung the moment the drop lapsed — was the nearest of them.
  Below level 7 the re-pick now needs a strictly HIGHER rung: an ally that starts hitting the
  camp, a summon walked in front of it, or the current target dropping a rung. A level 7+
  creep keeps the full comparison, which is why the trick "does not always work" on those.

## The net: one spell, four models, three sizes

Ensnare is the one spell whose art is chosen per TARGET, twice over, and both halves are in
the data rather than in the handler:

- **Which model.** `[Aens] buffid1 = Bena,Beng` — an AIR row wearing
  `ensnare_AirTarget.mdx` on the target's `chest,mount`, and a GROUND row wearing
  `ensnareTarget.mdx` at its origin. The only thing in the data that says which is which is
  the strings file's `EditorSuffix`: " (Air)" and " (Ground)" (`AbilityRegistry.domainBuff`
  reads it). **The air row is listed FIRST**, so the ordinary "buffs[0]" reading every other
  ability wants — `buffIdOf` still does it — dressed every ensnared Footman in the flyer's
  net. Web is the same shape (`Bwea,Bweb` → `Web_AirTarget.mdx` / `WebTarget.mdx`) and takes
  the GROUND row: Web lands on a flyer and leaves it on the ground, which is where it spends
  the buff.
- **Which clips.** Both models ship Birth/Stand/Death three times over — plain, `Medium` and
  `Large` — because a net over a Peasant and one over a Kodo Beast are one model at three
  sizes. (`ensnare_AirTarget.mdx` writes "Death medium" in lower case; matching is
  case-insensitive.) The plain set IS the small one. Which set a cast wants is `SimWorld.
  bodySize` and rides on the buff as `BuffFx.anim`; the renderer spends it in `sizedSeq`, and
  a model with only one set falls back to it. WC3 states no size CLASS anywhere, so the
  classes are read off the two numbers that measure a body and **the thresholds are ours**: a
  ground unit by its COLLISION, which the game gives every walker in exactly three sizes
  (16 / 31–32 / 48), and a flyer by its model SCALE, because collision is not a size for a
  flyer at all — every player air unit carries 8 (they do not collide) while the creep dragons
  carry 48.

The MISSILE needed nothing: `[Aens] Missileart = EnsnareMissile.mdl` at `Missilespeed` 1500,
so `resolveCast` throws it like any other unit-target spell with a missile, and the renderer
already flies a missile on its `Stand` clip (`missileSequence`).

**When a creep presses these** is `src/ai/creeps.ts` plus the sourced rules in `CAST_RULES`.
Hurl Boulder's is `heroMana` — "The Golem will prioritize to target hero units that are
attacking it" (warcraft3.info 176) plus "often prioritizing Heroes or casting units" (the
Wowpedia summary) — and that second rung is deliberately NOT given to Storm Bolt, whose own
source says heroes and nothing else.

## Open, and worth measuring against the real client

- **Where Hardened Skin sits in the damage pipeline.** The data names the two numbers and not
  their order. It is applied LAST here, after armour and the attack-type multiplier, because
  that is the only order under which the row's own guarantee — never below `Minimum Damage` —
  is true; reduced first, a Footman's 12.5 floors at 3 and is then taken under it by six points
  of armour.
- **Reincarnation's delay.** `Ore1` "Reincarnation Delay" is 5 on the hero row and 7 on the
  creep's; the revive is immediate for both here, as it is for the Ankh.
- Whether the "Camp" flag does anything beyond the 200 (deafness to construction is an
  inference), and the creep Shockwave's quorum (the hiveworkshop thread says 2, warcraft-gym
  says 3 for the Ogre Lord; the thread's 2 is kept).

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
  by its own account. Liquipedia is behind Cloudflare for a plain fetch but answers its API with
  `curl --compressed` (it refuses an uncompressed API request outright).
- A headless check of a damage-over-time field wants the caster DISARMED and the victims on
  HOLD: an Infernal that is also punching makes its own burn unreadable (10 a second read as
  45), and an idle ally rallies to the fight (`assistTarget`) and walks into the circle it was
  placed outside.
