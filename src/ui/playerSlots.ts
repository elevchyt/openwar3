import { MELEE_INSANE, MELEE_NEWBIE, MELEE_NORMAL } from "../ai/ids";
import { MELEE } from "../data/gameplayConstants";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import type { FdfScreen } from "./fdf/render";
import type { Option } from "./fdf/widgets";
import type { Controller } from "./lobby";
import { arg, findFrame, num, setProp, size, str } from "./mapBrowser";

// The player rows — one `UI\FrameDef\Glue\PlayerSlot.fdf` per slot, stacked under the map's
// own force headings — and everything about laying them out.
//
// This started inside ui/fdfSkirmish.ts and came out when the LAN game lobby (ui/fdfLanLobby.ts,
// UI\FrameDef\Glue\GameChatroom.fdf) turned out to be the same rows again: the engine drops
// PlayerSlot.fdf into a `TeamSetupContainer` on BOTH screens, from the same file, under the
// same force headings. Same reason ui/mapBrowser.ts exists — two screens the engine composes
// from one template get composed from one piece of code.
//
// What is NOT here is what each screen does with the rows: the Custom Game screen seats
// computers and the lobby seats people, and those rules belong to their own screens.

export const PLAYER_SLOT_FDF = "UI\\FrameDef\\Glue\\PlayerSlot.fdf";

/**
 * One entry of an empty slot's name menu.
 *
 * A computer appears once per `MeleeDifficulty()` (src/ai/ids.ts) — and, since issue #124,
 * once per AI as well: Blizzard's ported melee scripts and OpenWar3's own Computer+
 * (src/ai/plus/) are two different opponents at the same three difficulties.
 *
 * All of them share ONE controller. Neither the difficulty nor the AI is a different kind of
 * occupant — every check that asks "is somebody in this seat" (`seated`, the loading screen's
 * roster, the config's filter) means the same thing at all six — so both ride alongside as
 * plain fields rather than splitting `Controller` into six near-identical members.
 */
export interface SlotOption {
  /** The menu's value, and what a row stores. */
  value: string;
  label: string;
  controller: Controller;
  /** `MeleeDifficulty()` for a computer row; absent on Open/Closed. */
  ai?: number;
  /** This computer runs **Computer+**, OpenWar3's own improved melee AI (src/ai/plus/), rather
   *  than Blizzard's ported scripts. Six computer entries exist rather than three because the
   *  Advanced Options checkbox swaps which trio a row's menu offers — see `slotOptionsFor`. */
  plus?: boolean;
}

/**
 * Every slot option, both AIs' worth.
 *
 * A screen never shows all six: `slotOptionsFor` picks the trio the Custom Game screen's
 * "Computer+ (Improved AI)" checkbox has selected. They live in ONE table because everything
 * that reads a stored row back — `slotOption`, `labelOf`, the owner line under a hovered enemy
 * — has to resolve whichever value the row was saved with.
 *
 * The classic labels are the game's own (`UI\FrameDef\Glue\GlobalStrings.fdf` writes
 * COMPUTER_NEWBIE "Computer (Easy)", COMPUTER_NORMAL, COMPUTER_INSANE). The Computer+ ones are
 * OURS — no key in GlobalStrings names an AI Blizzard never shipped — and they are kept here
 * beside the labels they mirror rather than in the FDF overrides layer (src/overrides/),
 * because `labelOf` is asked for them by code that has no FDF library in scope: the owner line
 * of a hover tooltip is drawn mid-match.
 */
export const SLOT_OPTIONS: readonly SlotOption[] = [
  { value: "open", label: "Open", controller: "open" },
  { value: "closed", label: "Closed", controller: "closed" },
  { value: "computer-easy", label: "Computer (Easy)", controller: "computer", ai: MELEE_NEWBIE },
  { value: "computer", label: "Computer (Normal)", controller: "computer", ai: MELEE_NORMAL },
  { value: "computer-insane", label: "Computer (Insane)", controller: "computer", ai: MELEE_INSANE },
  { value: "computerplus-easy", label: "Computer+ (Easy)", controller: "computer", ai: MELEE_NEWBIE, plus: true },
  { value: "computerplus", label: "Computer+ (Normal)", controller: "computer", ai: MELEE_NORMAL, plus: true },
  { value: "computerplus-insane", label: "Computer+ (Insane)", controller: "computer", ai: MELEE_INSANE, plus: true },
];

/** What a slot's name menu offers when Computer+ is (or is not) switched on: the two empty
 *  states, then that AI's three difficulties and only those. Issue #124 — "replaces the
 *  Computer player options with Computer+ options as well when the checkbox is ticked". */
export function slotOptionsFor(plus: boolean): SlotOption[] {
  return SLOT_OPTIONS.filter((o) => o.controller !== "computer" || !!o.plus === plus);
}

/** The option a (controller, difficulty, AI) triple is showing — the row's menu value. Anything
 *  the menu does not offer (a human's own seat, a map's neutral player) falls through to the
 *  controller itself, which is what those rows print. */
