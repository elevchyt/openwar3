# Computer+ on Azeroth Grand Prix

`src/ai/plus/grandprix/` — a racer for Blizzard's kart map,
`Maps\FrozenThrone\Scenario\(8)AzerothGrandPrix.w3x`. Read this before touching any of it.

## Why it exists

A scenario runs none of the melee library, so no script seats a computer — and this map does not
imagine one at all. Every loop in its `war3map.j` walks the eight racers asking
`GetPlayerController(Player(n)) == MAP_CONTROL_USER`: `InitializePlayer` (who has a place on the
board), `StartPickingCart` (who gets a picker), `SortPlace`, `RefreshPlayerCheckPoints`,
`Lightning`'s targets. In the real game a computer seat is not given a cart and is not in the race.

`MapViewerScene.startCustom` recognises the map by its script (`isGrandPrixScript` — four of its own
triggers, never the file name) and hands the lobby's computers in seats 0–7 to
`RtsController.startGrandPrixAI`. Every computer seat gets it, whatever the Advanced Options switch
says: the classic AI is a melee build order and has nothing to drive.

The standing Computer+ rules hold (docs/computer-plus.md): authority-side only, **no cheats at any
difficulty**, and every number in the AI's files is OURS; every map fact is cited in `map.ts`
against the trigger or object it came from, and the test reads the running script's own globals
back against that file.

## Seating: a computer is a player to the script

The same move as Extreme Candy War (docs/candy-war-ai.md): in `runMapScript`'s `onBoot`, a computer
in a racer seat is presented to the script as `MAP_CONTROL_USER`. Nothing is granted by the engine —
the map's own init then gives the seat its picker, its cart, its row on the multiboard and its laps.

## The map in one screen

- **The lap dialog.** `Trig_Prepare_for_Game` asks ONE player — the first playing seat — for 3, 4, 5
  or 6 laps, and nothing happens until they answer.
- **The picker.** Each racer gets a cart turning on a pedestal with three buttons: Previous
  (`A002`), Next (`A00S`) and its own Select. `udg_PickCartTimer` gives everybody 30 s; the race
  starts as soon as all have chosen.
- **The cart is driven by the ARROW KEYS and nothing else.** Eight triggers per racer
  (`Turning_Left`, `Turning_Left_Released`, … `Deceleration_Stop`) on common.j's
  `EVENT_PLAYER_ARROW_*` set `udg_Turning` / `udg_Accelerating`, and `Trig_Move_Cart_Actions`
  (every 0.05 s) does the rest: speed ± the model's acceleration (twice that against the way it
  rolls) − drag, capped at the model's top; facing ± 3° while a turn key is held **and the cart is
  moving at all**; then the cart is SET `speed / 3` along that facing with a pathed
  `SetUnitPositionLoc`, if the ground there is cliff level 4 (`IsValidLocForVehicle`), else it stops
  dead. The cart's own move speed is 0: no order moves it.
- **So the turning circle grows with the speed.** 60° a second whatever the speed means that flat
  out (205 on the speedometer = 1367 world units a second) the circle is 1300 in radius — wider than
  the track. Braking for a corner is the only way round one.
- **A stopped cart cannot turn** (`CalcTurnSpeed` is 0 at speed 0). Nose against a wall, the
  throttle does nothing for ever; the way out is reverse.
- **The 3-2-1 lets you rev.** `CalcSpeed` already runs for a cart that is `GAME_PREPARING` and only
  the move is withheld, so a throttle held on the grid is speed in hand at "GO".
- **34 check points** (`Trig_Init_Place_Check_Points`), each a point and a facing; one is "reached"
  once the cart is on the far side of the line through it (`ReachedCheckPoint` — a half-plane, with
  no distance in it). They are visited in order, check point 0 again is a lap, and
  `CompletedAllLaps` writes `udg_TimeUsed`.
