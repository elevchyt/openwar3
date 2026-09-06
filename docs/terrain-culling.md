# Terrain camera culling — drawing the ground you can see

Read this before touching [`src/render/terrainCull.ts`](../src/render/terrainCull.ts), the
`ow3Runs` / `ow3DrawCells` hunks in `patches/mdx-m3-viewer@5.12.0.patch`, or anything that draws a
pass over the whole terrain grid.

## What it is

**Culling** is deciding not to draw something because it cannot be seen, and doing that decision
more cheaply than the drawing would have cost. The GPU already discards off-screen geometry — it
has to — but only *after* every vertex has been transformed and every triangle clipped, and after
the driver has been asked to do the work. Culling is refusing to ask.

The thing being culled here is the **terrain**. mdx-m3-viewer draws the ground as one instanced
quad per terrain cell and issues it for every cell on the map, every frame, regardless of where
the camera is pointed:

```js
instancedArrays.drawElementsInstancedANGLE(gl.TRIANGLES, 6, gl.UNSIGNED_BYTE, 0, this.rows * this.columns)
```

On Echo Isles that is **12 288 instances**, four times a frame on a map whose palette needs a
second tileset pass (ground, ground again, water). Measured in the running game, the camera at a
normal zoom sees **704 of them — 5.7 %**. The other 94 % were transformed and thrown away. On a
big map it is worse: the cost is the whole map, and what you can see is a screenful.

Warcraft III never did this. It drew the terrain around the camera, which is why it ran on the
machines it ran on.

## How it works, in one idea

The per-cell buffers are **row-major**. The ground shader recovers a cell's position from nothing
but its instance number:

```glsl
vec2 corner = vec2(mod(a_InstanceID, u_size.x), floor(a_InstanceID / u_size.x));
```

So one row of cells is a **contiguous slice of every per-cell buffer**, and drawing part of a row
is not a new kind of draw — it is the same draw with the attribute pointers offset. That makes
the entire mechanism a list of `(first, count)` pairs:

- `TerrainCull.update(camera)` fills that list, one run per visible cell row.
- `map.ow3Runs` carries it into the viewer.
- The patched `map.ow3DrawCells(rebind)` walks it, re-pointing the per-instance attributes at
  `first` and asking for `count` instances.

Nothing about the geometry, the buffers, the shaders or the draw order changes. With `ow3Runs`
unset, the call is the original one over the whole map — which is what a caller that has not
opted in still gets.

## Why blocks, and why per-row runs

Testing 12 288 cells against the frustum on the CPU every frame would cost more than the draw it
saves — that is the trap this kind of optimisation falls into. So the map is diced into **blocks
of 8×8 cells**, each carrying the Z range of the terrain (and the water table) under it, and a
block is tested as a box: 192 tests on Echo Isles instead of 12 288.

Then, per block row, the visible blocks are simply the columns **between the first and the last**.
That is not an approximation: a frustum's intersection with a horizontal slab is convex, so the
visible span within any single row is contiguous and "first through last" loses nothing.

The test itself is the standard positive-vertex one — for each of the camera's six planes, take
the box corner furthest along that plane's normal, and if even that corner is outside, every
corner is. It is **conservative**: a block whose box merely touches the frustum is kept. That is
the only kind of cull allowed to be invisible, because the worst thing it can do is draw a cell
that did not need drawing.

## Proving it is invisible

A cull is a claim about pixels, so test it in pixels. `TerrainCull.enabled` exists for exactly
this: turn it off and the stock full-map draw comes back, in the same frame, with nothing else
changed.

The measurement that matters is a **control**. Two frames with the cull ON already differ — the
rain falls, idle clips play, the fps readout ticks — so the question is not "do the culled and
unculled frames differ" but "do they differ by more than two culled frames do". On Echo Isles,
paused, at 1650:

```
culled vs culled  (noise floor): 36 244 px
culled vs uncull  (the test)   : 35 751 px
```

The cull is below the noise. Amplify the difference image and what is left is rain streaks, unit
bodies and the day/night medallion — nothing tile-shaped, which is what a culling error looks
like.

`holdRuns` is the other half of seeing it: freeze the runs, fly the camera out, and the region the
frozen frustum kept is all that is left of the world — the ground ends in mid-air with the trees
still standing over the void.

## What this is and is not worth

**On a modern GPU it is worth almost nothing.** Measured on the development machine, interleaved
four passes each way: 6.59 ms/frame culled against 6.63 ms unculled — about 1 %. That frame is
CPU-bound in the sim and the animation update, and a current GPU eats 12 288 instanced quads
without noticing.

That is not an argument against it, but it *is* the honest framing: this is a change for the
machine that has no headroom — where vertex throughput and the driver cost of a big draw are the
budget rather than a rounding error. Do not quote a percentage from this machine as though it
were the point.

**And be clear about what is saved, because it is not fill.** A cell outside the view was already
contributing no pixels: the GPU clipped it away. What it was costing is everything BEFORE that —
the vertex transform, the clip itself, and the driver's share of one enormous draw. So this buys
nothing on a machine that is fragment-bound and a great deal on one whose vertex path is weak or
partly in software, which is exactly the 2008 integrated part this is aimed at.

**And do not reach for SwiftShader to prove otherwise.** Running the same interleaved benchmark
under `--use-angle=swiftshader` as a stand-in for a weak GPU produced 202 and 261 ms/frame *for
the same condition* — a 30 % spread within one arm, which swamps anything being measured. A CPU
rasteriser is not a slow GPU, and at three frames a second it cannot resolve a difference this
size. The instance count (12 288 → 704, exact) and the pixel comparison are the measurements that
hold; a frame-time number for weak hardware has to come off weak hardware.

## What is NOT culled yet

Three passes still sweep the whole map every frame, and the runs are already computed for them:

- **`src/render/fogOverlay.ts`** — the fog-of-war veil, one indexed triangle per terrain cell over
  the entire map, and it is BLENDED, so it costs fill as well as vertices. Its index buffer is
  row-major over the same cell grid, so a run maps to an index range directly
  (`first * 6` indices, `count * 6` of them).
- **`src/render/terrainShadowOverlay.ts`** — the baked `war3map.shd` layer. This one already
  prunes by CONTENT: it builds triangles only for cells the mask actually shadows, plus a
  one-cell dilation. But that is still every shadowed cell on the map, drawn whatever the camera
  is doing, and on a forested map that is a large fraction of it. Its vertex soup is compacted to
  the kept cells, so a cell row is still a contiguous vertex range — just not one a multiply can
  find. It needs a per-row (start, count) table built alongside the mesh.
- **The cliffs.** `renderCliffs` draws each cliff model's instances, which is real geometry rather
  than a full-map sweep, but nothing tests them against the camera either. They would need
  per-instance bounds, not the cell runs.

The two overlays are ours and need no patch; the cliffs are a different shape of problem.
