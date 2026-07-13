# The camera — lens, zoom, and a map's own camera

What Warcraft III's camera actually does, and the trap that cost this project four wrong commits
in a row. Everything here is **measured against the real 1.27a client** — the numbers in the files
are right, but only if you resist the urge to reinterpret them.

The code lives in [`src/render/mapViewer.ts`](../src/render/mapViewer.ts) (`GAME_FOV`, `ZOOM_MIN/MAX`,
`MELEE_START`, `readCamera`/`writeCamera`), [`src/render/scriptCamera.ts`](../src/render/scriptCamera.ts)
(the tweens a map's script drives), and the constants themselves are in
[`src/data/gameplayConstants.ts`](../src/data/gameplayConstants.ts) (`CAMERA.*`).

## TL;DR

| Quantity | Value | Where it comes from |
|---|---|---|
| **Rendered lens** | **70°** vertical FOV | `Scripts\Blizzard.j` `bj_CAMERA_DEFAULT_FOV` — and it is the angle the client really renders with (measured below) |
| Default distance | 1650 | `bj_CAMERA_DEFAULT_DISTANCE` — what a match **opens on** |
| Angle of attack | 304 (= −56°) | `bj_CAMERA_DEFAULT_AOA` |
| Rotation / FarZ | 90 / 5000 | `bj_CAMERA_DEFAULT_ROTATION` / `_FARZ` |
| Our zoom range | 1250 – 2400 | Ours; brackets WC3's 1650 default. WC3's own wheel stops are not documented anywhere we trust |
| Melee camera centre | the starting **workers** | `Blizzard.j:8299` — *not* the town hall |

## The trap: the lens and the distance are one knob

What you see is set by **distance × tan(fov/2)**. Narrow the lens and everything looks farther away;
you can hide that by pushing the distance out, and the frame will look almost the same. So a wrong
lens does not announce itself as "wrong lens" — it announces itself as *every distance in the game
meaning the wrong thing*, and it is very easy to keep "fixing" it by tuning the zoom constants.

That is exactly what happened here. A previous pass concluded that the FOV *field* (70) and the
rendered *lens* were different quantities, put the lens at 45°, and translated every script's FOV
onto that narrower scale. Then the zoom constants got tuned to compensate, and the game still felt
welded to the ground, because a 45° lens shows **1.7× less world** than the real client does at the
same distance — no zoom range can buy that back.

**There is no translation.** `CAMERA_FIELD_FIELD_OF_VIEW` is a vertical FOV in degrees, WC3's
default is 70, and 70° is what the client renders with. A map that asks for 70 gets 70; a map that
narrows to a telephoto gets exactly the angle it asked for.

## How the 70° was established (repeat this, don't re-argue it)

Use a real-client screenshot of a **melee opening frame** — the camera is then WC3's own default
(distance 1650, AOA 304, rotation 90, no script touching it) and nothing about it is in doubt. Ours
is `~/Downloads/references/human hud and workers starting position.png`, 1920×1080.

The measurement needs no knowledge of the map, only a landmark whose **world size** you can
calibrate — the town hall's wall ring is ideal (crisp edges, sits on the ground):

1. Screenshot the same landmark from **our** engine, twice, at two different known lenses/distances.
   Every term is known there, so the hall's world width falls out of the projection.
2. In the reference, measure the wall ring's pixel width and the screen y of its front base. For a
   ground point at offset `dy` from the focus, with `k = (H/2)/tan(fov/2)`:

   ```
   z         = D + dy·cos(pitch)          // depth along the view axis
   cy − sy   = k·dy·sin(pitch) / z        // where that ground point lands on screen
   px width  = k · worldWidth / z
   ```

3. Solve for the one remaining unknown, the lens.

The answer is not close to 45°:

```
  lens    town hall would be…      (it measures 320 px)
   45°          480 px      ← what we were rendering: half again too big
   60°          361 px
   70°          308 px      ← the file's value, 4% off — inside the error of hand-picking edges
   80°          267 px
```

The fit's own minimum is ≈67°, and the residual against 70° is smaller than the uncertainty in
reading a model's silhouette by eye. So the file is telling the truth; take it literally.

> Note that lens and distance are **degenerate** for framing — a (fov, distance) pair fits the same
> frame along a whole valley. That is why the solve above pins the distance at the melee default
> (1650, which a fresh melee start guarantees) instead of fitting both at once.

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
`SetCameraTargetControllerNoZ`. Applied literally on the 70° lens, that is an ordinary view at
1790.9 — which is what the map means and what the real client shows. (It also ships
`Player1..7 Disallow MouseWheel` triggers: WarChasers *intends* to own your camera. That part is
authentic; leave it alone.)

The moment the lens was wrong, WarChasers looked like the *broken* one — it was the only map stating
its FOV explicitly, so it was the only map still being rendered at 70 while everything else sat at
45. It was right all along; the rest of the game was wrong.

## Zoom

`ZOOM_MIN = 1250`, `ZOOM_MAX = 2400`, and a match opens on **1650** — `bj_CAMERA_DEFAULT_DISTANCE`,
which through the 70° lens *is* the real client's opening view. Because the lens is right, these
distances mean what they mean in the real game.

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

The worker cluster sits between the hall and the nearest gold mine, so **the town hall lands slightly
right-of-centre** — in the real client and in ours alike. We get this for free by executing Blizzard.j
itself rather than reimplementing melee setup, so there is nothing to "correct" here.

## Related

- [`docs/triggers.md`](triggers.md) — the JASS/trigger tracker; the script camera is milestone 7.24.
- [`src/render/scriptCamera.ts`](../src/render/scriptCamera.ts) — a map's camera is *tweens over the one
  game camera*, not a second camera; a tween ends and lets go (`ResetToGameCamera` is how a map comes home).
