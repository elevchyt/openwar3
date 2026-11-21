# OpenWar3 docs

One deep-dive per subsystem. Each file says near the top what to read it before touching, so
start from the group that matches your change. Standing guidance for contributors is in
[`CONTRIBUTING.md`](../CONTRIBUTING.md) and, in long form, [`CLAUDE.md`](../CLAUDE.md).

Three files are **not** a how-it-works reference for the current code:
[`abilities-audit.md`](abilities-audit.md) is generated (do not hand-edit it), and
[`phase7-triggers-jass-plan.md`](phase7-triggers-jass-plan.md) and
[`perf-research.md`](perf-research.md) are records of a design and of a measurement effort.
Their entries below say so.

## Data, formats and the install

- [`REFERENCES.md`](REFERENCES.md) — the curated list of reference projects and research sources, and how far to trust each.
- [`wc3-data-formats.md`](wc3-data-formats.md) — where the game keeps each piece of data (archives, file formats, Func/Strings files, SLK columns).
- [`casc.md`](casc.md) — how a 1.30.4 (CASC) install is read, and how the older MPQ layout is still mounted.
- [`editions.md`](editions.md) — Reign of Chaos vs The Frozen Throne: the one client, the edition switch, `_V0`/`_V1` keys.
- [`patches.md`](patches.md) — the ledger of Blizzard patches after 1.30.4 and our own patch files laid over the install's tables.
- [`map-compatibility.md`](map-compatibility.md) — the compatibility layer for maps saved by a World Editor newer than 1.30.4.
- [`icons.md`](icons.md) — where a command-button icon comes from, and the derived and last-resort icons.
- [`reverse-engineering/`](reverse-engineering/) — locally archived engine internals: [`game-dll-thread.md`](reverse-engineering/game-dll-thread.md) (the `Game.dll` string dump) and [`tinkerworx-repos.md`](reverse-engineering/tinkerworx-repos.md) (RE'd engine structures).

## Rendering, camera and UI

- [`camera.md`](camera.md) — the camera lens, zoom, ground-follow and a map's own camera, measured against the real client.
- [`auto-camera.md`](auto-camera.md) — the observer's Auto Camera that pans to the most interesting part of a match.
- [`lighting.md`](lighting.md) — what lights a scene and what casts shadows (WC3 has no real-time shadows).
- [`terrain-culling.md`](terrain-culling.md) — drawing only the terrain you can see.
- [`unplayable-area.md`](unplayable-area.md) — the black border and carved-out regions around the playable ground.
- [`walkable-destructibles.md`](walkable-destructibles.md) — bridges, ramps and second storeys: the `walkable` column and ground height.
- [`spell-fx.md`](spell-fx.md) — the five separate mechanisms by which a spell shows itself.
- [`loading-screens.md`](loading-screens.md) — the loading screen between the menus and a match.
- [`campaigns.md`](campaigns.md) — the TFT campaign screen and what it takes to start a chapter.
- [`score-screen.md`](score-screen.md) — the score screen shown after a finished match.
- [`tooltips.md`](tooltips.md) — the command card's tooltip and the in-world hover slab.
- [`video-options.md`](video-options.md) — what each row of the Video panel does, the lowest-settings preset and the weak-GPU prompt.
- [`observer-hud.md`](observer-hud.md) — the HUD a watcher gets instead of a player's console.

## Simulation and mechanics

- [`selection.md`](selection.md) — what the cursor hits and what a drag box may take.
- [`creeps.md`](creeps.md) — how a Neutral Hostile camp behaves.
- [`items.md`](items.md) — items and item abilities.
- [`orbs.md`](orbs.md) — orb effects: attack modifiers that ride ordinary blows.
- [`illusions.md`](illusions.md) — Mirror Image, Wand of Illusion and the shared illusion mechanic.
- [`artillery.md`](artillery.md) — Mortar Team, Demolisher, Meat Wagon, Glaive Thrower and other artillery weapons.
- [`transports.md`](transports.md) — the Goblin Zeppelin and ships: a cargo hold that moves.
- [`night-elf.md`](night-elf.md) — the night elf economy.
- [`undead.md`](undead.md) — the undead economy.
- [`pause.md`](pause.md) — what "paused" means, who may pause, and what a paused game looks like.
- [`save-games.md`](save-games.md) — saved single-player games (`.o3s`).
- [`replays.md`](replays.md) — recording and watching replays, including going back in time.

## Triggers and JASS

- [`triggers.md`](triggers.md) — the living progress tracker for the trigger/JASS engine, and how each piece is verified.
- [`phase7-triggers-jass-plan.md`](phase7-triggers-jass-plan.md) — the original architecture and execution plan for running a map's own script. A design record: current status lives in `triggers.md`.

## AI

- [`melee-ai.md`](melee-ai.md) — Blizzard's melee AI, ported.
- [`computer-plus.md`](computer-plus.md) — Computer+, the improved melee AI that never cheats.
- [`candy-war-ai.md`](candy-war-ai.md) — Computer+ on Extreme Candy War.
- [`warchasers-ai.md`](warchasers-ai.md) — Computer+ as a party member on WarChasers.

## Multiplayer

- [`multiplayer.md`](multiplayer.md) — authority, transport and the road to multiplayer; also the progress tracker.
- [`voice-chat.md`](voice-chat.md) — push-to-talk voice chat in LAN matches (issue #133).

## Input and accessibility

- [`hotkeys.md`](hotkeys.md) — which key presses which button, and the hotkey editor.
- [`gamepad.md`](gamepad.md) — gamepad support.
- [`voice-control.md`](voice-control.md) — spoken commands (hold Period, say a command).

## Platforms and packaging

- [`windows.md`](windows.md) — the Windows installer and where the app finds the game.
- [`linux.md`](linux.md) — the Linux AppImages, including the 32-bit one.

## Logging, measurement and generated files

- [`match-log.md`](match-log.md) — the plain-text log every match writes.
- [`perf-logging.md`](perf-logging.md) — the per-match performance recording.
- [`perf-research.md`](perf-research.md) — the performance research ledger (issue #161): what was measured, what landed, what was reverted. A running ledger rather than a how-it-works page.
- [`abilities-audit.md`](abilities-audit.md) — **generated** by `node tools/audit-abilities.mjs`; do not hand-edit.
