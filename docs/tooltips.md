# Tooltips — the command card's, and the world's

The slab that appears above the command card when you hover a button: an ability, a unit to
train, a building to raise, an upgrade to research, a ware to buy, an item in the hero's pockets,
one of the engine's own orders. Also its sibling, the **hover slab** that floats over a unit in
the world.

Read this before touching `.hud-tooltip` in [`src/style.css`](../src/style.css),
`TOOLTIP_BOX` / `FONT_HEIGHTS` / `showTooltip` / `showItemTooltip` in
[`src/ui/hud.ts`](../src/ui/hud.ts), or `requirementLine` / `stockLine` / `patronLine` /
`cmdSection` in [`src/render/mapViewer.ts`](../src/render/mapViewer.ts).

## There is no FDF for it, and the game says so

The obvious place to look is `UI\FrameDef\`, and it is the wrong place: **no `.fdf` in the
install declares the command tooltip.** It is one of `CGameUI`'s programmatic frames — built in
code, not laid out in a file. `UI\MiscUI.txt` states the rule in its own words, right above the
block that exists precisely because of it:

> The following font heights are for text where the frame they are associated with is not
> created through the use of FrameDef files, such as when the frame is programatically created.
> […] To change the font height of a frame created in the FrameDef files, you will need to look
> in the appropriate .fdf file.

So the tooltip is described by **four** files, none of them a FrameDef of its own:

| what | where |
|---|---|
| the type sizes | `UI\MiscUI.txt` **[FontHeights]** |
| the art | `UI\war3skins.txt` **[Default]** `ToolTip*` |
| the lines the engine composes | `UI\FrameDef\GlobalStrings.fdf` |
| the engine's own buttons' words | `Units\CommandStrings.txt` |

Anything not in those four is **ours**, and every such value in the code says so.

## Type: three keys, one size

```
ToolTipName=0.011               // tooltip name (first line)
ToolTipDesc=0.011               // tooltip description and ubertip
ToolTipCost=0.011               // tooltip cost value
```

All three the same. **The name line is not drawn larger than the body** — that is the single
biggest thing that made ours read wrong (14 / 13 / 12.5 hard pixels, three sizes where the game
has one). They are fractions of the 0.6-tall UI space, so each is a length off `--stage-h`;
`FONT_HEIGHTS` in `ui/hud.ts` holds them by their own keys and `uiPx` converts. At a 900-tall
stage 0.011 is 16.5 px.

The same block also sizes the **hover slab** — `UnitTipPlayerName`, `UnitTipUnitName`,
`UnitTipDesc`, all 0.011 as well, so one length serves every line of it. They are listed apart
in `FONT_HEIGHTS` because the game lists them apart.

The heights are written to **`:root`**, not to the HUD root, because the hover slab lives in
`ui/stage.ts`'s world layer — a DOM subtree the HUD does not own. Same reason the tooltip's art
is lifted there (`applyWidgetSkin`). `dispose()` sweeps `--font-` and `--tt-` back off.

Two more `[FontHeights]` keys land on things whose current size is derived from the ART instead,
and they **disagree** with the file — an open question rather than a settled one:

* `CommandButtonNumber=0.009` against `.hud-count-badge`, whose numeral is sized in `cqw`
  against the `CommandButtonNumberOverlay` texture's own box (the numeral has to sit *inside* a
  painted frame, which a font height cannot promise).
* `PortraitStats=0.011` against the skinned `.hud-hp-value`, measured at `0.052 × --console-h`
  = 0.00915 of the UI space. 20 % apart.

Both need a screenshot pass against the console art before being switched over; neither is a
tooltip.

## Art: one skin for every race, and one file that isn't there

`war3skins.txt` keeps the tooltip keys in **[Default]** only — no `[Human]`/`[Orc]`/`[NightElf]`/
`[Undead]` section overrides them, so **every race hovers the human frame**:

```
ToolTipBackground=UI\Widgets\ToolTips\Human\human-tooltip-background.blp
ToolTipBorder=UI\Widgets\ToolTips\Human\human-tooltip-border.blp
ToolTipGoldIcon / ToolTipLumberIcon / ToolTipStonesIcon / ToolTipManaIcon / ToolTipSupplyIcon
UnitTipBackground=UI\Widgets\ToolTips\Human\human-tooltip-background2.blp
```

Decoded from the mounted install (`tools/install.cjs`'s `openInstall` plus mdx-m3-viewer's
`BlpImage`, headlessly in Node):

* `human-tooltip-border.blp` — **128 × 16**, eight 16 × 16 tiles.
* `human-tooltip-background.blp` — 64 × 64, one flat colour throughout (`24,34,49` at alpha 195).
  `tooltipFill` reads its single pixel rather than tiling it.
* the five cost icons — 32 × 32 each.
* **`human-tooltip-background2.blp` does not exist.** war3skins names a file 1.30.4 does not
  ship, so `UnitTipBackground` cannot resolve and the hover slab necessarily borrows
  `ToolTipBackground`. Ours does the same — now on purpose.

There is **no cooldown icon**, which settles a question you may be tempted to ask: the cost row
is gold / lumber / stones / mana / supply and nothing else. A spell's cooldown is not on it.

### Why the band is a band and the line is thin

Reading the border tiles' alpha is what makes the geometry make sense:

```
tile 0 (left edge)          tile 4 (upper-left corner)
| .+##+.         |          |                |
| .+##+.         |          |    ............|
| .+##+.         |          |   .++++++++++++|
   … 16 rows …               |  .++###########|
                            | .++############|
                            | .+####+++++++++|
                            | .+###++........|
                            | .+##++.        |
                            | .+##+.         |
                               … straight …
