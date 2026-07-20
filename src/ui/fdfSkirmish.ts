import type { DataSource } from "../vfs/types";
import { RACES, RACE_LABEL, type Race } from "../data/races";
import { MELEE } from "../data/gameplayConstants";
import type { MapInfo } from "../world/mapInfo";
import { PLAYER_COLORS } from "./hud";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import type { Option } from "./fdf/widgets";
import type { Controller, MeleeConfig, SlotConfig } from "./lobby";
import {
  MapBrowser, adopt, arg, findFrame, layoutInfoPane, nudgeX, nudgeY, num, setProp, size, str,
} from "./mapBrowser";

// The Custom Game screen (issue #61), built from UI\FrameDef\Glue\Skirmish.fdf: the map
// list, the player-slot rows, the map-info pane, and Start Game / Cancel.
//
// Skirmish.fdf declares those four areas as EMPTY container frames — MapListContainer,
// TeamSetupContainer, MapInfoPaneContainer — because the engine fills them at runtime from
// other files: the list from MapListBox.fdf, one PlayerSlot.fdf row per player, the pane
// from MapInfoPane.fdf. (TeamSetup.fdf is literally an empty frame.) So we compose the
// screen the same way, out of the game's own templates — `buildRoot` is exactly that hook.
//
// The map list and the map-info pane are not this screen's own: ui/mapBrowser.ts owns both
// (the LAN create screen mounts the same two widgets out of the same two files). What is
// left here is what makes this screen the CUSTOM GAME screen — the player rows.

const MAP_LIST_FDF = "UI\\FrameDef\\Glue\\MapListBox.fdf";
const MAP_INFO_FDF = "UI\\FrameDef\\Glue\\MapInfoPane.fdf";
const PLAYER_SLOT_FDF = "UI\\FrameDef\\Glue\\PlayerSlot.fdf";

/** The controllers a slot can take. WC3 also offers three AI difficulties; we have one AI,
 *  so the menu says what it actually is rather than offering a choice that does nothing. */
const CONTROLLERS: Array<[Controller, string]> = [
  ["open", "Open"],
  ["closed", "Closed"],
  ["computer", "Computer (Normal)"],
];

const HANDICAPS = [100, 90, 80, 70, 60, 50];

export interface SkirmishHandlers {
  onStart: (map: File, info: MapInfo, config: MeleeConfig) => void;
  onCancel: () => void;
}

interface Slot {
  id: number;
  controller: Controller;
  race: Race;
  team: number;
  handicap: number;
  /** The MAP declared this slot a computer (w3i player type 2), so it is not the lobby's to
   *  re-seat: the slot menu is greyed at "Computer (Normal)". See MapInfo's PlayerSlot. */
  locked: boolean;
}

/** A run of player rows under one heading. A melee map has a single, unnamed group (its rows
 *  just stack from the top of the panel); a custom map has one per FORCE it declares, and the
 *  lobby prints the map's own name for it over that force's rows. */
interface Group {
  name: string;
  rows: number[]; // indices into `slots` — which is also each row's widget suffix
}

/** Split the player rows into the map's forces, in the order the map declares them. */
function forceGroups(info: MapInfo, slots: Slot[]): Group[] {
  const groups: Group[] = [];
  for (const force of info.forces) {
    const rows = slots.map((s, i) => (force.players.includes(s.id) ? i : -1)).filter((i) => i >= 0);
    if (rows.length) groups.push({ name: force.name, rows });
  }
  // A map with no forces of its own (every melee map) — or one whose forces hold nobody we
  // can seat — is one plain run of rows.
  const seated = new Set(groups.flatMap((g) => g.rows));
  const rest = slots.map((_, i) => i).filter((i) => !seated.has(i));
  if (rest.length) groups.push({ name: "", rows: rest });
  return groups;
}

