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
`BOUNDARY_DARK` / `boundaryTint` / `boundaryMask` in
[`src/render/fogOverlay.ts`](../src/render/fogOverlay.ts), `BOUNDARY_BLOCK` / `AIR_EYE` /
`setBoundaryField` in [`src/sim/vision.ts`](../src/sim/vision.ts), `inPlayableArea` +
`airPath` + the flying branch of `pathTo` + `teleportUnit` in
[`src/sim/world.ts`](../src/sim/world.ts), `SetCameraBounds` / `GetCameraMargin` in
[`src/jass/natives/camera.ts`](../src/jass/natives/camera.ts), and `applyBoundaryTint` in the
mdx SD fragment shader ([`patches/mdx-m3-viewer@5.12.0.patch`](../patches/mdx-m3-viewer@5.12.0.patch)).
Checked by `tools/sim-boundary-test.cjs` (`pnpm sim:test`).

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
| a flyer | the destination is pulled inside the map, and the flight itself is ROUTED round — see §6 | `pathTo` / `airPath`, `teleportUnit` |
| a builder | the cells are `Unbuildable` too | `PathingGrid.buildable` |
| a point-target ability (Blink, Blizzard, a Dagger of Escape…) | refused outright with the engine's own line: `Units\CommandStrings.txt` [Errors] **`Outofbounds`** — "Targeted location is outside of the map boundary." The click is not spent and the reticle stays armed. | `castError` / `issueCast` / `useItem` |
| an EYE | the boundary blocks sight outright, at any height — see §7 | `sim/vision.ts` |
| the camera | the focus clamps to the camera bounds | `clampTarget` |

`castError` is the click-time answer and `issueCast` is the gate every route shares — a
trigger's `IssuePointOrder`, an order off the wire, an autocast — for the same reason every
other cast rule is checked in both places.

## 6. Air movement: a straight line, until it isn't

A flyer's path is one waypoint — WC3 air units cross cliffs, trees, buildings and crowds, so
there is nothing to search. The boundary is the single exception, and it is worth being exact
about how little it changes: `pathTo` asks `segmentPlayable` whether the straight line stays
inside the map, and only when the answer is no does it run `findPath` over the **air domain**.

`PathDomain`'s `"air"` is not a third terrain flag. It is the absence of almost every rule —
`walkable(cx, cy, "air")` reads `Unflyable` and no stamps at all, so a pier, a treeline and a
cliff are all open ground to it and only the black is shut. That means the search is the same
A* a Footman runs, over the same grid, and the result is string-pulled by the same
`smoothPath`, so a Gyrocopter told to cross a painted strip banks round its end in two long
runs rather than stepping a 45° staircase.

On an ordinary map nothing is ever in the way, `segmentPlayable` says so in a few dozen cell
reads, and air movement costs exactly what it always did.

## 7. The boundary blocks sight, and no height sees over it

Vision already has the mechanism: `sim/vision.ts` keeps a per-cell `block` height, a tree
raises it by `TREE_BLOCK`, and a ray-cast keeps a running horizon along each ray. The boundary
joins it as `BOUNDARY_BLOCK = Infinity` — which is the whole statement. A cliff and a treeline
are things you can see OVER from higher ground or from the air; the edge of the world is not a
thing at all, so nothing finite is above it.

Three details are load-bearing:

- **It is its own mask, not just a value in `block`.** Map borders are full of trees — WTii's
  Unit Tester has 614 of them in its — and `removeTreeBlocker` puts a cell back to bare
  ground. Without `VisionMap.boundary` to fall back on, felling a tree in the border would
  punch a window through the edge of the world.
- **Flyers are not exempt.** A flyer looks over a treeline and is seen over one, so
  `hasLineOfSight`'s `flying` used to return true without walking the ray at all. It now walks
  it from `AIR_EYE` — an eye height above every finite blocker — which leaves terrain and
  trees unable to shadow anything while the infinite blocker still wins. The same trick lets a
  flyer's REVEAL reuse the ground unit's ray-cast instead of needing a second one: from a
  kilometre up, every cell's angle rises monotonically with distance, so the result is the
  flat circle a flyer has always had with the boundary's shadow cut out of it.
- **The circle is kept when nothing is near.** `reveal` only takes the cast for a flyer when
  `boundaryWithin` finds an unplayable cell inside the disk — a byte scan with an early exit,
  far cheaper than the cast it decides against, and false for most units most of the time.

The consequence the issue was really about: two units on opposite sides of a painted strip
cannot see each other, so they cannot acquire or shoot each other either — `hasLineOfSight` is
what the acquisition gate reads (issue #45).

## 8. …and the things standing in it are black silhouettes

`BoundaryObject = 255,0,0,0` and `FoggedBoundaryObject = 255,64,64,96` are the object twins of
§4's terrain rows, and they follow the same shape: `BoundaryObject` is `BlackMaskedObject` to
the byte and `FoggedBoundaryObject` is `FoggedObject` to the byte. Alpha 255 on both, which is
the file saying **replace the colour** rather than dim it — so a tree in the border is a black
cut-out, not a darker tree.

This one needs the mdx **SD fragment shader**, because a unit or doodad is drawn by the model
pipeline and not by the terrain pass. `applyBoundaryTint` samples the mask by world XY (so a
flyer three hundred units up over the black is blacked out like anything else) and runs LAST,
after lighting and distance fog. Additive layers (filter mode 3/4) go to black rather than to
the tint, because black is their identity — a glow inside the boundary has to stop adding.

Which is why the fog mask is **RGBA** rather than one luminance byte. Three facts have to be
told apart and folding them into one channel loses two:

| channel | what it carries | who reads it |
| --- | --- | --- |
| R | terrain brightness **with** the boundary floor | the cliff and water shaders (`.r`, unchanged) |
| G | fog brightness **without** it | the model shader, to pick between the two object rows |
| B | the boundary mask itself | the model shader, to know the tint applies at all |

R cannot answer G's question: it has already been flattened to ~0.1 wherever the boundary is,
whatever the fog says. `EnableWorldFogBoundary(false)` clears both R's floor and B, which is
how one switch gives a cinematic back its unlit border *and* its unblackened doodads.

### One thing still not modelled

**A flyer's sight disk snaps to whole vision cells when the cast is taken.** `revealRadial`
uses the exact float radius and `revealLineOfSight` rounds it to cells, so a flyer within
reach of a boundary has a sight circle up to half a cell (32 world units) different from one
in open ground. Ground units have always had this; it is only newly visible on air.
