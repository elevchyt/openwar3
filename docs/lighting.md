# Lighting and shadows

What lights a scene in OpenWar3, and what casts shadows in it. Read this before adding
anything shadow- or light-shaped — the single most important fact is at the top.

## WC3 has no real-time shadows

No shadow maps, no shadow volumes, no per-light depth passes. Everything that looks like a
shadow in Warcraft III is one of four baked or decal mechanisms, and building a real-time
shadowing engine would move us *away* from the original rather than toward it:

| What | Where it comes from | Where we implement it |
| --- | --- | --- |
| Unit shadows | `Units\UnitUI.slk` `unitShadow` — a black-RGB/alpha blob texture, sized `shadowW`×`shadowH` and offset by `shadowX`/`shadowY` | [`render/shadowOverlay.ts`](../src/render/shadowOverlay.ts) |
| Building shadows | the same table's `buildingShadow`, one baked texture per building | the second `ShadowOverlay` pass in `mapViewer` |
| **Static map shadows** | **`war3map.shd`** — the mask the World Editor bakes for cliffs, doodads and scenery | [`render/terrainShadowOverlay.ts`](../src/render/terrainShadowOverlay.ts) |
| Time-of-day shading | `Environment\DNC\*.mdx` — a keyframed directional light per tileset | [`render/dayNight.ts`](../src/render/dayNight.ts) + the shader patch |

All three shadow layers are ground decals tessellated over the terrain's own corner grid, so
they morph across slopes and ramps instead of floating over them.

## `war3map.shd` — the static shadow layer

The file has **no header at all**, so the only way to read it is to check its length against
the map's own terrain grid. Measured on three real campaign maps:

| Map | cells | `war3map.shd` | bytes/cell |
| --- | --- | --- | --- |
| NightElfX01 | 96×128 | 196 608 | 16 |
| NightElfX02 | 128×160 | 327 680 | 16 |
| OrcX01 | 192×192 | 589 824 | 16 |

So it is **16 bytes per terrain CELL — a 4×4 sub-grid** — row-major, giving a mask of
(cells_x × 4) by (cells_y × 4). Every byte in all three maps is either **0 or 255**: a 1-bit
mask, not a gradient, so how dark a baked shadow reads is entirely our
`TerrainShadowOverlay.strength` (0.45) rather than anything the file says. Coverage runs 13%
to 34% of the map, so this is a large part of how a WC3 map reads.

The mask is stored on the same bottom-left-origin, row-major grid as `war3map.w3e`, which is
why the overlay's UVs are a plain grid fraction with no flip. If you ever see baked shadows
sitting in open ground with nothing above them, that assumption is what broke.

Unshadowed cells are dropped from the mesh — most of them are — with a one-cell dilation so
the bilinear filter still has real texels to blend toward at a shadow's edge.

## Glue-screen lighting (issue #105)

The main menu and the campaign backdrops are 3D scenes, and **every glue model carries its own
lights** in its MDX `LITE` chunk:

| Model | lights | type | attenuation | intensity |
| --- | --- | --- | --- | --- |
| `NightElf_Exp` | 4 (`Omni01`–`Omni04`) | omni | 80 → 200 | 6 / 250 / 15 / 7 |
| `Orc_Exp` | 4 | omni | 80 → 200 | 80 / 75 / 80 / 35 |
| `MainMenu3D_Exp` | 5 | omni | 80 → 200 | 170 … 280 |

We ignored all of them until issue #105, and with no light on the scene the SD shader fell
through to mdx-m3-viewer's stock `clamp(N·L + 0.7)` — a 0.7…1.0 wash with no falloff anywhere.
That is exactly the flat, over-bright look the campaign screen had.

**An 80→200 unit reach reads as far too small** for a scene whose bounds run to ±3000 — until
you read the model's own camera, which sits **340 units** from its target. These are dioramas:
a small lit set near the eye with a big painted backdrop far behind it, and the lights are
sized for the set. What covers the far scenery is the campaign's own `BackgroundFog*`.

Two things about the implementation are worth knowing before touching it:

* **Colours come out BGR.** The same quirk `dayNight.ts` documents for the day/night lights —
  neither the parser nor Warsmash swizzles them, and reading them straight gives a scene a
  mirror-image tint.
* **The base ambient is NOT from the file**, and is labelled as such wherever it appears. Every
  one of these lights carries `AmbIntensity 0`, which past 200 units would leave the scene
  pitch black, and the reference plainly is not. The engine supplies a base we cannot read out
  of the model, so it lives in `BackdropTuning.lightAmbient` with its own `?menudebug` slider
  rather than being smuggled in as a constant that looks like data.

The uniforms (`u_omni*`, `u_dnc*`, `u_distFog*`) are all added by
`patches/mdx-m3-viewer@5.12.0.patch`. **After editing that patch, restart the dev server and
delete `node_modules/.vite`** — Vite pre-bundles the dependency, so a running server keeps
serving the pre-patch copy and your shader change will appear to do nothing at all.
