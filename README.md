# OpenWar3

A browser-first, asset-compatible re-creation of the Warcraft III engine, in **TypeScript**.
Targets **TFT 1.27a**. Ships **zero Blizzard assets** — you supply your own legally-owned game
files, and it's fully playable on placeholder primitives with no assets at all.

See [`OpenWar3_PLAN.md`](./OpenWar3_PLAN.md) for the full plan.

## Status

**Playable melee prototype.** Pick a race, spawn on a real map, gather gold/lumber, build a base,
train an army, level a hero, and fight — all driven by the real 1.27a game data. The engine is a
**headless, deterministic simulation** (`src/sim/`) that the mdx-m3-viewer renderer only displays.

Implemented across the core engine:

- **Foundations** — Vite + TS scaffold, swappable renderer interface, asset resolver
  (`install → CC0 → primitive`), OPFS import, faithful asset-driven main menu.
- **VFS** — layered MPQ v1 (mdx-m3-viewer parser) + content profiles (TFT/RoC); any file by path.
- **World** — `war3map.w3e` terrain mesh, BLP1 decode, cliffs/ramps/water, doodads, destructibles,
  the authentic map renderer, and a pathing grid from `war3map.wpm`.
- **Data registries** — units, abilities, races, tech tree, sourced from the real SLK/INI tables
  (stats, models, icons, tooltips, sounds, per-level ability data).
- **Simulation** — movement + A\* pathfinding + cell-reservation collision (surrounds), turn rates,
  auto-acquisition, projectiles, the WC3 armor/damage model, day/night, gold/lumber harvesting,
  construction (with speed-build), training queues, rally points, shift-order queues, control groups.
- **Abilities & spells** — a modular, data-driven cast engine dispatched on each ability's base
  `code` (so custom-map abilities that copy a standard one work), a buff/effect system (stun, slow,
  auras, HoT/DoT, invuln, stat bonuses), unit + point + no-target casts, autocast, and a
  representative spell set (Holy Light, Storm Bolt, Thunder Clap, Death Coil, Dispel, Heal, auras,
  Divine Shield, Avatar, Resurrection, Water Elemental, …).
- **Heroes** — XP from kills (authentic thresholds), leveling with attribute growth, skill points,
  a learn-skill UI, and ultimates gated to level 6.
- **Corpses** — persistent, decaying, targetable (Resurrection today; Raise Dead/Cannibalize later).
- **HUD** — asset-driven console (minimap, portrait, info panel, inventory, command card),
  selection + control groups, hero XP bar, cooldown sweeps, resource/upkeep bar, F10 game menu.
- **Audio** — unit voices, weapon-impact and missile launch/impact SFX, spell cast sounds, all
  resolved data-drivenly from the game's sound tables and model folders.
- **Camera & input** — selection/marquee, right-click smart orders, edge-of-screen scrolling,
  the WC3 cursor + order reticles.

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
3. **Play a melee game:** click **Single Player**, pick a map (`.w3x`/`.w3m`, e.g. from
   `Warcraft III/Maps/…`) and a race, then start. You spawn with a town hall + workers.
   - **Camera:** WASD / arrow keys / screen-edge scroll pan · wheel zoom.
   - **Select:** left-click / drag-marquee · Ctrl+N bind & N recall control groups · F1–F3 heroes.
   - **Orders:** right-click to move/attack/gather/build-resume · the command card for build/train/
     abilities · click a hero's spell then a target (or the group grid) to cast.
   - **Economy:** send workers to a gold mine or trees; build farms for food; train an army.
   - Without an install you get placeholder terrain (the sim still runs).

## Legal

OpenWar3 is original code containing zero copyrighted assets. Assets are read only from your own
local install, client-side, and are never uploaded or hosted. The engine is fully open.
