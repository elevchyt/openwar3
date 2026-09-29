# Icons OpenWar3 derives, and the last resort

A command-button icon comes from one of four places, in this order:

1. **The install** — `ReplaceableTextures\CommandButtons\BTN*.blp`, `PassiveButtons\PASBTN*.blp`,
   `CommandButtonsDisabled\DIS(PAS)BTN*.blp`, or a map's own imported file.
2. **Our own art** — icons drawn for objects a later patch added (the Ritual Dagger, Sundering
   Blades, Gargoyle Prioritize), PNGs in `src/patches/art/` baked to BLP by
   `node tools/patch-art.mjs` and served at the path the later game uses (docs/patches.md).
3. **DERIVED from the install** — `src/vfs/derivedArt.ts`, computed once after the mount.
4. **The placeholder** — `BTNTemp.blp`, the engine's own, for an icon nothing above can supply.

Read this before touching `src/vfs/derivedArt.ts`, `src/assets/blpEncode.ts`, `placeholderIcon`
(src/data/commandStrings.ts) or `iconAt` (src/data/abilities.ts).

## Deriving a passive icon from its command icon

The game's later patches name art a 1.30.4 install does not have, and nearly all of it is the
PASSIVE twin of an icon it does: 1.32's upgrade badges (`[Aobs] Art=…\PASBTNBerserk.blp`, while
1.30.4 has `BTNBerserk.blp` and no `PASBTNBerserk.blp`). A PASBTN is not new art. It is the BTN's
own picture with the button's bevel taken off and the edge darkened into the frame.

Measured, ring by ring in from the edge (ring = `min(x, y, w-1-x, h-1-y)`), on the pairs 1.30.4
ships BOTH halves of — Evasion and Critical Strike — and on 2.0.4's own `PASBTNBerserk` against
1.30.4's `BTNBerserk`, the passive is the command icon multiplied by:

| ring | 0–3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12+ |
|---|---|---|---|---|---|---|---|---|---|---|
| × | 0 | 0.35 | 0.36 | 0.42 | 0.57 | 0.72 | 0.83 | 0.91 | 0.97 | 1 |

— rings 0–3 are the BTN's light bevel, and they go to black; 4–11 are an inner shadow fading out.
Applied to `BTNEvasion` it lands **3.2 / 255** (mean, per channel) from the real `PASBTNEvasion`,
against 31.5 for the bordered BTN as it stands; Critical Strike 3.4 against 27.8. The rings scale
with the icon if it is not 64×64. The result is re-encoded as a paletted BLP1 (256-colour median
cut, full mip chain) by `src/assets/blpEncode.ts` — the same encoder `patch-art.mjs` uses for our
drawn icons, so both are one format.

**The disabled passive needs nothing computed**: `DISPASBTN<X>` is `DISBTN<X>` to within a level or
two (1.30.4's Evasion pair, 2.0.4's Berserk pair), so a missing one is served as that file, byte
for byte. A greyed twin is never faked with a filter — CLAUDE.md's rule — and here it does not
have to be.

## When it happens

`DerivedArtDataSource` is the OUTERMOST VFS layer (vfs/loader.ts, both install kinds), so it
derives from whatever the layers below serve — the patched tables, our own art, the edition's
data set. `prepare()` runs once, right after the mount: it reads every `*Func.txt` the object
tables live in, collects each PASBTN (and its DISPASBTN twin) they name, and derives the ones the
install lacks — 34 icons for the 2.0.4 chain, well under a second. A path nothing named at mount
(a custom map's data) is derived the first time it is asked for, and cached.

Only a PASBTN/DISPASBTN whose source exists is derived, and `exists()` answers true for exactly
those, so every other reader still sees a truthful install.

## One icon per level

A few rows name one icon per LEVEL — `[Ahlh] Art=…\PASBTNHumanLumberUpgrade1.blp,…\PASBTNHumanLumberUpgrade2.blp`
— which, read as one path, names a file that does not exist. `AbilityDef.icons` is the list,
`icon` its first, and the command card draws `iconAt(def, level)`. A map's object edit that sets
the art replaces `icon` alone, and then `icon` wins. The level itself comes from `rlev`, the
upgrade effect that SETS an ability's level to the research's (`[Rhlh] effect2=rlev code2=Ahlh`,
SimWorld.sumUpgradeBonuses): Improved Lumber Harvesting shows the first icon, Advanced the second.

## The last resort

An icon that can be neither found nor derived is drawn as **`BTNTemp.blp`** — the engine's own
placeholder — rather than as an empty square, so the ability or item behind it is still there to
see and press (MapViewerScene.blpIcon, `placeholderIcon`). Its greyed twin then comes the ordinary
way, `DISBTNTemp.blp`. Two things are deliberately NOT given the placeholder: a greyed `DIS*` icon
(its fallback is the live art) and a path that is not a button icon at all (a model's texture).
And a row whose `Art` is EMPTY is not "missing art": the game draws no button for it (Frost
Attack's `[Afrb]`), and so do we.

`tools/derived-art-test.cjs` checks all of it against the real install.
