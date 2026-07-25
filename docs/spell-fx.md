# Spell FX — the five ways a spell shows itself

A spell's art is not one thing. WC3 has **five separate presentation mechanisms**, each with
its own data, its own lifetime and its own renderer path, and the commonest bug in this area
is reaching for the wrong one — looking for a model where there is only a ribbon, or hanging
the caster's art on the target. This page says which is which and where each one's data lives.

Everything here is verified against the real 1.27a MPQs; see [`REFERENCES.md`](./REFERENCES.md)
for the archive layout and [`wc3-data-formats.md`](./wc3-data-formats.md) for the tables.

| | what it is | data | code |
|---|---|---|---|
| **Effect models** | a one-shot `.mdx` played at a point or on a unit | `*AbilityFunc.txt` `Targetart` / `Casterart` / `Specialart` / `Areaeffectart` / `Missileart` | `SpellApi.emitEffect` → `MapViewerScene.spawnEffect` |
| **Buff art** | the persistent model a unit WEARS while a buff lasts | the `[B….]` **buff** row's `Targetart` + `Targetattach` | `fx(def)` / `api.buffFxOf(buffId)` → `trackBuffFx` |
| **Lightning** | a textured ribbon strung between two moving points | `*AbilityFunc.txt` `LightningEffect` → `Splats\LightningData.slk` | `SpellApi.emitLightning` → `LightningOverlay` |
| **Ubersplats** | a temporary ground decal | `Splats\UberSplatData.slk` | `SpellApi.emitSplat` → `UberSplatOverlay` |
| **Sound** | the cast/impact WAV | the effect model's own embedded `SND` event, or `Effectsound` → `AbilitySounds.slk` | `SoundBoard.playSpellSound` |

The first rule for any "this spell has no art" bug: **check which mechanism it actually uses
before assuming the art field is empty.** Chain Lightning genuinely has no `Targetart` — it was
never supposed to.

## 1. Effect models

The ordinary case: Holy Light's burst, Thunder Clap's ring, Blizzard's shards. Four art
fields, and which one an ability uses is per-ability rather than by rule — read the row.

Attachment matters: an effect played on a unit rides the unit; one played at a point stands on
the ground where it was cast. `SpellApi.emitEffect(art, x, y, targetId)` — pass `targetId` for
the first, `0` for the second.

## 2. Buff art — it is on the BUFF, not on the ability

**Most buff-applying abilities have no `Targetart` at all.** Divine Shield, Slow, Bloodlust,
Inner Fire: the model a unit wears while the buff lasts lives on the buff's own `[B….]` row
(`buffid1`), with an attachment point beside it. `def.targetArt` is the one-shot CAST flash
and belongs in `emitEffect`. Reaching for it here renders nothing.

A buff row carries **three** different arts and they are not interchangeable:

* `Targetart` — worn **while the buff lasts** (`AbilityDef.buffFx`).
* `Effectart` — played when the buff **ENDS** (`buffEffectArt`; a Feral Spirit wolf's
  unsummon poof is `[BOsf] Effectart`).
* `Specialart` — a **proc**, and what it means is per-ability (`buffSpecialArt`): Frost
  Armor's is the chill on an attacker, Mirror Image's is an illusion popping. Never treat it
  as a generic death slot.

### An ability may list several buffs, and it picks between them off its own numbers

`BuffID1` is a LIST. `AbilityRegistry.buffFx(buffId)` (via `SpellApi.buffFxOf`) resolves any
one of them, and the ability's data says which:

* **Regeneration items** — `BIrg,BIrl,BIrm` is life-and-mana, life, mana. A Healing Salve
  with no DataB wears `BIrl` and shows only the green swirl.
* **The Drain** — nine rows, `Bdcb,Bdcl,Bdcm, Bdtb,Bdtl,Bdtm, Bdbb,Bdbl,Bdbm`: a **caster**
  trio, a **target** trio, then the info-card **icon** trio, each ordered both/life/mana. So
  the ROLE picks the trio and the FLAVOUR picks within it. `buffid1` alone is `Bdcb` — the
  caster's life-drain art — which put a green life-drain swirl on a mana drain's victim until
  this was read properly.

## 3. Lightning — a ribbon, not a model

Chain Lightning, Healing Wave, Finger of Death, Forked Lightning, Mana Burn, Spirit Link,
Aerial Shackles, Mana Flare, the Chimaera's lightning attack and the Drains draw **no model at
all**. They string a textured ribbon between a source and a target that follows both while it
lives. There is nothing in the ability's art fields to find, which is exactly why these spells
landed in silence before issue #97.

**Which bolt** is `LightningEffect=CLPB,CLSB` in `Units\*AbilityFunc.txt` — the profiles, not
the SLKs (the same hiding place as the tech-tree fields). The primary bolt is first
(caster → first target), the secondary second (target → target). Reachable as
`AbilityDef.lightning`.

