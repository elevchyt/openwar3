# Orb effects

An **orb effect** is an *attack modifier*: something that rides a unit's ordinary blows
instead of being cast. The name comes from the orb ITEMS, but the family is much wider than
the shop — the arrow abilities, the Dryad's Slow Poison, the Spell Breaker's Feedback, the
Frost Wyrm's Frost Attack and the Mask of Death's life steal are all orbs — and the one rule
that binds all of them is:

> **Only one orb effect can ride a blow.**

Six orbs on a hero do not stack; five of them do nothing. That is the whole reason this needs
a subsystem rather than five independent handlers.

Implementation: [`src/sim/orbs.ts`](../src/sim/orbs.ts) (the family, the tiers, the picker),
`resolveOrb` / `applyOrbEffect` / `orbAttachments` in [`src/sim/world.ts`](../src/sim/world.ts),
`collectOrbAttachments` in [`src/render/mapViewer.ts`](../src/render/mapViewer.ts). Checked by
`tools/sim-orb-test.cjs` (`pnpm sim:test`).

## The priority ladder

Straight off [Liquipedia's Orb page](https://liquipedia.net/warcraft/Orb) § Priority, in its
own order:

1. **Arrows** have the highest priority
2. **Mask of Death** has the highest priority of all items
3. **Items** have a higher priority than **passive abilities**
4. All orbs have the same priority
5. If multiple orbs are in one inventory, their **position** determines which is active

Liquipedia does not say *which* position wins. The concrete answer is a player test in
[r/warcraft3, "Do two orbs cancel each other's effect?"](https://old.reddit.com/r/warcraft3/comments/1ewa65h/do_two_orbs_cancel_each_others_effect/):
two orbs in slots 1 and 2, and the **slot-2** orb is the one that fires; a second reply in the
same thread puts it as *"6 having the highest orb priority"*. So **later slot wins**.

Two consequences worth stating outright, because they are the ones players get wrong:

* A Priestess of the Moon with Searing Arrows switched **on** gets *no* benefit from any orb
  in her bag. Turn the arrows off (or run her out of mana) and the orb takes over — an arrow
  the caster cannot pay for is not a candidate at all.
* Giving a Dryad an orb **switches her Slow Poison off** for as long as she carries it.

## What is *not* exclusive

Two things an orb gives are properties of **carrying** it, and the ladder never sees them.

**The flat damage bonus.** Every orb item's tooltip words it as a carried stat — *"Adds 5
bonus damage to the attack of a Hero when carried"* (`Units\ItemStrings.txt`, `oven`) — i.e. a
Claws of Attack line. The reddit thread says the same: *"1) flat attack bonus… will always
stack. It will function as a claw."* So three orbs really is +21 damage on the sheet, and one
effect. It is summed in `itemBonuses`, not in the orb path.

**The air attack.** *"The Hero's attacks also become ranged when attacking air"* is pure data
once you notice that **every hero ships a second, dormant weapon**:

| | slot 1 | slot 2 |
|---|---|---|
| `Hpal` Paladin | 100 range, melee, `ground,structure,debris,item,ward` | 500 range, homing missile, **`…,air,…`** |
| `Obla` Blademaster | 100 range, melee, no `air` | 500 range, homing missile, **`air`** |

`weapsOn = 1` keeps slot 2 off. The orb switches it on through `DataE`, which
`Units\AbilityMetaData.slk` row **`Iob5`** names **"Enabled Attack Index"** (0..2) and which
every orb item sets to `2`. Mask of Death carries no `Iob5` at all — which is exactly why it
is the one "orb" that does **not** let a melee hero hit air, a point the reddit thread has to
correct a poster on.

**That dormant slot owns the hero's `Missileart`, and it is a trap.** A melee hero's UnitFunc
row carries a projectile model — `Ewar` Warden → `WardenMissile.mdl`, `Edem` Demon Hunter →
`DemonHunterMissile.mdl`, the Brewmaster's and the Gargoyle's the same — and it belongs to
**slot 2**, the shot the orb wakes. Those models occur *nowhere else* in the install: no
ability, no other unit. So "the row names a missile, therefore this unit shoots" hands a melee
hero a projectile the real game never throws, plus that missile's impact sound where WC3 plays
none (Warden's `unitUI` `weap1` is `_` — her audible blow is her model's own SND event). The
column that decides is **`weapTp`, per slot**: `normal` is melee and shows no art at all,
`instant` is ranged hitscan whose art is a one-shot burst on the unit struck (all six stock
`instant` slots name a `*Impact.mdx` holding a lone "Birth" sequence — nothing to loop in
flight), and only the `missile`/`msplash`/`mbounce`/`mline`/`artillery`/`aline` kinds fly.

That rule lives in exactly one function, **`slotMissileArt()`** (`src/data/units.ts`), and the
slot keeps its `Missileart` as *declared* so the question can be re-asked after a map moves the
answer. Its companion **`syncPrimaryWeapon()`** re-derives a def's flat `attack*` summary from
its slots, and runs both at load and after a `war3map.w3u` lands — so a stock hero, a retuned
one and a brand-new custom unit are decided by the same line, and `ua1w` (weapTp) / `ua1m`
(Missileart) / `uaen` (weapsOn) overrides all flow through it. See `src/data/enums.ts` for
`isRangedWeapon`/`launchesMissile` and `tools/sim-missile-art-test.cjs` for both halves.

## The family

| code | who | what it does on a hit |
|---|---|---|
| `AHfa` | Searing Arrows (PotM, `ACsa` creeps) | `DataA` bonus damage |
| `AHca` | Cold / Frost Arrows (Naga `ANfa`, Skeletal Marksman `ACcw`) | `DataA` extra damage, `DataB`/`DataC` move/attack slow |
| `ANba` | Black Arrow (Dark Ranger, `ACbk`) | `DataA` damage; a victim that dies marked rises as `UnitID1` |
| `ANia`/`ANic` | Incinerate (Firelord) | `DataA` × the stack count, and a death blast for `DataB` |
| `Afak` | Orb of Annihilation (Destroyer) | `DataA` damage + falloff splash |
| `AEpa` | Poison Arrows | `DataA` damage + poison |
| `Aspo` | Slow Poison (Dryad; `AIsz` = Assassin's Blade) | poison DoT + slow |
| `Aven`/`Apoi`/`Apo2` | Envenomed Spears (Wind Rider), Poison Sting, Orb of Venom's half | poison DoT |
| `Afbk` | Feedback (Spell Breaker, Arcane Tower `Afbt`) | burn mana, deal it back as damage |
| `Afra`/`Afrb` | Frost Attack (Nerubian Tower, Frost Wyrm, Blue Dragons) | the Slowed buff |
| `AIva` | Mask of Death / Killmaim life steal | heal `DataA` of the damage dealt |
| `AIfb` | Orb of Fire / of Kil'jaeden (`AIgd`) | splash inside `Area1` |
| `AIob` | Orb of Frost | the Slowed buff for `Dur1` |
| `AIcb` | Orb of Corruption | `-DataB` armour for `Dur1` |
| `AIlb` + `AIlp` | Orb of Lightning (RoC) | damage bonus + a purge |
| `AIpb` + `Apo2` | Orb of Venom | damage bonus + poison |
| `AIsb` | Orb of Slow / of Lightning (TFT, `AIll`) / of Darkness (`AIdf`) | a **chance** to run an "Effect Ability" |

Two shapes in that table are worth spelling out.

**An item's orb can have two halves.** The Orb of Venom's `abilList` is `AIpb,Apo2` — the
damage bonus and the poison — and the RoC Orb of Lightning's is `AIlb,AIlp`. They are one orb
and must win or lose together, so `resolveOrb` treats an item's orb abilities as a **set**.

**The "Effect Ability" orbs are entirely data.** `AbilityMetaData.slk` names their columns:
`Iob2`/`Iob3`/`Iob4` are *"Chance To Hit Units / Heros / Summons (%)"* and `Iobu` (`UnitID1`)
is the *"Effect Ability"*. So one generic wrapper covers all three, and what each one *is*
lives in its own row:

| | chances (unit / hero / summon) | Effect Ability |
|---|---|---|
| `AIsb` Orb of Slow | 15 / 5 / 35 | `AIos` (code `Aslo` — Slow) |
| `AIll` Orb of Lightning | 30 / 10 / 30 | `AIpg` (code `Aprg` — Purge) |
| `AIdf` Orb of Darkness | 100 / 100 / 100 | `ANbs` (raise a Dark Minion) |

Since `AIos` and `AIpg` carry real spell codes, they dispatch through the ordinary spell path
— no mana, no cooldown; the orb already paid.

## Numbers that are NOT in the data

* **The generic Slowed buff (`Bfro`)** — shared by Frost Nova, Frost Armor's chill, Frost
  Attack, Frost Breath and the Orb of Frost. Not one of those rows carries the magnitude
  (`AIob`'s Data columns are damage and nothing else; `Afra`/`Afrb`'s are empty), so it is
  engine-internal: **50% movement, 25% attack speed**, from Liquipedia's
  `Template:Infobox_Buff/Slowed`. Durations *are* data (Orb of Frost 3s / 1s on heroes, Frost
  Attack 5s, Frost Wyrm 10s / 3s).
* **Poison is non-lethal** — *"The poison damage is 8 damage per second and is non-lethal"*
  (Liquipedia, Orb of Venom). A poison DoT stops at 1 hp; ordinary DoTs (Liquid Fire) kill.
* **Orb of Corruption strips armour BEFORE the blow it rode in on** — *"The armor reduction
  happens, before the damage of the hero is dealt"* (Liquipedia, Orb of Corruption), which is
  why the very first hit of a fight already lands on reduced armour. Hence
  `applyOrbArmorFirst`, run ahead of `applyDamage`, while everything else runs after it.
* **A missed swing carries nothing** — *"Missing an Attack does not trigger the reduction"*
  (same page). `applyOrbEffect` bails when the blow dealt 0.

## Stacking Types — the column that says what *adds*

Two sources of the same poison: do they add, or does the second merely refresh the first?
The data answers it. `AbilityMetaData.slk` gives rows `Spo4` / `Poi4` / `Poa5` / `Hca4` the
type **`stackFlags`**, and WorldEditStrings names the bits:

| bit | `WESTRING_UE_STACKFLAGS_*` |
|---|---|
| 1 | Damage |
| 2 | Movement |
| 4 | Attack Rate |
| 8 | Kill unit |

| ability | value | reading |
|---|---|---|
| `Aspo` Slow Poison, `Aven` Envenomed Spears, `Apo2` Orb of Venom | **1** | the DoT stacks between attackers, the slow does not |
| `AHca` Cold Arrows | **7** | everything stacks |
| `AEpa` Poison Arrows | **0** | nothing stacks |

That `1` is exactly what Liquipedia's Orb of Venom page states independently — *"The poison
damage stacks, if the orbs are carried by different Heroes."* So `applyPoison` keys the DoT
per ATTACKER when the Damage bit is set, and per ability otherwise. (The slow half is keyed
per ability regardless: our slow model takes the strongest rather than summing, so a
per-source key would change nothing there.)

Buff group names for orbs carry **no colon** — a colon means "aura, and the first half is its
ability code" to the renderer's persistent-FX pass, and none of these are auras.

## Resolved at the strike, applied at the landing

For a ranged attacker those are a flight apart, and the orb has to be decided at the
**launch**, because *the orb owns the missile*: every member of the family carries its own
`Missileart` (Searing Arrows' fire arrow, Orb of Frost's `LichMissile`, the Mask of Death's
`NeutralizationMissile`). Swapping missile art at launch and re-resolving at impact could
disagree, so the chosen orb travels on the projectile (`SimProjectile.orb`). Per-shot mana
goes at the launch too: an arrow already loosed is paid for whether or not it connects.

Missile art is also the community's own test for membership — *"give it to a ranged unit and
see if it changes the missile art"*
([hiveworkshop, "Orb Abilities"](https://www.hiveworkshop.com/threads/orb-abilities.83426/)).

## The art worn on the unit

An orb item names both the model and the bone:

```
[AIfb]  Targetart    = Abilities\Spells\Items\AIfb\AIfbTarget.mdl
        Targetattach = weapon
        Specialart   = Abilities\Spells\Items\AIfb\AIfbSpecialArt.mdl
        Specialattach = chest
```

**`Targetart` is not a hit effect here, despite the name.** Parsing the models out of the
install settles it — `AIfbTarget`, `AIobTarget`, `AIlbTarget`, `OrbVenom`, `OrbCorruption` and
`OrbDarkness` each contain a single **looping `Stand`** sequence, which no one-shot burst
would. They are the glowing sphere that rides the carrier's weapon hand, and `Targetattach` is
the attachment node (`"Weapon Ref"` on every hero model). Mask of Death spells out the
counter-case by writing `Targetart=` with nothing after it: no orb, nothing worn.

Wearing one is **not** exclusive — carrying three orbs shows three, because carrying asks
nothing of the priority ladder. `World.orbAttachments` returns the list and the renderer feeds
it through the same persistent-FX pool buff art uses, so a found node means the model is
parented to the bone and animates with the swing.

`Specialart` *is* the proc — the flash on the unit that was hit (Orb of Corruption's ribbon,
the Mask of Death's `VampiricAuraTarget`, Feedback's `SpellBreakerAttack`). Orb of Fire's is
an empty stub: `AIfbSpecialArt.mdx` has a `TEXS` chunk and no geometry at all, so it draws
nothing, and that is the file's own doing rather than ours.

## Known divergence

Liquipedia documents a **bug** in the three "Effect Ability" orbs (Slow, Lightning, Darkness):
the wrapper does not fire when the attacker auto-acquired its target while idle, or on Stop or
Hold Position — but does under Attack-Move and Patrol. We fire it on every qualifying hit.

## See also

* [`docs/spell-fx.md`](spell-fx.md) — the five presentation mechanisms, and why a buff's art
  lives on the buff row rather than on the ability
* [`docs/wc3-data-formats.md`](wc3-data-formats.md) — where the tables live and how
  `AbilityMetaData` names the `DataA..I` columns
