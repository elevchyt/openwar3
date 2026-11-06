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
| Building shadows | the same table's `buildingShadow`, one baked 1-bit texture per building, FIRST ROW NORTH, sized by the file (13² for a Town Hall) at 32 world units a texel and shifted (48, 32) to the north-east, both a fit against 1.30.4 that no file states | the second `ShadowOverlay` pass in `mapViewer` |
| **Static map shadows** | **`war3map.shd`** — the mask the World Editor bakes for cliffs, doodads and scenery | [`render/terrainShadowOverlay.ts`](../src/render/terrainShadowOverlay.ts) |
| Time-of-day shading | `Environment\DNC\*.mdx` — a keyframed directional light per tileset | [`render/dayNight.ts`](../src/render/dayNight.ts) + the shader patch |

All three shadow layers are ground decals tessellated over the terrain's own corner grid, so
they morph across slopes and ramps instead of floating over them.

**How dark:** `UI\MiscData.txt` [FogOfWar] `ShadowImageColor` = 170,0,0,0, multiplied into the
texture's alpha. Shadow.blp peaks at 191, so bare dirt goes 145 → ~72 under a Peasant, which is what
1.30.4 measures. An earlier 0.32 here left units with no visible shadow at all. The blob sits where
`shadowX`/`shadowY` put it, with no extra push.

A BUILDING is not on that number. Its map is 1-bit, so `ShadowImageColor` would put 0.667 of black
over whole plateaus, and the real client does not: in the column north of an Altar of Storms, grass
goes (34,112,22) → (25,70,22) with blue unmoved. `BUILDING_SHADOW` is the fit, alpha 0.44 over
(16,16,22). The 1.30.4 reading is one measurement on one tileset, and the reason the two differ is
not known.

Overlapping shadows STACK on the real client as far as could be measured: a Farm's shadow took grass
already partly in a Town Hall's shadow by ×0.76, and clear grass beside it by ×0.80 (rough, read off
one frame). So they are blended one over the other here too, rather than unioned.

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

## Cliffs and ramps: who shades a tile with no ground