**What it looks like** is a row of `Splats\LightningData.slk` (`src/data/lightning.ts`):

| column | meaning |
|---|---|
| `Dir` \ `file` | the texture — a **256×64 horizontal strip** with the zig-zag painted into it on black, authored for ADDITIVE blending and tiling along U |
| `AvgSegLen` | "the portion of the texture visible at any instant (50 is half, 100 is full)", and the average world length of a geometry segment |
| `Width` | ribbon width, world units |
| `R,G,B,A` | tint over the texture (every stock row is plain white) |
| `NoiseScale` | "how fuzzy the lightning will become over long distances" — jitter as a FRACTION of the bolt's length. `0.05` = the electric bolts, `0.0001` = the smooth heal beams |
| `TexCoordScale` | scroll speed *divisor* ("higher => very slow"). **Negative** on the drains, whose texture crawls back toward the caster |
| `Duration` | "how long it will take to naturally fade" — the FADE, not the lifetime |

(Field meanings from Hive Workshop threads 203171 and 220370, checked against the table.)

**How long it lives** comes from the ABILITY, and those columns are named too:

* Finger of Death — DataA "Graphic Delay" `0.25`, DataB "Graphic Duration" `1`.
* Mana Burn — DataB "Bolt Delay" `0.25`, DataC "Bolt Lifetime" `1`.
* Everything else falls back to the row's own `Duration`, and Chain Lightning / Healing Wave
  additionally stagger their bounces (0.15s — the one invented number here; their rows name
  no interval, so the engine hardcodes one).

**Where it attaches**: each end uses that unit's own `UnitWeapons.slk` `launchz` / `impactz`
— the heights a missile leaves and lands by — so a bolt leaves the caster's hands and lands
on the target's body without a new per-unit table. A flyer's altitude is added by the
renderer each frame, so a bolt strung to a gryphon rides it up.

**Rendering** (`src/render/lightningOverlay.ts`) is our own GL pass, after the world's
translucent instances and before the fog: additive, depth-TESTING (a cliff hides a bolt) but
writing no depth (the units it arcs between stay whole). Both ends are re-read from the units
every frame. A bolt is visible while EITHER end is on screen.

**Cutting one short**: a bolt may carry a `tag`, and the sim can ask for every bolt with that
tag to be cut (`drainLightningStops`). A Drain's tether is strung for the channel's whole
duration and tagged `drain:<casterId>`, because the channel can break — see below.

## 4. Ubersplats

A temporary ground decal painted under a spell (Thunder Clap's scorch, `THND`). An
`UberSplatData.slk` row gives the texture, its half-width `Scale`, and a BirthTime / PauseTime
/ Decay alpha envelope that IS the effect's whole life. See the `ubersplats` note in
[`wc3-data-formats.md`](./wc3-data-formats.md).

## 5. Sound

Most abilities carry no `Effectsound` and sound themselves off their effect model's embedded
`SND` event, which is why the sound is resolved from the model PATH rather than from a field.
`Effectsound` is a **label** into `UI\SoundInfo\AbilitySounds.slk`, never a path.
`Effectsoundlooped` (the drains carry `SiphonManaLoop`) is a bed that plays for a channel.

## Channels, and what a broken one has to take with it

A channelled spell's art is not fire-and-forget: when the channel breaks, everything it put
in the world has to go with it. There are two shapes, and they need different teardowns.

* **Field channels** — Blizzard, Rain of Fire, Starfall, Tranquility, Death and Decay,
  Stampede, Earthquake. The effect is a repeating `SpellField`; `tickSpellFields` drops the
  field the moment the caster is re-tasked away from `cast` with channel time left.
* **The Drain** (`AHdr` — Life Drain / Siphon Mana) — the effect is a pair of ordinary timed
  BUFFS, one on each end, and a buff does not know its caster walked away. `tickDrains` runs
  the same interrupt test and strips the drain buffs off **both** units, then cuts the beam by
  tag. A drain transfers: what leaves the victim arrives in the caster, at the rate its own
  columns name — DataA "Life Transferred Per Second" (a dot paired with a hot), DataB "Mana
  Transferred Per Second" (a *negative* mana-regen buff on the victim, positive on the
  caster). Which of `DRAB,DRAL,DRAM` and which buff trio it wears follow from the same two
  numbers.

Not channelled, despite looking it: Flame Strike, Volcano, Locust Swarm, Bladestorm (the
Blademaster keeps moving), Immolation, Cluster Rockets.

## See also

* [`wc3-data-formats.md`](./wc3-data-formats.md) — where every table lives
* [`illusions.md`](./illusions.md) — a whole spell whose rules are about what it SHOWS
* `src/data/lightning.ts`, `src/render/lightningOverlay.ts`, `src/sim/spells.ts`
