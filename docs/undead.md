# The undead economy

The night elf plays a different economic game from the other three races ([`night-elf.md`](./night-elf.md)).
The **undead** play a different game again, and the two are not the same difference: the night
elf's is about *where the worker is* (inside a tree, inside a mine), while the undead's is about
*where the worker isn't*. An Acolyte never walks a load anywhere, never stays to finish a
building, and never stands where its gold is dug. Almost none of it is a tuning value — each
piece is a rule, and each rule is stated by a column.

This is that list, so the next person does not have to rediscover which column says what.

Implementation: `tickBlight` / `blightPaintOf` / `reassertBlight` / `footprintBlighted` /
`mineCrewOf` / `hauntedMine` / `ringStation` / `mineRingStations` / `freeRingSlot` /
`tickRingHarvest` / `tickMineCrews` / `hauntTarget` / `hauntMine` / `issueGoldWork` /
`stepOffFootprint` / `unsummonBuilding` / `summonsBuildings` in
[`src/sim/world.ts`](../src/sim/world.ts), the grid itself in
[`src/sim/blight.ts`](../src/sim/blight.ts), the `Auns` and `Aweb` handlers in
[`src/sim/spells.ts`](../src/sim/spells.ts), the Acolyte's profile in
[`src/data/races.ts`](../src/data/races.ts), `requirePlace` in
[`src/data/units.ts`](../src/data/units.ts), `syncBlight` / `groundSuitsBuilding` /
`snapPlacement` / `collectMineCircles` / `playSummonGesture` and the haunt branch of
`tickPendingBuild` in [`src/render/mapViewer.ts`](../src/render/mapViewer.ts), the
`SetBlight*` natives in [`src/jass/natives/melee.ts`](../src/jass/natives/melee.ts), and
`standWorkGold` / `playWorkAnimOnce` in
[`src/render/unitAnims.ts`](../src/render/unitAnims.ts) and
[`src/game/rts.ts`](../src/game/rts.ts). Checked by `tools/sim-undead-test.cjs`
and `tools/sim-regen-test.cjs` (`pnpm sim:test`).

## 1. Blight is TERRAIN, and every building in the game has an opinion about it

The finding worth writing down first: blight is not an undead feature with a counter-feature
bolted on. It is **one mechanism with a boolean**, and `Units\UnitAbilities.slk` hands a piece
of it to every structure in the game.

| ability | `Area1` | `DataA` "Expansion Amount" | `Dur1` | `DataB` "Creates Blight" | carried by |
| --- | --- | --- | --- | --- | --- |
| `Abgs` Blight Growth (Small) | 768 | 64 | 0.08 | **1** | Ziggurat, Crypt, Altar, Tomb, Slaughterhouse, Boneyard, Sacrificial Pit, Temple, Haunted Gold Mine… |
| `Abgl` Blight Growth (Large) | 960 | 64 | 0.08 | **1** | the Necropolis chain |
| `Abds` Blight Dispel (Small) | 768 | 64 | 0.08 | **0** | ~50 Human / Orc / Night Elf / neutral buildings |
| `Abdl` Blight Dispel (Large) | 960 | 64 | 0.08 | **0** | each of those races' main halls |

So a Human player expanding onto a dead undead base scrubs the rot off simply by finishing a
Farm there, and *no code has to say so*. Match on the ABILITY ID rather than the base `code` —
all four share `Abli`.

`DataA` and `Dur1` are why the disc does not appear, it **grows**: 64 world units every twelfth
of a second, so a 768 bloom takes 0.96s and a 960 one 1.2s. That is the purple wash players
watch spread out from a new Ziggurat.

**And what is painted stays painted.** Blight is ground, not an aura: knocking the Ziggurat down
leaves the rot exactly where it was. The classic manual's wording is precise about it — blight
"can be dispelled by your enemies **once the building that generated it has been destroyed or
unsummoned**" ([basics](https://classic.battle.net/war3/undead/basics.shtml)) — so while the
source stands there is nothing to dispel, and a LIVE undead building takes its own disc straight
back after a dispel has scrubbed it (`reassertBlight`, driven off the dispel event rather than
polled).

