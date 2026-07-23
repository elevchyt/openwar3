// The two prose pages the in-game menu shows, both read from the player's own archives.
//
// `EscMenuMainPanel.fdf` declares a HelpPanel and a TipsPanel, each holding nothing but a
// TEXTAREA — the words are not in the FrameDef. They live in their own files under `UI\`:
//
//   UI\HelpStrings.txt — ONE page of WC3 markup, verbatim. Not an INI, not keyed: the file
//                        IS the text ("|Cffc5ff26MENU COMMANDS|r", then the F9…F12 list).
//   UI\TipStrings.txt  — an INI: `[General] TipCount=60` and `Tip1`…`Tip60`, each a quoted
//                        line of markup. The Tips panel shows ONE at a time, which is what
//                        its Back / Next buttons are for.
//
// Both are localized files, so nothing here hardcodes a word of them.

import type { DataSource } from "../vfs/types";

export const HELP_STRINGS = "UI\\HelpStrings.txt";
export const TIP_STRINGS = "UI\\TipStrings.txt";

/** Read a `UI\*.txt` as the 8-bit text it is (the same decode the FDF loader uses). */
async function readText(vfs: DataSource, path: string): Promise<string | null> {
  if (!vfs.exists(path)) return null;
  return new TextDecoder("latin1").decode(await vfs.read(path));
}

/**
 * `UI\HelpStrings.txt`, split into the lines the TEXTAREA renders. The file's own blank
 * lines are kept — they are the spacing between one key's entry and the next, and dropping
 * them runs the whole page together.
 */
export async function loadHelpText(vfs: DataSource): Promise<string[]> {
  const src = await readText(vfs, HELP_STRINGS);
  if (!src) return [];
  return src.replace(/\r/g, "").split("\n");
}

/**
 * `UI\TipStrings.txt` → the tips in file order. `TipCount` is honoured rather than trusted:
 * we read up to it but stop caring the moment a key is missing, so a modified file with a
 * stale count can't produce a run of blank pages.
 */
export async function loadTips(vfs: DataSource): Promise<string[]> {
  const src = await readText(vfs, TIP_STRINGS);
  if (!src) return [];
  const values = new Map<string, string>();
  for (const line of src.replace(/\r/g, "").split("\n")) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) values.set(m[1], m[2].trim().replace(/^"|"$/g, ""));
  }
  const count = Number.parseInt(values.get("TipCount") ?? "0", 10);
  const out: string[] = [];
  for (let i = 1; i <= count; i++) {
    const tip = values.get(`Tip${i}`);
    if (!tip) break;
    out.push(tip);
  }
  return out;
}
