# Gamepad support

Issue #162. Warcraft III has no controller support at all, so **the mapping is the developer's,
not the game's**. What each button *does* is still the game's, because a pad press is turned into
the input the mouse or keyboard would have given and goes through the same doors.
[`src/ui/gamepad.ts`](../src/ui/gamepad.ts) is the whole subsystem. It is started once from
`main.ts` and polls for the life of the page, because a pad can be paired from any screen.

## The mapping (standard layout, PlayStation names)

| button | does | how |
| --- | --- | --- |
| left stick | moves the cursor | a drawn virtual cursor + synthetic pointer events (below) |
| left stick press | centre on the selection | `GamepadMatchHost.jumpToSelection` |
| right stick | pans the camera, 360° | `gamepadPan()`, read by `updateCamera` beside the arrow keys |
| right stick press | nothing yet | — |
| X | left click (or presses the card selector's button) | pointer/mouse events at the cursor |
| R1 | right click | pointer/mouse events, button 2 |
| O | cancel | the **Escape** key |
| Square | attack-move at the cursor, no reticle | `padAttackMove`: the card's own Attack, armed and aimed in one step |
| Triangle | centre on the last notification | the **Space** key |
| D-pad | moves the command-card selector | `GameHud.padCardMove` |
| L1 | select the whole army | the **"-"** key (so double-tap and hold-to-follow come with it) |
| L2 | cycle through your buildings | `RtsController.cycleBuilding` |
| R2 | select the next idle worker | the **F8** key |
| Start | F10 menu (pairs an unpaired pad) | the **F10** key |
| Select | Quest Log | the **F9** key |

A button that has a key IS that key. It is dispatched as a real `KeyboardEvent` at the focused
element, held for as long as the pad button is held, so it inherits every gate the key handlers
already have: a cinematic, a stopped match, a modal, a chat line being typed into. Only the
actions no key performs go through the `GamepadMatchHost` that `MapViewerScene.installGamepad`
installs, and each of those asks `canAct()` first. That is `GameHud.acceptsInput()`, the same
gates `onKey` asks, plus `hardPaused`.

## The virtual cursor

A page cannot move the OS pointer, so the cursor is drawn. Two things keep it from becoming a
second input system:

- **It is the mouse, event for event.** `pointermove`/`mousemove` go to the element under the
  point, the boundary events (`over`/`enter`/`leave`/`out`) fire on the ancestor chain as a real
  pointer's would, and a press is `pointerdown`/`mousedown` → `pointerup`/`mouseup` → `click`/
  `contextmenu`. A held X keeps sending moves to the element it went down on, which is the
  implicit capture a real press has, so a held X drags the selection box. The events carry
  `pointerId: 1` because Chromium treats the mouse's id as always active. Any other id makes
  the canvas's `setPointerCapture(e.pointerId)` throw.
- **It wears the cursor the page asks for.** Every 100 ms it reads the computed `cursor:` of the
  element under it and draws the first image in the list at that image's own hotspot. So the
  race gauntlet, the armed reticle and the tinted hover hand come from the rules that already
  exist (`applyRaceCursor`, `ui/cursor.ts`), and `cursor: none` hides it exactly where the
  edge-scroll chevron and the carried item replace the mouse's cursor.

**The OS pointer is hidden by a VEIL.** A page cannot move or remove the OS pointer, so while the
pad drives, a transparent full-page layer (`#gamepad-veil`, `cursor: none !important` under an ID
that beats every other cursor rule) sits between it and the page. A global `cursor: none` rule
would not work: the drawn cursor reads its image from the page's own `cursor:` values, and every
element would then report "none". The pad's events hit-test past the veil (`hit`, via
`elementsFromPoint`), so they still reach what is underneath. Raising the veil under a still mouse
makes the browser send real `pointerleave`/`mouseout` events from whatever the OS pointer was
over, and that is usually the element the pad has just entered. So those events are stopped at the
window while the veil is up, or the pad's hover tooltip comes straight back down. A real mouse
move, press or wheel notch takes the veil away. The press or notch that does it is spent on that.

