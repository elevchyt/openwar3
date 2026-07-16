# Illusions

An **illusion** is a copy of a unit that fights but cannot hurt anything. It is the shared
mechanic behind the Blademaster's **Mirror Image** (`AOmi`) and the **Wand of Illusion**
(`AIil`), and a custom map can hang it off either. Everything below is verified against the
real 1.27a MPQs — see [`REFERENCES.md`](./REFERENCES.md) for the archive layout.

The point of an illusion is that **the enemy cannot tell it from the original**. Every rule
here follows from that: it is an exact copy of the unit (same type, same stats on the sheet,
same name, same mana), its tells are shown *only* to the side that owns it, and the things it
cannot do are enforced silently at the sim level rather than by editing what it looks like.

## The data

Both abilities carry the same three numbers, and `Units\AbilityMetaData.slk` names the
otherwise-unlabelled `DataA..I` columns (see the `ability-data-column-names` note in
`docs/wc3-data-formats.md`). **They are not in the same order** — read the metadata, never
assume the index:

| | `AOmi` Mirror Image | `AIil` Wand of Illusion |
|---|---|---|
| Number of Images | **DataA** = 1 / 2 / 3 by rank | — (the item makes one) |
| Damage Dealt | **DataB** = `0` | **DataA** = `0` |
| Damage Taken | **DataC** = `2` | **DataB** = `2` |
| Animation Delay | **DataD** = `0.5` | — |
| Duration | `Dur1` / `Herodur1` = 60 | `Dur1` / `Herodur1` = 60 |

*"Damage Dealt (%)" of `0` is the whole trick*: the illusion's sheet still reads 26–48 like
the real Blademaster's, and it swings, connects and clangs — it simply does nothing. The
number lives in the data precisely so the lie is only in the damage, never in the display.