**The lattice is the terrain's own.** `BlightGrid` is one flag per `war3map.w3e` CORNER, 128
units apart, sharing the map's `centerOffset` — the same lattice mdx-m3-viewer's ground shader
blends `corner.blight` over. Anything coarser or finer would have to be resampled to draw and
the seams would show. The sim never sees the w3e (it is handed a `PathingGrid`) and does not
need to: the pathing map is exactly 4× the tile grid, so `corners = pathingCells / 4 + 1` is an
identity, not an estimate.

**Rendering it is a re-texture, not a decal.** The tileset ships its own
`TerrainArt\Blight\<Tileset>_Blight.blp` and the viewer already loads it and already honours a
`corner.blight` flag; what it had no way to do was change one after load. The patch adds
`setBlight` / `flushBlight` (which re-derive a tile's four texture slots and `bufferSubData`
just those bytes) and `syncBlight` is the only caller. Because blight enters the tile's normal
texture stack it blends into the neighbouring grass the way any two tiles do, instead of ending
at a hard circle.

> **Upstream bug fixed on the way:** `this.blightTextureIndex = this.tilesetTextures.length`
> read the *previous* map's texture list (the current one is still being built in a local), so
> the index pointed at ground tileset 0 and blight would have drawn as dirt.

Two open items, recorded rather than guessed at:

* `Units\MiscData.txt` carries `BuildingUnblightRadius=350`, commented "Radius of building
  blight dispel". It disagrees with `Abds`/`Abdl`'s own 768/960 and nothing says which event it
  belongs to. The per-building row is the more specific data and the one with a mechanism
  attached, so that is what is implemented.
* Not modelled: the sickly recolour blight puts on nearby TREES (a separate `*TreeBlight.blp`
  per tileset, which outlives the blight itself), and the `Environment\BlightDoodad` props the
  real client scatters over it.

## 2. `requirePlace` = "blighted" is the whole placement rule

`UnitBalance.slk` has a column called **`requirePlace`** ("Pathing - Placement Requires"), and
in the entire stock table it takes exactly one value: `blighted`, on exactly **eleven** undead
structures —

    uaod  Altar of Darkness      usap  Sacrificial Pit      uzig  Ziggurat
    ubon  Boneyard               usep  Crypt                uzg1  Spirit Tower
    ugrv  Graveyard              uslh  Slaughterhouse       uzg2  Nerubian Tower
    utod  Temple of the Damned   utom  Tomb of Relics

What is *not* in that list is the point: the **Necropolis chain** and the **Haunted Gold Mine**.
Which is precisely the manual's "only the Necropolis and a Haunted Gold Mine can be placed on
normal land". The column IS the rule, so nothing anywhere needs a list of ids, and a custom
map's own blight-bound building works for free.

