# The observer HUD

Issue #168. A watcher (the Custom Game screen's Observer Mode, or a seat on a LAN game's
Observers bench, `MeleeConfig.observer`) no longer gets a player's console. It gets
[`src/ui/observerHud.ts`](../src/ui/observerHud.ts), fed by
[`src/game/observerView.ts`](../src/game/observerView.ts).

## The layout is the developer's; the parts are the game's

1.30.4 ships no observer HUD beyond `UI\FrameDef\UI\ObserverPanel.fdf`'s three controls (the
vision pulldown and the Fog of War and Auto Camera checkboxes). So nothing in the install says
where anything goes. The layout was chosen from three mock-ups drawn over a live match
("B, Scoreboard"):

| Where | What |
| --- | --- |
| top left | **Menu (F10)** and **Chat (F12)** (`KEY_MENU` / `KEY_CHAT`, the same doors as the keys), then the **production panel**: a pulldown switching between *Production* (every building's job in hand and every structure going up, seconds left printed in the middle as a cooldown's are), *Units* (`SCORESCREEN_TAB1`, the standing army by type with counts) and *Upgrades* (researched, at the reached rank). |
| top centre | the **scoreboard**, one table on each side of the medallion's stone bridge: colour, race, name, gold, lumber, food, APM. Two teams give one team per side; any other split puts the first half of the seats on the left. The match clock sits under the medallion. |
| bottom left | the **minimap** with its option buttons in a column. These are the console's own elements, *adopted* rather than rebuilt, so every click and hotkey behaves as before. |
| bottom middle | the **hero panel**: up to four players side by side. Each column's pulldown picks whose heroes it shows, and picking a player already shown in another column swaps the two. Each hero row holds the portrait with its level, HP and mana bars, the learned skills at their ranks, and the six-slot belt. The panel is tall enough for three heroes. |
| bottom right | a **minimal selection** readout: name, level and class, HP/mana bars, a hero's violet **XP bar** with its numbers on it (experience into the level over what the level spans), icon, Damage/Armor, and the hero's belt — then the **Status** line, as the console's info panel draws it: the game's own `COLON_STATUS` label ("Status:") and the buffs' own `Buffart` icons on one row, each naming itself on hover (`HudSelection.buffs`, the list hud.ts's `renderStatus` draws). The row is always reserved in the panel and only hidden when the unit carries nothing, so a buff landing does not shift the belt under the watcher's eye. A building at work shows its **job** instead of the stat lines: the icon of what it is making, the build bar with the verb and seconds on it (`CONSTRUCTING` / `TRAINING` / `RESEARCHING` / `REVIVING`; a tier upgrade reads the name of what it becomes) and the jobs queued behind. That is how a watcher tells which hero an altar is bringing, and whether it is a hire or a revival. **Auto Camera** stands above it with no panel, because the replay panel it belongs to is for replays and there are none yet. |

What the HUD is built *from* is the game's:

- **Every panel** is the tooltip frame (`ToolTipBorder` / `ToolTipBackground`, hud.ts
  `TOOLTIP_BOX`). The fill is the element. The gold stroke sits on a pseudo-element pulled
  `--tt-bg-inset` outside it, so the slate lies behind the stroke. Clipping the fill to the
  border's padding box instead left a ring of map showing between the two; the mock-ups had
  that bug.
- **Every pulldown and button** uses `EscMenuButtonBackdropTemplate`, at
  `ObserverVisionMenu`'s own sizes (0.024 tall, `BackdropCornerSize 0.0125`, insets 0.004,
  `PopupButtonInset 0.01`, `EscMenuTextFont` 0.011). The fill is drawn inside the insets and
  the edge file over the whole frame, which is the FDF's two layers.
- **The race mark** is the score screen's `UI\Glues\ScoreScreen\scorescreen-player-<race>.blp`,
  a 2:1 framed portrait across the middle of a 64² texture, drawn as a 2:1 banner.
- **The resource icons** are the tooltip cost icons (`ToolTipGoldIcon` and so on). The resource
  bar's own `ResourceGold.blp` has no alpha channel and drew a black square on the slate.
- **Every count** (army size, skill rank, upgrade level, charges, hero level) uses the console's
  number box (`.hud-count-badge`).
- **Every icon names itself on hover** through `setGameTip`. Skills and upgrades read
  "Name (Level N)" (`INFOPANEL_LEVEL`), and heroes read "Proper Name — Level N Class"
  (`INFOPANEL_LEVEL_CLASS`).
- Clicking a hero, a building at work or a unit type selects it and centres the camera there
  (`HudDriver.observerFocus`).

The stone console goes: `ConsoleUi.setObserver` keeps only the medallion and its bridge
(`.fdf-observer`), and `.hud-observer` hides the console's zones.

## The data, and the one lane that crosses the wire

`observePlayer` reads everything off the unit records: heroes (in hire order, which is sim-id
order), learned skills, belts, queue heads, construction and the army. This works on a LAN
client too, because a watcher's viewpoint reveals the map and so its payload carries every unit
live. Food is derived from those units (`Authority.foodFor`).

Three readings are not on a unit record, and a player's snapshot deliberately carries only the
recipient's own: the **bank**, the **research** and the **fallen heroes**. Another player's are
scouting information. That reason does not apply to somebody outside the match, so a watcher's
payload carries a fourth lane, `WorldSnapshot.watched`. The host builds it for bench seats alone
(`RtsController.watchedFor`, via `HostSources.watchedFor`). The client keeps it as sent and reads
it in `observerView` rather than writing it into its own ledgers.

**APM** is counted at `Authority.execute`, the one door every seat's accepted actions pass
through, so a person and a computer are measured by the same rule. Selections and hotkey
presses never reach an authority, so this is narrower than a replay tool's APM. The figure is a
rolling one-minute window of game time (`src/game/apm.ts`), which is ours. On a LAN it is the
host's reading, carried in the lane.

## Colour

A seat's swatch (scoreboard, production labels, hero pulldowns) is the colour its units WEAR
right now, `RtsController.unitColor`, not its slot colour. With the ally-colour filter in mode 3
a watcher's world is painted one colour per team (`observerTeamColors`), and a swatch in the
slot colour then named a colour no unit on the field had.

The mana blue (`#2a6cf0`, hud.ts `STATBAR_TINT.mana`) is the developer's pick off these
mock-ups. It now tints every mana bar: the floating ones over units, the hero bar and the group
grid. The game's own `ManaBarConsoleSmall.mdx` violet read almost black on the slab.

Gold and lumber are printed as whole numbers (`observePlayer` floors them): the bank is a float
in the sim.

## Re-rendering under the pointer

Every reading refreshes four times a second, so the icon under the pointer must stay the same
job from one refresh to the next. The production strip is soonest-first, and it used to sort on
the WHOLE seconds it prints: two jobs showing the same number tied, the tie was broken by
whichever had ticked over first, and the two swapped places every second. The icon under the
pointer, and its hover name, flipped with the clock. It now sorts on the exact seconds left
(`productionOf`). Every head of queue ticks at the same rate, so that order only changes when a
job starts, ends or stalls. The slots are also keyed on their job (`syncKeyed`), so a slot keeps
its job when the list does reorder, and an element is moved only when it is out of place.

## Testing

- `tools/observer-view-test.cjs` (in `pnpm sim:test`) pins the readings (hire order, dead heroes
  with revive seconds, the three-hero cap, queue heads soonest first, research at its rank, the
  army's exclusions) and the APM window.
- Live: `?dev&map=TwistedMeadows&observe&ai=insane` seats four computers and this machine as the
  observer, which exercises all four hero columns.
