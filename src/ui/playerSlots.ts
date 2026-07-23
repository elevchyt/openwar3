import { MELEE } from "../data/gameplayConstants";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import type { FdfScreen } from "./fdf/render";
import type { Option } from "./fdf/widgets";
import type { Controller } from "./lobby";
import { arg, num, setProp, size, str } from "./mapBrowser";

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

/** The controllers an EMPTY slot can take. WC3 also offers three AI difficulties; we have one
 *  AI, so the menu says what it actually is rather than offering a choice that does nothing. */
export const CONTROLLERS: Array<[Controller, string]> = [
  ["open", "Open"],
  ["closed", "Closed"],
  ["computer", "Computer (Normal)"],
];

/** PlayerSlot.fdf's own HandicapPopupMenuMenu items, in its order. */
export const HANDICAPS = [100, 90, 80, 70, 60, 50];

/** The menu label a controller shows ("Computer (Normal)"). */
export function labelOf(c: Controller): string {
  return CONTROLLERS.find(([v]) => v === c)?.[1] ?? c;
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
