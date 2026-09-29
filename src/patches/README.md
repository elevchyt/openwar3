# `src/patches/` — the game's later patches, as OpenWar3's own data

(Not to be confused with the repository's top-level `patches/`, which holds pnpm patches to
npm packages.)

OpenWar3 reads a **1.30.4** install. Blizzard patched Warcraft III many times after that; each
release that changed the game is written down here as one JSON file, and `PatchDataSource`
([`src/vfs/patch.ts`](../vfs/patch.ts)) lays the whole chain over the install's tables, so every
reader sees the patched game. The ledger of releases, with sources, is
[`docs/patches.md`](../../docs/patches.md). Issue #160.

| file | what it is |
| --- | --- |
| `data/<version>.json` | one release: its rows, its sources, its engine changes |
| `manifest.ts` | the list of files that are applied (a file not imported there is not) |
| `index.ts` | the chain: order, the patch level, `patchAtLeast`, the Forsaken Paladin denylist |
| `tables.ts` | the SLK/TXT rewrite |
| `art/*.png` | our own icons for objects the patches added; `node tools/patch-art.mjs` → `art.ts` |

## Rules

* **The game is always on the latest patch.** `setPatchLevel()` rolls back to any release in the
  chain (or `"1.30.4"`), and exists for developers: tests, `?dev&patch=1.32.10`. No option,
  lobby row or saved setting reaches it.
* **Only The Frozen Throne's MELEE tables are patched.** Blizzard never rebalanced a custom data
  set or Reign of Chaos after 1.30, so a campaign chapter, a custom map and RoC read their own
  tables untouched (docs/editions.md). A patch names the LIVE path (`Units\UnitBalance.slk`),
  never a `Custom_V1\` or `Melee_V0\` one.
* **The Forsaken Paladin (3.0.0) does not exist.** `DENIED_IDS` / `DENIED_WORDS` in index.ts;
  `pnpm patches:check` fails on any mention. Nothing else 3.0.0 added (talents, equipment) is in
  scope either — the chain ends at 2.0.4.
* **No Blizzard text.** A value is a number, an id list, a path or OUR OWN words. Where a patch
  changes a number a tooltip spells out, use a replacement (`{"replace": [["300", "150"]]}`),
  which edits the install's own sentence at runtime without the sentence ever being in the
  repository. A NEW object's name and tooltips are written by us.
* **Values are the game's.** Transcribed from the patch notes (official first, then Liquipedia),
  and checked against the live build's tables with `node tools/patch-extract.mjs --cdn --verify`
  (see docs/patches.md). A change the notes never mention is still recorded — with
  `"source": "undocumented"`.

## The format

```jsonc
{
  "patch": "1.36.2",                 // the file name; a hotfix build is "1.36.2.21214"
  "build": 21179,
  "released": "2024-06-04",
  "notes": ["https://us.forums.blizzard.com/…/32218", "https://liquipedia.net/warcraft/Patch_1.36.2"],
  "changes": [
    {
      "note": "Tomb of Relics: Scroll of Healing removed, Wand of Negation added",   // our words
      "source": "liquipedia",        // optional: "liquipedia", "undocumented", or a URL
      "files": {
        "Units\\UndeadUnitFunc.txt": { "utom": { "Makeitems": "rnec,dust,skul,phea,pman,stwp,ocor,wneg" } },
        "Units\\ItemData.slk": { "wneg": { "goldcost": 150, "uses": 2 } }
      },
      "art": []                      // optional: icons from art/ this change adds, by WC3 path
    }
  ],
  "engine": [                        // optional: behaviour no table carries
    { "key": "orb-on-acquire", "note": "Orb effects trigger on auto-acquired attacks", "implemented": false }
  ]
}
```

* A **file** is the install path as the game spells it (`Units\AbilityData.slk`).
* A **row** is the id in the SLK's first column or the TXT's `[section]` (`[Misc]` for
  MiscGame.txt).
* A **column** is the SLK header (case-insensitive: `goldcost`, `Cool1`, `DataA2`) or the TXT key
  (`Makeitems`, `Requires`, `Ubertip`).
* A **value** is a number, a string exactly as the file would hold it, `null` to remove it, or
  `{"replace": [[from, to], …]}`.
* A row that does not exist is CREATED; give it `"$base": "<id>"` to start from a copy of an
  existing row in the same file (how Blizzard's own new objects are shaped) and then set what
  differs. `null` as the whole row removes it.
* Levelled fields are separate columns (`Cool1`…`Cool4`, `DataA1`…) in AbilityData.slk; in a TXT a
  levelled key is one comma list (`Researchtip`, `Ubertip` for each level, quoted when it holds a
  comma).
* Every patch-note line that changes the game is one `change`, even when it touches several
  files, and a change that touches nothing a table carries is an `engine` entry instead.

`pnpm patches:check` applies each release over the one before it and fails on any file, row,
column, `$base` or replacement that does not resolve; `--show <id>` prints a row before and
after the chain.