- **Power-ups.** A gift box (`n00C`) rolls one of twelve into the first free of four SLOTS — the
  dice are loaded by place: the leader rolls repairs and mines, the back of the field rockets and
  boosts — and each power-up is four abilities, one per slot, because a slot is a button (A, S, D,
  F). Pressing it is `Trig_Cart_Cast_Spell` → `CartUseSpell`. Every one is a Channel dummy; the
  effect is the script's. Plus the machine gun (`A01U`, 50 rounds, from 15 s in).
- **Destroyed is not out.** `Trig_Killed` flies a helicopter in and drops a new cart where the old
  one died, a few seconds later, with empty slots.
- **Two bridges** (`LT08`) carry the track over a river; their decks read the banks' cliff level
  (render/walkableHeight.ts), which is what makes them road.

Not used by the AI, and said so: the **mine-cart crossing** (`gg_rct_CrossArea1/2` — a passage
between the two long straights that skips check points 15–18, with ore carts running across it) and
the **pit stop** (`gg_rct_Repairing_Area`). Both are a person's to gamble on.

## How it plays (`index.ts`)

Everything goes through one of three doors, all a person's:

| What | Door |
|---|---|
| steering, throttle, brake | `GrandPrixPort.arrow` → `Interpreter.firePlayerEvent` — the same `EVENT_PLAYER_ARROW_*` `MapViewerScene.scriptArrow` raises for a keyboard |
| the picker, the four slots, the gun | `execute` (`{ c: "cast", code: <the ability id> }`) |
| the lap dialog | `GrandPrixPort.clickDialog` → `Interpreter.fireDialogClick` |

The cart is never ordered, moved or turned by us. The keys it believes it holds are read back from
the SCRIPT (`udg_Accelerating`, `udg_Turning`) rather than remembered, because `Accelerate` ignores
a press while the other pedal is down and a destroyed cart must not leave us believing in a key the
map has forgotten. What it READS is what a racer reads off the screen: the board (`udg_Places`), its
speedometer (`udg_Speed`), its slots (`udg_CartPowerUps`), its ammo, and where the carts are.

1. **The dialog** (`dialogPass`): if the map asks this seat, it answers after 2–4 s — three laps.
2. **The picker** (`pickPass`): a few presses of Next, then the Select of whichever cart is showing.
3. **The grid** (`think`): Normal and Insane hold the throttle through the 3-2-1; Easy waits.
4. **The racing line** (`route.ts`, built once): the drivable ground (cliff level 4 AND walkable —
   the script's move is pathed) on a 128-unit grid; an A* from each check point to the next in which
   a step beside a wall costs more than one down the middle; the string pulled smooth without being
   let nearer a wall than 330; a sample every 64 units; and at each sample the speed its curvature
   allows a cart that turns 60° a second. A check point is snapped only to the piece of ground the
   others share — the infield of a loop is level grass too.
5. **The speed plan** (`speedPlan`, per seat): that corner limit × the rung's nerve, capped at its
   model's top × the rung's pace, then walked BACKWARDS with the script's own brake (twice the
   acceleration a tick) so the cart is already slow enough when the corner arrives.
6. **Driving** (`drivePass`): find itself on the line (`locate` — just ahead of where it was, so the
   crossing never puts it on the other road; anywhere the script's own check point agrees with when
   it is lost); steer at a point down the road, further off the faster it goes, moved across into
   its own LANE where the road has the width (eight carts on one line bump each other to a third of
   their speed — the script reads a shove as a slide); throttle, coast or brake to the plan.
7. **Against a wall**: under 12 on the speedometer for 0.7 s → 0.9 s of reverse with the wheel the
   other way (reversing, the script turns a cart opposite to the key).
