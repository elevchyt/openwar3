# OpenWar3

A browser-first, asset-compatible re-creation of the Warcraft III engine, in **TypeScript**.
Targets **TFT 1.27a**. Ships **zero Blizzard assets** — you supply your own legally-owned game
files, and it's fully playable on placeholder primitives with no assets at all.

See [`OpenWar3_PLAN.md`](./OpenWar3_PLAN.md) for the full plan.

## Status

**Phase 3 — models & animation.** Real animated MDX (v800) units render via mdx-m3-viewer's
renderer with team color; play idle/walk/etc. by sequence. Terrain from Phase 2 still flies.

- **Phase 0** — Vite + TS scaffold, swappable renderer interface, asset resolver
  (`install → CC0 → primitive`), OPFS import skeleton, main-menu shell.
- **Phase 1** — layered MPQ v1 VFS (mdx-m3-viewer parser) + content profiles (TFT/RoC);
  import a Warcraft III folder and enumerate/extract any file by path.
- **Phase 2** — `war3map.w3e` terrain parse + mesh, BLP1 decode, `war3map.doo` doodads,
  RTS fly camera (WASD / drag / wheel).
- **Phase 3** — animated MDX unit rendering on a dedicated canvas.
  *(Terrain and models are separate scenes for now; unified in a later phase.)*

## Develop

```bash
pnpm install
pnpm dev           # http://localhost:5173
pnpm build         # typecheck + static build to dist/
```

## Testing manually

No assets are bundled, so you import your own install at runtime. Use **Chrome or Edge**
(the folder picker needs the File System Access API; Firefox/Safari fall back to a file input).

1. `pnpm dev` and open http://localhost:5173. You'll see **placeholder terrain** — fly it:
   **WASD** pan, **drag** rotate, **wheel** zoom.
2. **Import assets:** click the status line at the bottom of the menu and select your
   `Warcraft III` folder (the 1.27a install). It mounts the MPQs; the status shows the
   archives and file count.
3. **Real map:** click **Single Player** and pick a map (`.w3x`/`.w3m`, e.g. from
   `Warcraft III/Maps/…`). With an install imported it renders **authentically**
   (terrain textures, cliffs, water, doodads/units as models) via mdx-m3-viewer's map
   renderer — assets stream in over a second or two. **Drag** rotate, **wheel** zoom,
   **WASD** pan. Without an install you get the placeholder terrain instead.
4. **Animated models (Phase 3):** open the browser devtools console and run:
   ```js
   const models = openwar3.listModels();        // enumerable unit .mdx paths
   const seqs = await openwar3.viewModel(models[0]);  // render + play idle/walk
   seqs;                                          // [{index, name}, …] available animations
   openwar3.setSequence(2);                       // switch animation by index
   openwar3.showTerrain();                        // back to the terrain scene
   ```
   Pass a path from `listModels()` directly (avoids escaping backslashes). A known-good
   one: `openwar3.viewModel("Units\\Creeps\\Archnathid\\Archnathid.mdx")`.

## Legal

OpenWar3 is original code containing zero copyrighted assets. Assets are read only from your own
local install, client-side, and are never uploaded or hosted. The engine is fully open.
