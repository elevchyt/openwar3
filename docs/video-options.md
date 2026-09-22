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
in `OPTION_DEFS` for it was bound to a frame that has never existed. (The IN-GAME panel does
carry a `SpellFilterValue` — see below — but as a READOUT, not a control.)

## What each row does here

| Row | Backend |
|---|---|
| **Gamma** | An SVG `feComponentTransfer type="gamma"` over `#map`. Installed only off the middle. |
| **Resolution** | The size of the buffer the world is drawn into. |
| **Low Performance Mode** | Ours. One switch: every row below it at its cheapest rung. |
| **Model Detail** | *Nothing* — see below. |
| **Animation Quality** | Strides the map's widget stand-scan (1 / 2 / 4 frames). |
| **Texture Quality** | Drops 0 / 1 / 2 mip levels off the top of every BLP as it uploads. |
| **Particles** | Scales emission ×1 / ×0.5 / ×0.25 on top of the viewer's `SETTING_PARTICLES_HIGH`. |
| **Lights** | Caps the glue scene's uploaded omni lights at 8 / 4 / 0. |
| **Unit Shadows** | Skips the unit and building shadow passes (and the batch rebuild that feeds them). |
| **Occlusion** | *Nothing* — see below. |
| **Vertical Sync** | Ours. A Chromium launch switch in the desktop app — see the last section. |

## The in-game twin, and its five read-only rows

F10 → Options → Video is the same settings over a second, smaller panel — the game's own
`UI\FrameDef\UI\EscMenuOptionsPanel.fdf`, mounted by [`src/ui/escOptions.ts`](../src/ui/escOptions.ts)
as four more faces of the Esc menu's stack. There is one model and one store behind both
screens: every row there is an `OPTION_DEFS` row, bound through the same table (`escFrame` names
the few frames the two files spell differently — the in-game pulldowns are
`EscOptionsParticlesMenu` and friends).

What the in-game panel offers is deliberately SMALLER, and the shape is the game's, not ours.
Only the Gamma slider and the four pulldowns (Particles, Lights, Unit Shadows, Occlusion) are
controls; **Resolution, Model Detail, Animation Quality, Texture Quality and Spell Detail are
read-only values** — `ResolutionValue`, `ModelDetailValue` and so on are `TEXT` frames in the
file, with no pulldown anywhere near them. In 2003 that was because changing any of them meant
resetting the D3D device mid-match. We print the live value into each of them and leave the
pulldowns on the glue screen, because the file says which rows this panel gets to be.

## Resolution is the one that changes how many pixels are drawn

Every other rung on the panel takes work off the CPU or off the vertex path. This one divides
the **fill**: the ground, the water, the fog veil, the weather, and every translucent pass over
the world. 1280×720 is 2.25× fewer pixels than 1080p and 800×450 is 5.8× fewer. On a machine
whose GPU is the bottleneck it is the largest single thing on this screen.

It costs no framing at all, which is why it can be a plain number rather than a compromise. The
buffer is scaled into the stage by CSS, so the camera sees exactly the same world at 800×450 as
at 1440p — and the HUD is DOM, so it is not in this buffer
and stays sharp at every rung. `GAME_WIDTH`/`GAME_HEIGHT` in `ui/stage.ts` remain the LOGICAL
frame; this is only how many pixels are drawn into it.