export function slotOptionValue(controller: Controller, ai?: number, plus = false): string {
  if (controller !== "computer") return controller;
  const want = ai ?? MELEE_NORMAL;
  return SLOT_OPTIONS.find((o) => o.controller === "computer" && o.ai === want && !!o.plus === plus)?.value ?? "computer";
}

/** The option a menu value names. */
export function slotOption(value: string): SlotOption | undefined {
  return SLOT_OPTIONS.find((o) => o.value === value);
}

/** PlayerSlot.fdf's own HandicapPopupMenuMenu items, in its order. */
export const HANDICAPS = [100, 90, 80, 70, 60, 50];

/** The menu label a slot-option value shows ("Computer (Normal)"). */
export function labelOf(value: string): string {
  return slotOption(value)?.label ?? value;
}

/**
 * What a player slot is CALLED once the match is running — the owner line of a hover tooltip,
 * the Allies rows, the name a chat line arrives under, and `GetPlayerName` (so the melee
 * dialog's "%s was victorious." too).
 *
 * **`melee` is the whole rule.** On a melee map every slot is the LOBBY's: it seated whoever is
 * in it, and the w3i player record the map fills is boilerplate — Echo Isles' two slots are
 * TRIGSTR_001/TRIGSTR_003, which its own war3map.wts resolves to "Player 1" and "Player 2", the
 * World Editor's placeholders. Letting those win put a bare "Player 2" over a computer's units
 * for a whole match when the lobby had seated a "Computer+ (Insane)" there.
 *
 * On a scenario or a campaign chapter the reverse holds, and it is why the field is read at all:
 * a mission NAMES the sides it fields — "Illidan's Naga", "Wild Mur'guls", "Night Elf Villagers"
 * — and that is what WC3 prints under a hovered enemy. Reading "Computer (Normal)" over one of
 * those is a melee lobby's answer given to a mission.
 *
 * A player the lobby never seated (neutral, rescuable) only ever takes the map's name at all:
 * nobody is playing them, so a computer's label would be a lie about them.
 */
export function slotLabel(slot: NamedSlot, melee: boolean): string {
  const seated = slot.controller === "user" || slot.controller === "computer";
  // The lobby's own answer: WHO is in the seat. An AI slot reads back the exact entry its name
  // menu showed, Computer+ included — one table answers both — so the in-game name is the lobby
  // label letter for letter, which is what issue #124 asks for.
  const lobby = slot.controller === "computer"
    ? labelOf(slotOptionValue("computer", slot.aiDifficulty, slot.aiPlus === true))
    : slot.playerName?.trim() || `Player ${slot.id + 1}`;
  if (melee && seated) return lobby;
  return slot.name?.trim() || (seated ? lobby : `Player ${slot.id + 1}`);
}

/** What `slotLabel` needs of a seat — the naming fields of `MeleeConfig`'s `SlotConfig`
 *  (ui/lobby.ts), spelled out here so this file stays a table and imports no match config. */
export interface NamedSlot {
  id: number;
  controller: Controller;
  /** The MAP's own name for the side (w3i player record). */
  name?: string;
  /** The person in the seat, by the name they play under. */
  playerName?: string;
  /** `MeleeDifficulty()`, on a computer the lobby seated. */
  aiDifficulty?: number;
  /** …and whether that computer is a Computer+ (src/ai/plus/). */
  aiPlus?: boolean;
}

/** A run of player rows under one heading. A melee map has a single, unnamed group (its rows
 *  just stack from the top of the panel); a custom map has one per FORCE it declares, and the
 *  lobby prints the map's own name for it over that force's rows. */
export interface Group {
  name: string;
  /** Indices into the screen's slot array — which is also each row's widget suffix. */
  rows: number[];
}

/** What `forceGroups` needs of a map: the forces it declares, if any. */
export interface ForceMap {
  forces: ReadonlyArray<{ name: string; players: number[] }>;
}

/** Split the player rows into the map's forces, in the order the map declares them.
 *  `slotIds[i]` is the map player id of row `i`. */
export function forceGroups(map: ForceMap, slotIds: readonly number[]): Group[] {
  const groups: Group[] = [];
  for (const force of map.forces) {
    const rows = slotIds.map((id, i) => (force.players.includes(id) ? i : -1)).filter((i) => i >= 0);
    if (rows.length) groups.push({ name: force.name, rows });
  }
  // A map with no forces of its own (every melee map) — or one whose forces hold nobody we
  // can seat — is one plain run of rows.
  const seated = new Set(groups.flatMap((g) => g.rows));
  const rest = slotIds.map((_, i) => i).filter((i) => !seated.has(i));
  if (rest.length) groups.push({ name: "", rows: rest });
  return groups;
}

/** Frame names of the dropdowns PlayerSlot declares as plain BUTTONs (TeamButton /
 *  ColorButton), for every row a map could have. Pass to `mountFdfScreen`'s `dropdownButtons`
 *  — it is read once at mount, before a map (and so a slot count) is known. */
export function dropdownButtonNames(rows: number = MELEE.MAX_PLAYERS): string[] {
  const names: string[] = [];
  for (let i = 0; i < rows; i++) names.push(`TeamButton${i}`, `ColorButton${i}`);
  return names;
}

