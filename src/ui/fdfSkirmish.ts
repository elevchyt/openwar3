import { MELEE_NORMAL } from "../ai/ids";
import { computerPlusDefault } from "../data/options";
import { ADVANCED_OPTIONS_OVERRIDE, OW3_STRINGS } from "../overrides";
import type { DataSource } from "../vfs/types";
import { RACES, RACE_LABEL, type Race } from "../data/races";
import type { MapInfo } from "../world/mapInfo";
import { PLAYER_COLORS } from "./hud";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import { savedPlayerName } from "./fdfLan";
import { OBSERVER_PLAYER, type Controller, type FogMode, type MeleeConfig, type SlotConfig } from "./lobby";
import {
  BLURB_SCROLLBAR_FDF, MapBrowser, adopt, findFrame, layoutInfoPane, nudgeX, nudgeY, num,
  setProp, size, str,
} from "./mapBrowser";
import {
  HANDICAPS, PLAYER_SLOT_FDF, buildSlotRows, dropdownButtonNames, fillForceLabels,
  forceGroups, labelOf, slotOption, slotOptionValue, slotOptionsFor, teamOptions, type Group,
} from "./playerSlots";

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
const ADVANCED_OPTIONS_FDF = "UI\\FrameDef\\Glue\\AdvancedOptionsPane.fdf";

/**
 * The right-hand column's two faces.
 *
 * Skirmish.fdf declares MapInfoPanel and AdvancedOptionsPanel as two frames in the same
 * place, each with a button that names the OTHER one: MapInfoPanel's button reads
 * `KEY_ADVANCED_OPTIONS` and AdvancedOptionsPanel's reads `KEY_MAP_INFO`. So the "Advanced
 * Options" button is not a button on the options screen — it IS the swap, and the screen has
 * no third state. (Their frame names say the opposite of what they show, which is the one
 * thing to keep straight while reading this file: `MapInfoButton` is the button ON the map
 * info panel, and the word on it is "Advanced Options".)
 */
const PANEL_FACES = { info: "MapInfoPanel", advanced: "AdvancedOptionsPanel" } as const;

/** Map Visibility, as `AdvancedOptionsPane.fdf`'s own `MapVisibilityPopupMenuMenu` lists it —
 *  four `MenuItem`s whose labels are GlobalStrings keys. The value each one carries into the
 *  match is a `FogMode`; see `visibilityFog`. */
const VISIBILITY_ITEMS = ["DEFAULT", "HIDE_TERRAIN", "MAP_EXPLORED", "ALWAYS_VISIBLE"] as const;
type Visibility = (typeof VISIBILITY_ITEMS)[number];

/**
 * What each visibility choice means to the match.
 *
 * `HIDE_TERRAIN` and `DEFAULT` land on the same `FogMode` because we model one unexplored
 * state, not two: WC3's Hide Terrain additionally blanks the terrain in the minimap preview
 * and the loading screen, which is a presentation difference on ground that is black either
 * way while you play.
 */
function visibilityFog(v: Visibility): FogMode {
  switch (v) {
    case "MAP_EXPLORED": return "explored";
    case "ALWAYS_VISIBLE": return "revealall";
    default: return "unexplored";
  }
}

export interface SkirmishHandlers {
  onStart: (map: File, info: MapInfo, config: MeleeConfig) => void;
  onCancel: () => void;
}

