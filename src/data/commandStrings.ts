import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import type { DataSource } from "../vfs/types";
import type { PlayableRace } from "./races";

// The game's own refusal messages — the gold line the console flashes when it won't
// do what you asked ("Not enough gold.", "Must target an enemy unit.").
//
// They all live in ONE place in the real game: the [Errors] block of
// Units\commandstrings.txt, 216 of them. We read them straight out of the archive
// rather than transcribing, for the usual reason — a hand-copied string drifts, and
// this file is also what a localized install translates, so a Spanish install should
// say "No hay suficiente oro." without us knowing a word of Spanish.
//
// Some entries are ONE comma-separated string indexed by race, because each race names
// its own building: Nofood is "Build more Farms…,Build more Burrows…,Summon more
// Ziggurats…,Create more Moon Wells…". The index is the engine's race order, which is
// NOT our alphabetical one — see RACE_ORDER.

/** The engine's race order, as the comma-indexed [Errors] entries are written. Read off
 *  Nofood itself: Farms(human), Burrows(orc), Ziggurats(undead), Moon Wells(nightelf). */
const RACE_ORDER: PlayableRace[] = ["human", "orc", "undead", "nightelf"];

export class CommandStrings {
  constructor(private errors: Map<string, string>) {}

  /** One error string by its commandstrings.txt key ("Nogold"). Keys are matched
   *  case-insensitively — the data's own casing is inconsistent ("Targgetmine"). */
  get(key: string): string {
    return this.errors.get(key.toLowerCase()) ?? "";
  }

  /** A race-indexed error ("Nofood" → the caller's own supply building). Entries that
   *  aren't race-indexed just come back whole, so this is safe on any key. */
  forRace(key: string, race: PlayableRace): string {
    const parts = this.get(key).split(",");
    if (parts.length < RACE_ORDER.length) return parts[0] ?? "";
    return parts[RACE_ORDER.indexOf(race)] ?? parts[0];
  }
}

export function loadCommandStrings(vfs: DataSource): CommandStrings {
  const errors = new Map<string, string>();
  const bytes = vfs.rawBytes("Units\\commandstrings.txt");
  if (!bytes) return new CommandStrings(errors);
  const data = new MappedData(new TextDecoder("windows-1252").decode(bytes));
  const row = data.getRow("Errors");
  for (const [key, value] of Object.entries(row?.map ?? {})) {
    // The data quotes the odd entry and leaves trailing spaces on others
    // ("Mustbeclosertomine=Must root closer to the gold mine. ").
    errors.set(key.toLowerCase(), value.replace(/^"|"$/g, "").trim());
  }
  return new CommandStrings(errors);
}