A cliff or ramp tile has **no ground** — the viewer draws a `Cliffs\`/`CliffTrans\` model in
its place and leaves the tile's four texture slots at zero. Three things went wrong at those
tiles, and together they were the "seams where slopes meet the ground" and the "sharp black
lines on cliffs" (Lost Temple shows all three at once):

1. **Two layers drew a plane through the rock.** The fog-of-war veil and the `war3map.shd`
   layer are meshes on the ground's corner grid; on a cliff tile that grid is a plane slanting
   from the low corners to the high ones. The cliff shader ALREADY dims itself by the fog mask,
   so wherever that plane landed on a ramp or a cliff top it was dimmed twice — a ramp in
   explored fog drew at a quarter of the grass beside it, a hard-edged dark rectangle with the
   ramp's outline — and wherever it cut a curved cliff face it painted a jagged black wedge.
   Now both layers skip those cells (`FogOverlay.skipCells`, `TerrainShadowOverlay.skipCells`,
   driven by `MapViewerScene.syncGroundless` off the viewer's own `cornerTextures`), and the
   cliff shader samples the shadow mask itself (`cliffs.frag` `u_shdTexture`), as it already
   samples the fog. Neither layer is LIFTED any more either: a lifted edge rides up the screen
   and left the last three pixels of every plateau tile above a cliff unfogged once the quad
   hanging below it was gone. The polygon offset alone wins (no speckle in unexplored fog at
   any zoom).
2. **The ground lit itself by the cliff layers.** `ground.vert` took its normal from the FINAL
   corner height (ground + cliff layer + a ramp's half layer), so every tile beside a cliff or
   ramp was lit as a 27° hill. Under Lordaeron's low south-west sun (terrain light direction
   −0.68, −0.41, 0.62) that is about half brightness — a band along every cliff edge and an
   outline round every ramp, near-black at night. HiveWE and Warsmash both light from the RAW
   ground height and position from the final one; the height map now carries both (luminance =
   raw, alpha = final).
3. **A cliff model's normals are smoothed.** Where the mesh meets the grass its vertex leans
   toward its own slope or wall (a ramp's flat border sits ~25° off vertical), so the two sides
   of the seam were lit differently. A cliff vertex on a cell edge at a ground level (x or y on
   the 128 grid, z on a half layer) now takes the ground's own normal there — Warsmash's idea,
   studied not lifted. The `nz > 0.6` guard comes from a census of all 253 stock cliff/ramp
   models: every vertex where a natural cliff or a ramp meets the ground is at nz ≥ 0.6 and
   every wall vertex on those lines under 0.3, while City cliffs split vertices on purpose
   (walls at 0, bevels at 0.45) and keep their creases.

A trap when testing any of this: `MapViewerScene.ensureFog` rebuilds the veil whenever
`fog` is null, so setting `mapScene().fog = null` from the page does NOT turn the fog off.

**A cliff WALL hardly answers the sun.** Sampled per wall on 1.30.4 (Booty Bay), walls whose model
normals give N·L anywhere from 0 to 0.56 all read about 0.3 of the rock texture, while the full
`ambient + 1.3·N·L` took them to 1.0 and 0.17 either side of a tile seam: alternating bright tan and
black along one hillside. The Terrain light itself is right (a trace reads direction
0.675, 0.406, −0.616, diffuse 1.29, ambient 0.168, 0.168, 0.195), and the stock models' normals are
right too. So `cliffs.frag` replaces N·L with `0.16 + 0.07·N·L` wherever `n.z` is low, blending back
to the real N·L by 0.75 so the lip that meets the grass stays lit as the ground is. Those two numbers
are a FIT. Why the real client does this is not known: `SetMaterial`'s values could not be read
(see "Not settled" below), and a cliff's material is the likely answer.

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
`Type 1`, a DIRECTIONAL light with identity rotation and `Intensity 0.1`. The MDX gives it no
direction to read, so it is skipped rather than guessed at.

**`KLAV` turns a light off.** A flash is a light with a visibility track: `Omni10`, the lightning on
Exodus of the Horde (intensity 350), and `Omni05boom`, the meteors on Reign of Chaos's menu. Ignored, a
strike lights the whole set on every frame. The viewer has no getter for a light's track, and a light's
`getVisibility` reads the generic `KGAO` and answers 1, so `updateLights` asks for `KLAV` by name.

If a glue scene looks *noisier* than the real client, it is the LIGHTING and not the textures: see
the next section, which is what that turned out to be on the main menu.

### What the real client actually does: a Direct3D trace

**The expansion's main menu no longer guesses any of this.** Wine logs every Direct3D call a game
makes, so the real client's numbers can be read rather than fitted. Everything in this table was
read off 1.30.4 (recipe below) at 1920×1080 with Particles on its highest rung: the Frozen Throne and
Reign of Chaos main menus, the Sentinels and Prologue campaign screens, and a chapter in play.

| What | The real client | What we had fitted by eye |
| --- | --- | --- |
| Pipeline | **fixed-function**: no shader in the frame, `SetFVF` + CPU-skinned dynamic buffers | per-pixel |
| Lighting | per VERTEX, then interpolated | per pixel |
| Light colour | the colour **as stored** × intensity (Omni: `90.35, 240, 184.47`, teal) | BGR swap, which gives yellow-green |
| Attenuation | **1 / (1 + 0.0005·d²)**, range 10000 (`D3DLIGHT9` read out of memory) | a linear 80→200 window |
| Base ambient | none: `D3DRS_AMBIENT` is never set, and each light's own ambient is 0 | 0.65 |
| Fog, campaign screen | the campaign's own `BackgroundFog*` **exactly**: Sentinels 0→1700 `0x664D4D`, Prologue 0→2000 `0x00334D` | replaced per model, and graded |
| Fog, main menu (in no file) | Icecrown 0→7000 `0xB2B2CC`; Reign of Chaos 100→5500 `0x0B140B` | fitted |
| Additive layers and particles | drawn with fog **off** | faded to black, or never fogged |
| Blended particles | fogged, unless the emitter is flagged `Unfogged` | never fogged |
| `Unfogged` layer | fog off | ignored |
| Texture filter | bilinear, **POINT** mip filter, LOD bias **-0.5** | trilinear, no bias |
| Eye, target, near, far | the model's camera **exactly**, no dolly, pan or orbit | fitted per screen |
| Projection | **vertical FOV = 0.6 × the MDX field** (60→36°, 90→54°, 70→42°), x-scale = y-scale · 3/4 | fitted per screen |
| Colour grade | none | a CSS filter per screen |
| Particle counts | **0.45 ×** the viewer's rate on every steady emitter (809 / 1800 snow, 61 / 135 fog sheets, 27 / 60 clouds) | 1 × |

That table is the whole "noise": a flat 0.65 wash shows every texel at full contrast, where the real
scene is lit by inverse-square falloff from a few coloured points and sits in a fog that starts at the
eye. It is also why Icecrown's water is teal: the teal omni sits just above it. No texture blur is
involved, and the real client's bias makes its surfaces SHARPER than plain trilinear.

The path is `scene.ffp` (`FixedFunctionLights` in `render/menuScene.ts`, `sd.vert` in the viewer patch)
and `DistFog.honourFlags`. **Every glue scene is on it, and the per-model tuning table is gone.** Only
Sentinels and Prologue (plus both main menus) could be reached without unlocking anything, so the other
backdrops follow from the rules above and have not been compared to the real client themselves.

A MATCH is the same pipeline with other inputs, and is NOT on this path yet: `0x112`/`0x152` FVFs and no
shader, so units are lit per vertex, by DIRECTIONAL lights (diffuse 1.29, `D3DLIGHT9.Ambient` 0.17…0.29,
no `D3DRS_AMBIENT` there either), with linear fog from the map. Ours lights a unit per pixel.

Not settled:

* **Material.** `SetMaterial` passes a stack pointer the trace does not dereference, and reading it with
  a breakpoint did not work out. Emissive 0 is a fit (edge correlation 0.74 at 0, 0.61 at 0.3 on Icecrown)
  that also holds on the three other screens compared, not an observation.
* **Which lights.** Sentinels' `Omni01` and `Omni04` (intensity 6 and 7, no tracks) are never set by the
  real client, and nothing found explains it. We leave them on; the screen matches regardless.
* **Whether 0.45 is global.** It held on Icecrown's snow, fog sheets and clouds, and Prologue's rain is
  658 against 594, but Prologue's second-largest draw is 246 particles against our 33, and a match has not
  been compared at all. It contradicts `SETTING_PARTICLES_HIGH` (docs/video-options.md), so it is applied
  to glue emitters rather than to `PARTICLE_SCALE`.
* **The projection on another window.** All of it was read at 1920×1080.
* **Splashes.** The real client draws MORE splash particles at once (90 in one draw against our 48)
  and they read much dimmer, so the gap is not a count; our bursts can still saturate to white.

**Recipe.** `flatpak run --user --filesystem=home --env=WINEDEBUG=+d3d9 org.winehq.Wine "Warcraft
III.exe" -launch -windowmode windowed`, inside the private Xephyr, piped through `gzip`; `+d3d9,+d3d`
adds light and matrix VALUES at 30× the log (2 GB of gzip in 4½ minutes, still only about a minute to
the menu), so to walk the client through screens, filter the stream down to the latest frame instead of
storing it. A screen in play under the trace is still responsive enough to click. Take the frame between the last two `d3d9_device_Present`s. Attenuation is not in any trace
line: read the `D3DLIGHT9` the `SetLight` line points at with `winedbg --file <script> 0x<pid>`, from
a shell inside the SAME `flatpak run` (each run has its own wineserver). Offset 84 is Attenuation0;
attaching ends the game, so read everything in one attach.

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