/** Mount the Custom Game screen over `maps` — the install's own `Maps\` folder. */
export async function mountSkirmish(
  container: HTMLElement,
  vfs: DataSource,
  maps: Map<string, File>,
  h: SkirmishHandlers,
): Promise<FdfScreen> {
  const browser = new MapBrowser(vfs, maps);

  // Screen state. The FDF screen rebuilds its DOM on every resize, so this — not the DOM —
  // is the source of truth; `onBuild` re-fills the widgets from it each time. The map list
  // and the info pane keep theirs in `browser`; the player rows are ours.
  let slots: Slot[] = [];
  let groups: Group[] = []; // the player rows, under the map's own force headings
  let maxSlots = 0;
  let localIndex = 0; // which row is YOU — the first slot the map lets a human take

  /** A map was picked (or its folder finished reading): reseat the player rows on it. */
  browser.onChange = () => {
    const info = browser.selected?.info;
    if (info) {
      // A map's slots come from the map. Seat the local player in the first one a human may
      // take; a MELEE map then fills the rest with computers (pick Echo Isles, press Start, and
      // you have an opponent), while a custom map leaves its free slots OPEN — WarChasers' three
      // spare heroes stand empty in the real client, because a scenario's other seats are for
      // people. A slot the map declared a computer is never ours to seat either way: it stays
      // that map's own AI player.
      maxSlots = info.slots.length;
      localIndex = Math.max(0, info.slots.findIndex((s) => s.controller === "user"));
      const spare: Controller = info.isMelee ? "computer" : "open";
      slots = info.slots.map((s, i) => ({
        id: s.id,
        controller: s.controller === "computer" ? "computer" : i === localIndex ? "user" : spare,
        race: s.defaultRace,
        team: s.team,
        handicap: 100,
        locked: s.controller === "computer",
      }));
      groups = forceGroups(info, slots);
    }
    // The whole screen is rebuilt: the rows and their headings are frames, and there are now
    // a different number of them. (MapBrowser saves the list's scroll across this.)
    screen.relayout();
  };
  browser.onActivate = () => start();

  const screen = await mountFdfScreen({
    container,
    vfs,
    fdfPath: "UI\\FrameDef\\Glue\\Skirmish.fdf",
    rootFrame: "Skirmish",
    includeFdf: [MAP_LIST_FDF, MAP_INFO_FDF, PLAYER_SLOT_FDF],
    // The engine composes this screen from four files; so do we.
    buildRoot: (lib) => { browser.useStrings(lib); return buildSkirmishRoot(lib, groups); },
    // "Advanced Options" is one of two mutually exclusive panels in the FDF (the other
    // shows the map info); the map info is the one on screen, so its twin stays hidden.
    hidden: ["AdvancedOptionsPanel"],
    // The dropdowns the FDF declares as plain BUTTONs (see PlayerSlot.fdf). Named for
    // every slot a map could have (bj_MAX_PLAYERS) — this list is read once at mount,
    // before a map (and so a slot count) is known.
    dropdownButtons: dropdownButtonNames(MELEE.MAX_PLAYERS),
    panels: ["GameSettingsLabel", "GameSettingsPanel", "TeamSetupPanel", "MapInfoPanel", "PlayGameBackdrop", "CancelBackdrop"],
    // The two panels that hold what the screen is FOR — the map list, and the details of the
    // map picked out of it — are not part of the furniture the screen arrives with. They come
    // in after the chrome has landed, so the screen reads as filling itself in.
    // MapInfoPanel, not its MapInfoPaneContainer: the panel is the whole right-hand column,
    // the pane AND the Advanced Options button under it, and they arrive together.
    // The "Game Settings" title comes with them — it names the map list, so it belongs to
    // what the screen fills in rather than to the chrome the screen arrives wearing.
    latePanels: ["GameSettingsLabel", "GameSettingsPanel", "MapInfoPanel"],
    handlers: {
      PlayGameButton: () => start(),
      CancelButton: h.onCancel,
    },
    onBuild: (s) => fill(s),
  });

  function start(): void {
    const picked = browser.selected;
    if (picked) h.onStart(picked.file, picked.info, toConfig(slots, picked.info));
  }

  // Leaving the screen must stop the browser's background read — it walks the whole install.
  const dispose = screen.dispose.bind(screen);
  screen.dispose = (): void => { browser.dispose(); dispose(); };

  void browser.openFolder(browser.cwd);

  return screen;

  /** (Re)fill every widget from the state above — called after each build/rebuild. */
  function fill(s: FdfScreen): void {
    browser.fill(s); // the map list and the map-info pane
    const picked = browser.selected;
    // Nothing picked yet: no map to start.
    s.setEnabled("PlayGameButton", !!picked);
    // Advanced Options (handicaps, random races, tournament rules…) is a screen of its own
    // that we don't have. Grey it out rather than leave a button that answers to nothing.
    s.setEnabled("MapInfoButton", false);
    if (!picked) return;

    // The map names its own forces ("Forest Task Force", "Monolithic Creeps"); the frames are
    // there, this puts the names in them.
    groups.forEach((g, i) => { if (g.name) s.setText(forceLabelName(i), g.name); });

    const teams = teamOptions(maxSlots);
    const fixed = picked.info.fixedPlayerSettings;
    slots.forEach((slot, i) => {
      const mine = i === localIndex;
      const name = s.popup(`NameMenu${i}`);
      if (name) {
        // Your own slot is you — WC3 shows your profile name there, not a menu of others. A
        // slot the MAP owns (a computer player it declared) shows what it is and takes no
        // choice: the real client greys WarChasers' "Dungeon Denizens" row at Computer.
        name.setOptions(
          mine ? [{ value: "user", label: "Player" }]
          : slot.locked ? [{ value: "computer", label: labelOf("computer") }]
          : CONTROLLERS.map(([v, l]) => ({ value: v, label: l })),
        );
        name.value = slot.controller;
        name.onChange = (v) => { slot.controller = v as Controller; fill(s); }; // the row's other menus follow who is in it
        name.setEnabled(!mine && !slot.locked);
      }
      // An EMPTY slot has nothing to configure: on an Open/Closed row the real client greys
      // the race, team, colour and handicap and leaves only the slot menu live.
      const seated = slot.controller === "user" || slot.controller === "computer";
      const race = s.popup(`RaceMenu${i}`);
      if (race) {
        race.setOptions(RACES.map((r) => ({ value: r, label: RACE_LABEL[r] })));
        race.value = slot.race;
        race.onChange = (v) => { slot.race = v as Race; };
        // Note "fixed player settings" does NOT reach the race: on WarChasers (which sets the
        // flag) the client still opens the race menu on both seated rows — yours and the AI's.
        race.setEnabled(seated);
      }
      const team = s.popup(`TeamButton${i}`);
      if (team) {
        team.setOptions(teams);
        team.value = String(slot.team);
        team.onChange = (v) => { slot.team = parseInt(v, 10); };
        // …but the team and the handicap it does: a fixed-settings map hands out everyone
        // else's, and only your own row stays yours to set.
        team.setEnabled(seated && (!fixed || mine));
      }
      const colour = s.popup(`ColorButton${i}`);
      if (colour) {
        // The colour IS the player slot in WC3 — player 6 is green because it is player 6 —
        // so the swatch is the slot's own colour and the menu is read-only. The options are
        // the WHOLE palette, not the first `maxSlots` of it: a popup drops a value it has no
        // option for, and a map that seats players 0/1/5/6/11 (WarChasers) would then paint
        // three of its five rows with option 0's red.
        colour.setOptions(PLAYER_COLORS.map((c, ci) => ({ value: c, label: `Player ${ci + 1}` })));
        colour.value = PLAYER_COLORS[slot.id % PLAYER_COLORS.length];
        colour.setEnabled(false);
      }
      const handicap = s.popup(`HandicapMenu${i}`);
      if (handicap) {
        handicap.setOptions(HANDICAPS.map((p) => ({ value: String(p), label: `${p}%` })));
        handicap.value = String(slot.handicap);
        handicap.onChange = (v) => { slot.handicap = parseInt(v, 10); };
        handicap.setEnabled(seated && (!fixed || mine));
      }
    });
  }
}