```

Tiles 0/2 are a plain vertical stroke at texels 1–4, tiles 1/3 the same at 9–12, tiles 4–7 the
corner arcs. Two consequences:

1. **The edges are UNIFORM along the run**, so tiling and stretching render identically for this
   art — but the engine *tiles* a `BackdropEdgeFile`, so `border-image` uses `round`. It also
   means `sliceTooltipBorder` has to rotate tiles 2 and 3 a quarter turn to serve as the
   horizontal edges (they are drawn as vertical strips in the strip).
2. **Only 4 of the band's 16 texels carry ink, and only 2 are opaque.** So the visible gold rule
   is always a quarter of the band, and the frame reads thin however wide the nine-patch is.

`TOOLTIP_BOX.band` is **measured off a reference shot of the real client**, and against the type
rather than in pixels — the only scale-invariant thing in a screenshot. There the corner arc's
radius is a little over half the cap height of the title beside it, ≈ 0.55 em, and the band *is*
the arc.

`Glue/BattleNetChatActionMenu.fdf` dresses the identical bnet strip with `BackdropCornerSize
0.016` / `BackdropBackgroundInsets 0.005` / a first label anchored 0.0095 in, and 0.016 is
tempting because it is exactly the tile at 1:1 on a 600-tall screen. **It was tried and it is
wrong for the tooltip** — 2.4× too heavy, a fat rounded frame nothing like the reference. That
FDF dresses a 0.18 × 0.2 context menu; 0.016 is the art's own resolution, not a statement about
the tooltip. The tooltip draws the same tile smaller.

## The box

`right: 0`, not `left`. In the reference shot the slab is far wider than the command card and
hangs off its **left** edge with the right edges flush — measured in the running game at 1325 vs
1324, which is the border pseudo-element's own inset.

That pin comes with a trap worth stating once: an absolutely-positioned box with only **one**
horizontal edge pinned shrink-to-fits against the space from its containing block to that edge —
and the containing block here is the command card, which is *narrower than the tooltip*. So
pinning the right edge silently capped the width at the card's and wrapped the body two lines
early. `width: max-content` with `max-width` doing the wrapping is the fix.

Where it wraps is stated in **ems of its own body text** (`TOOLTIP_BOX.wrapEm`), because that is
the relationship the shot shows — the box is as wide as the text it has to fit. The number is
ours; the shot is what it matches: an Ancient of War's Ubertip breaks after "Keeper of primary
assault troops. Trains Archers," — 48 characters, where ours broke at 35.

Also from the shot, and also ours: leading is **tight** (1.2, not the 1.4 that opened the body
into a paragraph), and a cost icon is the **height of the digit beside it** — the art is 32
texels square and drawn at its own resolution it towers over 0.011 type.

## The lines the engine composes

`GlobalStrings.fdf` is where the tooltip's own sentences live. Take them from the table; never
retype them. A literal is the same bug twice — a localized install says the English, and our
copy of the markup is free to drift from the file's.

| key | string | where |
|---|---|---|
| `REQUIRESTOOLTIP` | `\|Cffffff00Requires:` | `requirementLine` |
| `REQUIREDLEVELTOOLTIP` | `Hero level:` | the learn-skill page |
| `OUTOFSTOCKTOOLTIP` | `Out of stock` | `stockLine` |
| `COOLDOWNSTOCKTOOLTIP` | `Coming soon` | `stockLine` |
| `ITEM_NAME_HOTKEY` | `%s (\|cfffed312NumPad %u\|r)` | `showItemTooltip` |
| `ITEM_USE_TOOLTIP` | `\|CFFFED312Left-Click to Use\|R` | `showItemTooltip` |
| `ITEM_PAWN_TOOLTIP` | `\|cff808080Drop item on shop to sell\|R` | `showItemTooltip` |

**`REQUIRESTOOLTIP` is worth reading as it is written.** The colour is baked into the *string*,
it is pure **yellow** — and it has no `|r` to close it, so the requirement names that follow
stay yellow to the end of the line. Ours drew it in red for a long time, hard-coded in English.

**`REQUIREDLEVELTOOLTIP` carries no colour of its own**, unlike its neighbour. It is the same
*kind* of line, so it is dressed in the same yellow rather than in a gold of our own choosing.

**The two empty-shelf strings are two strings for a reason.** A ware that has been bought and is
restocking is "Out of stock"; one whose `stockStart` has not come round yet has never been on the
shelf at all, and a Tavern hero before 2:15 is "Coming soon". Neither the count nor the clock
tells them apart — `period` is the `stockStart` wait in one case and the `stockRegen` one in the
other, and a map may make them equal — so `ShopStock.pending` carries the bit, set at seeding
and cleared by the first arrival.

Note that these are the **tooltip** keys, distinct from `commandstrings.txt`'s `[Errors]
Outofstock`, which is what `buyItem` speaks aloud when the click actually arrives. The shelf says
it quietly and the click says it out loud; both exist in the real game. `Neednearbypatron` is the
one refusal the card states in **advance**, because it is the one you cannot fix by waiting.

`ITEM_PAWN_TOOLTIP` is the only place the game ever tells you that dropping an item onto a shop
sells it. It is grey because it is an affordance and not an instruction, and it is gated on the
item's own **`ipaw`** — a quest item cannot be pawned, so the offer does not apply to it.

## The engine's own command buttons

Move, Stop, Hold Position, Attack, Attack Ground, Patrol, Build, Set Rally Point, Hero Abilities
and the four Cancels are **not abilities**, so they have no `AbilityStrings` row. The game keeps
them in `Units\CommandStrings.txt`, one `[Cmd*]` section each:

```
[CmdHoldPos]
Tip=|cffffcc00H|rold Position
Ubertip="Orders your units to stand where they are and attack units that are within range. When
on Hold Position your units will not chase down enemy units that run away, nor move to engage
ranged attackers."
Hotkey=H
```

The `Tip` already gilds the hotkey letter, so the title pairs itself with the letter on the
button's corner with nothing for us to do. The Ubertips are much fuller than a one-line
paraphrase and they say things a player actually needs: that a Move onto a **unit** follows it,
that Hold Position will not chase, that a rally point can be set on a mine or on trees to
auto-harvest. `cmdSection` reads them — and the `Hotkey` beside them, which is the **only**
place Move's M and Rally's Y are written down anywhere in the game. The fallbacks passed in
beside each call are the file's own English and the file's own letter, so an unmounted install
reads and answers the same.

> **The trap that hid all of this for a year.** `MappedData` lower-cases every property key as
> it loads, so `map["Tip"]` is `undefined` and always was. Read with the file's own
> capitalisation, `loadCommandStrings` found nothing in any `[Cmd*]` section and every engine
> command button silently fell back to the English beside its call — invisible on an English
> install, and exactly the bug reading the file is supposed to prevent on any other one. Found
> while wiring `Hotkey` (issue #142). The `[Errors]` half never had it, because that loop
> lower-cases the keys it finds rather than naming them.

Two options change what this paragraph produces, both under Options → Gameplay → "Hotkeys:"
([`src/data/hotkeys.ts`](../src/data/hotkeys.ts)):

* **Grid.** The key is the button's PLACE on the card and is nowhere in its name, so `gridTitle`
  strips the gilding — which would now point at a key that does nothing — and prints the real key
  after the name, in the parentheses and the `|cfffed312` gold `ITEM_NAME_HOTKEY` uses for
  exactly this: "Train Peasant (Q)".
* **Custom.** The player's `CustomKeys.txt` ([`src/data/customKeys.ts`](../src/data/customKeys.ts))
  rewrites the `Tip` and the `Hotkey` in the table above before anything reads them, so nothing
  here knows it happened. That file is also the only thing that ever gives a `[Cmd*]` section a
  `Buttonpos` — the stock file carries none.

Three things the sections settle that a paraphrase gets wrong:

* **Build is race-specific.** `[CmdBuildHuman]`/`[CmdBuildOrc]` say "Build Structure",
  `[CmdBuildNightElf]` says **"Create Building"** and `[CmdBuildUndead]` says **"Summon
  Building"** — and the Ubertips say "create" and "summon" to match. A Wisp does not build and an
  Acolyte does not either. `buildCmdKey` asks the **worker**, not the lobby seat, so a
  transferred worker keeps its own race's card. (`[CmdBuild]` and `[CmdBuildNaga]` exist too.)
* **Cancel is four buttons.** `[CmdCancel]` drops an un-issued *order*; `[CmdCancelBuild]`,
  `[CmdCancelTrain]` ("Stops training the current unit.") and `[CmdCancelRevive]` are separate
  sections for the same slot.
* **Set Rally Point** is `Set Rall|cffffcc00y|r Point` — the gilded letter is not the first one.

Each section also carries a `Hotkey`, which we do **not** read yet: ours already agree with the
file for every one of these (M/S/H/A/P/B/Y/O), and `[CmdCancel]`'s is the raw VK code `27`.
Reading them is the door to `CustomKeys.txt`, the player's own remap file, and belongs with that
work rather than here.

## The slab refreshes under a still cursor

The command tooltip is re-shown **every frame** for the slot the cursor is on (`Hud.refreshCmdTooltip`),
against whatever that slot holds now — not only on `pointerenter`. The reason is that most of what a
tooltip says is a *reading*: the cost row reddens by comparing the price to the stash, the yellow
"Requires:" line is the tech you are missing, and the DIS* twin is a prerequisite. Every one of those
changes while the cursor sits still, and a `pointerenter` fires only when it moves. The twelve buttons
are built once and only re-dressed, so the element under the cursor never changes either; the old
code hid the slab whenever the card's key changed and waited for an enter that never came, which is
why a Farm's red 80 stayed red after the gold arrived until you re-hovered. Every writer to the slab
goes through `setTooltip`, which writes the DOM only when the HTML differs, so the per-frame re-show
costs a string compare. `:hover` is asked directly because an emptied slot is a disabled button, and
a disabled button is not told when the cursor leaves it.

## The gold mine's worker count wears the same dress

The `3/5` the game prints across a gold mine — a classic one three Peasants are working, and an
Entangled or a Haunted Gold Mine alike, green once it reads `5/5` — is drawn in the tooltip's own art
(a classic mine has no crew column of its own, so its `/5` is the `Abgm`/`Aenc` "Max Number of
Miners" — `SimWorld.classicMineCrew` — and a worker counts only while its order is still `harvest`
or `return`, so pulling one off the mine takes it off the count) — the `human-tooltip-border` strip
around the tooltip's slate — so `.unit-crew-count` shares `.hud-tooltip.skinned`'s nine-patch and fill
(`worldOverlays.ts syncCrewLabels`). What it *says* is a per-side fact: only the local player's and
their allies' workers count, an enemy's crewed mine floats nothing (not even the `/5`), and it needs
eyes on the mine. On the host that is `SimWorld.mineCrewFor` for the local seat; a client is sent the
answer per recipient (`MineSnapshot.crew`/`crewCap`), because the harvest targets it would be counted
from never cross the wire.

## Still open

* **Cost-number colour.** Ours is `#fed312` gold, reddening when you cannot pay. The reference
  shot agrees on gold, but the red is unverified — the engine hard-codes both.
* **The gap above the card** is 48 px at a 1080 reference, chosen to clear the console art's own
  top edge rather than measured off anything.
* **Enhanced Tooltips.** The Options panel's `TooltipsCheckBox` (`ENHANCED_TOOLTIPS`,
  `EscMenuOptionsPanel.fdf`) is GONE from the panel as of issue #142 — it was wired
  `applied: false`, a tooltip switch that changed nothing, and what the real option adds has
  never been established. The slab described above is the one OpenWar3 draws, always. If the
  difference is ever established, the row comes back rather than the behaviour changing under
  a setting nobody can see.
* **`ToolTipStonesIcon`** is unused: nothing in melee spends Mana Stones. A custom map might.
