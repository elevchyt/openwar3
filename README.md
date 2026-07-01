# OpenWar3

A browser-first, asset-compatible re-creation of the Warcraft III engine, in **TypeScript**.
Targets **TFT 1.27a**. Ships **zero Blizzard assets** — you supply your own legally-owned game
files, and it's fully playable on placeholder primitives with no assets at all.

See [`OpenWar3_PLAN.md`](./OpenWar3_PLAN.md) for the full plan.

## Status

**Phase 2 — textures & terrain.** Fly-camera view (WASD / drag / wheel) of a heightmap
terrain — procedural placeholder with zero assets, or a real `.w3x` via **Single Player**.
Cliffs render as height steps; doodads as placeholder boxes.

- **Phase 0** — Vite + TS scaffold, swappable renderer interface, asset resolver
  (`install → CC0 → primitive`), OPFS import skeleton, main-menu shell.
- **Phase 1** — layered MPQ v1 VFS (mdx-m3-viewer parser) + content profiles (TFT/RoC);
  import a Warcraft III folder and enumerate/extract any file by path.
- **Phase 2** — `war3map.w3e` terrain parse + mesh, BLP1 decode, `war3map.doo` doodads,
  RTS fly camera. *(Authentic tile-texture blending and cliff models come with Phase 3.)*

## Develop

```bash
pnpm install
pnpm dev           # http://localhost:5173
pnpm build         # typecheck + static build to dist/
```

## Legal

OpenWar3 is original code containing zero copyrighted assets. Assets are read only from your own
local install, client-side, and are never uploaded or hosted. The engine is fully open.