interface Slot {
  id: number;
  controller: Controller;
  /** `MeleeDifficulty()` for a computer row — the Easy/Normal/Insane the name menu picked
   *  (src/ai/ids.ts). Meaningless on any other controller and left at NORMAL there. */
  ai: number;
  race: Race;
  team: number;
  handicap: number;
  /** The MAP declared this slot a computer (w3i player type 2), so it is not the lobby's to
   *  re-seat: the slot menu is greyed at "Computer (Normal)". See MapInfo's PlayerSlot. */
  locked: boolean;
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
  /**
   * Which of the right-hand column's two faces is up — the array `mountFdfScreen` reads its
   * `hidden` set out of on every build, so swapping its contents and asking for a relayout IS
   * the panel swap. (It has to be the same array object: `build()` re-reads `opts.hidden`, and
   * a fresh one would never be seen.)
   */
  const hiddenPanels: string[] = [PANEL_FACES.advanced];
  /** The FDF library, captured on build so the panel's own MenuItem labels resolve through
   *  GlobalStrings ("Always Visible", "Map Explored") rather than being re-typed here. */
  let lib: FdfLibrary | null = null;
  /**
   * The Advanced Options state.
   *
   * Two of these reach the match: `visibility`, and `computerPlus` (our own row — see below).
   * The other five are the real controls off `AdvancedOptionsPane.fdf` and they are drawn
   * greyed, because each needs something the match setup does not have yet rather than a line
   * of wiring here:
   *
   *  · Lock Teams / Teams Together — the first is a lobby rule about who may change a team
   *    menu after the host has set it (there is no second person on this screen to stop), the
   *    second re-seats allied players onto ADJACENT start locations, and a slot takes the
   *    map's own start location by index (see `toConfig`).
   *  · Full Shared Unit Control — `AllianceType.SharedControl` between team-mates at seed
   *    time. `MeleeConfig.forces` carries `allied` and `sharedVision` and nothing else, so
   *    this is a change to the alliance seeding rather than to the screen.
   *  · Random Races / Random Hero — both are `IsMapFlagSet` flags that Blizzard.j's melee
   *    initialisation reads (`MAP_RANDOM_HERO` swaps the free-hero token for a rolled hero),
   *    and that native answers false to everything today (jass/natives/melee.ts).
   *
   * The Observers dropdown is not among them: it is GONE, and `observerMode` stands in its
   * place (see below, and src/overrides/).
   */
  const advanced = {
    lockTeams: false,
    teamsTogether: false,
    sharedControl: false,
    randomRaces: false,
    randomHero: false,
    /** Opens on Map Explored, which is what this screen has always started a match with —
     *  the whole map as grey terrain memory, live fog still hiding enemy movement. DEFAULT is
     *  a real fourth choice here (WC3's normal pitch-black fog), not a rename of that one. */
    visibility: "MAP_EXPLORED" as Visibility,
    /**
     * **Computer+** — play the computer seats with OpenWar3's own improved melee AI
     * (src/ai/plus/, docs/computer-plus.md) rather than Blizzard's ported scripts.
     *
     * The pane's ninth row, and the only one on it that is not the game's own (its frames come
     * from `src/overrides/ui/AdvancedOptionsPane.fdf` — the install is never edited). It is one
     * switch for the whole match rather than a per-row choice, which is why flipping it also
     * swaps what every computer row's NAME menu offers: "Computer (Easy)" becomes "Computer+
     * (Easy)" and so on (issue #124).
     *
     * Opens on whatever Options → Gameplay → "Use Computer+ as default AI" was left at.
     */
    computerPlus: computerPlusDefault(),
    /**
     * **Observer Mode** — get up from your own slot and just watch.
     *
     * The pane's replacement for the game's "Observers:" dropdown, which chooses how other
     * PEOPLE may watch a game you are HOSTING and so had nothing to offer on a single-player
     * screen (it sat greyed at "No Observers"). This one is about the person at this machine:
     * switched on, your row becomes an ordinary OPEN slot — re-seatable as a computer like any
     * other, since the point is to watch a game of computers play out — and the match starts
     * with no seat of ours in it at all (`MeleeConfig.observer`).
     *
     * Off by default: the Custom Game screen is for playing a custom game.
     */
    observerMode: false,
  };

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
        // …and OUR row is only ours while we are playing: an observer's seat opens like any
        // other spare one, on this map and on every map picked after it.
        controller: s.controller === "computer" ? "computer"
          : i === localIndex ? (advanced.observerMode ? "open" : "user")
          : spare,
        // A spare seat opens on the difficulty the reference opens on — the menu's own
        // middle entry, which is also what a slot the MAP owns is greyed at.
        ai: MELEE_NORMAL,
        race: s.defaultRace,
        team: s.team,
        handicap: 100,
        locked: s.controller === "computer",
      }));
      groups = forceGroups(info, slots.map((s) => s.id));
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
    // Every letter belongs to the map list's type-ahead search here (issue #137) — a map's
    // name is spelled with the same letters this screen's buttons answer to.
    noShortcutKeys: true,
    rootFrame: "Skirmish",
    includeFdf: [MAP_LIST_FDF, MAP_INFO_FDF, ADVANCED_OPTIONS_FDF, PLAYER_SLOT_FDF, BLURB_SCROLLBAR_FDF],
    // …and our own layer on the Advanced Options pane: the Computer+ switch, which the 2003 UI
    // has no frame for. See src/overrides/.
    overrides: [OW3_STRINGS, ADVANCED_OPTIONS_OVERRIDE],
    // The engine composes this screen from five files; so do we.
    buildRoot: (l) => { lib = l; browser.useStrings(l); return buildSkirmishRoot(l, groups); },
    // Advanced Options and the map info are one column with two faces, and exactly one of
    // them is on screen at a time (see PANEL_FACES). `hiddenPanels` is which.
    hidden: hiddenPanels,
    dropdownButtons: dropdownButtonNames(),
    panels: ["GameSettingsLabel", "GameSettingsPanel", "TeamSetupPanel", "MapInfoPanel", "AdvancedOptionsPanel", "PlayGameBackdrop", "CancelBackdrop"],
    // The two panels that hold what the screen is FOR — the map list, and the details of the
    // map picked out of it — are not part of the furniture the screen arrives with. They come
    // in after the chrome has landed, so the screen reads as filling itself in.
    // MapInfoPanel, not its MapInfoPaneContainer: the panel is the whole right-hand column,
    // the pane AND the Advanced Options button under it, and they arrive together.
    // The "Game Settings" title comes with them — it names the map list, so it belongs to
    // what the screen fills in rather than to the chrome the screen arrives wearing.
    latePanels: ["GameSettingsLabel", "GameSettingsPanel", "MapInfoPanel", "AdvancedOptionsPanel"],
    handlers: {
      PlayGameButton: () => start(),
      CancelButton: h.onCancel,
      // The two buttons that swap the column over. Each lives on the panel it is leaving and
      // is captioned with the one it goes to — MapInfoButton reads "Advanced Options".
      MapInfoButton: () => showFace("advanced"),
      AdvancedOptionsButton: () => showFace("info"),
    },
    onBuild: (s) => fill(s),
  });

  /** Swap the right-hand column's face. The panel is a frame the build either renders or
   *  skips, so this is one line of state and a rebuild. */
  function showFace(face: keyof typeof PANEL_FACES): void {
    hiddenPanels.length = 0;
    hiddenPanels.push(face === "advanced" ? PANEL_FACES.info : PANEL_FACES.advanced);
    screen.relayout();
  }

  /**
   * Observer Mode was flipped: leave our row, or take it back.
   *
   * Leaving hands it over as OPEN rather than as a computer, because the row is now a choice
   * to be made and not a decision taken for us — and coming back takes it whatever it was
   * turned into meanwhile, since it is our seat again. A row the MAP owns was never ours to
   * get up from (see Slot.locked).
   */
  function seatLocalRow(): void {
    const seat = slots[localIndex];
    if (!seat || seat.locked) return;
    seat.controller = advanced.observerMode ? "open" : "user";
    seat.ai = MELEE_NORMAL;
  }

  function start(): void {
    const picked = browser.selected;
    if (!picked) return;
    h.onStart(picked.file, picked.info, toConfig(slots, picked.info, {
      fog: visibilityFog(advanced.visibility),
      computerPlus: advanced.computerPlus,
      observer: advanced.observerMode,
    }));
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
    // Nothing picked yet: no map to start — nor is there anything to WATCH if the observer
    // emptied the last seat, which is a match of nobody rather than a game of computers.
    s.setEnabled("PlayGameButton", !!picked && (!advanced.observerMode || slots.some(isSeated)));
    // …and nothing to configure either: the options are the MATCH's, so the button that
    // opens them is dead until there is a map to play.
    s.setEnabled("MapInfoButton", !!picked);
    fillAdvanced(s);
    if (!picked) return;

    // The map names its own forces ("Forest Task Force", "Monolithic Creeps"); the frames are
    // there, this puts the names in them.
    fillForceLabels(s, groups);

    const teams = teamOptions(maxSlots);
    const fixed = picked.info.fixedPlayerSettings;
    slots.forEach((slot, i) => {
      // Our own row — unless we have got up from it: an OBSERVER's old seat is nobody's, so it
      // wears the full slot menu and can be handed to a computer like any other open one.
      const mine = i === localIndex && !advanced.observerMode;
      const name = s.popup(`NameMenu${i}`);
      if (name) {
        // Your own slot is you — WC3 shows your profile name there, not a menu of others. A
        // slot the MAP owns (a computer player it declared) shows what it is and takes no
        // choice: the real client greys WarChasers' "Dungeon Denizens" row at Computer.
        // Which AI's three difficulties this row offers is the Advanced Options switch's
        // (issue #124: "replaces the Computer player options with Computer+ options as well
        // when the checkbox is ticked"). A slot the MAP owns still shows the plain label —
        // there is no choice on that row to make.
        name.setOptions(
          mine ? [{ value: "user", label: "Player" }]
          : slot.locked ? [{ value: "computer", label: labelOf("computer") }]
          : slotOptionsFor(advanced.computerPlus).map((o) => ({ value: o.value, label: o.label })),
        );
        name.value = slotOptionValue(slot.controller, slot.ai, advanced.computerPlus);
        // The row's other menus follow who is in it — and a computer row carries the
        // difficulty its menu entry named (Computer (Easy) / (Normal) / (Insane)).
        name.onChange = (v) => {
          const opt = slotOption(v);
          slot.controller = opt?.controller ?? (v as Controller);
          slot.ai = opt?.ai ?? MELEE_NORMAL;
          fill(s);
        };
        name.setEnabled(!mine && !slot.locked);
      }
      // An EMPTY slot has nothing to configure: on an Open/Closed row the real client greys
      // the race, team, colour and handicap and leaves only the slot menu live.
      const seated = isSeated(slot);
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

  /**
   * The Advanced Options pane — the five checkboxes, the two menus and the button back.
   *
   * Called on every build whether the pane is up or not: when it is hidden none of these
   * frames exist and every lookup answers null, which is exactly the right no-op.
   */
  function fillAdvanced(s: FdfScreen): void {
    const text = (key: string): string => lib?.string(key) ?? key;

    // The five that answer to nothing yet — see `advanced` for what each one is waiting on.
    // Drawn with the state they would carry so the pane reads as a real screen, and greyed so
    // it does not lie about being live.
    const dead: Array<[string, boolean]> = [
      ["LockTeamsCheckBox", advanced.lockTeams],
      ["TeamsTogetherCheckBox", advanced.teamsTogether],
      ["AdvSharedControlCheckBox", advanced.sharedControl],
      ["RandomRacesCheckBox", advanced.randomRaces],
      ["RandomHeroCheckBox", advanced.randomHero],
    ];
    for (const [name, value] of dead) {
      const box = s.checkBox(name);
      if (!box) continue;
      box.checked = value;
      box.setEnabled(false);
    }
    // …and the one that does. Its four items are the FDF's own MenuItem list, under the
    // GlobalStrings names the game prints them by.
    const visibility = s.popup("MapVisibilityMenu");
    if (visibility) {
      visibility.setOptions(VISIBILITY_ITEMS.map((v) => ({ value: v, label: text(v) })));
      visibility.value = advanced.visibility;
      visibility.onChange = (v) => { advanced.visibility = v as Visibility; };
    }

    // …and the two that are OURS. Flipping either re-fills the whole screen, because neither
    // is only about the match: Computer+ changes what every computer row's name menu offers,
    // and Observer Mode empties (or takes back) our own row.
    const plus = s.checkBox("ComputerPlusCheckBox");
    if (plus) {
      plus.checked = advanced.computerPlus;
      plus.onChange = (on) => { advanced.computerPlus = on; fill(s); };
    }
    const observer = s.checkBox("ObserverModeCheckBox");
    if (observer) {
      observer.checked = advanced.observerMode;
      observer.onChange = (on) => { advanced.observerMode = on; seatLocalRow(); fill(s); };
    }
  }
}

// --- composing the screen out of the game's templates ------------------------------

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
  if (pane) adopt(root, "MapInfoPaneContainer", [layoutInfoPane(pane, { w: 0.234375, h: 0.2875, descOverhang: 0.014, lib })]);

  // …and the same container's OTHER face, out of AdvancedOptionsPane.fdf. Like the map list
  // it is a bare `FRAME` whose children anchor to it, so it takes the container's own box.
  const advanced = lib.resolveRoot("AdvancedOptionsPane");
  if (advanced) {
    setProp(advanced, "SetAllPoints", []);
    adopt(root, "AdvancedOptionsPaneContainer", [advanced]);
  }

  // The player rows, stacked down the team-setup frame under the map's own force headings
  // (ui/playerSlots.ts — the LAN game lobby builds the same rows out of the same file).
  adopt(root, "TeamSetupContainer", buildSlotRows(lib, groups, "TeamSetupContainer"));

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
  //    …and its twin the same way, since the two faces of the column have to land on the
  //    same spot for the swap to read as a swap rather than a jump.
  nudgeX(findFrame(root, "MapInfoPaneContainer"), -MAP_INFO_NUDGE);
  nudgeX(findFrame(root, "MapInfoBackdrop"), -MAP_INFO_NUDGE);
  nudgeX(findFrame(root, "AdvancedOptionsPaneContainer"), -MAP_INFO_NUDGE);
  nudgeX(findFrame(root, "AdvancedOptionsBackdrop"), -MAP_INFO_NUDGE);
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

/** Is somebody actually IN this row? The two empty states are lobby states, not occupants —
 *  the same question the config's filter, the roster and the row's own greying all ask. */
function isSeated(slot: Slot): boolean {
  return slot.controller === "user" || slot.controller === "computer";
}

/** The lobby config the melee initializer consumes (ui/lobby.ts). Start locations come
 *  from the MAP — the lobby only seats players, it doesn't place them. */
function toConfig(
  slots: Slot[],
  info: MapInfo,
  opts: { fog: FogMode; computerPlus: boolean; observer: boolean },
): MeleeConfig {
  const playing: SlotConfig[] = slots
    .filter(isSeated)
    .map((s) => {
      const mapSlot = info.slots.find((m) => m.id === s.id);
      return {
        id: s.id,
        controller: s.controller,
        race: s.race,
        team: s.team,
        startX: mapSlot?.startX ?? 0,
        startY: mapSlot?.startY ?? 0,
        name: mapSlot?.name,
        // Which computer the row picked, and which AI plays it. Only a computer has either
        // — see SlotConfig.
        ...(s.controller === "computer" ? { aiDifficulty: s.ai, aiPlus: opts.computerPlus } : {}),
        // The one seat a human is in on this screen is theirs, under the name the profile
        // saved — the loading screen's roster is the only thing that reads it.
        ...(s.controller === "user" ? { playerName: savedPlayerName() } : {}),
      };
    });
  // The map's neutral/rescuable players had no row to be seated in and are in the match all
  // the same — they own units, and the map's name for them is what a hover reads (see
  // MapInfo.neutralPlayers).
  for (const p of info.neutralPlayers) {
    playing.push({ id: p.id, controller: p.controller, race: p.defaultRace, team: p.team, startX: p.startX, startY: p.startY, name: p.name });
  }
  // A fresh seed per match, so two games on the same map don't roll the same crits and
  // drops. Math.random picks it; the sim never touches Math.random itself (world.ts).
  // `forces` carries what the MAP says its forces grant each other — a melee map declares
  // none and the seeding falls back to the lobby's own promise (MapInfo.ForceGrants).
  return {
    slots: playing,
    // Advanced Options → Visibility. Was hardcoded to "explored" while there was no screen
    // to say otherwise; the pane's own default still opens on Map Explored, so a match
    // started without touching it plays exactly as it did before.
    fog: opts.fog,
    forces: info.forces.map((f) => ({ allied: f.allied, sharedVision: f.sharedVision })),
    seed: 1 + Math.floor(Math.random() * 2147483645),
    // Advanced Options → Observer Mode: nobody in `playing` is us, so the match is told which
    // seat this machine watches from — one that is nobody's (ui/lobby.ts OBSERVER_PLAYER).
    ...(opts.observer ? { observer: true, localPlayer: OBSERVER_PLAYER } : {}),
  };
}