It is asked of every BUILD SQUARE the footprint covers, not of its centre: a 12×12 Temple of the
Damned is 384 units across and half of it hanging off the edge of the rot is exactly the
placement the real client refuses. The square (64 units — WC3's own placement grid) is also the
resolution the green/red ghost draws at, so what the player sees refused and what is refused are
the same squares.

The refusal has its own sentence and its own voice, and the undead are the only race with a
second one: `[Errors] Offblight` = **"Must summon structures upon Blight."**, spoken over
`UISounds.slk`'s `OffBlightUndead` → `AcolytePlacedOffBlight1.wav`, distinct from the
`CantPlace*` ("Unable to build there.") that all four races share.

## 3. An Acolyte summons and walks away

> "Acolytes do not need to maintain buildings under construction. Buildings will continue
> construction on their own (like Protoss) so start a building summoning then move the Acolyte
> to another task." — [basics](https://classic.battle.net/war3/undead/basics.shtml)

So an Acolyte that reaches its site hands the structure its own clock (`BuildingState.selfBuilds`)
and is released on the spot. That flag already existed for the Entangled Gold Mine, which arrives
at it from the other end — nobody *can* be put on that one — and the undead are the case where a
building HAS a worker and then lets it go.

The consequences are the ones players plan around: one Acolyte lays a Ziggurat, a Crypt and an
Altar in the time a Peasant lays one building, and **nothing can interrupt an undead building by
killing its worker**. It is also why the undead have no equivalent of the human speed-build:
there is nobody there to pile on to.

Per-race construction style now reads:

| race | how | who can help |
| --- | --- | --- |
| human | from outside, hammering | any number — *speed build*, at a surcharge |
| orc / night elf | from INSIDE the shell | one, and it is hidden |
| **undead** | **summons, then leaves** | **nobody, and nobody is needed** |

Two things "then leaves" has to mean literally, and both were missing:

* **It steps out from under what it raised.** The Acolyte walks to the SITE — there is no
  footprint to path around while it is walking — and the stamp lands the instant the structure
  rises, so the summoner is left standing inside its own foundation, on cells nothing can walk
  off. Every consequence of that reads as a different bug: it kneels in the middle of the
  model, a repair order aimed at the new building starts from the centre, and the Acolyte
  cannot leave at all. `stepOffFootprint` is the move the Peasant has always made and the one
  `emergeBuilder` makes for a peon coming back out; the Undead branch simply returned before
  reaching it.
* **The summoning gesture is played ONCE, at the raise.** Every other worker STAYS, so its
  work clip can be driven by the ordinary picker off `constructing`; by the time the picker is
  next asked about an Acolyte there is no job left to read. So the kneel is fired where it
  happens (`playSummonGesture` → `playWorkAnimOnce`) and sized to the clip — held while the
  Acolyte stands there, dropped the moment the player walks it off.

## 4. The Haunted Gold Mine: a crew, a clock, and no round trip

`Abgm` "Blighted Gold mine" carries the whole arrangement in four columns:

| column | value | meaning |
| --- | --- | --- |
| `DataA1` | 10 | Gold per Interval |
| `DataB1` | 1 | Interval Duration (seconds) |
| `DataC1` | 5 | Max Number of Miners |
| `DataD1` | **200** | Radius of Mining Ring |

Ten gold a second at a full crew is **two gold a second per Acolyte** — which is a Peasant's
10-per-trip round trip exactly, and the reason the race is not simply richer. `Aegm`, the
Entangled Gold Mine's row, says the same two numbers in the same two columns, so one reader
serves both (`mineCrewOf`) and the only difference is where the crew stands.

And *that* is the whole trade. A Wisp is **safe and stuck** — it is cargo inside a building with
800 hit points. An Acolyte is **exposed and free** — it kneels in the open at 200 units, where
anything can reach it, and it can be pulled off to summon something without losing its place in
a queue, because there is no queue.

> "Up to five Acolytes may gather around the Haunted Gold Mine and begin adding gold to your
> reserves, without having to carry it back to the Necropolis."

**The worker's own row says 200 as well.** `Aaha` "Acolyte Harvest" is the emptiest harvest row
in the game — no lumber per interval, no capacity, no gold per trip, no damage to a tree — and
its single number is `Rng1` = **200**, the ring's radius seen from the worker's side. Compare
`Ahar`/`Ahrl` at 116 (an arm's length: the reach to a shaft or a trunk) and `Awha` at 900 (how
far a wisp looks for a tree). Two rows, one distance, one mechanism. `WorkerProfile.minesInRing`
is the flag that names it, and it is the same *kind* of statement as the Wisp's
`deliversInPlace`: what this worker's harvest ability does NOT carry.

**Its model agrees, too.** `Acolyte.mdx` authors exactly eight clips —

    Stand · Stand 2 · Walk · Attack · **Stand Work Gold** · Death · Decay Flesh · Decay Bone

— with no "Stand Gold" and no "Walk Gold" anywhere, because an Acolyte never carries gold and no
pose for carrying it was ever drawn. In their place is one clip for kneeling at a mine and
working it where it stands. It is the only unit in the game with one (`AnimSet.standWorkGold`).

Three practical rules the geometry forces:

* **The ring is pushed OUT along its own ray** where a station would land inside solid ground.
  `Abgm`'s 200 is measured from the mine's centre and a gold mine is a 16×16-cell building.
  Pushed *radially* the ring keeps its shape and its slots stay distinct; a nearest-free-cell
  search collapses two neighbours onto the same doorstep.
* **A slot is claimed at ARRIVAL, and the NEAREST free one wins.** Acolytes arrive as a clump
  from one side — the melee opening literally spawns three of them together — and handing out
  slots in index order sends some of them round the far side of the building, through the two
  who have already sat down. They wedge, and the ring never fills.
* **An Acolyte cannot mine a BARE mine at all.** There is no ring until the mine is haunted:
  `[Errors] Blightminefirst` = "Must haunt gold mine first." The mirror of a Wisp having no pick.

**And the ring is DRAWN.** WC3 paints a rune circle on the ground at every one of the five
stations — `Abilities\Spells\Undead\UndeadMine\UndeadMineCircle.mdx` — which is what makes a
mine with three of the five taken legible at a glance. The model authors exactly
**Birth · Stand · Death** and nothing else, and that is the whole lifecycle stated by the art:
the marks bloom as the haunting finishes, hold while the building stands, and play their Death
when the record goes — mined out, or knocked down by an enemy and left as the bare rock it was.
They ride the persistent-FX pool buff art uses (`collectMineCircles`), so all three acts come
for free.

Two things follow from the marks existing, and neither is cosmetic:

* **The stations are ONE answer, not two that have to agree.** `mineRingStations` is what the
  renderer places the marks from and what `tickRingHarvest` walks the Acolytes to, so a map
  that widens the ring or seats a sixth Acolyte gets the circles to match with no second
  reading of `Abgm`.
* **An Acolyte STEPS ONTO its mark, it does not walk round to it.** The approach is one leg,
  not two: it walks up to the RING (measured against the mark it is heading for, since the
  stations are pushed clear of the building's 16×16-cell footprint and "within `Abgm`'s 200 of
  the centre" is ground nobody can stand on), takes the nearest free mark on arrival, and is
  placed on it. A second walk leg aimed at the station went straight through the building, so
  the pathfinder took it the long way round the mine and past whoever was already kneeling —
  and left where the walk happened to stop, a crew reads as five Acolytes standing *beside*
  five circles. The station is walkable by construction (`ringStation` pushes out along its
  own ray until it is), and this happens once.
* **The marks are TURNED to face the mine.** The circle is not radially symmetric: it is a
  broken ring whose open side — the straight bar the runes hang off — is the side the Acolyte
  kneels on. Unrotated, all five point the same way and four of them read as litter on the
  ground. The model is authored with its bar along **−X**, so the heading that puts the bar
  INTO the mine is the one pointing AWAY from it — a half-turn off the usual "models face +X",
  measured against the real client rather than assumed.

**A ring is not a cargo hold, and the rally path has to know it.** "Go and mine" aimed at a mine
with a building over it (`issueGoldWork` — a right-click on the rock, and a rally flag planted
on it) used to answer with `issueGarrison` whatever the building was. That is right for an
ENTANGLED mine, whose crew climbs inside, and wrong for a HAUNTED one, which has no hold to
enter: the order was refused and the Acolyte fell through to a plain move and stood at the rock
doing nothing. `garrisonCap` is the question, asked in the same terms `mineCrewOf` reads the two
rows in — a hold, or a ring.

**Placement snaps to the mine.** A building carrying `Abgm` is valid exactly where a free gold
mine is and nowhere else, so the ghost jumps from mine to mine rather than sliding over the
ground — and the ordinary footprint test is bypassed, because the mine's own cells are stamped
unbuildable and that is the one site the building belongs on.

**The melee opening already asked for all of this.** `Blizzard.j`'s `MeleeStartingUnitsUndead`
runs `BlightGoldMineForPlayerBJ` (which is `RemoveUnit` on the mine + `CreateBlightedGoldmine`
in its place) and then `SetBlightLoc(whichPlayer, nearMineLoc, 768, true)` — a patch of rot
around the mine, which is what the three Acolytes standing there regenerate on. Both were
no-ops; as no-ops the race began its game off blight, next to a mine it could not use.

`CreateBlightedGoldmine` raises a real `ugol` but hands back the **mine's** handle, deliberately:
our mine is not a unit (see `MINE_ID_BASE`), the gold lives on the mine record and the building
merely stands over it — and the two things Blizzard.j does with the return value
(`SetResourceAmount`, `GetUnitLoc`) are questions about the mine.

## 5. Unsummon: half of it back

`Auns` — DataA "Salvage Cost Ratio" **0.5**, DataB "Accumulation Step" **50**.

> "Converts buildings back into resources, recovering 50% of construction costs. Acolytes
> automatically Unsummon Haunted Gold mines after they are empty."
> — [Acolyte](https://classic.battle.net/war3/undead/units/acolyte.shtml)

It is the mirror of summoning, and it is why an undead player can *re-shape* a base rather than
live with it: a Ziggurat put down in the wrong place is half its gold back, not a total loss.
The building leaves the way a CANCELLED one does — no death, no corpse, no kill credit, and the
renderer plays the race's own cancel explosion over the spot — which is not an approximation: an
unsummoning is a building being un-made by its owner, which is exactly what a cancel models.

Open: the row carries **no duration** (`Dur1` and `Cast1` are both 0), so the building goes at
once here rather than collapsing over a few seconds as the real client shows. What the step of
50 measures is unrecorded — the granularity the salvage trickles in at is the obvious reading,
and a trickle needs the duration the row does not give — so it is applied as the rounding of the
payout.

## 6. The Acolyte has ONE work pose, and the Ghoul has no hammer

Two card-and-clip facts that belong here because both are read straight off the same rows.

**One pose, three jobs.** `Acolyte.mdx` authors no "Stand Work" at all — its only working clip
is **"Stand Work Gold"**, and WC3 plays that same kneel for every one of the three things an
Acolyte does with its hands: mining a Haunted Gold Mine, repairing (`Arst` Restoration), and the
summoning gesture over a building it lays down. So `AnimSet.build` falls through `standWork` →
**`standWorkGold`** → the attack swing, in that order; without the middle rung an Acolyte swung
its blade at everything it mended. Looped for the two jobs that last (mine, repair), once for
the one that does not (summon — see §3).

The mining kneel needed one more thing said. `chopLumber` falls back to the plain attack clip
for a model that authors no "Attack Lumber", which the Acolyte does not — so the renderer's
chop-driven branch had it hacking at the rock on the chop clock and `pickSequence`'s ring branch
was never reached. `ringSlot` is the flag that tells the two harvests apart: a swing at a tree,
or a channel at a mine.

**Gather is a BUTTON, and the data says so four times.** `Ahar` (Peasant/Peon), `Ahrl` (Ghoul),
`Aaha` (Acolyte) and `Awha` (Wisp) each carry the same pair of faces at the same slot —

    Art=ReplaceableTextures\CommandButtons\BTNGatherGold.blp
    Unart=ReplaceableTextures\CommandButtons\BTNReturnGoods.blp
    Buttonpos=3,1        Order=harvest

— and `[Ahrl]`'s entry in `CommonAbilityFunc.txt` is a comment saying it out loud: "Lumber
Harvest uses button art and position from the [Ahar] Harvest ability." The `Un` half is not a
toggle but a STATE: a worker with a load shows Return Goods, because that is what the same
button does next (`isHarvestCode` in `data/races.ts`, `toggleIsOn` → `carryGold || carryLumber`; the order is `returnresources`). A
Wisp and an Acolyte never carry anything, so theirs never turns over — which is what the
original shows too.

That makes the GHOUL's card fall out of the data rather than out of a list of ids:

| | Ghoul | why |
| --- | --- | --- |
| Build Structure | **no** | `[ugho] Builds` is empty — it gathers lumber and nothing else |
| Repair | **no** | its `abilList` is `Acan,Ahrl,Aiun` — no `Arep`/`Arst`/`Aren` anywhere, and `repairRefusal` was already refusing every press |
| Gather / Return | **yes** | `Ahrl`, at the same `Buttonpos=3,1` as everyone else's |
| Cannibalize | once researched | `[Acan] Requires=Ruac` |

The Build button now asks the worker's own `Builds` list (an empty one used to open an empty
page) and the generic Repair fallback is gone: repairing is an ability, and all four stock
workers carry their own row for it.

## 7. Web (`Aweb`) — Ensnare aimed upward

The Crypt Fiend's, and the two abilities are ONE ability in the data: `AbilityMetaData.slk`
declares the `Ens1..Ens3` field group `useSpecific = "Aens,ACen,Aweb,ACwb,AIwb"`, so a Web's
Data columns ARE an Ensnare's, and the numbers agree (both `DataA` 0.6, `DataB` 200). What is
not shared is `targs1`: Ensnare takes `ground,air,enemy,neutral` and Web takes
**`air,enemy,neutral`** — it is the half of Ensnare that only ever points at a flyer.

Which is why it does the one thing Ensnare does not have to: the target is pulled DOWN.
`SimUnit.webbed` is derived from the buff's group the way `ethereal` is derived from Banish's,
and it changes two answers — `targetKeyOf` reports `ground` instead of `air` (melee units can
reach a webbed Gargoyle, which is the whole point of the ability) and `flyHeight` drops to the
floor and back to the type's own `moveheight` when it wears off. The pin itself is Ensnare's
full root: it cannot move, it can still shoot. Duration `Dur1` 12, `HeroDur1` 7.

The BUTTON is the part that needed no code at all, and that was the bug: `[Aweb] Requires=Ruwb`
already gates it through the ordinary tech check and the row already sits on `ucry` from birth
(`[ucry] abilList = Aweb,Aspa,Abur,Aiun`), so the research was landing on an ability
`KNOWN_ABILITIES` had never been told about. Adding the row is what makes the Web upgrade
visible.

## What is still missing

This milestone is the ECONOMY. The rest of the race is data-driven and largely arrives for free
(the tech tree, the unit roster, the four heroes' spells), but these are known gaps:

* **Sacrifice** — `Alam` (an Acolyte turning itself into a Shade at the Sacrificial Pit) and
  `Asac` (the Pit's own). Both are `todo` in [`abilities-audit.md`](./abilities-audit.md).
* **Ziggurat towers** — `uzg1`/`uzg2` upgrade through the ordinary building-upgrade path, but
  `Afra` Frost Attack (the Nerubian Tower's) is an ORB effect and belongs with [`orbs.md`](./orbs.md).
* The Obsidian Statue's `Arpl`/`Arpm`/`Arpb`, the Destroyer's `Aave`/`Advm`/`Aabs`, the Banshee's
  `Acrs`/`Aams`/`Apos`, the Necromancer's `Arai`, the Meat Wagon's `Amel`/`Amed`/`Aexh`, the
  Graveyard's `Agyd`, the Gargoyle's `Astn`, the Shade's `Agho` — all still `todo`; see the
  audit for the full list. (The Crypt Fiend's `Aweb` came off it — see §7.)
* Blight on TREES, and the blight doodads (see §1).

## The Obsidian Statue is the race's only healer

`uobs` carries two autocasts and **they are not the Moon Well's `Ambt`** — that is a battery a
unit walks up to and drinks from, which is why a well stands in a base and a statue walks with the
army. The statue's are ordinary unit-target autocasts it casts on somebody:

- **`Arpl` Essence of Blight** — restores life. The important one: without it an undead army has
  to go home between fights, which on a melee map *is* the fight.
- **`Arpm` Spirit Touch** — restores mana.

Both live on every statue and **both draw on the same mana pool**, so a statue with both switched
on does neither job well. That is why an undead player builds two and splits them, and it is what
`ComputerPlusAi.statuePass` does (life to the first — see [`computer-plus.md`](./computer-plus.md)).

The tech gates are `[uslh] Requires=unp1,ugrv` (a Slaughterhouse needs a Halls of the Dead and a
Graveyard — tier 2) and `[uobs] Requires=utom`, the **Tomb of Relics**, which is also the race's
shop. `uobs` UnitAbilities is `"Arpl,Arpm,Aave"`; the `Amb2` row in AbilityData, whose base code
*is* `Ambt` and whose comment says "Mana Battery (Obsidian Statue)", is not what the unit carries.
