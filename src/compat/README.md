# `src/compat/` — reading maps saved by a later editor

This directory is a **compatibility layer**, and the whole of its value is that the standard
build does not learn about it. Read [`docs/map-compatibility.md`](../../docs/map-compatibility.md)
first; this file is the contract.

OpenWar3 plays **TFT 1.30.4** and that does not change — every number, table and asset comes out
of a 1.30.4 install, and the gate in [`src/vfs/version.ts`](../vfs/version.ts) still says so. What
lives here is about the other half: a **map file** a player downloaded, which a 1.31 / 1.36 /
Reforged 2.0 World Editor wrote with fields the 2003 formats did not have.

## The contract

1. **Every branch is `if (version >= N) { …new… } else { …exactly what it does today… }`.** A
   v18 or v25 w3i, a v11 w3e, a v2 object file must take byte-for-byte the current path. The
   regression evidence is the install's own 210 maps: `node tools/map-compat.cjs --check`.
2. **The format is asked ONCE, at the map door**, into a `MapFormatProfile` (`mapFormat.ts`).
   Nothing deeper re-derives it, and nothing in the sim, the renderer, the AI or the data tables
   ever asks "is this a Reforged map".
3. **Nothing outside this directory imports from it except at named seams** — the map loaders in
   `src/world/`, and the map row in `src/ui/mapBrowser.ts`. `src/compat/` may import from
   `src/world`, `src/data`, `src/jass` and `src/vfs`; the traffic is one-way. This is the rule
   [`src/ai/plus/`](../ai/plus/) lives under and for the same reason: a thing that must stay
   removable has to stay separable.
4. **Format knowledge for a file mdx-m3-viewer parses ITSELF lives in the viewer patch**, not
   here — `war3map.w3e` (terrain) and `war3map.w3u` (object data) are read by the renderer as
   well as by us, and a second reader would be a second, disagreeing answer. The patch hunks say
   so where they sit.

## What is NOT here

A Reforged **mode**. We draw SD art out of an SD install: the HD object set a Reforged map ships
(`war3mapSkin.w3u` and friends) is ignored on purpose, `solverParams.reforged` stays false, and a
map's `supportedModes` is read and not acted on.
