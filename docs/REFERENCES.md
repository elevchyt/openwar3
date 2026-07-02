# Reference projects & research sources

Open-source projects we lean on (see plan §3 for roles). **Rule of thumb: treat references as
hypotheses — verify format/behavior claims against the real 1.27a MPQs in `Warcraft III/` before
building on them** (the cliff-ramp naming scheme is the cautionary tale: HiveWE's code was
incomplete; the MPQ file list settled it).

| Project | What we use it for | Notes / gotchas |
|---|---|---|
| [mdx-m3-viewer](https://github.com/flowtsohg/mdx-m3-viewer) | Rendering + all WC3 parsers (our base, patched via `patches/`) | No ramps, no tileset cliff/tree textures, MPQ header search bug — all fixed in our patch |
| [HiveWE](https://github.com/stijnherfst/HiveWE) | Terrain/cliff/ramp/pathing reference (`src/base/terrain.ixx`) | Best ramp reference, but misses 2-layer (X/H) ramps and hardcodes the CliffTrans dir — cross-check with MPQ data |
| [Warsmash](https://github.com/Retera/WarsmashModEngine) | Behavioral reference for sim, orders, JASS natives | Java; ≥1 GPL dep — study, don't lift |
| [war3-model](https://github.com/4eb0da/war3-model) | Alternative TS MDX parser/renderer | Oracle for MDX parsing diffs |
| [w3x-parser](https://github.com/voces/w3x-spec) | `.w3m/.w3x` format reference | |
| [StormLib](https://github.com/ladislav-zezula/StormLib) / [CascLib](https://github.com/ladislav-zezula/CascLib) | MPQ/CASC correctness reference | CASC only matters for §9 |
| [Nowar-Sans-War3](https://github.com/nowar-fonts/Nowar-Sans-War3) | Multi-language game font (Friz Quadrata replacement), OFL 1.1 | Bundled at `public/fonts/NowarSans.ttf` |

## Researching game mechanics

For gameplay semantics that aren't in any file format (turn rate, damage timing, acquisition,
upkeep, …), **search Hive Workshop threads first** — the modding community has empirically reverse-
engineered most mechanics. Example: turn rate semantics came from
[How does Turn Rate work? (thread 129619)](https://www.hiveworkshop.com/threads/how-does-turn-rate-work.129619/)
— the object-editor value is radians per 0.03 s internal frame, capped at ~0.2 rad/frame.

Practical notes:
- hiveworkshop.com blocks direct fetching (403) — go through a web search engine and read cached
  summaries, or search for the thread title.
- Warsmash's source is the next stop: it encodes many of these findings as code.
- When a mechanic matters for gameplay feel, write the source (thread/repo) next to the constant in
  the code.
