# Items and item abilities

An item's *behaviour* is not in the item. `Units\ItemData.slk` says what a Scroll of
Regeneration costs, how many charges it has and which model lies on the ground; what it **does**
is an ability id in its `abilList`, and that ability is an ordinary row in
`Units\AbilityData.slk` with the same fields a hero spell has — `targs1`, `Area1`, `Rng1`,
`Dur1`, `Cool1`, `DataA…DataI`, `BuffID1`, `UnitID1`.

> **An item ability is an ability.** Treat it like one, dispatch it like one, and read its
> numbers off its own row like one.

That is the whole design rule here, and getting it wrong is the shape of nearly every item bug
we have had: a Scroll of Regeneration that regenerated only its holder, three shop scrolls that
did nothing at all when pressed, a Talisman of Evasion that dodged nothing, fourteen aura items
that broadcast to nobody.

Implementation:
[`src/data/items.ts`](../src/data/items.ts) (the item table — pure data),
`applyItemAbility` / `itemAreaTargets` / `itemAbility` / `auraSources` / `itemBonuses` in
[`src/sim/world.ts`](../src/sim/world.ts),
the `ITEM abilities` section of `SPELL_HANDLERS` in [`src/sim/spells.ts`](../src/sim/spells.ts),
`KNOWN_ABILITIES` + `ALIAS_TARGETS` in [`src/data/abilities.ts`](../src/data/abilities.ts).
Checked by `tools/sim-item-test.cjs` and `tools/sim-item-regen-test.cjs` (`pnpm sim:test`).

Related: [`orbs.md`](./orbs.md) for the attack-modifier items (they are a family with a rule of
their own and are **not** covered here), [`illusions.md`](./illusions.md) for the Wand of
Illusion, [`spell-fx.md`](./spell-fx.md) for where an item's art lives.

## The three doors into one dispatcher

There are three ways an item's ability reaches the sim, and only one place that decides what it
does — `SimWorld.applyItemAbility`:

| door | reached by | example |
|---|---|---|
| **pressed** | `useItem` — the inventory button, its numpad key, `UnitUseItem*` | Potion of Healing |
| **picked up** | `applyPowerup` — walking over a `powerup` item | Rune of Healing, Tome of Strength |
| **carried** | `recomputeStats` / `applyAuras` / the passive derivations | Claws of Attack, Warsong Battle Drums |

The first two share `applyItemAbility` because **the game ships the same ability both ways
round**: `AIha` is the Scroll of Healing *and* the three Runes of Healing; `AIsa` is the Scroll
of Speed *and* the Rune of Speed; `AIdi` is the Wand of Negation *and* the Rune of Dispel Magic.
Writing a switch per door is what left the scroll half of each pair silently doing nothing.

`applyItemAbility` returns three answers, and the distinction matters:

* `"unhandled"` — no case and no `SPELL_HANDLERS` entry knows this code, so the caller tries the
  item's **next** ability. This is how a Helm of Battlethirst (`AIxk,AIa4,AIs4`) finds Berserk
  past two stat rows.
* `false` — understood, but there was nothing to do. **No charge is spent.** This is what
  refuses a Potion of Healing at full health and a Rod of Necromancy waved over bare ground.
* `true` — it fired; spend the charge and start the cooldown.

## Who an effect lands on

`itemAreaTargets` is the one answer to "who does this item reach", and it is read off the
ability's own row:

```
Area1 > 0   →  every unit inside it that targs1 admits, the user included
Area1 = 0   →  the user alone
```

Three rows in one family show why this cannot be assumed. All three are `code = AIrg`:

| alias | item | row | reaches | its own Ubertip |
|---|---|---|---|---|
| `AIsl` | Scroll of Regeneration | `Area1` 600 | the **area** | "all friendly non-mechanical units in an area around your Hero" |
| `AIrl` | Healing Salve | `Rng1` 500 | a **unit** | "a **target unit's** hit points" |
| `AIpr` | Clarity Potion | neither | the **user** | "the **Hero's** mana" |

Reading a cast range as an area, or an area as "the drinker", turns one of these into another.

**Aiming is not in the tables.** `Rng1` and `Area1` cannot tell a point-target item from a
self-cast one — the Scroll of Healing (`Area1` 600, `Rng1` 250) is *"around the Hero"* while the
Wand of Negation (`Area1` 200, `Rng1` 500) is *"in a target area"*, and nothing but the words
says which. So every aim in `KNOWN_ABILITIES` was read out of the **item's Ubertip**, exactly as
[`abilities-audit.md`](./abilities-audit.md) requires for spells.

`AIrg` is also the one case in the game that forces `ALIAS_TARGETS`, the per-row aiming override:
keying the aim on the base code alone would make the Clarity Potion demand a target, or the
Healing Salve fire on the drinker.

