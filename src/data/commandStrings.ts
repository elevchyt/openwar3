import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import type { DataSource } from "../vfs/types";
import { layCustomKeys } from "./customKeys";
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
// The same file also names the engine's own non-ability command buttons, one section
// each ([CmdCancel], [CmdCancelBuild], [CmdCancelTrain]…), carrying the Tip and Ubertip
// the card shows — and the `Hotkey` that presses it, which is the one place in the game
// Move's M and Rally's Y are written down. Those come out of here too, for exactly the same
// reason: a letter retyped at the call site is a letter a CustomKeys.txt cannot move.
//
// Some entries are ONE comma-separated string indexed by race, because each race names
// its own building: Nofood is "Build more Farms…,Build more Burrows…,Summon more
// Ziggurats…,Create more Moon Wells…". The index is the engine's race order, which is
// NOT our alphabetical one — see RACE_ORDER.

/** The engine's race order, as the comma-indexed [Errors] entries are written. Read off
 *  Nofood itself: Farms(human), Burrows(orc), Ziggurats(undead), Moon Wells(nightelf). */
const RACE_ORDER: PlayableRace[] = ["human", "orc", "undead", "nightelf"];

/** A built-in command button's card entry, as the engine's own section carries it:
 *  `Tip=Cancel (|cffffcc00ESC|r)`, the Ubertip that explains what it drops, the `Hotkey` that
 *  presses it, and — only ever from a player's CustomKeys.txt — the slot it sits in. */
export interface CommandText {
  tip: string;
  ubertip: string;
  /** `Hotkey`, as a single upper-case letter. "" when the section names none, and "" for a
   *  numeric code this engine has no name for — see `keyName`. */
  hotkey: string;
  /** `Buttonpos` as [col, row]. Null in a stock install: CommandStrings.txt carries no button
   *  positions at all (the engine seats its own buttons), and this is here because a
   *  CustomKeys.txt may — "[cmdcancelbuild] Buttonpos=3,2" is a real line out of a real one. */
  pos: [number, number] | null;
}

/**
 * What a `Hotkey=` value means when it is a NUMBER.
 *
 * `[CmdCancel] Hotkey=27` in the shipped file, and 27 is VK_ESCAPE — the engine writes a
 * virtual-key code where the key has no letter, and the Tip says so in words ("Cancel
 * (|cffffcc00ESC|r)"). Only the codes that can plausibly appear are named; anything else
 * yields "" and the button keeps whatever the engine gave it, which is the right answer for a
 * key this HUD has no way to press.
 */
const VIRTUAL_KEYS: Record<number, string> = {
  8: "Backspace", 9: "Tab", 13: "Enter", 27: "Escape", 32: " ", 46: "Delete",
  37: "ArrowLeft", 38: "ArrowUp", 39: "ArrowRight", 40: "ArrowDown",
  112: "F1", 113: "F2", 114: "F3", 115: "F4", 116: "F5", 117: "F6",
  118: "F7", 119: "F8", 120: "F9", 121: "F10", 122: "F11", 123: "F12",
};

/** One `Hotkey=` value as the HUD's key matcher spells keys: an upper-case letter, or one of
 *  the named keys above. */
function keyName(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return VIRTUAL_KEYS[Number(raw)] ?? "";
  return (raw[0] ?? "").toUpperCase();
}

/** `Buttonpos=x,y` — column 0-3, row 0-2, as CustomKeyInfo.txt defines the axes. */
function buttonPos(value: string): [number, number] | null {
  const parts = value.split(",").map((n) => Number(n.trim()));
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  return [parts[0], parts[1]];
}

export class CommandStrings {
  constructor(
    private errors: Map<string, string>,
    private commands: Map<string, CommandText> = new Map(),
  ) {}

  /** One engine command button's entry by its section key ("CmdCancel"). Empty strings if the
   *  install doesn't carry it, so a caller can fall back. */
  command(key: string): CommandText {
    return this.commands.get(key.toLowerCase()) ?? { tip: "", ubertip: "", hotkey: "", pos: null };
  }

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

/** Strip the data's own quoting/padding — it quotes the odd entry and leaves trailing
 *  spaces on others ("Mustbeclosertomine=Must root closer to the gold mine. "). */
function clean(value: string): string {
  return value.replace(/^"|"$/g, "").trim();
}

export function loadCommandStrings(vfs: DataSource): CommandStrings {
  const errors = new Map<string, string>();
  const commands = new Map<string, CommandText>();
  const bytes = vfs.rawBytes("Units\\commandstrings.txt");
  if (!bytes) return new CommandStrings(errors, commands);
  const data = new MappedData(new TextDecoder("windows-1252").decode(bytes));
  // The player's own hotkeys/tips/slots over the top, when Options → Gameplay → "Hotkeys:" is
  // on Custom (data/customKeys.ts). The engine's OWN buttons are half of what a CustomKeys.txt
  // usually moves — a real one opens "[cmdrally] Hotkey=F" — and they are the only buttons in
  // the game with no object row to carry it, so this table is where theirs has to land.
  layCustomKeys(data);
  const row = data.getRow("Errors");
  for (const [key, value] of Object.entries(row?.map ?? {})) {
    errors.set(key.toLowerCase(), clean(value));
  }
  // Every other section is one command button ([CmdCancel], [CmdCancelTrain], …).
  //
  // The field names are LOWER CASE here, and that is not a style choice: `MappedData` lowercases
  // every property key as it loads (`mapped.map[name.toLowerCase()] = property`), so `map["Tip"]`
  // is undefined and always was. Read with the file's own capitalisation, this loop found
  // nothing in any section and every engine command button silently fell back to the English
  // written beside its call — which is invisible on an English install and is exactly the bug
  // this file exists to prevent on any other one. Found while wiring `Hotkey` (issue #142).
  for (const [key, section] of Object.entries(data.map)) {
    if (key.toLowerCase() === "errors") continue;
    const map = (section as { map?: Record<string, string> }).map ?? {};
    const tip = clean(map["tip"] ?? "");
    const ubertip = clean(map["ubertip"] ?? "");
    const hotkey = keyName(clean(map["hotkey"] ?? ""));
    const pos = buttonPos(clean(map["buttonpos"] ?? ""));
    if (tip || ubertip || hotkey) commands.set(key.toLowerCase(), { tip, ubertip, hotkey, pos });
  }
  return new CommandStrings(errors, commands);
}

/**
 * The art WC3 draws for an unavailable command button: the icon's own
 * `ReplaceableTextures\CommandButtonsDisabled\DIS<basename>` twin.
 *
 * It is NOT the live icon tinted — the engine swaps in a second TEXTURE, and that texture
 * differs in two ways: it is desaturated, and the gold button frame is GONE (the DIS* art
 * fills the tile edge to edge where the BTN art spends its outer pixels on the frame).
 * Wearing the frame is what makes a button look pressable, so a greyed one must not. The rule
 * is the same for a passive's `PASBTN*` as for a `BTN*`: DIS plus the basename.
 *
 * Here rather than on the renderer because two surfaces ask it — the command card's greyed
 * buttons and the hero bar's DEAD heroes — and a second copy of a path convention is exactly
 * how the two drift apart. Null for a path with no directory to strip, and for the handful of
 * icons that ship no twin the caller falls back to desaturating the live art.
 */
export function disabledIconPath(path: string): string | null {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (cut < 0) return null;
  return `ReplaceableTextures\\CommandButtonsDisabled\\DIS${path.slice(cut + 1)}`;
}