`:hover` cannot see a synthetic pointer. The places that ask the DOM whether something is still
hovered call `isHovered(el)` instead (the command tooltip, the stat slabs, `gameTip`), and the
stylesheet's hover glows have `.pad-hover` twins. If you add a `:hover` rule that matters, give it
a `.pad-hover` twin as well. A trusted mouse move puts the virtual cursor away.

## Pairing

The Gamepad API only exposes a pad after one of its buttons has been pressed with the page
focused. Seeing a pad is not the same as pairing it:

- If a pad is seen and none is paired, the notification stack says "press START to pair". The
  stack sits above the fps strip and is lifted by the strip's height while the strip is up.
- **Start** on an unpaired pad pairs it. That press is used up by the pairing, so it does not
  also open F10.
- Options → Gameplay → **Detect Gamepad**, on both the glue panel and the F10 panel, listens for
  ten seconds. The first button pressed on any pad pairs that pad. The button greys out and
  counts down on its own label (`bindGamepadButton`).
- While a pad is paired, that same button reads **Unpair Gamepad**. Pressing it releases
  everything the pad holds and takes away its cursor, the veil and the command-card frame, which
  puts the game back on the mouse and keyboard. The pad stays connected, and the "press START to
  pair" line is not raised for it again (`quiet`). START, or Detect Gamepad, pairs it again.
- A pad turned on **mid-session** needs no special handling. Chromium watches udev and brings the
  device in as soon as it connects, and the game polls `getGamepads()` every frame on every
  screen. This was measured with an 8BitDo SN30 Pro+ over Bluetooth: turned off, the game said
  "Gamepad disconnected.", and turned back on, "press START to pair". The page only sees the pad
  after one of its buttons goes down, though, and the snapshot that first carries the pad shows
  no button pressed. So that first press can never be read as Start. While Detect Gamepad is
  listening, the pad's appearance is therefore counted as its press, and it pairs.
- One pad is paired at a time. When it disconnects, every held button is released first, so a
  pad that goes away mid-drag cannot leave a stuck marquee or a camera riding the army.

## The command-card selector

The D-pad moves a gold frame over the 4×3 card, and while it is in charge X presses the button
under it and its tooltip is shown. Moving the left stick hands X back to the cursor. Pressing a
button that arms something (an order, a building on the cursor) also hands X back, so the next
X aims it in the world. The frame starts over when the selection or the card page changes:

- on a unit's card it starts at the **bottom-left** slot (a worker's Build, a soldier's Hold);
- on a building's card it starts at the **top-left** slot, and the same goes for shops and
  taverns;
- a submenu (the build list, the skill page) also starts at the **top-left**.

## The building cycle (L2)

It visits the hall, then the altar, then the unit producers tier by tier, then the upgrade
buildings, then the shops, one building per press. Within a group the order is the order the
buildings went up in. Every group is read off the data (`RtsController.buildingRank`):

- **hall:** the `TownHall` classification;
- **altar:** `Revive`;
- **producers:** `Trains`;
- **upgrade buildings:** `Researches`;
- **shops:** `Makeitems`/`Sellitems`.

The tier comes from `Requires`, through the hall chain and the `TWN2`/`TWN3` pseudo-techs.
Farms, towers, Moon Wells and burrows are not visited.

## Notifications (Triangle / Space)

The Space ring (`noteSpacebarPoint`, eight points, newest first) already held minimap pings,
which include every raid on your base, and the script's `SetCameraQuickPosition`. Issue #162
adds your **completions**: a building up, a unit trained, a research or a structure upgrade
finished (`noteCompletion`). Triangle is Space, so the keyboard walks the same ring.

## Testing without a pad

Stub the API before the page loads (CDP `Page.addScriptToEvaluateOnNewDocument`): define
`Navigator.prototype.getGamepads` to return one `{ index: 0, connected: true, mapping:
"standard", axes: [0,0,0,0], buttons: [{ pressed }, …] }` object, then flip its fields from the
test. That drives the real poll, pairing, cursor and every mapping. A trusted CDP
`Input.dispatchMouseEvent` followed by a small stick nudge puts the virtual cursor exactly where
you want it.
