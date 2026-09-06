# Video Options — what each row of the panel actually does

Read this before touching `src/render/videoQuality.ts`, the Video panel, or anything that wants
to be cheaper on a weak machine. The screen itself is the game's own
`UI\FrameDef\Glue\OptionsMenu.fdf` and is mounted by `src/ui/fdfOptions.ts`; the settings are
stored by `src/data/options.ts` like every other option, and applied by
[`src/render/videoQuality.ts`](../src/render/videoQuality.ts).

The panel existed long before any of it did anything: every row was bound, remembered and
persisted, and `applied: false` said so. This document is about the half that now has a backend
and, just as importantly, the half that does not and why.

## The panel is not ours to design

Three things about the shipped 1.30.4 file decide the shape of this feature.

**The labels are per-row.** Each dropdown names its own MenuItems — `LOW_MODELS` / `MEDIUM_MODELS`
/ `HIGH_MODELS`, then `LOW_ANIM…`, `LOW_TEXTURES…`, `LOW_PARTICLES…`, `LOW_LIGHTS…` — and
GlobalStrings.fdf gives all fifteen of them the same three words. There is **no generic
`LOW`/`MEDIUM`/`HIGH` key in GlobalStrings at all**, which is why a shared label table left every
video dropdown displaying its own raw key in capitals.

**"Shadows" is `COLON_SHADOWS` = "Unit Shadows:".** It is the shadows that belong to MODELS. The
baked `war3map.shd` layer is not one of them — it is part of how the ground looks
(`docs/lighting.md`) — and stays on at every setting.

**There is no Spell Detail row.** The whole `SpellFilterBackdrop` / `SpellFilterMenu` block is
commented out in the shipped FDF, so the game has no such control. The option that used to sit
in `OPTION_DEFS` for it was bound to a frame that has never existed.

## What each row does here

| Row | Backend |
|---|---|
| **Gamma** | An SVG `feComponentTransfer type="gamma"` over `#map`. Installed only off the middle. |
| **Model Detail** | *Nothing* — see below. |
| **Animation Quality** | Strides the map's widget stand-scan (1 / 2 / 4 frames). |
| **Texture Quality** | Drops 0 / 1 / 2 mip levels off the top of every BLP as it uploads. |
| **Particles** | Scales emission ×1 / ×0.5 / ×0.25 on top of the viewer's `SETTING_PARTICLES_HIGH`. |
| **Lights** | Caps the glue scene's uploaded omni lights at 8 / 4 / 0. |
| **Unit Shadows** | Skips the unit and building shadow passes (and the batch rebuild that feeds them). |
| **Occlusion** | *Nothing* — see below. |

**Only ONE of these numbers is the game's**, and it is worth knowing which. mdx-m3-viewer's
`geometryemitterfuncs.js` records the observation in its own source — *"The game scales the
emission rate of particle emitters depending on the particles setting. High seems to double the
emission"* — and ships `SETTING_PARTICLES_HIGH = 2`, which every emitter object multiplies its
authored rate by. So **the rate written into an MDX is Warcraft III's Medium**, and High is twice
it. We leave that 2 where it is and scale it, which makes our High exactly what OpenWar3 has
always drawn and our Medium the game's own middle rung. Every other rung in the file is OURS and
says so at its definition. Nothing in the install describes what a quality setting does — these
were engine settings, not data — so there is nothing to check them against.

## The two rows with no backend, and why they stay that way

**Model Detail.** WC3's rungs chose between models of different complexity. An MDX carries one
mesh; there is no LOD to fall back to and nothing in the install ships a low-detail twin. The
tempting substitute — thinning the map's doodads — changes what a map *looks like* rather than
what it costs to draw, which is not what the row says, so it is left unapplied.

**Occlusion.** This is the x-ray silhouette a unit shows through a cliff or a tree — the exact
thing `EnableOcclusion` switches off for a cinematic (`src/jass/natives/cinematic.ts`, where the
native is a no-op for the same reason). We do not draw it, so there is nothing to switch.

## Two traps

**A terrain tileset is an ATLAS, so it must keep its mips.** An "extended" tileset is four
variations side by side in one image — that is exactly what the ground shader's `u_extended`
test (`width > height`) is asking about. An atlas has no padding between its cells, so every mip
level down blends further across their borders; promoting a coarse level to level 0 painted a
**dark seam around every terrain tile on the map**. Wide images are therefore exempt from the
drop. Nothing is lost by it: the memory is in the hundreds of unit and doodad skins, and those
are square.

**Animation Quality cannot touch the skeletons, and that is not an oversight.** The expensive
half of animating a model is the node walk and the per-instance bone-texture upload — and the sim
moves a unit by writing its position onto the instance, with the bone matrices carrying that to
the screen. An instance whose animation is skipped is an instance that **stops moving**. So what
is strided is the part that is pure idle bookkeeping: `map.update()`'s walk over every doodad and
every map-placed unit (3 300 trees on Twisted Meadows) asking whether a stand clip has run out.
The water roll in that same call is stepped by hand on the frames the scan skips, or the sea runs
at a quarter speed on Low.

## Where the settings reach the vendored viewer

Texture Quality and Particles are both read from inside mdx-m3-viewer, which is JavaScript we do
not own and cannot import our modules into. They travel on one global, `__OW3_VIDEO__`, whose
shape is `VideoBridge` in `videoQuality.ts`; the two hunks that read it live in
`patches/mdx-m3-viewer@5.12.0.patch` (`viewer/handlers/blp/texture.js` and
`viewer/handlers/mdx/particleemitter2.js`) and name it. After editing that patch, restart the dev
server and delete `node_modules/.vite`, or Vite serves the pre-patch bundle (CLAUDE.md).

**When each takes effect.** Particles, Unit Shadows, Lights, Animation Quality and Gamma are live
— the Options screen applies the working copy on every change, so the scene behind the panel
follows the dropdown. **Texture Quality is read as a texture uploads**, so it reaches the next
map rather than the one on screen.

## Verifying a change

`tools/sim-options-test.cjs` (run by `pnpm sim:test`) pins the applier: every rung's number,
including that an unknown value from an older or hand-edited store falls back to the default
rather than putting a junk string into a ladder. Everything else here is visible, so screenshot
it — `?dev&map=EchoIsles&ai=easy` with the options seeded into `localStorage` before the boot
navigation is the whole test.
