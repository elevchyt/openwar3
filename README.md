# OpenWar3

A browser-first, asset-compatible re-creation of the Warcraft III engine, in **TypeScript**.
Targets **TFT 1.27a**. Ships **zero Blizzard assets** — you supply your own legally-owned game
files, and it's fully playable on placeholder primitives with no assets at all.

See [`OpenWar3_PLAN.md`](./OpenWar3_PLAN.md) for the full plan.

## Status

**Phase 0 — scaffold.** Vite + TypeScript app with a placeholder WebGL renderer (spinning
primitive, no assets) behind a swappable renderer interface, an asset resolver with the
`install → CC0 → primitive` fallback chain, an OPFS import skeleton, and the main-menu shell.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + static build to dist/
```

## Legal

OpenWar3 is original code containing zero copyrighted assets. Assets are read only from your own
local install, client-side, and are never uploaded or hosted. The engine is fully open.