**The MDX's 80→200 attenuation window lights nothing.** The real client's falloff is the constant in the
table above, on every model read so far.

The uniforms (`u_ffp*`, `u_dnc*`, `u_distFog*`, `u_boundary*`) are all added by
`patches/mdx-m3-viewer@5.12.0.patch`. Two traps live there, and both cost real time:

**After editing that patch, restart the dev server and delete `node_modules/.vite`** — Vite
pre-bundles the dependency, so a running server keeps serving the pre-patch copy and your
shader change will appear to do nothing at all.

**The shader source is a JS TEMPLATE LITERAL.** A backtick in a comment you add inside it ends
the string, and whatever follows lands in JS — a backslash there is an esbuild syntax error and
a dev server that starts and then serves nothing. So no backticks around `UI\MiscData.txt` or
around a constant's name, however much the rest of the codebase writes them that way; and
double any backslash you do keep, since the literal eats one. The failure looks like
`✘ [ERROR] Syntax error "\"` pointing at a COMMENT, which reads as impossible until you notice
what the file really is (issue #117).

## A map's distance fog

Laid on exactly as the map states it: a D3D trace of 1.30.4 on Bandit Ridge reads FOGTABLEMODE
linear, FOGSTART 2000, FOGEND 4000, FOGCOLOR 0x808080, which is its w3i and its `main()` to the
digit. There used to be a house `MAP_FOG_STRENGTH` of 0.65 here, because the haze looked too heavy.
It looked too heavy for a different reason: we open at distance 2400 (docs/camera.md) and the real
client at 1650, which has every piece of ground past that 2000 where the real client has almost
none. So `fogForZoom` scales the ramp with a PLAYER's zoom past 1650, holding each screen row on the
value it has at 1650. Grass at the top of the screen on Bandit Ridge: real (26,98,23); ours was
(48,108,46). A script's camera is not scaled, since its fog is composed for that shot.

Only Bandit Ridge has been compared against the real client for this. A map whose ramp starts inside
the view (a low start, or a dark clock like Extreme Candy War's) now gets more haze than the 0.65
gave it, and that has not been compared.

## A building placed but not yet begun

`UI\MiscData.txt` [Placement]: `PaidStructureColor` 96,128,128,255 and `UnpaidStructureColor`
96,255,128,128, ARGB. The model wears the whole row (see-through, team colour showing through as a
dim red on 1.30.4), and its foundation splat wears the colour at full alpha. That split is read off
the real client and no file states it. The price goes at the click there too (500 → 180 gold for two
Barracks before either had started), so a real queue only ever showed Paid.

## Water and shoreline

Read off `TerrainArt\Water.slk` and checked against 1.30.4 on Booty Bay:

* **`cells`** (2 on every row) is how many terrain cells one water frame covers. The stock viewer
  repeated the frame every cell, which laid a one-cell grid over the whole sea.
* **`texRate`** is frames per second, so `advanceWater(dt)` rolls by real time (real client: a ~3 s
  loop of 45 frames at 15). The stock `texRate / 60` per frame ran 2.4× fast on a 144 Hz screen.
* **`lighting`** 0 (the dungeon-like rows D, C, G) takes no day/night light.
* **The foam is not in the map.** `shoreDir` + `shoreSFile`/`shoreOCFile`/`shoreICFile` name
  particle-only models the engine lays along the coast itself, and
  [`render/shoreline.ts`](../src/render/shoreline.ts) does the same off the corners' water flags:
  two wet corners take the straight model, one the inside corner, three the outside corner, each
  centred on its cell. The rule is READ OFF THE MODELS (every emitter swims toward the land), since
  no file states it. `shoreInFog` 0 shows foam only on ground in sight.
* **The sea is fogged ONCE.** The water sheet writes no depth, and it dims itself by the fog mask
  (it has to: a cliff or ramp tile has no veil under it). The veil drawn LAST passed the depth
  test straight through the sheet and dimmed it again, so every water cell over ground was
  darkened twice and every one over a cliff once — hard rectangles of two brightnesses wherever
  the two alternate, which is the deep water along a map's border ((2)MysticIsles' south edge).
  So the cells where the sheet stands above the ground (`FogOverlay.waterCells`, the water
  shader's own `waterHeight + offset > height` test — the w3e water FLAG alone is set under dry
  land too) are veiled by `renderUnderWater` just BEFORE the water pass, and the last veil skips
  them.

## Fog of war: the fade and the tints

Both from 1.30.4 at 30 fps, driving the real client under Wine:

* **It fades.** The image keeps changing for a second after a Peasant stops, and the slow part of an
  `iseedeadpeople` reveal is a straight line one second long. So the vision map is still sampled at
  10 Hz, and `FogOverlay.fade` moves what is DRAWN toward it at black-to-clear in one second
  (`FOG_FADE_PER_MS`), re-uploading at most every 33 ms and not at all once settled. Widgets step at
  the same rate (`fadeWidgets`). Largest single step while a unit walks: 0.16 before, 0.033 after.
  It reads the world's `dt`, so a pause holds the fog. Sight itself is unaffected: gameplay and the
  unit-hiding gate still read the hard `vision.stateAt`.
* **Remembered ground is `FoggedTerrain`** 170,16,16,32 rather than black at 0.5: land (20,71,22)
  lit is (12,31,26) under it, its blue going UP. `cliffs.frag` blends to the same tint, or each
  cliff and ramp tile is plain dark green beside blue-grey ground, with a hard line at every cell.
  Water only multiplies by the same 1/3, which is what it measures on the real client. A remembered building or tree is `FoggedObject` 64,64,96, not a flat half.
