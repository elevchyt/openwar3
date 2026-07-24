# The camera — lens, zoom, ground-follow, and a map's own camera

What Warcraft III's camera actually does, and the trap that cost this project several wrong
commits in a row. The numbers here are **measured against the real 1.27a client**, with a ruler
that no asset can corrupt (see below) — the previous two attempts both measured a *model*, and
both were wrong.

The code lives in [`src/render/mapViewer.ts`](../src/render/mapViewer.ts) (`GAME_FOV`,
`fovFromWc3`, `ZOOM_MIN/MAX`, `MELEE_START`, `followGround`, `readCamera`/`writeCamera`),
[`src/render/scriptCamera.ts`](../src/render/scriptCamera.ts) (the tweens a map's script drives),
and the field defaults are in [`src/data/gameplayConstants.ts`](../src/data/gameplayConstants.ts)
(`CAMERA.*`).

## TL;DR

| Quantity | Value | Where it comes from |
|---|---|---|
| **Rendered lens** | **32°** vertical FOV | Measured off the real client (below). NOT the FOV field |
| FOV *field* | 70 | `Scripts\Blizzard.j` `bj_CAMERA_DEFAULT_FOV` — what a script SAYS; `fovFromWc3` puts it on the lens |
| Default distance | 1650 | `bj_CAMERA_DEFAULT_DISTANCE` — what a match **opens on** |
| Angle of attack | 304 (= −56°) | `bj_CAMERA_DEFAULT_AOA` |
| Rotation / FarZ | 90 / 5000 | `bj_CAMERA_DEFAULT_ROTATION` / `_FARZ` |
| Focus height | **the terrain under it** | The camera keeps its distance to the GROUND, not to z = 0 |
| Our zoom range | 1250 – 2400 | Ours; brackets WC3's 1650 default. WC3's own wheel stops are not documented anywhere we trust |
| Melee camera centre | the starting **workers** | `Blizzard.j:8299` — *not* the town hall |

## The trap: the lens and the distance are one knob

What you see is set by **distance × tan(fov/2)**. Narrow the lens and everything looks farther
away; you can hide that by pushing the distance out, and the frame will look almost the same. So a
wrong lens does not announce itself as "wrong lens" — it announces itself as *every distance in
the game meaning the wrong thing*, and it is very easy to keep "fixing" it by tuning the zoom
constants.

Because the two are degenerate, **any solve has to pin one of them**. Pin the distance: a melee
opening frame is guaranteed to be at `bj_CAMERA_DEFAULT_DISTANCE` (1650), AOA 304, rotation 90,
with no script touching it.

## How the 32° was established (repeat this, don't re-argue it)

Use a ruler the game itself defines. `Blizzard.j`'s `MeleeStartingUnits*` places the five starting
workers at exact offsets around the point it *then centres the camera on*:

```jass
local real unitSpacing = 64.00
...
call CreateUnit(whichPlayer, 'hpea', peonX + 1.00 * unitSpacing, peonY + 0.15 * unitSpacing, ...)
call CreateUnit(whichPlayer, 'hpea', peonX - 1.00 * unitSpacing, peonY + 0.15 * unitSpacing, ...)
...
call SetCameraPositionForPlayer(whichPlayer, peonX, peonY)
```

So the two side workers are **exactly 128 world units apart, at the focus**. No model size, no
asset scale, no guess about where the camera is pointing.

1. Start a skirmish in the real client (`Frozen Throne.exe -window`) and screenshot the opening
   frame **without touching the wheel** — 500/150 resources is the proof nothing has happened yet.
2. Select the workers so their **selection circles** are drawn (those are flat on the ground; a
   health bar floats ~100 units up and reads ~5 % too wide).
3. Measure the pixel distance between the two side workers' circle centres.

In a 1424×720 frame that distance is ~101 px for 128 world units, so with
`k = (H/2)/tan(fov/2) = px_per_unit · z`:

```
  k    = 0.786 px/unit × 1614  ≈ 1269
  fov  = 2·atan(360 / 1269)    ≈ 31.7°      ⇒ we render 32°
```

Cross-check with a size the MPQ states outright: at 32° the human Town Hall's wall ring measures
~400 world units across, and its ubersplat (`Splats\UberSplatData.slk`, `HTOW`, `Scale` 230 =
half-width) is 460 across — the walls sit just inside their own dirt patch, as they do on screen.
At 45° they would be 610 across and at 70° ~690, both of them spilling well outside it.

### The two earlier answers, and why they missed

- **45°** fitted two landmarks (mine + town hall) but had to grid-search the camera's focus at the
  same time, so the fit had somewhere to hide.
- **70°** measured a town hall's wall ring at 320 px in a frame it believed was 1920×1080. The
  frame was 1424×720. Run the same numbers on the true height and that measurement says 45°, not
  70 — it was a resolution mix-up, not a new finding.

Both calibrated against a **model**, so both inherited whatever our own renderer got wrong about
that model's size. The worker spacing doesn't have that failure mode.

> The FOV field is still 70 wherever WC3 writes it, and `GetCameraField` must still answer 70 on
> the default camera. `fovFromWc3`/`fovToWc3` translate in **tan-space**, so the framing *ratio* a
> script asks for is preserved: 70 ⇒ 32°, and a map that narrows to a telephoto narrows by the
> same factor it does in the real game.

## The focus rides the terrain

WC3 keeps its distance to the **ground under the middle of the screen**, not to the z = 0 plane —
scroll onto a plateau and the camera climbs with it. `followGround` samples the terrain under the
focus every frame and sets `target[2] = ground + CAMERA_FIELD_ZOFFSET` (issue #73).

Pinning the focus at z = 0 makes every map pay for its own terrain: on Tirisfal Glades' highest
plateau (+1268) the eye — only 1650·sin 56° = 1368 above the focus plane — ends up practically in
the dirt, while a map sitting below the plane frames far too wide. Melee maps mostly open on a
flat mid-height plateau and custom maps go wherever their author put them, which is exactly the
"custom maps look different from melee maps" the issue reported.

The follow is **eased** (`GROUND_EASE`, ~0.12 s), or cresting a cliff would jolt the whole view by
a 128-unit layer in one frame; a real teleport (map load, minimap jump, a script's camera apply) is
detected as a focus move of ≥ 512 units in one frame and snaps instead.

`CAMERA_FIELD_ZOFFSET` is therefore stored as what it is — an **offset above the terrain**, not the
focus's world z. `readCamera`/`writeCamera` speak the offset; `followGround` adds the ground back.

## A map's own camera

Every camera object the World Editor writes carries the **full field set**, whether or not the map
author meant anything by any given field. `(4)WarChasers`' `gg_cam_CamStart1` is precisely
`bj_CAMERA_DEFAULT` with the distance nudged:

```jass
call CameraSetupSetField( gg_cam_CamStart1, CAMERA_FIELD_ZOFFSET,         0.0,    0.0 )
call CameraSetupSetField( gg_cam_CamStart1, CAMERA_FIELD_ROTATION,        90.0,   0.0 )
call CameraSetupSetField( gg_cam_CamStart1, CAMERA_FIELD_ANGLE_OF_ATTACK, 304.0,  0.0 )
call CameraSetupSetField( gg_cam_CamStart1, CAMERA_FIELD_TARGET_DISTANCE, 1790.9, 0.0 )
call CameraSetupSetField( gg_cam_CamStart1, CAMERA_FIELD_FIELD_OF_VIEW,   70.0,   0.0 )
call CameraSetupSetField( gg_cam_CamStart1, CAMERA_FIELD_FARZ,            5000.0, 0.0 )
```

…and its `Snap Camera to Player` trigger re-applies it **every 2 seconds**
(`TriggerRegisterTimerEventPeriodic`, 2 s), on top of riding the player's wisp with
`SetCameraTargetControllerNoZ`. That 70 is the *default* field, not a wide-angle request: through
`fovFromWc3` it lands on the ordinary 32° lens at 1790.9, which is what the map means and what the
real client shows. (It also ships `Player1..7 Disallow MouseWheel` triggers: WarChasers *intends*
to own your camera. That part is authentic; leave it alone.)

## Zoom

`ZOOM_MIN = 1250`, `ZOOM_MAX = 2400`, and a match opens on **1650** —
`bj_CAMERA_DEFAULT_DISTANCE`, which through the 32° lens *is* the real client's opening view.
Because the lens is right, these distances mean what they mean in the real game.

- **Never re-tune the lens to change how roomy the game feels.** The lever is `ZOOM_MAX`. Changing
  `GAME_FOV` silently redefines every distance constant and every map's camera.
- WC3's own wheel stops have not been measured; 1250/2400 is our choice, not ground truth. The
  *default* it opens on is ground truth.

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

The worker cluster sits between the hall and the nearest gold mine, so **the town hall lands
slightly right-of-centre** — in the real client and in ours alike. We get this for free by
executing Blizzard.j itself rather than reimplementing melee setup, so there is nothing to
"correct" here. (It is also what makes the worker spacing a usable ruler: the camera is pointed
exactly at the middle of them.)

## Related

- [`docs/triggers.md`](triggers.md) — the JASS/trigger tracker; the script camera is milestone 7.24.
- [`src/render/scriptCamera.ts`](../src/render/scriptCamera.ts) — a map's camera is *tweens over the one
  game camera*, not a second camera; a tween ends and lets go (`ResetToGameCamera` is how a map comes home).