8. **Power-ups** (`itemPass`), each pressed when it is worth something, after the rung's reaction:

   | Power-up | Pressed when |
   |---|---|
   | Repair Kit | life under the rung's bar (30 / 45 / 60 %) |
   | Engine Boost | above half speed with 1700 of straight road ahead |
   | Specklefrogg's Rocket | not leading (it flies at the leader) |
   | Electric Justice | not leading, or a rival within 1500 |
   | Uther's Blessing | a rival within 450 (it spins what it touches), or life under 35 % |
   | Ethereal Cloak | leading, or life under 40 % |
   | Blaze, Mine, Web Trap | a rival 120–1200 behind on our strip of road |
   | Sheepedo | a rival 150–1400 ahead, inside a cone |
   | Carrion Swarm | a rival within 800 ahead and 250 to the side |
   | Blizzard | a rival inside its 500 circle, `speed × 5` ahead (`DoBlizzard`) |

   A power-up held longer than the rung hoards is pressed anyway, so four full slots do not stop it
   picking up a fifth (a Repair Kit is kept unless it would do some good).
9. **The gun**: a rival in the 200-wide, 1500-long lane it fires down (`UnitCatchGunFire`), in bursts.

## The difficulties (`profile.ts`)

| | Easy | Normal | Insane |
|---|---|---|---|
| looks every | 0.2 s | 0.1 s | 0.05 s |
| straight-line pace | 80 % | 92 % | 100 % |
| corner nerve | 70 % | 85 % | 97 % |
| counts on its brakes | 50 % | 70 % | 90 % |
| flying start | no | yes | yes |
| reaction (power-ups, gun) | 1.5–3 s | 0.5–1.2 s | 0.1–0.3 s |
| hoards a power-up for | 12 s | 20 s | 30 s |
| gun burst / gap | 1 / 3 s | 2 / 1.5 s | 3 / 0.6 s |

## Replays, saves, LAN

- **Replay.** A computer's keys and its dialog click are script INPUTS and are recorded as anybody's
  are (`Interpreter.inputTap`, in the AI phase); its button presses are commands at
  `Authority.execute`. The AI does not think on playback.
- **Save.** `GrandPrixAi` is registered (`game/save/classes.ts`); the racing line, the speed plans
  and the port are transient and found again on the first look after a load.
- **LAN.** Authority-side only, like every AI.

## Tested

`tools/ai-plus-grandprix-test.cjs` (in `pnpm sim:test`) runs the REAL `war3map.j` headless
(`tools/grandprix-harness.cjs`: the real interpreter over a real SimWorld on the map's own w3e and
wpm) with eight Computer+ seats and asserts that map.ts matches the script's globals, that the
racing line is a closed road through all 34 check points, that nothing moves with no key pressed
(the control), that **every seat finishes three laps inside a derived bound** — the lap is 107 030
world units, flat out with no corners is `laps × length ÷ (top × 20/3)` ≈ 235 s at 205, nobody may
beat that, and Insane must be home within 1.5×, Normal 1.6×, Easy 1.9× — that Insane beats Easy,
and that the power-ups and the gun are used and the rocket is never fired by the leader. Measured
there: Insane 256–294 s, Normal 281–306 s, Easy 351–358 s; 375 game seconds in about 30 s.

The harness has no ability registry and stamps no trees: a cast is raised to the script as its
spell event (all the map listens for), the dummy casters' buffs never land, and the two bridge
decks are stated as rects. The live match has all of it — see below.

## Verified live

`?dev&map=AzerothGrandPrix&ai=plus-normal&observe` (every seat a computer, this machine watching),
headless Chrome over CDP at Sim Speed 6×, reading `udg_TimeUsed` out of the running script. Here
the buffs land, the trees stand, the sheep and the ore carts are on the road and the carts shoot
each other for real:

| eight seats of | first home | last home |
|---|---|---|
| Normal | 299 s | 345 s |
| Insane | 262 s | 339 s |

Every seat answered the dialog or picked a cart, left the grid at speed (Normal read 182–193 on the
speedometer five seconds after GO), and finished all three laps; no script error and no
unimplemented native in either run. The spread inside one rung is the race — eight carts with
rockets — not the driving: alone on the road a Normal seat laps in 92 s.
