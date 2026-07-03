# CLAUDE.md — working guide for OpenWar3

OpenWar3 is a browser-first, asset-compatible re-creation of the **Warcraft III (TFT 1.27a)** engine in TypeScript.
See [`README.md`](./README.md) and [`OpenWar3_PLAN.md`](./OpenWar3_PLAN.md) for scope; this file is the standing
guidance for how to build here.

## Prime directive: match the original game, and use our sources to do it

Everything we build should be **as close to the original Warcraft III as possible** — behaviour, timings, layout,
naming, and feel. Do not guess at WC3 mechanics or invent values. Before implementing or adjusting any gameplay, UI,
data, or asset behaviour, **consult our sources** and cite what you used.

**Our sources (read these, in this order for a given question):**

1. **The real 1.27a MPQs in `Warcraft III/`** — the ground truth. When a reference and the game data disagree, the MPQ
   wins (this is a hard-won rule; see the cliff-ramp story in `docs/REFERENCES.md`). Read `.slk`/`.txt`/`.w3*` data,
   model `.mdx`, and asset paths straight from the archives.
   - **Archive split** (mounted in `src/vfs/profiles.ts`, patch wins): `War3.mpq` = all Reign-of-Chaos content +
     base sounds; `War3x.mpq` = Frozen-Throne models/data/effect sounds; `War3xLocal.mpq` = TFT **localized unit
     voices**. So a TFT unit (e.g. the Blood Mage) draws its model from War3x but its voice lines from War3xLocal.
   - **TFT audio (Huffman+ADPCM):** WC3 stores every WAV as **Huffman(+ADPCM)**. War3.mpq WAVs are PCM (RoC), but
     **all** War3x/War3xLocal WAVs are huffman — stock `mdx-m3-viewer` threw `compression type 'huffman' not
     supported`, muting every expansion sound. Fixed in `patches/mdx-m3-viewer@5.12.0.patch` (Storm-Huffman port in
     `huffman.js` + `file.js` wiring + an `adpcm.js` signedness fix). Verify decodes from Node against the real MPQs.
2. **[`docs/REFERENCES.md`](docs/REFERENCES.md)** — the curated index of reference projects and research threads, with
   per-source gotchas. Start here to find the right reference for a topic.
3. **[`docs/reverse-engineering/`](docs/reverse-engineering/)** — locally archived engine internals:
   - [`tinkerworx-repos.md`](docs/reverse-engineering/tinkerworx-repos.md) — RE'd **engine class layouts** (`CAgent`→
     `CWidget`→`CSelectable`→`CUnit`, the per-order **ability objects** `attackAbility`/`moveAbility`/`heroAbility`/
     `buildAbility`/`inventoryAbility`, `AbilityLevelData` fields). Use these to shape our unit/ability/order model.
   - [`game-dll-thread.md`](docs/reverse-engineering/game-dll-thread.md) — the `Game.dll` string dump: real class/file
     names (`CGameUI`, the `frame`/`framedef`/`fdfile` FDF UI system, the `glue` menus) and the data-file/asset names
     the engine reads. Use it to **name and organise our subsystems to mirror the original**.
4. **Hive Workshop threads & the official [classic WC3 basics pages](https://classic.battle.net/war3/basics/)** for
   mechanics that live in no file format (turn rate, acquisition, upkeep, rally, etc.). hiveworkshop 403s plain
   fetchers — fetch with a browser `User-Agent` (see `docs/REFERENCES.md`).

**Rules when using sources:**
- **Verify, don't trust blindly.** References are hypotheses — confirm format/behaviour against the real MPQs or
  observed game behaviour before building on them.
- **Cite the source next to the code.** When a constant or behaviour comes from a thread/repo/data file, name it in a
  comment right there (the codebase already does this — match that style).
- **Prefer the real asset.** If WC3 has a model/texture/icon/sound for something, use its real path from the MPQs
  (asset-resolver philosophy: authentic when present, placeholder otherwise). Example: the learn-skill button uses
  `ReplaceableTextures\CommandButtonsDisabled\DISBTNSkillz.blp`; spell AoE circles are
  `ReplaceableTextures\Selection\SpellAreaOfEffect*.blp`.
- **Legal boundary:** OpenWar3 ships **zero Blizzard assets or code**. The RE material is *documentation of behaviour
  and naming only* — never lift Blizzard binaries, decompiled code, or GPL reference code (Warsmash: study, don't lift).
  Assets are read only from the user's own local install at runtime.

## Practical

- **Build / check:** `pnpm dev` (localhost:5173), `pnpm build` (typecheck + build), `pnpm typecheck`. Run `pnpm typecheck`
  before considering a change done.
- **Layout:** sim in `src/sim/` (world, pathing, `spells.ts`), game glue in `src/game/rts.ts`, rendering + command card
  in `src/render/mapViewer.ts`, HUD DOM in `src/ui/hud.ts`, data tables in `src/data/` (units, techtree, `abilities.ts`),
  audio in `src/audio/`, styles in `src/style.css`.
- Match the surrounding code's comment density and idiom — this codebase documents *why* (and its WC3 source) inline.