/** The menu label a controller shows ("Computer (Normal)"). */
function labelOf(c: Controller): string {
  return CONTROLLERS.find(([v]) => v === c)?.[1] ?? c;
}

// --- composing the screen out of the game's templates ------------------------------

/** Frame names of the dropdowns PlayerSlot declares as BUTTONs, for every row. */
function dropdownButtonNames(rows: number): string[] {
  const names: string[] = [];
  for (let i = 0; i < rows; i++) names.push(`TeamButton${i}`, `ColorButton${i}`);
  return names;
}

function teamOptions(rows: number): Option[] {
  return Array.from({ length: Math.max(rows, 2) }, (_, i) => ({ value: String(i), label: `Team ${i + 1}` }));
}

/** Skirmish + the map list, the player rows and the info pane dropped into its containers. */
function buildSkirmishRoot(lib: FdfLibrary, groups: Group[]): FdfFrame {
  const root = lib.resolveRoot("Skirmish");
  if (!root) throw new Error("Skirmish.fdf: no Skirmish frame");

  const listBox = lib.resolveRoot("MapListBox");
  if (listBox) {
    setProp(listBox, "SetAllPoints", []); // the list fills the container the FDF sized
    adopt(root, "MapListContainer", [listBox]);
  }

  const pane = lib.resolveRoot("MapInfoPane");
  // Skirmish.fdf's own MapInfoPaneContainer box, and the shade of the gap under it the
  // blurb may run into before the Advanced Options base begins (Echo Isles' five lines
  // want it; the button still sits clear underneath).
  if (pane) adopt(root, "MapInfoPaneContainer", [layoutInfoPane(pane, { w: 0.234375, h: 0.2875, descOverhang: 0.014 })]);

  const slot = lib.resolveRoot("PlayerSlot");
  if (slot) {
    // Stack the rows down the top of the team-setup frame, group by group: a force's heading
    // (the map's own name for it), then its rows. PlayerSlot declares its own Height (0.025)
    // and chains its widgets left-to-right off its own LEFT edge, so only the y is ours.
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
          setProp(label, "SetPoint", [arg("TOPLEFT"), str("TeamSetupContainer"), arg("TOPLEFT"), num(FORCE_INDENT), num(-y)]);
          built.push(label);
          y += FORCE_PITCH;
        }
      }
      const x = group.name ? ROW_INDENT : 0; // only a group under a heading is indented under it
      for (const i of group.rows) {
        const row = suffixed(slot, String(i));
        setProp(row, "SetPoint", [arg("TOPLEFT"), str("TeamSetupContainer"), arg("TOPLEFT"), num(x), num(-y)]);
        built.push(row);
        y += ROW_PITCH;
      }
    });
    adopt(root, "TeamSetupContainer", built);
  }

  // The right-hand chrome is a 3D model (render/menuScene.ts) stretched to frame a 16:9
  // screen, so its two panels sit a little left of where Skirmish.fdf's 4:3 anchors put
  // their contents. Two nudges put the DOM back inside the chrome that carries it:
  //
  //  · the map-info panel (the pane and the Advanced Options button) moves left, so the
  //    minimap, the stat rows and the blurb centre on the panel rather than hugging its
  //    right edge;
  //  · Start Game / Cancel grow to fill their slot — the FDF's 0.24-wide button base is
  //    narrower than the slot the chrome leaves for it. Both grow together, keeping the
  //    file's own base:button ratio (0.24 : 0.168), so the ornate ends still frame the button.
  nudgeX(findFrame(root, "MapInfoPaneContainer"), -MAP_INFO_NUDGE);
  nudgeX(findFrame(root, "MapInfoBackdrop"), -MAP_INFO_NUDGE);
  // …and the map list rides up off the panel's bottom rail, which its lower border was
  // resting on, to sit centred between the two.
  nudgeY(findFrame(root, "MapListContainer"), MAP_LIST_NUDGE);
  for (const [base, button] of [["PlayGameBackdrop", "PlayGameButton"], ["CancelBackdrop", "CancelButton"]]) {
    setProp(findFrame(root, base), "Width", [num(BOTTOM_BUTTON_BASE_W)]);
    setProp(findFrame(root, button), "Width", [num(BOTTOM_BUTTON_BASE_W * BUTTON_TO_BASE)]);
  }

  // The "Game Settings" title anchors itself to the screen's top-left but declares no
  // Height, so it would inherit the root's — a screen-tall box with the title floating in
  // the middle of it. The engine sizes text frames to their text; give it its own line.
  size(findFrame(root, "GameSettingsLabel"), 0.16, 0.024);

  // The FDF has no frame for the two big left-hand areas — they are chrome in the sprite
  // layer — but the panels have to slide as units, so name the containers as our panels.
  renameFrame(root, "MapListContainer", "GameSettingsPanel");
  renameFrame(root, "TeamSetupContainer", "TeamSetupPanel");
  return root;
}

