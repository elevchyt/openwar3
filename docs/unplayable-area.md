# The unplayable area

Every WC3 map is bigger than the map you play on. Around the playable ground sits a margin of
terrain that is fully modelled, textured and lit and that you may never walk into, build on,
fly over or aim at — the black border. A mapmaker can carve more of it out of the middle of
the map with the World Editor's **Nothing** tool, and (2)BootyBay's coastline is one big
hand-shaped example of exactly that.

This is what the four files say about it, so the next person does not have to rediscover which
one to believe. (Issue #117.)

Implementation: `isBoundaryTile` / `boundaryCorners` / `playableRect` / `cameraBoundsOf` /
`CAMERA_MARGIN` in [`src/world/terrain.ts`](../src/world/terrain.ts), `PathingFlag.Unflyable` /
`playable` / `playableAt` / `nearestPlayable` in [`src/sim/pathing.ts`](../src/sim/pathing.ts),
`FOG_OF_WAR` in [`src/data/gameplayConstants.ts`](../src/data/gameplayConstants.ts),
`BOUNDARY_DARK` / `boundaryTint` in [`src/render/fogOverlay.ts`](../src/render/fogOverlay.ts),
`inPlayableArea` + the flying branch of `pathTo` + `teleportUnit` in
[`src/sim/world.ts`](../src/sim/world.ts), and `SetCameraBounds` / `GetCameraMargin` in
[`src/jass/natives/camera.ts`](../src/jass/natives/camera.ts). Checked by
`tools/sim-boundary-test.cjs` (`pnpm sim:test`).

## 1. One fact, four files

A `.w3x` states where its boundary is four times over, in four files written by four different
parts of the editor. They agree exactly, which is what makes any of them checkable.

| file | how it says it |
| --- | --- |
| `war3map.w3e` | two per-TILE flags: **boundary flag 1** = bit `0x4000` of the water-level word (the editor's own margin), **boundary flag 2** = bit `0x80` of the texture byte (the Nothing tool). Either one means unplayable. |
| `war3map.wpm` | those tiles' pathing cells carry **`0x04`**, and nothing else in the map does |
| `war3map.j` | `main()` opens with `SetCameraBounds(<playable rect> ± GetCameraMargin(…))` |
| `war3map.w3i` | `cameraBounds` — the *result* of that sum — plus `cameraBoundsComplements`, the margin in tiles per side |

**The two w3e flags are one flag.** mdx-m3-viewer's parser calls them `mapEdge` and
`boundary`; `isBoundaryTile` is the OR of them and every consumer asks that, never one of the
two. A melee map like (2)EchoIsles uses `mapEdge` alone; BootyBay uses both, heavily
overlapping; a hand-made test map with a "Nothing" strip painted mid-field uses `boundary`
alone for that strip.

**The flags are on TILES, stored at the tile's lower-left corner.** The last corner row and
column anchor no tile, and BootyBay's are stale and *unflagged* — trusting them pushes the
playable rect a whole row past the map. Every loop over the boundary runs `ty < height - 1`.

## 2. `0x04` is the boundary's own pathing bit — and it means "no flying"

The wpm byte for the border is `0xce`; for a cliff it is `0xca`. One bit apart, and that bit is
what the format specs call *unflyable*. It is worth stating plainly because the obvious reading
of "`0xce` is unwalkable terrain" is what hides it: a cliff and the border are both unwalkable,
unbuildable and no-water, and the **only** thing the border stops that a cliff does not is an
air unit.

Cross-tabulated per cell over three maps (`tools/sim-boundary-test.cjs` re-checks this every
run), `0x04` is set on exactly the cells whose terrain tile carries a w3e boundary flag, and on
no other cell. So `PathingGrid.playable()` — "is `0x04` clear?" — is the whole question "is
this point part of the map", answered from the grid rather than from a rectangle, which is what
makes a shaped boundary like BootyBay's work.

Read it off the terrain **baseline** only, never the building/tree stamps: a barracks standing
on a cell does not move the edge of the world.

## 3. `GetCameraMargin` is 512 across and 256 up and down

Not in any data file — the engine keeps them — but not a guess either. Subtract each map's w3i
`cameraBounds` from the literals its own `main()` passes to `SetCameraBounds` and the margin
falls out, the same pair every time:

| map | `main()`'s literals | `war3map.w3i` cameraBounds | margin |
| --- | --- | --- | --- |
| (2)BootyBay | −10240, −5376, 10240, 3840 | −9728, −5120, 9728, 3584 | 512 / 256 |
| (2)EchoIsles | −7424, −5632, 7424, 5120 | −6912, −5376, 6912, 4864 | 512 / 256 |
| BoundaryTest | −3328, −3584, 3328, 3072 | −2816, −3328, 2816, 2816 | 512 / 256 |

`common.j` indexes them `CAMERA_MARGIN_LEFT, RIGHT, TOP, BOTTOM` = 0..3, and they are plain
`constant integer`s — **not** converted handles like the `camerafield`s next door, so the
native reads the int. Reading them as an enum handle answers −1, which silently makes every
margin 0 and leaves every map's camera a margin too wide.

Three rects come out of this and they are not interchangeable:

| rect | what it is | who asks |
| --- | --- | --- |
| `GetWorldBounds()` | the whole terrain grid, black border included | the minimap picture |
| `GetPlayableMapRect()` / `bj_mapInitialPlayableArea` | where a unit may be — the bounding box of non-boundary tiles | scripts, `playableRect` |
| camera bounds / `bj_mapInitialCameraBounds` | that, pulled IN by the camera margin — where the camera's FOCUS may be | the camera clamp, `GetCameraBoundMinX` |

Blizzard.j derives the middle one from the last (`InitBlizzard`: playable area = camera bounds
*widened* by the margins), so a wrong margin moves `GetPlayableMapRect()` for every map in the
game, not just the camera.

## 4. The tint is fog, and the game says so

`UI\MiscData.txt` keeps the boundary's colours in the **`[FogOfWar]`** section, beside the
ones for explored and unexplored ground:

```
FoggedTerrain=170,16,16,32          BlackMaskedTerrain=255,0,0,0
BoundaryTerrain=230,0,0,0           FoggedBoundaryTerrain=170,16,16,32
BoundaryObject=255,0,0,0            FoggedBoundaryObject=255,64,64,96
```

ARGB. The pair is the whole rule: unplayable ground **in sight** takes `BoundaryTerrain`, black
at 230/255 — a shape survives and nothing else — while unplayable ground under fog takes the
ordinary fog tint (`FoggedBoundaryTerrain` is `FoggedTerrain` to the byte, because fog is
already the stronger statement). So **the boundary is a floor on darkness, never a ceiling**,
which is how `fogOverlay.ts` applies it: `dark = max(dark, 230/255)`.

Two consequences worth knowing:

- The floor goes on **after** the fog's softening blur. Unlike a sight edge this is not a
  vision boundary that wants easing, and a blur would dissolve a one-tile strip of "Nothing"
  (weight 1/5 at radius 2) into almost nothing. The per-tile mask is dilated onto the corner
  grid instead (`boundaryCorners`), so a boundary tile is uniformly dark and the falloff is
  spent on the playable side — one tile of fade into the map, which is how the border reads.
- The same per-corner brightness texture feeds the patched cliff and water shaders, so cliff
  faces and water inside the boundary darken with the ground rather than staying lit.

`EnableWorldFogBoundary(false)` turns the tint off — `UI\TriggerStrings.txt` names it
"Enable/Disable **Boundary Tinting**" — and Blizzard.j's `CinematicModeExBJ` drops it alongside
`FogEnable`/`FogMaskEnable` for the length of a cinematic, so a flythrough may leave the
playable area and still see ground. It is a render switch and nothing else; the sim's vision
map never hears about it.

## 5. What the boundary refuses

| who | how it is stopped | where |
| --- | --- | --- |
| a ground or water unit | the cells are `Unwalkable`; `findPath` already snaps a goal to the nearest walkable cell, so an order into the black walks as close as it can | `sim/pathfind.ts` |
| a flyer | the destination is pulled to the nearest cell with `0x04` clear — the one grid bit a flyer respects | `pathTo`, `teleportUnit` |
| a builder | the cells are `Unbuildable` too | `PathingGrid.buildable` |
| a point-target ability (Blink, Blizzard, a Dagger of Escape…) | refused outright with the engine's own line: `Units\CommandStrings.txt` [Errors] **`Outofbounds`** — "Targeted location is outside of the map boundary." The click is not spent and the reticle stays armed. | `castError` / `issueCast` / `useItem` |
| the camera | the focus clamps to the camera bounds | `clampTarget` |

`castError` is the click-time answer and `issueCast` is the gate every route shares — a
trigger's `IssuePointOrder`, an order off the wire, an autocast — for the same reason every
other cast rule is checked in both places.

### Not modelled, deliberately

- **A flyer's straight line still crosses a mid-map "Nothing" strip.** Air movement is a
  straight line by design (`pathTo`); only the *destination* is clamped. The border itself is a
  frame, and no straight line between two points inside a frame leaves it, so this only shows
  up on hand-painted interior boundaries.
- **The boundary does not block line of sight.** Nothing in the data says it should: the tint
  rows live in `[FogOfWar]` and describe a colour, and a boundary tile has ordinary terrain
  height, which is what WC3's sight is blocked by. A near-black tile a unit *can* see is
  already the whole visible effect. If the real client turns out to block sight across a
  painted strip, that is a separate, testable change to `sim/vision.ts` — not something to
  assume.
- **`BoundaryObject` (a unit or doodad in the boundary drawn as a black silhouette).** Units
  cannot get there, and a doodad in the border is hidden by unexplored fog in an ordinary
  match. It would need the boundary mask threaded into the mdx SD shader.
