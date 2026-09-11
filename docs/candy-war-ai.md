# Computer+ on Extreme Candy War

`src/ai/plus/candy/` — a hero player for Blizzard's own Halloween lane map,
`Maps\FrozenThrone\Scenario\(10)ExtremeCandyWar2004.w3x`. Read this before touching any of it.

## Why it exists at all

A scenario runs none of the melee library, so no script ever calls `StartMeleeAI` and nothing seats a
computer. In the real game a computer put in a hero seat on this map stands in the hero picker for the
whole match. Computer+ plays it: `MapViewerScene.startCustom` recognises the map by its script
(`isCandyWarScript` — the four triggers `Pick_Heroes` and `Crate_Detection_North/Middle/South`, never
the file name) and hands the lobby's computers in the ten HERO seats (0–4 Horde, 6–10 Alliance) to
`RtsController.startCandyWarAI`. Seats 5 and 11 are the map's own ARMY computers and are never ours.

Every computer hero seat gets Computer+, whatever the Advanced Options switch says: the classic AI is a
melee build order and has nothing to play here.

The same standing rules as the melee Computer+ (docs/computer-plus.md): authority-side only, every
decision leaves through `PlusHost.execute` (the door a click goes through), and **no cheats at any
difficulty**. Every number in the AI's own files is OURS; every map fact is cited in `map.ts` against
the trigger, rect or object it came from.

## The map in one screen

The full reference is in the source comments of `map.ts`; the rules that shape the AI:

- **Winning is escorting.** Each lane has an invulnerable candy monster (`hmtt` top, `h001` mid, `h002`
  bot). It walks only while ONE side's living, unstealthed heroes are within **600** of it
  (`Crate_Detection_*`, every second) — away from them. Creeps never push it. Reaching the far end kills
  that lane's enemy Candy Mage; three dead mages remove the enemy Candy Vault's invulnerability, and the
  vault's death is victory (`Horde_Victory` / `Alliance_Victory`).
- **Healing** is the Fountain of Power (`nfnp`, +2% life and mana a second within 500) in the shopping
  area, and nothing else. An enemy hero entering your shopping area is teleported out.
- **Death** is not an altar. The corpse stays where it fell (Neutral Passive, paused, invulnerable) and
  an invisible ghost appears at the graveyard. Once the timer (5 + 2×level) is up, the ghost within
  600 of its corpse gets `AEsb` (free, 70% life), within 300 of the Spirit Healer `ANbr` (full, costs
  level×30 XP) or at level 10 `AAns` (400 gold). The player has to walk the ghost and press it.
- **Items** have hard slot rules enforced by trigger (1 weapon, 1 armour, 2 accessories, 1 artifact,
  plus sapper-only and sapper-forbidden lists). A breaking pick-up is destroyed and refunded — to the
  wrong player in two triggers — so the AI keeps to them itself (`mayCarry`).
- **Spells** are rebuilt on unrelated bases (Fireball is Firebolt, Eviscerate is Finger of Death), so
  the AI keys everything on the map's own ability ids and casts each with its own `SimAbility.code`
  (a cast command is matched on the BASE code — `SimWorld.findAbility`).

## How it plays (`index.ts`)

1. **Pick** through the map's own trigger. `Pick_Heroes` fires on `EVENT_PLAYER_UNIT_SELECTED` and has no
   controller check — the only reason a computer never gets a hero is that it never selects anything. So
   the computer selects a costume twice (`RtsController.selectForAi`, raised in `drainSelectionEvents`
   beside the local player's), after `udg_GameOn` says the intro is over, and the map creates the hero
   and hands it Boots of Haste and a Scroll of Teleportation itself. It picks for the TEAM (`choosePick`):
   a healer if there is none, a front line if there is none, never a class already on its side if
   another is free.
2. **Parity, not a cheat.** `Initialize_Players` gives a PERSON +300 gold and food cap 10 under a
   `MAP_CONTROL_USER` filter. The seat gets exactly those two (`START_GOLD` / `START_FOOD_CAP`). The
   user-made `ExtremeCandyWarAI.w3x` (Maps\Download) sets its computers to 550 gold and creates their
   items from nothing; it was studied for the shape of a computer on this map and nothing was lifted.
3. **Lane split** (`pickLane`): the lane with the fewest of its side, counting the other computers,
   the lanes people CLAIMED in chat ("im going top"), and where a quiet person's hero is standing. It
   says its lane on the allies channel as it leaves the base.
4. **The objective** (`laneMove`), in order: an enemy vault that has lost its shield; this lane's
   monster while the enemy mage it would kill is alive (escort it, standing behind it within 600,
   farming what comes at it, and waiting for creeps before walking it under a tower); this lane's
   monster on OUR half while our mage is alive (stand by it — two sides within 600 freeze it); else
   another lane with something left, or the lane's buildings with the creeps.
5. **Fights** (`decide` / `chooseTarget` / `worthFighting`): a free swing at a hero in reach when it is
   safe (harass), a commit when the fight reads as won — its side against theirs as √Σ(life × damage),
   a tower with nobody else to shoot counted against it — and a kill it is close to. It announces who it
   is going in on ("going in on the undead warlock", `heroCallName`: class name, given name when there is
   one) and joins what an ally near it is visibly fighting or has declared.
6. **Leaving** at `retreatHp`, when a fight has turned, or (casters) out of mana — to the fountain, until
   `returnHp`. With three of them on it and a bad read it tells the team to back off.
7. **Spells** (`spells.ts`) per class, keyed on the map's ids and the map's triggers (Charge teleports
   past 200, Frost Nova roots within 500, Eviscerate spends combo points, Hellfire burns the caster,
   Mana Burn refuses sappers). One cast per pass, through `castError` first.
8. **Items**: a legal class build (`BUILDS`), then a potion, then the team's creep upgrades; potions,
   hastes, the blink dagger, the teleport scroll home or to an ally who called for help.
9. **Death**: walks the ghost to the corpse when that is not a trap, else to the Spirit Healer.

## The difficulties (`profile.ts`)

The brief: "reaction times, nuke capabilities/combos etc. (easy should be easy, normal should be normal
and insane should be very hard/skilled)".

| | Easy | Normal | Insane |
|---|---|---|---|
| looks every | 1.1 s | 0.55 s | 0.2 s |
| spell delay into a fight | 1.5 s | 0.6 s | 0.05 s |
| misclicks | 35% | 12% | 0 |
| combos (disable → burst, interrupts) | no | yes | yes |
| holds finishers for the kill | no | no | yes |
| reads a fight / harasses / focuses | no | yes | yes |
| last-hits | no | no | yes |
| retreats at / returns at | 18% / 60% | 30% / 85% | 35% / 95% |
| tower sense, items, class builds | no | yes | yes |

## Chat (`chat.ts`)

Allies channel: lanes, engages, following an ally in, falling back (for itself — news — or for the team —
a call), deaths, kills, "careful, 3 heroes mid". All channel: a light, candy-flavoured line after some
kills (the developer asked for jokes here; issue #124's no-jokes rule is the melee computer's) and an
occasional "wp" when it dies.

It HEARS a call for help (answers yes or no and why, and comes — by scroll when it is far), a rally
("attack", "lets push mid" — answered, and the lane taken), an engage on a named enemy hero (joined
silently), "back!" (backs off when close), and lane claims. **Its own lines must never read as calls**
— `tools/ai-plus-candy-test.cjs` runs every one of them through `readCandyCall`.
