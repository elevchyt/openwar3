# The camera — lens, zoom, and a map's own camera

What Warcraft III's camera actually does, and the two traps that cost this project three wrong commits
in a row. Everything here is **measured against the real 1.27a client**, not read out of a file — because
on this particular question the files lie (see [`REFERENCES.md`](REFERENCES.md): the MPQ wins over any
reference, but *observed behaviour* wins over the MPQ).

The code lives in [`src/render/mapViewer.ts`](../src/render/mapViewer.ts) (`GAME_FOV`, `ZOOM_MIN/MAX`,
`MELEE_START`, `fovFromWc3`/`fovToWc3`, `readCamera`/`writeCamera`) and
[`src/render/scriptCamera.ts`](../src/render/scriptCamera.ts) (the tweens a map's script drives).

## TL;DR

| Quantity | Value | Where it comes from |
|---|---|---|
| **Rendered lens** | **45°** vertical FOV | **Measured from the real client** (below). NOT the 70 in the data. |
| Camera-setup FOV **field** | 70 | `Scripts\Blizzard.j` `bj_CAMERA_DEFAULT_FOV` — a *field* value, not the rendered angle |
| Default distance | 1650 | `bj_CAMERA_DEFAULT_DISTANCE` |
| Angle of attack | 304 (= −56°) | `bj_CAMERA_DEFAULT_AOA` |
| Rotation / FarZ | 90 / 5000 | `bj_CAMERA_DEFAULT_ROTATION` / `_FARZ` |
| Our zoom range | 1250 – 2000, opens at 2000 | Ours; brackets WC3's 1650 default |
| Melee camera centre | the starting **workers** | `Blizzard.j:8299` — *not* the town hall |

## Trap 1 — the FOV field is not the lens

`bj_CAMERA_DEFAULT_FOV = 70` is sitting right there in Blizzard's own code, so it is very tempting to
render at 70°. **Don't.** The real client renders that same default camera at about **45°** vertically
(on a ~2:1 window). Render at 70° and the entire game sits `tan(35°)/tan(22.5°)` = **1.7× too wide**, and
every camera distance stops meaning what it means in the real game.

So the **FIELD** (what scripts speak, ordinary value 70) and the **LENS** (what we project with,
ordinary value 45°) are *different quantities*, and a script's FOV must be translated between them.
`fovFromWc3` maps a field onto the lens by the framing it produces — the half-height it subtends at the
focus, relative to each scale's own ordinary value:

```
k        = tan(field/2) / tan(70°/2)          // how much wider/narrower than WC3's ordinary view
lens     = 2·atan( k · tan(45°/2) )           // the same relative framing, on our lens
```

Field 70 lands exactly on our 45° (an ordinary view stays ordinary — which is what the real client
does), and a shot that deliberately narrows to a telephoto keeps the zoom-in factor it would have had in
WC3. `fovToWc3` is the inverse, so `GetCameraField(CAMERA_FIELD_FIELD_OF_VIEW)` reads 70 on the default
camera exactly as it does in the real game.

## Trap 2 — honouring a map's camera setup literally

Every camera object the World Editor writes carries the **full field set**, whether or not the map author
meant anything by any given field. So a camera that means "an ordinary view" still *says* 70.

`(4)WarChasers`' `gg_cam_CamStart1` is the worked example — it is precisely `bj_CAMERA_DEFAULT` with the
distance nudged:

```jass
call CameraSetupSetField( gg_cam_CamStart1, CAMERA_FIELD_ZOFFSET,         0.0,    0.0 )
call CameraSetupSetField( gg_cam_CamStart1, CAMERA_FIELD_ROTATION,        90.0,   0.0 )
call CameraSetupSetField( gg_cam_CamStart1, CAMERA_FIELD_ANGLE_OF_ATTACK, 304.0,  0.0 )
call CameraSetupSetField( gg_cam_CamStart1, CAMERA_FIELD_TARGET_DISTANCE, 1790.9, 0.0 )
call CameraSetupSetField( gg_cam_CamStart1, CAMERA_FIELD_FIELD_OF_VIEW,   70.0,   0.0 )   // <-- ordinary!
call CameraSetupSetField( gg_cam_CamStart1, CAMERA_FIELD_FARZ,            5000.0, 0.0 )
```

…and its `Snap Camera to Player` trigger re-applies it **every 2 seconds** (`TriggerRegisterTimerEventPeriodic`,
2 s), on top of riding the player's wisp with `SetCameraTargetControllerNoZ`. Take the 70 at face value on a
45° engine and the map is pinned 1.7× too wide **forever** — the mouse wheel moves the *distance*, not the
lens, so the player can never undo it. That is exactly the "WarChasers is forcefully zoomed out" bug.

With the translation in place, the map frames the ordinary view the real client shows, at its own 1790.9.

> The map also ships `Player1..7 Disallow MouseWheel` triggers and re-imposes its distance on a timer —
> WarChasers *intends* to own your camera. That part is authentic; leave it alone.

## How the 45° was established (repeat this, don't re-argue it)

Solving a camera from one screenshot needs only landmarks whose **world** positions you already know:

1. Run the real client windowed: `Frozen Throne.exe -window` (automates fine; see the
   `wc3-ground-truth-from-the-real-client` note). Start a **melee** game — the camera is then WC3's own
   default: distance 1650, AOA 304, rotation 90, no script touching it.
2. Screenshot the start view. Pick two landmarks with known world positions — the **gold mine** and the
   **town hall** are ideal, and our own engine will print both (mine list, start location, ground heights).
3. Grid-search the camera focus `(tx, ty)` × vertical FOV, projecting both landmarks with the known
   distance/AOA/rotation, and minimise reprojection error against their measured pixel positions.
4. Confirm by eye: render the same map at the same distance and stack the frames.

The error curve is unambiguous — it bottoms out at 45° and 70° is nowhere near:

```
  fov    rms reprojection error (px), minimised over the focus
   35        52.1
   40        38.6
   45        34.8   <-- minimum
   50        37.8
   60        50.2
   70        62.5
   80        73.0
```

(The ~35 px floor is the hand-measured landmark pixels, not model error; what matters is the shape.)

## Zoom

`ZOOM_MIN = 1250`, `ZOOM_MAX = 2000`, and a match **opens fully zoomed out** (`MELEE_START = ZOOM_MAX`).
Because the lens is right, these are real-game distances: WC3's own default (1650) sits inside the range,
so the opening view is about a fifth wider than the one the real client opens on.

Two things worth knowing before anyone "fixes" this again:

- **Distances only mean something at the correct lens.** The pre-2026-07 code used 2400/3600 — those look
  reasonable, but they were quietly compensating for a lens that was briefly set too narrow/too wide. If
  you change `GAME_FOV`, every distance constant silently changes meaning.
- **Authentic framing is tighter than people expect.** WC3's default view is noticeably closer in than the
  roomy view OpenWar3 shipped with historically. That is not a bug. If a wider feel is ever wanted, the
  lever is `ZOOM_MAX` (≈3400 reproduces the old roomy framing) — **never** the lens, which would break
  every map camera again.

WC3's own wheel stops have not been measured; 1250/2000 is our choice, not ground truth.

## Melee camera centring

Blizzard.j centres the opening camera on the **starting workers**, not on the town hall
(`Blizzard.j:8297`, and the same block per race):

```jass
if (doCamera) then
    // Center the camera on the initial Peasants.
    call SetCameraPositionForPlayer(whichPlayer, peonX, peonY)
    call SetCameraQuickPositionForPlayer(whichPlayer, peonX, peonY)
endif
```

The worker cluster sits between the hall and the nearest gold mine, so **the town hall lands slightly
right-of-centre** — in the real client and in ours alike. We get this for free by executing Blizzard.j
itself rather than reimplementing melee setup, so there is nothing to "correct" here.

## Related

- [`docs/triggers.md`](triggers.md) — the JASS/trigger tracker; the script camera is milestone 7.24.
- [`src/render/scriptCamera.ts`](../src/render/scriptCamera.ts) — a map's camera is *tweens over the one
  game camera*, not a second camera; a tween ends and lets go (`ResetToGameCamera` is how a map comes home).
