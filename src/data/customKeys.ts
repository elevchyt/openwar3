import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import { hotkeyMode } from "./hotkeys";

// `CustomKeys.txt` — the player's own hotkeys and tooltips (issue #142).
//
// This is the backend of Options → Gameplay → "Hotkeys:" → **Custom**, and the file documents
// itself: `CustomKeyInfo.txt` ships in every install beside `CustomKeysSample.txt` (which is the
// WHOLE default set written out, ready to edit). Both are loose files in the Warcraft III folder,
// not archive entries — which is most of what makes this feature awkward to wire and is why the
// text arrives through `setCustomKeys` rather than through the VFS.
//
// What the file may say, quoting CustomKeyInfo.txt's three headings:
//
//   * **hotkeys** — `Hotkey`, `Unhotkey`, `Researchhotkey`. Comma-separated where an action has
//     one per level ("[Rhme] Hotkey=X,Y,Z" is the three ranks of Iron/Steel/Mithril swords).
//   * **button positions** — `Buttonpos`, `Unbuttonpos`, `Researchbuttonpos`, each `x,y` with
//     x=0 the leftmost column, x=3 the rightmost, y=0 the top row, y=2 the bottom.
//   * **tool tips** — `Tip`, `Untip`, `Researchtip`, `Revivetip` (the altar's button) and
//     `Awakentip` (the tavern's — a tavern does not revive a hero, it AWAKENS one, which is
//     the game's own word for it: MiscGame's "Max awaken (tavern) cost of a hero"), so the
//     words can be made to match the keys. The file's own example is "[ogru] Hotkey=T /
//     Tip=Train Orc Grunt (|cffffcc00T|r)".
//
// **ELEVEN KEYS AND NOT ONE MORE.** `OVERRIDABLE` is a closed list on purpose. This file is the
// player's — hand-edited, or written by one of the hotkey generators everybody uses — and it is
// merged straight onto the game's own data tables. A blanket merge would let it rewrite a damage
// column, so the overlay carries exactly the eleven fields Blizzard documents and drops
// everything else on the floor. It may rebind and re-word; it may not change the game.
//
// **WHERE IT IS MERGED.** Each of the four registries (units, abilities, upgrades, items) and
// `commandStrings` builds a `MappedData` out of the install's `*Strings.txt`/`*Func.txt` and
// then reads `Hotkey`/`Tip`/`Buttonpos` off it. So the overlay goes on THERE, one `applyTo` per
// table, and every consumer downstream — the command card, the learn page, the shop, the
// tooltips — is reading the player's value without knowing this module exists. That is also
// what the file says it does: "Entries in this file will override the existing default
// shortcuts."
//
// One thing it does NOT reach, worth knowing before hunting it: a MAP's own object data
// (`w3u`/`w3a`) is applied after the SLKs and therefore WINS. A custom ability has an id of its
// own that no CustomKeys.txt can have named anyway; a base ability whose hotkey a map
// deliberately moved keeps the map's.
//
// And one worth knowing because it looks like nothing happens: `Revivetip` and `Awakentip` are
// two fields — the ALTAR's button and the TAVERN's — and the stock data writes them ALIKE on
// all 89 hero rows that carry either. So a file that moves only one of them is the only way to
// see that they are read separately, which is exactly what this file is for.

/** The eleven fields a CustomKeys.txt may override, lowercased as `MappedData` keys them. */
const OVERRIDABLE: readonly string[] = [
  "hotkey", "unhotkey", "researchhotkey",
  "buttonpos", "unbuttonpos", "researchbuttonpos",
  "tip", "untip", "researchtip", "revivetip", "awakentip",
];

/** One parsed CustomKeys.txt, ready to lay over the game's own tables. */
export class CustomKeys {
  /** Section name, LOWERCASED, → that section's overridable fields. */
  private readonly sections = new Map<string, Record<string, string>>();

