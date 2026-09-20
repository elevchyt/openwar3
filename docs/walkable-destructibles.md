# Walkable destructibles: bridges, ramps and second storeys

Read this before touching [`src/render/walkableHeight.ts`](../src/render/walkableHeight.ts),
`RtsController.groundOrDeck` in [`src/game/rts.ts`](../src/game/rts.ts), or the `walkable` field
on `MapDestructible`.

## The column

`Units\DestructableData.slk` has a **`walkable`** column, and it is 1 on **106 of the 247**
stock types: every bridge (`LT00`–`LT11` wood, `YT00`–`YT31` rock and stone, `DTsb`–`DTs3` the
demon force bridge, `YSdb`/`YSdc` the ruined city one), the stone ramps `LTr1`–`LTr8`, the
Dalaran thrones, and the invisible platforms a mapmaker builds an upper storey out of. Nothing
else in that table means anything remotely like it — every other column is about what the thing
is made of, how much life it has, or how it dies.

## It is a HEIGHT flag, not a pathing one

Where a unit may walk was already settled before `walkable` was read. Each of these types
carries a `pathTex` — `PathTextures\CityBridgeLarge45.tga` and friends — which is stamped onto
the pathing grid exactly like a tree's or a gate's, and it is what makes the water under a
bridge crossable in the first place. What `walkable` adds is that **the deck, not the terrain,
is the floor**.

That matters precisely because a bridge spans a gap: the terrain under it is far below. On
Human01 (The Defense of Strahnbrad) the single `LT05` at `(1216, -960, -114)` sits over a
streambed at **-165**, with its two banks at about **+73**. Read the floor as the terrain and
every unit crossing is drawn down in the water, under the planks it is supposed to be on — which
is exactly what OpenWar3 did until this landed.

## How the height is found: a ray, straight down

The reference casts a ray down the world's Z axis at the destructible's own geometry and takes
the nearest surface it meets. Warsmash's shape is worth quoting because it also settles the two
edge cases:

```java
ray.set(x, y, 4096, 0, 0, -8192);                 // QuadtreeIntersectorFindsWalkableRenderHeight
if (instance.intersectRayWithCollision(ray, out, true, true)) z = max(z, out.z);
…
final float unitZ = Math.max(getWalkableRenderHeight(unitX, unitY),
                             terrain.getGroundHeight(unitX, unitY));
```

* **Two decks over one point** → the highest wins, which is what makes a stack of invisible
  platforms a second storey rather than an argument.
* **The GROUND is always in the max** → a unit that steps off the end of a bridge is back on the
  grass in the same step, with nothing to say about where the deck stopped, and a map with no
  walkables costs nothing at all.

We do the same ray, with one difference of bookkeeping: the triangles are transformed into world
space **once, at map load**, rather than every query against a live instance. A destructible does
not move, so its deck is a fixed piece of geometry; only who is standing on it changes. They go
into a coarse bucket grid (128 world units) so a query touches a handful of triangles instead of
the model's several hundred.

**The geometry is parsed straight out of the archives, not taken off the viewer's doodad
instance** — because the viewer does not keep it. `setupGeosets` uploads each geoset into a GL
buffer and the runtime `Geoset` holds byte offsets into that buffer, not vertices. So
`MapViewerScene.walkableMesh` reads the `.mdx` through the VFS with the `mdlx` parser, once per
distinct model.

## The .doo's `z` is absolute

A doodad record's third coordinate is a WORLD height, not an offset above the terrain: the
viewer's own `Doodad` moves the instance to `doodad.location` verbatim and adds nothing under it.
The Strahnbrad bridge's `-114` is what makes the numbers work out — the model's deck runs from
**195** at the ends up to **274** at the crown of its arch, so placed at -114 it lands on the
banks at **+81** (the ground there is +73) and rises to **+160** over the water.

Those four numbers are what `tools/render-walkable-height-test.cjs` asserts against the real
install, because they are the ones that go wrong if the transform is wrong: forget the record's
z, or turn the model the other way, and one of them moves by hundreds of units.

## Where it is applied

`RtsController.groundOrDeck(x, y)` is the one answer, and everything that stands on the floor
asks it: the drawn body (`this.loc[2]` in the per-frame unit sync), `standZ` (and through it the
selection rings, the flash rings and the screen projection a drag box uses), the move-order
arrow, a selected ground item's ring and a rally flag.

**And the CLICK RAY.** `RtsController.groundHit` marches the ray from the camera against
`groundOrDeck`, not against the terrain — the deck is what the player is looking at, so it has
to be what the player is clicking on. Marched against the terrain alone the ray sails straight
through the planks and lands in the water some way past them: on Strahnbrad's bridge a
right-click on the middle of the span came out **381 world units** away, and near the far end up
to **600**. That is both halves of "bridges don't work properly" at once — the click that does
not land where you clicked, and the crossing that then never happens, because the destination it
did land on is a spot in the river that no unit can stand on. With the deck in the march the
same three clicks land 0–2 units from the point aimed at.

The only clicks that still miss are the ones the ARCH hides: a bridge is a curve, and from a
shallow camera angle the crown genuinely occludes the far slope behind it. That is what the
reference does too — you cannot click a piece of bridge you cannot see.

**A ring drawn on a deck is drawn FLAT.** A selection circle is an ubersplat, and an ubersplat
conforms to the terrain corner by corner (`render/uberSplatOverlay.ts`), which over a bridge
puts it in the river hundreds of units below the unit it belongs to. `RingInfo.deck` carries the
deck height when the unit is standing on one, and `SplatOptions.floor` then emits a single quad
at that height instead of tessellating the ground. There are no terrain corners on a deck to
follow and a deck is flat enough not to need any.

Two things deliberately do NOT ask it:

* **a building's seat**, which samples the tallest terrain its footprint spans (issue #15) —
  nothing in the game founds a structure on a bridge;
* **the pathing grid**, which never asks the model anything. This is the same division as
  `collisionSize` against the model's `COLLISIONSHAPE` nodes (see
  [`selection.md`](./selection.md)): one system is 2D and about where you may go, the other is
  3D and about where you are drawn.

## What WC3 does not do

You cannot walk *under* a bridge. The engine treats the deck as ground and rejects a fly height
below zero, which is why every "two levels" tutorial for the World Editor is really a recipe of
pathing blockers and invisible platforms rather than a second pathing layer. Nothing here tries
to be cleverer than that.