/** How far left the map-info panel's contents move to sit inside the 3D chrome (above). */
const MAP_INFO_NUDGE = 0.052;
/** Start Game / Cancel: the width of the ornate base, and the button's share of it.
 *
 *  The base fills the slot the 3D chrome leaves it (wider than Skirmish.fdf's 0.24, which is
 *  authored for a 4:3 screen). The SHARE, though, is the file's own — 0.168 / 0.24 = 0.7 —
 *  and it has to be: the button is anchored TOPRIGHT to the base's TOPRIGHT, so all of the
 *  base the button does not cover is the ornate fleur END on its left. Widen the button's
 *  share and you don't get a bigger button in the same frame, you get a button that has eaten
 *  its own frame — which is what a share of 0.79 did here. */
const BOTTOM_BUTTON_BASE_W = 0.3;
const BUTTON_TO_BASE = 0.168 / 0.24;

/** How far up the map list moves to centre between the panel's two rails. */
const MAP_LIST_NUDGE = 0.006;

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

/** The frame name of group `g`'s heading. */
const forceLabelName = (g: number): string => `ForceLabel${g}`;

/** Rename a frame in place (and every reference to it in the tree). */
function renameFrame(root: FdfFrame, from: string, to: string): void {
  (function walk(f: FdfFrame): void {
    if (f.name === from) f.name = to;
    for (const p of f.props) {
      for (let i = 0; i < p.args.length; i++) {
        if (p.args[i].str && p.args[i].s === from) p.args[i] = str(to);
      }
    }
    f.children.forEach(walk);
  })(root);
}

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

/** The lobby config the melee initializer consumes (ui/lobby.ts). Start locations come
 *  from the MAP — the lobby only seats players, it doesn't place them. */
function toConfig(slots: Slot[], info: MapInfo): MeleeConfig {
  const playing: SlotConfig[] = slots
    .filter((s) => s.controller === "user" || s.controller === "computer")
    .map((s) => {
      const mapSlot = info.slots.find((m) => m.id === s.id);
      return {
        id: s.id,
        controller: s.controller,
        race: s.race,
        team: s.team,
        startX: mapSlot?.startX ?? 0,
        startY: mapSlot?.startY ?? 0,
      };
    });
  // A fresh seed per match, so two games on the same map don't roll the same crits and
  // drops. Math.random picks it; the sim never touches Math.random itself (world.ts).
  return { slots: playing, fog: "explored", seed: 1 + Math.floor(Math.random() * 2147483645) };
}