## A carried ability is an ability

`passiveLevelData(u, code)` used to look only at `u.abilities`. Every passive item in the game
carries an ability that some derivation elsewhere in the sim was already implementing, and none
of them ever asked the inventory:

| item | its ability | is | derivation it feeds |
|---|---|---|---|
| Talisman of Evasion | `AIev` | `AEev` — the Demon Hunter's Evasion | `tryEvade` |
| Searing Blade | `AIcs` | `AOcr` — the Blademaster's Critical Strike | `rollCriticalStrike` |
| Rusty Mining Pick | `AIbx` | `AHbh` — the Mountain King's Bash | `rollBash` / `applyBash` |
| Necklace of Spell Immunity | `AImx` | `Amim` — Magic Immunity | `u.magicImmune` |
| Goblin Night Scope | `AIuv` | `Ault` — Ultravision | `u.sightNight` |
| Gem of True Seeing | `Adt1` | `Adet` — Detect | `u.detectRadius` |

`Adet` is the tell that this was always the missing half: no unit in 1.30.4 lists it, the audit
calls it "a dead row kept for custom maps", and the reason nothing lists it is that the **item**
is what hands it out.

One rule to keep: **items do not stack a passive with itself.** `itemAbility` returns the first
match in slot order, which is why two Talismans of Evasion are one Talisman of Evasion. (The
carried *stats* — `+damage`, `+armour`, `+max mana` — do stack, and are summed in `itemBonuses`.
That split is the same one the orbs make; see [`orbs.md`](./orbs.md).)

The same fix applies to **auras**: `auraSources` yields a unit's learned aura abilities *and* its
carried ones. Fourteen items are auras (Warsong Battle Drums, the Ancient Janggo of Endurance,
the Legion Doom-Horn, Scourge Bone Chimes, Alleria's Flute of Accuracy, the Lion Horn of
Stormwind, Bladebane Armor, Khadgar's Pipe of Insight, the Ring of the Archmagi, the Mindstaff,
the Thunderlizard Diamond, the Sacred Relic, the Ancestral Staff, the Shield of Honor and the
Scepter of Healing), every one of them says *"and friendly nearby units"* in its own tooltip, and
scanning only `abilities` made all of them do nothing whatever — **including for their bearer**,
since `self` is in the aura's `targs1` rather than being a special case.

## Where each behaviour lives

Three homes, chosen by what the effect needs to see:

1. **`SPELL_HANDLERS`** (`src/sim/spells.ts`) — anything expressible over `SpellApi`. Most of
   them. An item whose code is a real spell needs no entry at all: the Wand of the Wind is
   Cyclone, the Scroll of the Beast is Roar, the Potion of Divinity is Divine Shield, the Crown
   of the Deathlord is Finger of Death — `useItem`'s fall-through dispatches them with the
   **item's** numbers on the **spell's** handler.
2. **`applyItemAbility`'s own cases** (`src/sim/world.ts`) — the world-level ones: the Moonstone
   (the day clock), the Scroll of Town Portal and the Amulet of Recall (mass teleport), the
   Sacrificial Skull (blight), the "Tiny" buildings (the summon queue), the Tome of Power and
   the Tome of Retraining (hero progression), the glyphs (the tech graph), the Soul Gem.
3. **A derivation** — the carried passives above, plus `itemBonuses` for the flat stats and
   `tickCarriedItems` for the two that need a clock (Cloak of Flames, Amulet of Spell Shield).

Two `SpellApi` methods exist only because items need them:
`revealArea` (the Crystal Ball, the Flare Gun, Dust of Appearance, the Potion of Omniscience,
the Wand of Shadowsight — the only effects in the game that touch vision without putting a unit
on the map) and `createIllusion` (the Wand of Illusion copies its **target**, where Mirror Image
copies the caster).

## The one item that is not instant