export function teamOptions(rows: number): Option[] {
  return Array.from({ length: Math.max(rows, 2) }, (_, i) => ({ value: String(i), label: `Team ${i + 1}` }));
}

/** The frame name of group `g`'s heading. */
export const forceLabelName = (g: number): string => `ForceLabel${g}`;

/** Put the map's own force names in the heading frames `buildSlotRows` made for them. */
export function fillForceLabels(s: FdfScreen, groups: Group[]): void {
  groups.forEach((g, i) => { if (g.name) s.setText(forceLabelName(i), g.name); });
}

/**
 * The rows (and their headings) for `groups`, anchored down the top of `container`.
 *
 * PlayerSlot declares its own Height (0.025) and chains its five widgets left-to-right off its
 * own LEFT edge, so only the y is ours. Hand the result to `adopt(root, container, …)`.
 */
export function buildSlotRows(lib: FdfLibrary, groups: Group[], container: string): FdfFrame[] {
  const slot = lib.resolveRoot("PlayerSlot");
  if (!slot) return [];
  setProp(findFrame(slot, "HandicapMenu"), "Width", [num(HANDICAP_WIDTH)]);
  const built: FdfFrame[] = [];
  let y = 0;
  groups.forEach((group, g) => {
    if (group.name) {
      const label = lib.resolveRoot("StandardLabelTextTemplate");
      if (label) {
        label.name = forceLabelName(g);
        size(label, 0.3, FORCE_PITCH);
        // A heading, not a title: it sits a size under the label type the template carries.
        setProp(label, "FrameFont", [str("MasterFont"), num(FORCE_FONT), str("")]);
        setProp(label, "SetPoint", [arg("TOPLEFT"), str(container), arg("TOPLEFT"), num(FORCE_INDENT), num(-y)]);
        built.push(label);
        y += FORCE_PITCH;
      }
    }
    const x = group.name ? ROW_INDENT : 0; // only a group under a heading is indented under it
    for (const i of group.rows) {
      const row = suffixed(slot, String(i));
      setProp(row, "SetPoint", [arg("TOPLEFT"), str(container), arg("TOPLEFT"), num(x), num(-y)]);
      built.push(row);
      y += ROW_PITCH;
    }
  });
  return built;
}

/**
 * The handicap dropdown, wider than the 0.05 PlayerSlot.fdf gives it.
 *
 * Every dropdown in the row declares the same type size (`FrameFont "MasterFont",0.011`
 * on PlayerSlotPopupMenu's title), and WC3's own font sets "100%" inside 0.05 at that
 * size. Ours does not — the same gap `POPUP_LABEL_SCALE` exists for — so `fitLabel` was
 * shrinking the handicap label alone, seven steps down to 9.6px against the 13.1px of the
 * Name/Race/Team boxes beside it, and past the floor the ellipsis cut it to "10…".
 *
 * The label's room is the widget less the title's `FontJustificationOffset` (0.01) on the
 * left and `PopupButtonInset` + the arrow (0.01 + 0.011) on the right, which leaves 0.019
 * of the 0.05 for text where "100%" wants ~0.025. This is that, with a little slack —
 * the value reads at the row's own size, and nothing is cut. Widening it moves only
 * PingValue, which chains off its right edge and is empty outside a network game.
 */
const HANDICAP_WIDTH = 0.06;

/** One line of the team-setup panel: a player row (PlayerSlot is 0.025 tall) or a force's
 *  heading. The rows sit shoulder to shoulder in the reference, so the pitch is barely more
 *  than the row itself. */
const ROW_PITCH = 0.026;
/** The rows are indented under their heading, and the heading itself sits in a little from
 *  the panel's left edge. */
const ROW_INDENT = 0.012;
const FORCE_INDENT = 0.006;

/** The force heading's type size (StandardLabelTextTemplate's own 0.013 sets too loud here). */
const FORCE_FONT = 0.0095;
/** The line a heading takes up: its own type and no more — it should crowd the rows it names,
 *  not float between them. */
const FORCE_PITCH = 0.0155;

/**
 * A copy of `frame` with EVERY name in its subtree suffixed — "RaceMenu" → "RaceMenu3" —
 * and every reference to those names rewritten to match. Ten PlayerSlot rows are ten
 * copies of one template, and the layout solver resolves a `SetPoint … "NameMenu"` by
 * NAME across the whole screen: without this, every row's widgets would chain off the
 * last row's, and the rows would collapse on top of each other.
 */
function suffixed(frame: FdfFrame, suffix: string): FdfFrame {
  const names = new Set<string>();
  (function collect(f: FdfFrame): void {
    if (f.name) names.add(f.name);
    f.children.forEach(collect);
  })(frame);

  return (function rewrite(f: FdfFrame): FdfFrame {
    return {
      type: f.type,
      name: f.name ? f.name + suffix : "",
      inherits: null, // `frame` is already resolved, so nothing is left to inherit
      withChildren: false,
      props: f.props.map((p) => ({
        key: p.key,
        args: p.args.map((a) => (a.str && names.has(a.s) ? str(a.s + suffix) : a)),
      })),
      children: f.children.map(rewrite),
    };
  })(frame);
}
