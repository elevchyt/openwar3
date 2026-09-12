# Hotkeys — which key presses which button

Options → Gameplay → **"Hotkeys:"** offers three, and the row is OpenWar3's
([`src/overrides/ui/OptionsMenu.fdf`](../src/overrides/ui/OptionsMenu.fdf)): the 2003 screen had
a checkbox here instead, "Custom Keyboard Shortcuts", which is one of the three answers rather
than the whole question (issue #142).

Read this before touching [`src/data/hotkeys.ts`](../src/data/hotkeys.ts),
[`src/data/customKeys.ts`](../src/data/customKeys.ts), the key handler in
[`src/ui/hud.ts`](../src/ui/hud.ts), or `cmdSection` in
[`src/render/mapViewer.ts`](../src/render/mapViewer.ts).

| rung | where the key comes from | where it is implemented |
|---|---|---|
| **Legacy** (default) | a letter the DATA carries — `Hotkey` on the ability/unit/upgrade/item row, or `Hotkey` in the `[Cmd*]` section for the engine's own buttons | nowhere: it is what the card has always done |
| **Grid** | the button's PLACE on the card | `hotkeys.ts`, in the HUD's key handler |
| **Custom** | the player's `CustomKeys.txt` | `customKeys.ts`, at the SLK boundary |

**The three are not three implementations of one thing, and that is the point.** Grid is a
KEYBOARD scheme — it changes how a key finds a button and reads nothing about the button. Custom
is a DATA overlay — it changes which letter is written on the button, and the card then finds it
by letter exactly as Legacy does. Which is why `gridHotkeys()` answers **false** for `custom`,
and why nothing in the HUD's key handler mentions custom keys at all.

## Grid

The command card is 4×3 and so is the block of keys under the left hand, row for row:

```
 Q W E R        ← the card's top row
 A S D F        ← its middle row
 Z X C V        ← its bottom row
```

The pockets move with it and take the 2×3 block immediately to the right of that hand — **T/Y,
G/H, B/N** — which is the same shape the numpad's 7/8, 4/5, 1/2 has. The numpad stays live
either way, being a place too.

Every grid key is read off **`KeyboardEvent.code`**, never `.key`. Grid is a claim about the
SHAPE of the keyboard: the top-left four keys are the card's top row whatever the layout prints
on them. Legacy is the opposite — a letter the data names — and goes on reading `.key`.

The pockets are asked **before** the card. The two sets of letters do not overlap, but an
inventory key is the more specific claim, which is the same way round as the numpad block above
it in the handler.

The tooltip has to move with the binding or it lies: Legacy gilds the key inside the name because
that is where the key came from (`|cffffcc00M|rove`), and a grid key is nowhere in the name. So
`gridTitle` strips the gilding and prints the real key after the name — "Train Peasant (Q)",
"Potion of Healing (T)" — in the parentheses and the `|cfffed312` gold the game's own
`ITEM_NAME_HOTKEY` uses for exactly this.

## Custom — `CustomKeys.txt`

**The format documents itself.** `CustomKeyInfo.txt` ships in every install and is the source for
everything in this section; `CustomKeysSample.txt` beside it is the whole default set written
out, ready to edit. Read those before this.

A section is an OBJECT ID — a unit, an ability, an upgrade, an item — or one of the engine's own
`[Cmd*]` sections, and it may set **eleven** fields and no others:

| family | fields |
|---|---|
| hotkeys | `Hotkey`, `Unhotkey`, `Researchhotkey` |
| button positions | `Buttonpos`, `Unbuttonpos`, `Researchbuttonpos` — `x,y`, x=0 leftmost … x=3 rightmost, y=0 top … y=2 bottom |
| tooltips | `Tip`, `Untip`, `Researchtip`, `Revivetip` (the altar's), `Awakentip` (the tavern's) |

A comma list is one value **per level**, for the actions that have levels: `[Rhme]
Hotkey=X,Y,Z` is the three ranks of the human melee upgrade, and `Tip=` takes three to match.

**Eleven and not one more.** `OVERRIDABLE` is a closed list on purpose. This file is the
player's — hand-edited, or written by one of the hotkey generators everybody uses — and it is
merged straight onto the game's own data tables. A blanket merge would let it rewrite a damage
column. It may rebind and re-word; it may not change the game, and
[`tools/custom-keys-test.cjs`](../tools/custom-keys-test.cjs) pins that.

### Where it is merged

Each of the four registries (units, abilities, upgrades, items) and `commandStrings` builds a
`MappedData` out of the install's `*Strings.txt` / `*Func.txt` and then reads `Hotkey` / `Tip` /
`Buttonpos` off it. The overlay goes on **there**, one `layCustomKeys` per table — so the command
card, the learn page, the shop and every tooltip read the player's value without knowing this
feature exists. That is also what the file says it does: "Entries in this file will override the
existing default shortcuts."

The engine's own buttons are the half with no object row to carry an edit, and a real
CustomKeys.txt moves them constantly (`[cmdrally] Hotkey=F`). Theirs land in
`Units\CommandStrings.txt`'s table, which is why **the letters are no longer retyped at
`cmdSection`'s fifteen call sites**: a letter written in `mapViewer.ts` is a letter no
CustomKeys.txt can move.

### Three traps, each of which fails silently

1. **Line endings.** mdx-m3-viewer's `IniFile` splits on `"\r\n"` and nothing else. This is the
   one game file a PLAYER writes — on any OS, in any editor, or by a generator — so an LF-only
   file is not a corner case, and unnormalised it parses as one enormous line and yields no
   sections at all. Which looks exactly like "custom keys do nothing".
2. **Casing.** The game's rows are `Anei`, `CmdRally`, `Rhme`; a real file says `[anei]`,
   `[cmdrally]`. `MappedData.getRow` is an exact lookup, so a straight `load()` of the file mints
   a second `anei` row beside `Anei` and overrides nothing. The overlay therefore walks the
   TARGET's rows and matches case-insensitively, which also means a row is only ever
   **overridden, never invented**: a section naming something the install does not have finds
   nothing and is dropped.
3. **`Hotkey=` is sometimes a NUMBER.** `[CmdCancel] Hotkey=27` is in the shipped file, and 27 is
   `VK_ESCAPE` — the engine writes a virtual-key code where the key has no letter, and the Tip
   says so in words ("Cancel (|cffffcc00ESC|r)"). Read as a letter it is "2". `keyName` resolves
   the codes it can name and answers "" for the rest, leaving the caller's own key standing.

### Where the file lives

`CustomKeyInfo.txt` names two places in two consecutive paragraphs — the 1.30 user-data path
`Documents\Warcraft III\CustomKeyBindings\CustomKeys.txt`, and then "once a customization file
has been created in the **installed folder**". The user-data folder is outside the install and
therefore outside everything a folder pick can see, so what OpenWar3 honours is the
installed-folder spelling, plus the same `CustomKeyBindings\` sub-folder inside the install in
case the player kept that shape when they moved the file where the game could be pointed at it.

It is a LOOSE file beside the exe, not an archive entry, so it cannot arrive through the
`DataSource` every other table is read from. It rides on `PickedInstall.customKeys` instead and
is handed to the data layer by `loadProfile` — the one function all three install doors pass
through (the browser's picker, the desktop app's manifest, the `?dev` boot), which is the same
reason the version gate is asked there.

### What it does not reach

* **A map's own object data wins.** `w3u`/`w3a` edits are applied after the SLKs. A map's custom
  ability has an id no CustomKeys.txt could have named anyway; a base ability whose hotkey a map
  deliberately moved keeps the map's.
* **`Awakentip` has nowhere to land** — nothing reads a tavern-revive title yet (see the `uawt`
  note in [`src/data/objectData.ts`](../src/data/objectData.ts)). It is carried so that the day
  something does, the player's file is already being asked.

## When a change takes effect

The overlay is applied when the registries are built, which is at the start of a match. The
Options screen is not reachable from inside one — `escMenu`'s Options button is greyed, there is
no `EscMenuOptionsPanel` yet — so the row can only change BETWEEN matches, which is exactly when
the registries are rebuilt. Grid, being a keyboard scheme rather than data, is live either way.