  constructor(text: string) {
    // `MappedData` is the same parser every other data table here goes through, so a CustomKeys
    // file is read exactly as `CommandStrings.txt` is — comments (`//`), quoted values and all.
    // With ONE fix it cannot do for itself: mdx-m3-viewer's IniFile splits on `"\r\n"` and
    // nothing else, and this is the one game file a PLAYER writes — on any OS, in any editor,
    // or by a generator. An LF-only file parsed as one enormous line yields no sections at all,
    // which reads exactly like "custom keys do nothing".
    const data = new MappedData(text.replace(/^﻿/, "").replace(/\r?\n/g, "\r\n"));
    for (const [name, row] of Object.entries(data.map)) {
      const fields: Record<string, string> = {};
      for (const key of OVERRIDABLE) {
        const v = (row as { map: Record<string, string> }).map[key];
        if (v !== undefined && v !== "") fields[key] = v;
      }
      if (Object.keys(fields).length) this.sections.set(name.trim().toLowerCase(), fields);
    }
  }

  /** How many sections actually carry something — for diagnostics, and for the "did it load?"
   *  question a player's bug report always turns out to be. */
  get size(): number {
    return this.sections.size;
  }

  /**
   * Lay this file over one of the game's tables, in place.
   *
   * Walks the TARGET's rows rather than this file's sections, which is the whole of the
   * matching rule: a row is only ever overridden, never invented. A section naming something
   * the install does not have (a typo, or a row from another patch) simply finds nothing.
   *
   * The names are matched CASE-INSENSITIVELY, because the two sides do not agree and never
   * did: the game's rows are `Anei`, `CmdRally`, `Rhme`, while a hand-written or
   * generator-written file says `[anei]`, `[cmdrally]`, `[RHME]`. `MappedData.getRow` is an
   * exact lookup, so a straight `load()` of the file would quietly mint a second `anei` row
   * beside `Anei` and override nothing at all.
   */
  applyTo(target: MappedData): void {
    for (const [name, row] of Object.entries(target.map)) {
      const over = this.sections.get(name.trim().toLowerCase());
      if (!over) continue;
      const map = (row as { map: Record<string, string> }).map;
      for (const [key, value] of Object.entries(over)) map[key] = value;
    }
  }
}

/**
 * The file's text as the install handed it over, parsed once.
 *
 * A module singleton, like `applyVideoOptions`' and `applyHotkeyOptions`' state, and set from
 * the same place every install door passes through (`loadProfile`, src/vfs/loader.ts). The
 * alternative — threading it into `loadUnitRegistry(vfs)` and its three siblings — is a
 * parameter on every call site of four functions for a value that is a property of the
 * INSTALL, which is what the VFS already is.
 */
let parsed: CustomKeys | null = null;

/** Hand the mounted install's CustomKeys.txt over, or null when the folder has none. Parsed
 *  eagerly so a malformed file costs nothing at the start of a match. */
export function setCustomKeys(text: string | null): void {
  parsed = text ? new CustomKeys(text) : null;
}

/**
 * The overlay to apply, or null.
 *
 * The OPTION is asked here rather than at the eleven call sites, so "custom is off" and "the
 * folder has no such file" are one answer and a registry never has to know which. The Options
 * screen is not reachable from inside a match (`escMenu`'s Options button is greyed — there is
 * no `EscMenuOptionsPanel` yet), so the row can only change BETWEEN matches, which is exactly
 * when the registries are rebuilt. Nothing has to be re-applied live.
 */
export function customKeys(): CustomKeys | null {
  return hotkeyMode() === "custom" ? parsed : null;
}

/** Lay the player's file over one of the game's tables when the option is on. The one call the
 *  registries make — `customKeys()?.applyTo(table)` spelled once so the gate cannot be
 *  forgotten at one of the ten places that ask. */
export function layCustomKeys(...tables: MappedData[]): void {
  const keys = customKeys();
  if (!keys) return;
  for (const t of tables) keys.applyTo(t);
}
