# Selection: what the cursor hits, and what a drag box may take

Read this before touching `pickAt`, `boxSweep`/`boxPicks`/`selectBox` in
[`src/game/rts.ts`](../src/game/rts.ts), or
[`src/render/modelCollision.ts`](../src/render/modelCollision.ts).

Two rules run this whole area, and both are facts about the original rather than choices:

1. **A click is a RAY against the model's own collision shapes.** Not the mesh, not a capsule
   we invent, not a disc drawn around the unit's feet.
2. **A GROUP is a thing you have command of.** A drag box hands you as many of your own units
   as it covers, and never more than **one** of anybody else's.

---

## 1. Click detection — `COLLISIONSHAPE`, not the mesh

Warcraft III does the hit test against invisible primitive volumes the modeller placed in the
model's own node hierarchy: `COLLISIONSHAPE` nodes, which are spheres, boxes, planes or
cylinders. The engine raycasts from the camera through the cursor and asks which of those the
ray meets. This is why the standard answer to "my custom unit can't be clicked in-game" is
*you forgot the collision shape* — hiveworkshop
[156930](https://www.hiveworkshop.com/threads/collision-shapes-how-to-make-your-model-selectable.156930/).

**This is a different system from the one units bump into each other with.** Pathing and
body-blocking use the flat 2D `collisionSize` radius off `UnitData` against the pathing grid
and ignore the model entirely (hiveworkshop
[309631](https://www.hiveworkshop.com/threads/collision-size.309631/)). Nothing in this
document touches movement, and nothing in [`src/sim/pathing.ts`](../src/sim/pathing.ts) has an
opinion about clicking.

### What the install actually contains

Verified rather than taken on trust, over every model `Units\UnitUI.slk` names
(`tools/` scratch survey; re-run it against `Warcraft III/` if you doubt a number):

| | |
| --- | --- |
| models named by `UnitUI.slk` | 530 |
| carrying collision shapes | **440** |
| carrying none | 89 — almost all buildings |
| shape kinds | 551 spheres, 204 boxes, **0 cylinders**, 0 planes |
| shapes parented to a bone rather than the model root | **1**, in the whole corpus |

A **unit** is typically two overlapping spheres, head and chest:

```
Units\Human\Footman\Footman.mdx     Sphere r=38.1 at (5.3, 0, 63.2)   ← head
                                    Sphere r=38.1 at (3.2, 0, 22.8)   ← chest
Units\NightElf\Wisp\Wisp.mdx        Sphere r=64.2 at (0, -2.8, 65.7)
Units\Human\Knight\Knight.mdx       Box (-65.4,-29.1,0)..(65.4,29.1,81.8)   ← the horse
                                    Sphere r=45.9 at (31.3, -0.2, 96.8)     ← the rider
```

### A BUILDING is clicked by a slab at its base, not by its silhouette

This is the one that surprises. Across the 87 building collision boxes in the install:

| | |
| --- | --- |
| boxes whose base sits at **z = 0** | 85 / 87 |
| box height | min **26** (Town Hall, Ziggurat) · median **113** · max **300** (Temple of Tides) |
| box height as a fraction of the model's own height | median **0.23** |

The Town Hall's model rises to z = 643 and its collision box is **26 units tall**. So a
building is clicked by its footprint, and the tip of a Necropolis spire or a Town Hall steeple
is not a click target. That also reads straight out of the modelling advice above, which says
a shapeless model can still be drag-selected "over its **base**".

### The fallback, for the 89 models that state nothing

Those are nearly all buildings — the Orc Barracks, Great Hall, Spirit Lodge, Voodoo Lounge and
Troll Burrow among them — and they still have to be clickable, so `RtsController.pickVolumes`
falls back on the thing they DO state exactly: their own footprint, as a slab
`BUILDING_SLAB` = **113** units tall. That number is ours; it is the corpus's own median,
standing in for a slab the artist never drew. A shapeless *mobile* unit (the wards, the
Locust, a Skink) keeps the sphere the pick used before any of this, so nothing that was
clickable stops being so.

### Rules that fall out of using a real ray

- **Nearest hit wins**, and that is the entire tie-break. The old code had to prefer units over
  buildings by hand; a ray does it for free, because whichever body it reaches first is the one
  drawn in front of the other.
- **A hit behind the terrain is dropped** (`tGround`), so a unit over the lip of a cliff is not
  clickable through the cliff. With `PICK_GROUND_SLACK` of give, because a building's slab lies
  *on* the ground it stands on.
- **`PICK_PAD_PX` = 4** grows every volume by four pixels' worth of world. Ours, not the game's:
  a collision sphere is exact and a mouse is not.
- The volumes come off the instance's **node world matrices**, so they follow the model's
  position, facing, scale and (for the one bone-parented shape in the game) its animation.

### Seeing it

The cheat panel's **Show Colliders** draws the real volumes — spheres as three great circles,
boxes as twelve edges — where they actually sit. A Footman wearing his two spheres is the
picture of this whole document.

---

## 2. The drag box

`boxSweep` splits what the rectangle covers three ways, and `boxPicks` decides:

| the box covers | it takes |
| --- | --- |
| your units (and anything else) | **all** your units — a building is never mixed in |
| only your buildings | all of them |
| only other players' / neutral bodies | **exactly one**, nearest the box's centre, a unit before a building |
| nothing | nothing — an empty box KEEPS the group (WC3 has no click-to-deselect) |

The single-foreign rule is why the "your units win" row needs no clause of its own: a box over
your army and an enemy's takes your army, because yours are found first.

Other rules the box keeps:

- **Units beat buildings** inside your own half of it — a box over a Footman and your Town Hall
  takes just the Footman.
- **A selection is units XOR buildings**, the same rule `selectAt` and the control groups keep
  (`ownSelectionByKind`). An additive (Shift) box may only join a selection of its own kind,
  and a foreign body joins **nothing** — there is no group for it to be the second member of.
- **A foreign body passes the same fog gate a click does** — `drawnFromMemory` — so an explored
  but unseen enemy building cannot be boxed any more than it can be clicked.
- The live marquee **previews exactly what the release will take**, each ring in its own
  allegiance colour (`ringAllegiance`), so the one enemy a box may take previews red rather
  than pretending to be a unit you command.

Note that the box tests against the unit's screen position and selection circle, NOT against
the collision shapes — that is the original's own split, and it is what "a shapeless model can
still be drag-selected over its base" means.

---

## Where it lives

| | |
| --- | --- |
| shape extraction + the ray tests | [`src/render/modelCollision.ts`](../src/render/modelCollision.ts) |
| `pickAt` / `pickVolumes` / `boxSweep` / `boxPicks` | [`src/game/rts.ts`](../src/game/rts.ts) |
| the wireframe overlay | `pushColliderVolume` in [`src/render/mapViewer.ts`](../src/render/mapViewer.ts) |
| headless test | `tools/render-model-pick-test.cjs` (`pnpm sim:test`) |