**Every rung is NAMED at 16:9, and what it fixes is the HEIGHT.** This is the one list WC3 built
at runtime rather than writing into the FDF — the `MENU` frame under `ResolutionMenu` is empty in
the file, because the game enumerated the display modes the hardware offered. A browser has no
display modes, so the analogue is the ladder of buffer sizes. The stage takes the window's aspect
between 4:3 and 16:9 (`ui/stage.ts`, issue #151) — never wider, because a wider box quietly hands
the player more map than the real game gives — and the buffer has to take the same aspect or the
world is drawn stretched. So `renderSize` keeps the rung's height and takes the stage's width:
"1920 x 1080" is 1920×1080 on a 16:9 screen, 1728×1080 on 16:10 and 1440×1080 on 4:3 (and on
5:4, whose stage is held at 4:3 and letterboxed). The lens is vertical, so the height is the
dimension that decides how sharp the world is. The test asserts both: that every rung is named
at exactly 16:9, and what each window shape draws.

The glue screens take the same setting as a FACTOR rather than a pair of numbers: that canvas is
the whole window at whatever shape the window is, not a game frame, so what carries over is the
ratio to 1080p. The default rung is 1 and changes nothing anywhere.

**What it is worth, measured both ways, because the answer is entirely about what the frame is
short of.** On a frame that is FILL-bound — the camera on empty ground, the match paused, 13
instances on screen, so what is left is the terrain, the water, the veil and the weather:

| | ms/frame | |
|---|---|---|
| 1920×1080 | 6.79 | |
| 1280×720 | 4.57 | −33 % |
| 800×450 | 3.14 | −54 % |

On a frame that is CPU-bound — the same map with an army of 180 standing on it, 263 instances —
the same three rungs give 21.5, 19.9 and 19.0 ms. Barely anything. Both numbers are true and the
pair of them is the point: this setting divides the pixels and nothing else, so it is worth half
the frame to a machine whose GPU is the bottleneck and nearly nothing to one whose CPU is.

**Only ONE of these numbers is the game's**, and it is worth knowing which. mdx-m3-viewer's
`geometryemitterfuncs.js` records the observation in its own source — *"The game scales the
emission rate of particle emitters depending on the particles setting. High seems to double the
emission"* — and ships `SETTING_PARTICLES_HIGH = 2`, which every emitter object multiplies its
authored rate by. So **the rate written into an MDX is Warcraft III's Medium**, and High is twice
it. We leave that 2 where it is and scale it, which makes our High exactly what OpenWar3 has
always drawn and our Medium the game's own middle rung. Every other rung in the file is OURS and
says so at its definition. Nothing in the install describes what a quality setting does — these
were engine settings, not data — so there is nothing to check them against.

## Low Performance Mode (issue #161)

The row directly under Resolution, and the only one on this panel that is about the other rows.
It is **ours** — the 2003 panel is nine independent settings and has nothing that says "all of
it, as cheap as it goes" — and a machine that needs it should not have to find seven dropdowns
and know which way each one is cheaper.

### The shared pose cache — what the mode is actually for

The rungs below are the small half of this mode. The large half is one change that has no row on
the panel at all, and it comes straight off the profile: at 257 units and 6× CPU throttle the
frame's biggest phase is `anim` (45 ms of 93), and inside it the **MDX node walk is ~41% of all
CPU** — `recalculateTransformation`, `updateNodes` and the gl-matrix calls they make — against
**~7% for the drawing** (`render` plus every GL call). Skinning is already on the GPU via the bone
texture. What costs is sampling every node's tracks and composing its matrices, in JavaScript,
per instance, per frame.

And it is mostly the same answer. Probed in a real match, **317 visible instances were holding 60
distinct** `(model, sequence, ~33 ms frame)` **poses** — 34 Footmen in one bucket — because an RTS
draws crowds of one unit doing one thing. So the pose is sampled once per bucket and replayed:
the fog cache's lesson (`SightStamps`, src/sim/vision.ts) in a second place.

**What is shared is the LOCAL pose, not the bone matrices.** A bone matrix here is world-space
(`worldMatrix = parent.worldMatrix * localMatrix`, and the root's parent is the instance), so two
units standing apart can never share one. What is shareable is the per-node translation/rotation/
scale the tracks are sampled into; every instance still composes its own world matrices, which is
why billboarding, per-instance scale, emitters, attachments and click collision are all untouched.

Two things make it work, both in `viewer/handlers/mdx/modelinstance.js` in the patch:

- **`forced` means two different things** and they had to be told apart. A sequence change must
  rewrite every node's locals, including the ones the new clip says nothing about. A MOVE —
  `recalculateTransformation` on the instance, which the sim does to every walking unit every
  frame — forces the node walk for a reason that has nothing to do with the tracks: the world
  matrices hang off the instance's, so they must be recomposed while the local pose is untouched.
  Without that split nothing shares, because *the units worth sharing are the ones that are
  moving*. `ow3PoseReset` is the first kind.
- **Entries outlive the frame**, because a walk cycle loops: after one lap every bucket of it is
  already sampled and a crowd samples nothing at all.

The cost is **animation time quantized to 30 Hz** — clips step at the bucket rate — which is the
trade this mode exists to make, and why it is off at full quality. A model whose TRS tracks are
driven by a GLOBAL SEQUENCE is excluded: those are sampled against the instance's own elapsed-time
counter, so two instances genuinely differ and no key on (sequence, frame) can say so.

Measured, same scene, interleaved: **38.9 → 34.2 ms** median, **−12%**, where the rungs alone had
been worth −2%.

What is still on the table is the other half of that 41%: the per-instance world compose
(`recalculateTransformation` + `fromRotationTranslationScaleOrigin` + `multiply4` ≈ 22% of CPU).
It needs the bone matrices to become INSTANCE-LOCAL, with the instance's own matrix applied in the
vertex shader — and then a bucket's composed matrices are shareable too, and a pose can be strided
for distant units without the unit's body lagging behind its position. That is the next step, and
it is a bigger surface: everything that reads a node's world matrix (emitters, attachments,
`src/render/modelCollision.ts`'s click ray) would have to apply the instance matrix too.

### The rungs

What it forces is `LOW_PERF_FORCED` in [`src/render/videoQuality.ts`](../src/render/videoQuality.ts):

| Row | Forced to |
|---|---|
| Model Detail | Low *(no backend — see below)* |
| Animation Quality | Low (widget scan strided 4) |
| Texture Quality | Low (2 mips dropped; reaches the NEXT map) |
| Particles | Low (×0.25) |
| Lights | Low (no omni lights) |
| Unit Shadows | Off |
| Occlusion | Off *(no backend)* |

**Two rows are deliberately not in that table.** **Resolution** is the one rung that changes how
many pixels are drawn, and so the one a weak GPU cares most about — which is exactly why it stays
the player's: how sharp the world is against how smooth it runs is the trade only they can make,
and issue #161 asks for it in as many words. **Gamma** is the brightness of the picture rather
than a cheaper drawing of the same one; a full-screen filter pass is not free, but a player on a
dim panel needs it wherever they set it.

**It is forced at APPLY time and never written to the store.** `applyVideoOptions` lays the table
over the options it is handed; the player's own seven values sit untouched in localStorage, so
unticking the box gives every one of them back with nothing having to be remembered. That is also
why `VideoSettings` carries `lowPerf` beside the rungs it forces: the mode is a fact of its own,
not something to infer from a rung the player might equally have chosen by hand.

**Both screens grey the rows it owns AND show the rung it puts them at.** Half of that rule is not
enough: a live dropdown over a setting the applier overrides is a control that does nothing, and a
dead one still reading "High" while the renderer draws Low is the panel lying about the game. The
forced label is painted onto the WIDGET only — the working copy keeps the player's value. On the
in-game panel the same applies to its four pulldowns, and its three read-only rows (Model Detail,
Animation Quality, Texture Quality) print the forced rung for the same reason: a readout says what
the renderer is doing.

The row is on the **in-game panel** too, where it closes the panel rather than sitting under
Resolution — that file's Video panel puts its pulldowns first and its read-only values after, so
"under Resolution" there would drop a live control into a block of readouts. It has to be
reachable there at all because the two panels are one store: a mode turned on from the menus would
otherwise be unreachable until the match ended.

**Launch flag.** `?lowperf` turns it on for the session, applied inside `loadOptions` so that the
boot applier, the glue screen and the F10 panel all agree. The box then shows ticked, which is
true, and OK persists it like any other choice. Not DEV-gated, unlike `?dev`: this one is for the
machine that needs it.

**Where the row sits, and what it cost to put there.** The shipped 1.30.4 file has a checkbox row
commented out in exactly this slot — `FixedAspectRatioCheckboxLabel` / `FixedAspectRatioCheckBox`,
"Disabled for 1.29, needs some work" — and left behind both its anchors and the two re-anchorings
Model Detail wears when a row stands between it and Resolution. What is ours is the arrangement
(box then label, like the panel's other four checkbox rows) and the SPACING: the game paid 0.0105
for this insertion, and at that price the panel overran, because this panel carries a row the 2003
one never did ("Vertical Sync") and the last row landed on the frame's bottom rail. The box tucks
into the 0.042 of empty label column the pulldowns' own chrome already leaves, the row costs
**0.005**, and both of this panel's checkbox rows tuck **0.0115** under their labels so the last
row lands where it always did. Measured in the running screen at 16:9 and at 4:3.

**What it is worth, measured.** Echo Isles, 6× CPU throttle in headless Chrome, interleaved
off/on/off/on, median frame time:

| Scene | Off | On | |
|---|---|---|---|
| Early game, 110 units — rungs only | 7.7 / 7.7 ms | 7.0 / 7.5 ms | −3…9 % |
| An army standing on it, 259 units — rungs only | 40.1 / 40.0 ms | 39.2 / 39.3 ms | −2 % |
| …the same army, with the shared pose cache | 38.8 / 39.0 ms | 34.1 / 34.3 ms | −12 % |

The first two rows are the panel's own rungs, and they are worth a few per cent: most of them are
idle bookkeeping and one shadow pass, and the texture rung does not reach a map that is already
loaded. The 259-unit row says it sharply — with the CPU throttled 6×, taking the unit and building
shadow passes away is worth under a millisecond of a 40 ms frame, so that is not where a weak
machine's time goes. The third row is the pose cache, and it is where this mode's value is. **The substance of issue #161 is still the renderer work behind the flag**
— particles and ribbons off rather than quartered, the fog overlay and the baked shadow layer
taking terrain-cull's runs (docs/terrain-culling.md), skinning off the main thread, single-pass
terrain, batching by texture — each of which the issue gates on its own Step 0 profile. The flag
is where they land; `VideoSettings.lowPerf` is what they ask.

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

## Vertical Sync, and the 300 fps cap (desktop app only)

The panel's last row, **"Vertical Sync"**, is OURS: 1.30.4's panel has no frame-rate or vsync
row. It is **on by default**. In the desktop app it is a Chromium LAUNCH switch
(`disable-gpu-vsync` + `disable-frame-rate-limit` in `electron/main.mjs`), so the choice is kept
by the SHELL, in its own `settings.json`, which is read before the window exists — the page's
localStorage is read far too late for it. The Options screen asks the shell for the saved choice
when it mounts (it wins over localStorage). On OK with the box changed it saves the choice to the
shell first and then asks `VSYNC_RESTART` in the menus' own Yes/No box: **Yes relaunches the
game** (`ow3:relaunch`), No keeps the choice for the next launch. A browser tab keeps the
browser's own vsync and no page can turn it off, so there the box is shown ticked and greyed.

**Why not live.** Nothing in Electron changes vsync on a running window: `setFrameRate` is for
offscreen rendering only, `commandLine.removeSwitch` does not reach a GPU process that is already
running, and restarting the GPU process to re-read its flags loses every WebGL context the game
holds. A live "vsync" that capped the page at the display's refresh rate was rejected: it matches
the rate but not the phase of the refresh, so it judders, and on by default it would have been
what every player got. The relaunch is safe because Options is only reachable from the menus. An
AppImage relaunches `APPIMAGE` rather than `execPath`, which sits inside its own squashfs mount.

Why a player would turn it off: a vsynced page is at least a refresh behind the hardware pointer.
With it off the page caps itself at **300 fps**, and that number is OURS.

Chromium has no "uncapped, but no faster than N" switch, so [`src/render/frameCap.ts`](../src/render/frameCap.ts)
patches `requestAnimationFrame` itself. That way every loop and poll in the page sees a 300 Hz
display, with no call site that has to remember the cap. The trap in it cost a run: with the
limit off, **a real frame that draws nothing is followed by a ~16 ms pause**. A cap that polled
real frames until one was due therefore held a match at ~110 fps. The cap sleeps on a timer
instead, and every real frame it asks for runs the batch. Measured on Echo Isles in a
1280×720 window: 144 fps with vsync on, ~530 uncapped, 301 capped.

The reticle and the tinted hover hand are real `cursor:` images for the same reason
(`overlayCursor` in `mapViewer.ts`). A DOM element moved to the pointer trails it by a frame or
two at any frame rate. The pulse is 8 baked frames stepped on the wall clock, and Chromium re-reads
a changed `cursor:` without the mouse moving.

The CARRIED ITEM is the exception, on purpose: it is DOM again (`updateCarriedItem` /
`placeCarriedItem`, moved on pointermove as well as on the frame). As one composed cursor image it
did not trail, but every right-click on an item built a fresh canvas plus its dozen edge crops and
wrote them into a custom property on `<body>` — a whole-document style recalc — and the pick-up
hitched visibly. The reticle and the hand are baked once and reused, so they do not pay that.

Chromium refuses any cursor over 32 px whose rect reaches outside the viewport and moves to the
next list entry, and the bottom inventory row sits ~5 px off the bottom edge. So
`cursorImageValue` lists EDGE CROPS between the image and its ≤32 px twin, 8 px apart per side.
Near an edge the cursor looks clipped rather than shrinking (63×53 → 45 → 37 → 29 approaching
the bottom). To measure it, use Electron's `cursor-changed` in a **frameless** window: a framed
test window on this desktop hides ~25 px of the page that `innerHeight` still counts, and every
edge reading comes out wrong by exactly that.

## Verifying a change

`tools/sim-options-test.cjs` (run by `pnpm sim:test`) pins the applier: every rung's number,
including that an unknown value from an older or hand-edited store falls back to the default
rather than putting a junk string into a ladder — and, for Low Performance Mode, that it forces
every row in its table, leaves resolution and gamma alone, does not touch the options it is handed
(so unticking restores them), and names only keys the Video panel has with values those rows
actually offer. Everything else here is visible, so screenshot
it — `?dev&map=EchoIsles&ai=easy` with the options seeded into `localStorage` before the boot
navigation is the whole test.
