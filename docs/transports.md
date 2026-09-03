# Transports — the Goblin Zeppelin and the ships (issue #128)

A transport is a **cargo hold that moves**. The hold itself is the mechanism the Orc Burrow and
the Entangled Gold Mine already use (`SimUnit.garrison` / `garrisonCap`, `issueGarrison`,
`tickGarrison`, `enterHost`); what a transport adds is that it goes to its passengers, has to
ask what is under it before it can put anybody down, and shows its hold in the info panel.

## The data (all of it, and where it lives)

| Row | What | Fields that matter |
|---|---|---|
| `Sch3` (code `Acar`) | Cargo Hold (Transport) — Goblin Zeppelin `nzep`, air barge `uarb` | `DataA1` = **8** seats, `Area1` = **250**, `Dur1` = **0.5** |
| `Sch5` (code `Acar`) | Cargo Hold (Ship) — `hbot` `obot` `nbot` `etrs` `ubot` | `DataA1` = **10**, `Area1` = 250, `Dur1` = 0.5 |
| `Aloa` / `Slo3` | **Load** — `BTNLoad`, Buttonpos 0,2, hotkey L, `Order=load`, targs `ground,friend` | "Loads a targeted friendly land unit." |
| `Adro` / `Sdro` | **Unload All** — `BTNUnLoad`, Buttonpos 1,2, hotkey U, `Order=unload` | "Unloads all carried units **at a target location**." — a POINT order |
| `Adri` | Unload Instant (Entangled Gold Mine only) | empties the hold here and now |
| `UnitData.cargoSize` | seats a passenger TAKES | Mortar Team, Demolisher, Kodo, Glaive Thrower, Meat Wagon, Sapper = **2**; Siege Engine, Mountain Giant = **4** |
| `war3skins` `CargoBackdrop` | `human-transport-slot.blp` — ONE 64×64 gold-framed pocket | drawn once per seat |
| `[Errors]` | `Canttransport` "Unable to load target.", `Noroom` "Cargo capacity unavailable.", **`Cantland` "Unable to land there."** | the three refusals |

The FDF (`SimpleInfoPanelCargoDetail`) carries only the name and description strings; the
pocket grid is the engine's own layout, as the training queue's slots are. Its shape is read off
the reference shot on the issue: 2×4 for the Zeppelin's eight.

`Achd` "Cargo Hold Death" on the Zeppelin and the barge carries no art and is not wired to
anything in the game we can find; a transport that dies takes its cargo with it, exactly as a
Burrow does (`kill`).

## How it plays

- **Boarding is a meeting** (`issueLoad` / `issueGarrison(…, meet)`, `tickLoad`). The Load
  button and a right-click on a unit with the transport selected are the transport's order:
  it sets off for the passenger (`chase`) while the passenger walks to it, and whichever gets
  within `inHostReach` first closes the gap — `tickGarrison` boards mid-stride and re-aims as
  the host moves. A right-click on the transport with units selected (`boardTransport`) is the
  same meeting from the other end, but only fetches an **idle** transport; one that is sailing
  somewhere keeps its order and the passenger walks the whole way. With the aimed passenger
  aboard, `tickLoad` goes on to the nearest other unit still walking to it, so a group is
  collected rather than made to finish the walk.
- **Seats, not heads** (`garrisonLoad`, `holdRoom`). A full hold refuses at the door; the card
  greys Load on `holdRoom <= 0` and the right-click sends only as many as fit.
- **Unloading asks the ground** (`dropSpot`). A transport may put a passenger down only on a
  cell the PASSENGER can stand on within the hold's `Area1` of its centre — a Zeppelin over the
  lake or the forest keeps its cargo, a ship at sea keeps its party, and a ship at the shore
  lands it on the beach. Every non-player way out (the host dying, `RemoveUnit`, Stand Down)
  keeps the old unbounded search, because a crew buried alive is worse than one standing a few
  cells off.
- **The slot click** (`unloadOne`, `unloadone` command) puts ONE passenger off where the hold
  stands; refused, it answers `Cantland` with the gold line and the error sound. A Burrow's peon
  let out this way goes back to work (`resumeGarrisonJob`), as Stand Down sends it.
- **Unload All is a point order** (`issueUnloadAt`, `tickUnload`, order `unload`). The transport
  goes there (a ship's goal snaps to the nearest water — `findPath` does that) and puts its cargo
  off one body per `Dur1`. Nowhere to land when it arrives: the order ends, the cargo stays, and
  the owner hears `Cantland` through `drainRefusals` — the one sim→HUD refusal channel, for an
  order the sim accepted and then had to give up on.
- **Life goes on inside.** A passenger is `inBurrow` and off the field (`isOffField`), so no
  UI can address it, but every clock that ages a unit still runs: a poison keeps ticking, and a
  passenger that reaches zero dies aboard and leaves the roster (`kill`).

## The panel

`SelectionInfo.cargo` (owner's side only — an enemy's hold shows nothing) lists the passengers
in boarding order with the seats each takes; `renderCargo` in `ui/hud.ts` lays them into
`cargoSlots` pockets, 4 to a row (5 for a ship's ten). A wide unit spans its `size` pockets: the
icon and health bar in the first, the same icon **dimmed with no bar** in the rest, so it reads
"this one takes two seats" rather than "there are two of these". The panel replaces the stat
lines while anybody is aboard and the stats come back the moment the last one steps off.

## Checks

`tools/sim-transport-test.cjs` (in `pnpm sim:test`) pins the meeting, the idle-only nudge, the
legal drop, the point unload and its half-second beat, the ship landing on the shore, a
passenger dying aboard, and seat counting.