Every item in the game fires on the press — except the **Scroll of Town Portal**. `AItp` is the
only `AI*` row in the install with a cast time (`Cast1 = 5`; every other item ability is 0), and
Blizzard's own page spells out what those five seconds are
([classic.battle.net](http://classic.battle.net/war3/basics/townportalscrolls.shtml)):

> When a Hero activates a Town Portal scroll they become invulnerable. During the channeling, the
> Hero cannot do any action (such as move, attack, use any other item nor his spell). Any nearby
> units are not invulnerable so they can still be destroyed. After a short casting period (5 sec.
> cast time) the Hero will then transport with the surviving units.

Four things follow, and an instant teleport gets all four wrong:

* **The hero is invulnerable** for the whole channel — folded into `invulnerable` by
  `recomputeStats`, beside `vanished` and `insideBuild`. It is still *on the field* and visible;
  it simply cannot be hurt. That is the whole reason a scroll is an escape rather than a gamble.
* **It cannot act.** `castLocked` gains `portalLeft > 0`, which closes every order path at once,
  and `recomputeStats` zeroes the speed — the same two clauses an Ancient mid-root uses.
* **It cannot be aborted.** "Under no circumstances", so the charge is spent on the press: there
  is no state in which the scroll is half-used and refundable.
* **It takes "the surviving units".** The party is gathered when the clock runs out, not when the
  scroll is pressed — an army wiped out during the channel is an army the scroll does not save,
  and the units standing around the hero are *not* covered by its invulnerability.

It is **not** routed through `pendingCast`: an item ability is not in `SimUnit.abilities` at all
(see above), so the spell pipeline has nothing to hang it on. `SimUnit.portalLeft` is its own
small clock, in the shape of `morphT` — the same kind of thing, a committed transition that takes
no orders and does not move.

**Where it goes** is `nearestHall(owner, x, y)` — the hall nearest the *clicked* point, of the
user's own. So the two ways of using it fall out of one rule: click a spot and you go to the hall
nearest that spot; **double-click the item (or press its hotkey twice) and the click is on
yourself**, which is your own nearest hall. That second form is `RtsController.useInventorySlot`'s
re-press branch, and it is what Computer+ uses (`plus/items.ts`) — the only aim that cannot go out
of date while the hero runs.

`Cast1` is data like any other: a map that edits it to 0 gets the instant scroll back, and
`itemTownPortal` still has that path.

## Charges, cooldowns and refusals

* A charge is spent **only** on `true`, and `USE_ITEM` is raised *after* it — so
  `GetItemCharges` inside a use trigger reports what is left, which the classic
  `SetItemCharges(GetManipulatedItem(), n+1)` idiom relies on.
* `cooldownid` is a GROUP: pressing one puts every item in that group on the same cooldown.
* Refusals are answered **before** the click is spent, in `itemReadyError` (is it usable at all,
  is it cooling down) and `itemUseError` (may it be aimed at that). Every string is the game's
  own `[Errors]` key — `Notownportalhalls` = *"There are no friendly Town Halls to Town Portal
  to."* was written for the Scroll of Town Portal, and `Needsummoned` for Control Magic.

## Two things still open

**`AIrb` Rune of Rebirth.** Its row carries nothing at all — no duration, no data, one buff
(`BIrb`) — and its Ubertip, *"Places the monster that held this rune under your control"*,
describes something that cannot happen as written: the creep that held the rune is dead by the
time you can pick it up. Not guessed at. It wants a measurement against the real client (see
the `wc3-ground-truth` convention in [`abilities-audit.md`](./abilities-audit.md)).

**`Amec` Mechanical Critter.** Its row names no unit — `UnitID1` is empty, and no unit type
called "Mechanical Critter" exists anywhere in the install. The engine picks the map's own
critter and nothing in the data says which one, so the item does nothing and **keeps its
charge** rather than perishing to summon something invented. A custom map that fills the column
in gets its critter.

**`Aspb` Spell Book.** `DataA "Spell List"` = `AEer,Adis,Aroa`, `DataC/DataD "Minimum/Maximum
Spells"` = 3, `DataE "Base Order ID"` = `spellbook`. It is not an effect but a **sub-command
card**: the item grants a button that opens a second page of buttons. That is UI machinery we do
not have yet, and faking it as "cast one of the three at random" would be a different item.

Also flagged rather than guessed at: **`Aste` Wand of Mana Stealing** reuses Death Pact's
metadata block (`Udp1..5`, "Life Converted to Mana", "Mana Conversion As Percent"), which
describes a different ability. `DataA` = 50 is read as a flat 50 mana, following the item's own
Ubertip; whether the engine treats it as a percentage wants a measurement.

And two deliberate simplifications, both noted at their handler:

* **Cyclone** (`AIcy`) holds its victim with a stun plus an invulnerability rather than by
  changing what the unit *is*. A real cyclone can still be shot by AIR units; ours cannot be
  shot at all. Flipping `flying` would re-settle the unit's pathing for the duration.
* **Cloud** (`AIfg`) stops enemy towers attacking with a certain `miss`, which is the shape its
  own metadata block describes (`DataB "Chance To Miss (%)"`). A stun would also have stopped
  the building training and researching, which Cloud does not.

## See also

- [`abilities-audit.md`](./abilities-audit.md) — the generated coverage table (`pnpm data:audit`)
- [`wc3-data-formats.md`](./wc3-data-formats.md) — where `ItemData.slk` / `ItemFunc.txt` /
  `ItemStrings.txt` / `ItemAbilityFunc.txt` live
- [`computer-plus.md`](./computer-plus.md) § "Items: buying them, and pressing them" — the AI half:
  which button Computer+ presses and when, and what it buys