Art, from the `*AbilityFunc.txt` rows (a buff row carries **three** different arts — see
[the buff-art rules](#see-also)):

| | `AOmi` | `AIil` |
|---|---|---|
| cast effect | `Specialart` = `MirrorImage\MirrorImageCaster.mdl` | `Targetart` = `Items\AIil\AIilTarget.mdl` @ `origin` |
| missile | `Missileart` = `MirrorImage\MirrorImageMissile.mdl`, `Missilespeed` 1000 | — |
| buff | `BOmi` | `BIil` |
| **death pop** | `[BOmi] Specialart` = `MirrorImage\MirrorImageDeathCaster.mdl` | `[BIil] Specialart` = *the same model* |

`MirrorImageDeathCaster.mdx` carries the event `SNDxAOMI`, which `AnimLookups` resolves to
`MirrorImageDeath.wav` — so **playing the model plays the sound**; never wire that WAV by hand.

### Two data traps

- **`[AOmi] Targetart` is `LevelupCaster.mdl`** — a model Mirror Image never shows. It carries
  `SND…AHER` → `Levelupcaster.wav`, so the default cast-sound order (target → caster → special)
  made every Mirror Image play the hero **level-up chime**. `SPELL_SOUND_ART` in
  `src/render/mapViewer.ts` names the art that actually carries a cast's sound.
- **A buff's `Specialart` is a proc, not a generic "death" slot.** It happens to be the death
  pop for `BOmi`/`BIil`, but Blizzard's own comment on `[BNlm]` says the Lava Spawn's "is used
  when the lava monster splits". Read it only where you know the ability.

## The rules

`SimUnit` carries `isIllusion`, `illusionDamageDealt` and `illusionDamageTaken`
(`src/sim/world.ts`). An illusion is *also* a summon (`isSummon`, `summonLeft`), which is what
gives it the timer, the no-corpse death and its vulnerability to Dispel Magic for free.

| rule | where | why there |
|---|---|---|
| deals no damage | `applyDamage` | the ATTACK path. The blow must still **land** — it records the hit so the weapon-on-armour clang fires, then returns 0. Bailing out early leaves the copies swinging in silence, which identifies them instantly. |
| takes 200% | `landDamage` | the true chokepoint. `spellDamage` skips `applyDamage` entirely, and Dispel Magic hitting a summon is exactly the case that must double. |
| cannot cast | `issueCast` | backstop for triggers/hotkeys/autocast. The command card also emits no ability buttons (`pushAbilityButtons`) — a card full of spells that silently refuse reads as a bug. |
| cannot pick up items | `pickUpItem` | every route in (walk-over, right-click, a trigger's `UnitAddItem`) funnels through that one door. |
| dies by popping | `kill` → `unsummon` | an illusion never plays a death clip: it is replaced by `unsummonArt` (the buff's `Specialart`). No corpse, no XP — it was only ever a picture. |
| expires at 60s | `summonLeft` → `unsummon` | same path as the pop. |

## The asymmetry (the important part)

The owner and their allies must be able to pick their images apart from the real unit. The
enemy must not. **Both tells key off the LOCAL viewpoint (`seesFor`), never off the unit:**

- **Blue wash** — `ILLUSION_TINT`, exported from `src/game/rts.ts`. It is folded into
  `applyFogTint`, which is the *single owner* of a unit's `vertexColor` and composes
  base × fog × AoE-highlight × ghost-fade. Writing the tint anywhere else gets silently
  clobbered the next time fog brightness changes.
- **"Summoned Unit (Ns)" timer** instead of the hero XP bar — `SelectionInfo.isSummon` is
  gated the same way, and `src/ui/hud.ts` lets the summon branch win over the hero branch.
- **The 3D portrait bust** wears the same wash (`ModelViewerScene.setTint`, driven by
  `SelectionInfo.isIllusion`). Set it on **every selection**, not once at load: one viewer is
  reused for every unit and an illusion shares the original's model, so selecting the real
  hero right after one of his images would otherwise inherit the blue.

To an enemy, `isSummon`/`isIllusion` both report `false`, so the image keeps a hero's XP bar,
no tint and no timer — an ordinary Blademaster.

Nothing in the MPQs carries the tint (`AOmi` declares no colour field); like the ghosting on
invisible/ethereal units it is a hardcoded engine look.

## Copying the original exactly

An illusion is a copy of the unit **as it stands right now** — not of its unit type. Spawning
gives you the type's defaults, and every one of these would otherwise be a tell. `IllusionInit`
(`src/sim/world.ts`) is the payload; `initIllusion` applies it.

- **proper name** — heroes roll a random one at spawn, which would label four "identical"
  Blademasters with four different names.
- **level** — spawning starts every hero at the unit TYPE's level 1, so a level-5 Blademaster
  would conjure three level-1 copies.
- **mana** — the original's pool *after* the cast is paid. (`AOmi`'s cost is spent up front at
  cast commit, so the value read when the sequence starts is already post-cast. Capture it
  **once** rather than at landing, or the images drift apart from each other via regen.)
- **base attributes + baseMaxHp** — tomes are PERMANENT and live here (`applyPowerup` bumps
  `baseStr`/`baseAgi`/`baseInt`/`baseMaxHp`), so a copy built from the unit type alone is
  missing every tome the hero ever drank.
- **inventory** — the copy is *seen* carrying the same six slots, and `itemBonuses` reads
  `held.itemId`, so it picks up the same +damage/+armour/+stats for free.

**Order matters** and is why `initIllusion` is one method rather than writes at the call site:
the level must land *before* `recomputeStats`, and hp/mana can only be set after it has run.
Set the level and stop, and the next tick's `recomputeStats` raises maxHp past hp — the copy
stands there looking wounded.

### The inventory is a picture

The items are **inert copies**: same `itemId`, but `id: 0`. An item in WC3 is ONE entity that
JASS handles track across ground↔inventory (see `HeldItem.id`), so handing four copies the
original's ids would have four units claiming to hold it. The copy therefore cannot:

- **use** one (`useItem`) — no potion drunk, no charge spent off a bottle nobody owns
- **drop or give** one (`doDropItem`, `transferItem`) — that would duplicate the original's gear
- **rearrange** them (`swapItems`), or pick anything up (`pickUpItem`)

It also drops nothing when it dies: `kill` routes an illusion to `unsummon` → `removeUnit`,
which never reaches `dropInventory` — otherwise three images popping would triple the hero's
Claws of Attack.

**Item auras do not work on a copy** — and get this for free today rather than by a guard:
`applyAuras` iterates `src.abilities` (the unit's OWN ability list), and items never feed it.
If item-granted auras are ever wired up, they must skip `isIllusion` units.

### Levelling

Images level with their original (`levelUp` → `levelUpIllusion`), nova and all — a Blademaster
who dinged while his images stood beside him would otherwise be the only one of the four to
grow, flash and refill. `illusionOf` carries the link (matching on owner+typeId is a guess that
breaks the moment a player fields two of a type). An image earns nothing of its own: no skill
point (it cannot learn or cast) and no `HERO_LEVEL` event, which is the *player's* hero
levelling and must fire once, not once per copy.

## Mirror Image's staging

Mirror Image is not "summon N copies"; it is a shuffle, and `startMirrorImage` /
`tickMirrorImage` (`src/sim/world.ts`) run it:

1. Dismiss any existing images (a re-cast replaces the pack — each pops).
2. Dispel the caster ("Dispels all magic from the Blademaster", straight off the Ubertip).
3. The caster **vanishes** (`SimUnit.vanished`: hidden, untargetable, takes no orders) and
   `MirrorImageCaster` plays in his place.
4. After **DataD "Animation Delay"**, throw one `MirrorImageMissile` per destination.
5. Each missile that lands places an image — **except one tile, drawn at random, where the
   real hero is set back down**. The tiles come off a random ring phase every cast, so
   neither the enemy nor the caster can read the answer off the pattern.

`AOmi` declares **no `Animnames`**, and the Blademaster's model has no `Spell` clip — so he
plays nothing and simply stands. (WC3 plays `Animnames`, else `Spell`, else nothing. Falling
back to the *attack* clip is not something the engine does.)

## Adding Wand of Illusion

`AIil` is far simpler than `AOmi` — no vanish, no missiles, no random placement:

1. Add `AIil: { target: "unit" }` to `KNOWN_ABILITIES` (`src/data/abilities.ts`). It currently
   loads as `passive`, which is the graceful default for anything unlisted.
2. On cast: play `def.targetArt` (`AIilTarget.mdx` @ `origin`) on the target, then spawn one
   illusion of **the target's** type beside it — `AOmi` copies the *caster*, `AIil` copies the
   *target*.
3. Build an `IllusionInit` off **the target**: `dealt` = `DataA`, `taken` = `DataB` (**note the
   shifted indices**), plus its name / level / mana / base attributes / inventory. Set
   `unsummonArt` = `def.buffSpecialArt` and `summonLeft` = `Dur1`, and let `initIllusion` apply
   it — do not poke the fields yourself, the ordering matters (see above).
4. Everything else — the blue wash, the timer, the no-damage rule, the pop and its sound —
   already follows from `isIllusion` + `isSummon` and needs no new code.

## See also

- `src/sim/world.ts` — `IllusionInit`, `initIllusion`, `startMirrorImage`, `tickMirrorImage`,
  `spawnIllusion`, `levelUpIllusion`, `unsummon`
- `src/game/rts.ts` — `ILLUSION_TINT`, `applyFogTint`, `SelectionInfo`
- [`wc3-data-formats.md`](./wc3-data-formats.md) — where each table lives
- [`REFERENCES.md`](./REFERENCES.md) — the reference index and its per-source gotchas
