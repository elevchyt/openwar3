# Reverse-engineering sources: TinkerWorX Warcraft III repos

Two reference repos the user added as sources. Both document how the **real** engine is structured. As with every
reference in [`../REFERENCES.md`](../REFERENCES.md): **treat as hypotheses, verify against the 1.27a MPQs / observed
behaviour before building on them.** OpenWar3 contains zero Blizzard code — we use these to name and shape our own
clean implementations, never to copy binaries or lifted code.

---

## 1. TinkerWorX/warcraftIII — RE'd engine structures (C/C++ headers + IDA)

<https://github.com/TinkerWorX/warcraftIII> — *"reverse engineered material for Warcraft III plus scripts/utilities to
reverse it further."* IDA-Pro-dumped class layouts of core game objects. **This is the high-value one for gameplay.**

Files: `CAgent.h` / `CAgentWar3.h` / `CAgent_VTable.h`, `CSelectable.h`, `CUnit.h` / `CUnit_VTable.h` / `CUnitRefList.h`,
`CAbility.h`, `AbilityLevelData.h`, `AbilityUIDef.h`, `AbilDataCacheNode.h`, `CWidget.h` / `CWidget_VTable.h`,
`CWar3Image.h`, `Vector2.h` / `Vector3.h`, `StringArray.h` / `CharArray.h`, and `IDA/Map Natives.idc` /
`IDA/Map Storm Imports.idc` (IDA scripts naming the JASS-native and Storm import thunks).

**Class hierarchy (from the headers):** `CAgent` → `CWidget` → `CSelectable` → `CUnit`. Everything selectable/orderable
derives from `CWidget`; polymorphism is via the `*_VTable` structs.

**Reverse-engineered fields worth knowing (names are the RE'd ones, not raw `field_XX`):**

- **`CUnit`** — the engine hangs one *ability object per order category* off each unit:
  `attackAbility`, `moveAbility`, `heroAbility`, `buildAbility`, `inventoryAbility` (all `void*` → `CAbility`).
  Also `float defense`, `int userData`, `Vector3 position` at offset **[0x284]**.
  - **Direct relevance to OpenWar3:** this is exactly how our command card is organised — Move/Attack/Build and the
    **Hero Abilities (learn-skill) button map 1:1 to `moveAbility` / `attackAbility` / `buildAbility` / `heroAbility`**.
    When we grow the order system, model orders as ability objects on the unit, not ad-hoc branches.
- **`CAbility`** — `CUnit* owner` (the unit that has the ability) + `int abilityId` (the rawcode).
- **`AbilityLevelData`** — the per-level ability stats, matching the World Editor fields exactly:
  `statsTargetsAllowed`, `statsCastingTime`, `statsDurationNormal`, `statsDurationHero`, `statsManaCost`,
  `statsCooldown`, `statsAreaOfEffect`, `statsCastRange`, `dataA`…`dataI` (the per-ability "Data" fields), `unitId`,
  `buffId`. Use this as the shape for our ability data records.

## 2. TinkerWorX/Blizzard.Net.Warcraft3 — managed WC3 data structures (C#)

<https://github.com/TinkerWorX/Blizzard.Net.Warcraft3> — MIT-licensed C# library "for dealing with Warcraft III." Its
useful part is `Blizzard.Net.Warcraft3/Statistics/` — a clean, named model of WC3 **game/replay statistics data**:
`UnitInfo`, `StructureInfo`, `HeroInfo`, `ItemInfo`, `PlayerItemInfo`, `AbilityInfo`, `UpgradeInfo`, `ShopInfo` /
`ShopGoodInfo`, `BuildQueueInfo` / `BuildQueueType`, `ObserverGame` / `ObserverData`, `PlayerInfo`,
`PlayerGameResult`, and the enums `PlayerRace`, `PlayerType`, `PlayerSlotState`, `RacePreference`, `AiDifficultyPreference`.

**How we use it:** as a cross-check for enum values and record shapes (race ids, player slot/type states, build-queue
categories, what per-unit/per-hero/per-item stats the engine tracks). It's a data/replay model, not engine internals —
lower priority than the `warcraftIII` headers for gameplay fidelity, but a tidy reference for naming.

---

*Scraped/summarised 2026-07-03. See [`game-dll-thread.md`](./game-dll-thread.md) for the companion Game.dll
string-dump archive.*
