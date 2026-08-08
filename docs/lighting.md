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

| Model | screen | lights | type | attenuation | intensity |
| --- | --- | --- | --- | --- | --- |
| `NightElf_Exp` | Sentinels | 4 (`Omni01`–`Omni04`) | omni | 80 → 200 | 6 / 250 / 15 / 7 |
| `Alliance_Exp` | Alliance | 4 + `FDirect01` | omni + **1 directional** | 80 → 200 | 400 / 1000 / 1000 / 800, directional 0.1 |
| `Undead3D_Exp` | Scourge | 4 (`Omni01`,`03`,`04`,`05`) | omni | 80 → 200 | 120 / 111 / 222 / 40 |
| `Orc_Exp` | Bonus | 4 | omni | 80 → 200 | 80 / 75 / 80 / 35 |
| `MainMenu3D_Exp` | main menu | 5 | omni | 80 → 200 | 170 … 280 |

**`Type` is not always 0**, and Alliance_Exp is the model that proves it: `FDirect01` is
`Type 1`, a DIRECTIONAL light — a direction and no attenuation, where every other light in the
glue set is a point. `updateOmniLights` had no filter and uploaded it as an omni at its pivot,
which put it 6102 units from that model's own camera target against a 200-unit reach: it lit
nothing, and it spent a shader slot claiming to. Non-omni lights are skipped now. It is skipped
rather than approximated because the MDX gives no direction to approximate FROM — identity
rotation, no parent, `Intensity 0.1` — and picking a base axis for it would be inventing what
the reference shows rather than reading it.

**Alliance_Exp is lit almost entirely by the base ambient, and that is the data's doing.** Its
four omnis sit 1361 / 5804 / 7109 / 4206 units from the camera target with the same 80→200 reach
every glue light has, so barely any of that set is inside a light. Measured by rendering one
frozen frame with `scene.omniLights` on and then null, mean |Δ| over the scene: Sentinels 17.1,
Scourge 14.5, Bonus 10.7 — **Alliance 2.8**. That is why its baked `lightAmbient` is 0.83 where
the others sit near 0.5, and it is the right answer rather than a workaround: with no practical
lights near the subject, ambient is what the engine has left to light Kael with.

We ignored all of them until issue #105, and with no light on the scene the SD shader fell
through to mdx-m3-viewer's stock `clamp(N·L + 0.7)` — a 0.7…1.0 wash with no falloff anywhere.
That is exactly the flat, over-bright look the campaign screen had.

**The main menu is on the same path**, not a special case: `updateOmniLights` reads whatever is
in the 3D scene (`backdropModel ?? bgModel`), so MainMenu3D_Exp's five lights are sampled and
uploaded exactly as a backdrop's are. Verified by toggling `scene.omniLights` on a frozen frame:
the tower, the chains, the ice spikes, the bergs and the ocean all change. What it does NOT have
is any shadow art — the model names 49 textures and not one of them is a shadow — so there is
nothing further to hook up there; a glue scene's shadows are painted into its textures.

If a glue scene looks *sharper* than a screenshot of the real client, that is very likely the
screenshot rather than the renderer — see **"Calibrate a screenshot reference on something you
render identically"** in [`REFERENCES.md`](REFERENCES.md), which measures it and also rules out the
mip chain, a missing shading layer and the install's `*_mip1.blp` files as causes.

### A glue scene's shadows are painted, and one of them is painted 178 times

There is no shadow *pass* to hook up on these screens — a glue model's shadows are in its art.
Read out of each model's `TEXS` chunk, four of the five name no shadow texture at all
(NightElf_Exp 88, Alliance_Exp 26, Orc_Exp 23, MainMenu3D_Exp 49 — none shadow-named), and the
fifth is the exception worth knowing about:

**`Undead3D_Exp` ships 216 of its 248 textures as baked shadow FRAMES** —
`UI\Glues\SinglePlayer\Undead3D_Exp\shadowMap0000…0354.blp` (178, even numbers) and
`Textures\shadowMapHair0000…0074.blp` (38). They are Arthas's own self-shadowing, baked per
animation frame and played back as a flipbook: two material layers (22 and 29) carry a **`KMTF`
texture-id track**, animated in both `Birth` and `Stand`, blended over the model at alpha 0.35
and 0.5 — the second one `Unshaded` and `Unfogged`, since a shadow cast by his hair onto his
face is not something the scene's own lights or haze should touch.

**This already works, and it works because mdx-m3-viewer samples KMTF per instance per frame**
(`modelinstance.js`, `layer.variants['textureId'][sequence]` → `instance.layerTextures[i]`,
which is what the batch binds). Nothing in OpenWar3 had to be added for it. Verified on the
running screen: all 248 textures resolve in the install and all 248 load, and forcing the two
cached layer textures to something else on a frozen frame changes 68k pixels across Arthas —
his face and hair flatten out and the modelling on his armour goes. If you are ever testing
this, note the trap that made it look dead the first time: **the render path reads the CACHED
`instance.layerTextures`, not `getTextureId`**, so monkeypatching the getter on a stopped scene
proves nothing — nothing calls it until an update runs.

The screen-edge sprite layers (`scenePanel` / `sceneLeft`) deliberately get no lights. They are
flat UI chrome drawn through an orthographic camera, and lighting the metal border with the
seascape's lamps is not what any of this is for.

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
