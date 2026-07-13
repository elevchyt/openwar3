import type { DataSource } from "../vfs/types";
import { blpToCanvas } from "../render/blputil";
import { RACES, RACE_LABEL, type Race } from "../data/races";
import { mapSizeLabel, MELEE } from "../data/gameplayConstants";
import { parseMapInfo, type MapInfo } from "../world/mapInfo";
import { MAPS_PREFIX } from "../assets/opfs";
import { PLAYER_COLORS } from "./hud";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import type { ListItem, Option } from "./fdf/widgets";
import type { Controller, MeleeConfig, SlotConfig } from "./lobby";

// The Custom Game screen (issue #61), built from UI\FrameDef\Glue\Skirmish.fdf: the map
// list, the player-slot rows, the map-info pane, and Start Game / Cancel.
//
// Skirmish.fdf declares those four areas as EMPTY container frames — MapListContainer,
// TeamSetupContainer, MapInfoPaneContainer — because the engine fills them at runtime from
// other files: the list from MapListBox.fdf, one PlayerSlot.fdf row per player, the pane
// from MapInfoPane.fdf. (TeamSetup.fdf is literally an empty frame.) So we compose the
// screen the same way, out of the game's own templates — `buildRoot` is exactly that hook.
//
// The one thing the FDF cannot give us is where the map-info pane's labels go: the engine
// positions them in code, so the file has a Suggested-Players/Map-Size/Tileset/Description
// frame with no SetPoint at all. Those anchors are ours (INFO_ROWS below), laid out to
// match the reference screenshot.

const MAP_LIST_FDF = "UI\\FrameDef\\Glue\\MapListBox.fdf";
const MAP_INFO_FDF = "UI\\FrameDef\\Glue\\MapInfoPane.fdf";
const PLAYER_SLOT_FDF = "UI\\FrameDef\\Glue\\PlayerSlot.fdf";

// The list's row icons — the game's own (MapInfoPane.fdf names icon-file-melee for the
// player-count badge; the folder/UMS icons sit beside it in UI\Widgets\Glues).
const ICON_FOLDER = "UI\\Widgets\\Glues\\icon-folder.blp";
const ICON_MELEE = "UI\\Widgets\\Glues\\icon-file-melee.blp";
const ICON_UMS = "UI\\Widgets\\Glues\\icon-file-ums.blp";

/** Tileset letter → name, as the World Editor lists them (WorldEditStrings tileset names). */
const TILESETS: Record<string, string> = {
  A: "Ashenvale", B: "Barrens", C: "Felwood", D: "Dungeon", F: "Lordaeron Fall",
  G: "Underground", I: "Icecrown", J: "Dalaran Ruins", K: "Black Citadel",
  L: "Lordaeron Summer", N: "Northrend", O: "Outland", Q: "Village Fall",
  V: "Village", W: "Lordaeron Winter", X: "Dalaran", Y: "Cityscape", Z: "Sunken Ruins",
};

/** The controllers a slot can take. WC3 also offers three AI difficulties; we have one AI,
 *  so the menu says what it actually is rather than offering a choice that does nothing. */
const CONTROLLERS: Array<[Controller, string]> = [
  ["computer", "Computer (Normal)"],
  ["open", "Open"],
  ["closed", "Closed"],
];

const HANDICAPS = [100, 90, 80, 70, 60, 50];

/** Every map we have read, path → info. Module-level, so coming back to the Custom Game
 *  screen doesn't re-read and re-parse the whole install's Maps folder a second time. */
const mapCache = new Map<string, MapInfo>();

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
}

/** Mount the Custom Game screen over `maps` — the install's own `Maps\` folder. */
export async function mountSkirmish(
  container: HTMLElement,
  vfs: DataSource,
  maps: Map<string, File>,
  h: SkirmishHandlers,
): Promise<FdfScreen> {
  const entries = mapEntries(maps);
  const icons = loadIcons(vfs);

  // Screen state. The FDF screen rebuilds its DOM on every resize, so this — not the DOM —
  // is the source of truth; `onBuild` re-fills the widgets from it each time.
  let selected: { path: string; file: File; info: MapInfo } | null = null;
  let slots: Slot[] = [];
  let maxSlots = 0;
  let alive = true; // cleared on dispose, so the background read below stops

  const readMap = async (path: string): Promise<MapInfo | null> => {
    const cached = mapCache.get(path);
    if (cached) return cached;
    const file = maps.get(path);
    if (!file) return null;
    const info = parseMapInfo(new Uint8Array(await file.arrayBuffer()), baseName(path));
    mapCache.set(path, info);
    return info;
  };

  const chooseMap = async (path: string, screen: FdfScreen): Promise<void> => {
    const file = maps.get(path);
    const info = await readMap(path);
    if (!file || !info) return;
    selected = { path, file, info };
    // A map's slots come from the map. Seat the local player in the first one and let the
    // AI have the rest — WC3's default when you pick a melee map.
    maxSlots = info.slots.length;
    slots = info.slots.map((s, i) => ({
      id: s.id,
      controller: i === 0 ? "user" : "computer",
      race: s.defaultRace,
      team: s.team,
      handicap: 100,
    }));
    screen.relayout(); // the row count changed, so the frame tree itself has to be rebuilt
  };

  const screen = await mountFdfScreen({
    container,
    vfs,
    fdfPath: "UI\\FrameDef\\Glue\\Skirmish.fdf",
    rootFrame: "Skirmish",
    includeFdf: [MAP_LIST_FDF, MAP_INFO_FDF, PLAYER_SLOT_FDF],
    // The engine composes this screen from four files; so do we.
    buildRoot: (lib) => buildSkirmishRoot(lib, maxSlots),
    // "Advanced Options" is one of two mutually exclusive panels in the FDF (the other
    // shows the map info); the map info is the one on screen, so its twin stays hidden.
    hidden: ["AdvancedOptionsPanel"],
    // The dropdowns the FDF declares as plain BUTTONs (see PlayerSlot.fdf). Named for
    // every slot a map could have (bj_MAX_PLAYERS) — this list is read once at mount,
    // before a map (and so a slot count) is known.
    dropdownButtons: dropdownButtonNames(MELEE.MAX_PLAYERS),
    panels: ["GameSettingsLabel", "GameSettingsPanel", "TeamSetupPanel", "MapInfoPanel", "PlayGameBackdrop", "CancelBackdrop"],
    handlers: {
      PlayGameButton: () => start(),
      CancelButton: h.onCancel,
    },
    onBuild: (s) => fill(s),
  });

  function start(): void {
    if (selected) h.onStart(selected.file, selected.info, toConfig(slots, selected.info));
  }

  // Leaving the screen must stop the background read below — it walks the whole install.
  const dispose = screen.dispose.bind(screen);
  screen.dispose = (): void => { alive = false; dispose(); };

  // The list shows each map's OWN name ("Booty Bay", not "(2)BootyBay"), and its icon says
  // whether it's a melee map or a custom one — both of which are inside the map. Reading a
  // whole install's worth of maps up front would stall the screen's entrance, so the rows
  // go up under their file names and are refreshed, one map at a time, in the background.
  void (async () => {
    let changed = false;
    for (const e of entries) {
      if (!alive) return; // the player left; stop reading files for a screen that is gone
      if (e.header) continue;
      try {
        const info = await readMap(e.path); // cached after the first visit
        if (!info) continue;
        e.label = info.name || e.label;
        e.melee = info.isMelee;
        changed = true;
      } catch (err) {
        console.warn(`[OpenWar3] couldn't read ${e.path}:`, err);
      }
    }
    if (alive && changed) screen.list("MapListBox")?.setItems(entries.map((e) => toListItem(e, icons)));
  })();

  return screen;

  /** (Re)fill every widget from the state above — called after each build/rebuild. */
  function fill(s: FdfScreen): void {
    const list = s.list("MapListBox");
    if (list) {
      list.setItems(entries.map((e) => toListItem(e, icons)));
      list.onChange = (path) => void chooseMap(path, s);
      list.onActivate = () => start();
      if (selected) list.select(selected.path);
    }
    // Nothing picked yet: no map to start.
    s.setEnabled("PlayGameButton", !!selected);
    // Advanced Options (handicaps, random races, tournament rules…) is a screen of its own
    // that we don't have. Grey it out rather than leave a button that answers to nothing.
    s.setEnabled("MapInfoButton", false);
    if (!selected) return;

    fillMapInfo(s, selected.info);

    const teams = teamOptions(maxSlots);
    slots.forEach((slot, i) => {
      const name = s.popup(`NameMenu${i}`);
      if (name) {
        // Your own slot is you — WC3 shows your profile name there, not a menu of others.
        name.setOptions(i === 0 ? [{ value: "user", label: "Player" }] : CONTROLLERS.map(([v, l]) => ({ value: v, label: l })));
        name.value = slot.controller;
        name.onChange = (v) => { slot.controller = v as Controller; };
      }
      const race = s.popup(`RaceMenu${i}`);
      if (race) {
        race.setOptions(RACES.map((r) => ({ value: r, label: RACE_LABEL[r] })));
        race.value = slot.race;
        race.onChange = (v) => { slot.race = v as Race; };
      }
      const team = s.popup(`TeamButton${i}`);
      if (team) {
        team.setOptions(teams);
        team.value = String(slot.team);
        team.onChange = (v) => { slot.team = parseInt(v, 10); };
      }
      const colour = s.popup(`ColorButton${i}`);
      if (colour) {
        colour.setOptions(PLAYER_COLORS.slice(0, maxSlots).map((c, ci) => ({ value: c, label: `Player ${ci + 1}` })));
        colour.value = PLAYER_COLORS[slot.id % PLAYER_COLORS.length];
        // The colour IS the player slot in WC3 — it isn't a free choice the sim can honour,
        // so the swatch shows the slot's colour and the menu is read-only.
        colour.setEnabled(false);
      }
      const handicap = s.popup(`HandicapMenu${i}`);
      if (handicap) {
        handicap.setOptions(HANDICAPS.map((p) => ({ value: String(p), label: `${p}%` })));
        handicap.value = String(slot.handicap);
        handicap.onChange = (v) => { slot.handicap = parseInt(v, 10); };
      }
      // A map that fixes its own races/teams doesn't take suggestions from the lobby.
      if (selected?.info.fixedPlayerSettings) {
        race?.setEnabled(false);
        team?.setEnabled(false);
      }
    });
  }
}

/** Fill the map-info pane: the badge, minimap, the three stat rows and the blurb. */
function fillMapInfo(s: FdfScreen, info: MapInfo): void {
  s.setText("MaxPlayersValue", String(info.slots.length));
  s.setText("MapNameValue", info.name);
  s.setText("SuggestedPlayersValue", info.recommendedPlayers || `${info.slots.length} players`);
  // "Map Size" is a WORD, not a measurement: the game buckets a map by its player count
  // (UI\MiscData.txt [BattleNetCustomFilter]), which is how a 1v1 reads "Small".
  s.setText("MapSizeValue", mapSizeLabel(info.slots.length));
  s.setText("MapTilesetValue", TILESETS[info.tileset] ?? info.tileset ?? "—");
  s.setText("MapDescValue", info.description || "");

  // The minimap comes out of the MAP's own archive, not the install's, so it can't go
  // through the renderer's VFS-path sprite table — paint it straight onto the SPRITE frame.
  const el = s.frame("MinimapImage");
  if (!el) return;
  const canvas = info.minimap ? blpToCanvas(info.minimap) : null;
  el.style.background = canvas ? `url(${canvas.toDataURL()}) center/contain no-repeat` : "#000";
}

// --- the map list ------------------------------------------------------------------

interface MapEntry {
  path: string; // key into the maps table ("Maps\\FrozenThrone\\(2)EchoIsles.w3x")
  folder: string; // "" for the top level
  label: string; // the file's stem to begin with, replaced by the map's own name
  header: boolean; // a folder row
  melee: boolean; // drives the row icon; only known once the map has been read
}

/** Group the install's maps the way the reference lists them: sub-folders first (as
 *  headers with their maps under them), then the loose maps at the top level. */
function mapEntries(maps: Map<string, File>): MapEntry[] {
  const all: MapEntry[] = [...maps.keys()].map((path) => {
    const parts = path.slice(MAPS_PREFIX.length).split("\\");
    return { path, folder: parts.slice(0, -1).join("\\"), label: baseName(path), header: false, melee: true };
  });
  // Campaign maps aren't skirmish maps — the Campaign screen is a different menu.
  const playable = all.filter((e) => !/(^|\\)campaign(\\|$)/i.test(e.folder));
  const byLabel = (a: MapEntry, b: MapEntry): number => a.label.localeCompare(b.label);
  const folders = [...new Set(playable.map((e) => e.folder))].filter(Boolean).sort();
  const out: MapEntry[] = [];
  for (const folder of folders) {
    out.push({ path: `folder:${folder}`, folder, label: folder.split("\\").pop() ?? folder, header: true, melee: false });
    out.push(...playable.filter((e) => e.folder === folder).sort(byLabel));
  }
  out.push(...playable.filter((e) => !e.folder).sort(byLabel));
  return out;
}

function toListItem(e: MapEntry, icons: Icons): ListItem {
  return {
    value: e.path,
    label: e.label,
    header: e.header,
    depth: e.header ? 0 : e.folder ? 1 : 0,
    icon: e.header ? icons.folder : e.melee ? icons.melee : icons.ums,
  };
}

interface Icons {
  folder: HTMLCanvasElement | null;
  melee: HTMLCanvasElement | null;
  ums: HTMLCanvasElement | null;
}

function loadIcons(vfs: DataSource): Icons {
  const icon = (path: string): HTMLCanvasElement | null => {
    const bytes = vfs.rawBytes(path);
    return bytes ? blpToCanvas(bytes) : null;
  };
  return { folder: icon(ICON_FOLDER), melee: icon(ICON_MELEE), ums: icon(ICON_UMS) };
}

function baseName(path: string): string {
  const file = path.split("\\").pop() ?? path;
  return file.replace(/\.(w3m|w3x)$/i, "");
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
function buildSkirmishRoot(lib: FdfLibrary, rows: number): FdfFrame {
  const root = lib.resolveRoot("Skirmish");
  if (!root) throw new Error("Skirmish.fdf: no Skirmish frame");

  const listBox = lib.resolveRoot("MapListBox");
  if (listBox) {
    setProp(listBox, "SetAllPoints", []); // the list fills the container the FDF sized
    adopt(root, "MapListContainer", [listBox]);
  }

  const pane = lib.resolveRoot("MapInfoPane");
  if (pane) adopt(root, "MapInfoPaneContainer", [layoutInfoPane(pane)]);

  const slot = lib.resolveRoot("PlayerSlot");
  if (slot) {
    const built: FdfFrame[] = [];
    for (let i = 0; i < rows; i++) {
      const row = suffixed(slot, String(i));
      // Stack the rows down the top of the team-setup frame. PlayerSlot declares its own
      // Height (0.025) and chains its widgets left-to-right off its own LEFT edge.
      setProp(row, "SetPoint", [arg("TOPLEFT"), str("TeamSetupContainer"), arg("TOPLEFT"), num(0), num(-i * 0.0275)]);
      built.push(row);
    }
    adopt(root, "TeamSetupContainer", built);
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

/** Put `children` inside the named container frame. */
function adopt(root: FdfFrame, container: string, children: FdfFrame[]): void {
  const target = findFrame(root, container);
  if (target) target.children.push(...children);
}

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

/**
 * Anchor the map-info pane's rows. MapInfoPane.fdf gives the badge, the minimap and the
 * label/value pairs, but only the pairs are anchored to EACH OTHER — where any of it sits
 * in the pane is decided by the engine, so we decide it here (matched to the reference:
 * name badge, minimap, three stat rows, then the blurb).
 */
function layoutInfoPane(pane: FdfFrame): FdfFrame {
  setProp(pane, "SetAllPoints", []);

  // The name row: the player-count badge, then the map's name, then the author badge —
  // already chained to each other in the FDF, so only the badge needs placing.
  setProp(findFrame(pane, "MaxPlayersIcon"), "SetPoint", [arg("TOPLEFT"), str("MapInfoPane"), arg("TOPLEFT"), num(0.03), num(-0.004)]);
  size(findFrame(pane, "MapNameValue"), 0.14, 0.019);

  setProp(findFrame(pane, "MinimapImage"), "SetPoint", [arg("TOP"), str("MapInfoPane"), arg("TOP"), num(0), num(-0.032)]);

  // The stat rows: label left, value right-justified over the same full-width box (the
  // value's own `SetPoint TOPLEFT <label> TOPLEFT` + JUSTIFYRIGHT is the FDF's own idiom).
  let prev = "";
  for (const [name, gap] of INFO_ROWS) {
    const row = findFrame(pane, name);
    if (!row) continue;
    size(row, 0.2344, 0.016);
    if (prev) setProp(row, "SetPoint", [arg("TOPLEFT"), str(prev), arg("BOTTOMLEFT"), num(0), num(-gap)]);
    else setProp(row, "SetPoint", [arg("TOPLEFT"), str("MapInfoPane"), arg("TOPLEFT"), num(0), num(-0.178)]);
    size(findFrame(pane, name.replace(/Label$/, "Value")), 0.2344, 0.016);
    prev = name;
  }
  // The blurb wraps under its label (the FDF anchors it there itself); it just needs a box
  // deep enough for the longest of Blizzard's own melee descriptions.
  size(findFrame(pane, "MapDescValue"), 0.2344, 0.085);
  return pane;
}

/** The map-info pane's stat rows, in order, with the gap above each. */
const INFO_ROWS: Array<[string, number]> = [
  ["SuggestedPlayersLabel", 0],
  ["MapSizeLabel", 0.002],
  ["MapTilesetLabel", 0.002],
  ["MapDescLabel", 0.008],
];

// --- small FdfFrame helpers ---------------------------------------------------------

const arg = (s: string) => ({ s, n: null, str: false });
const str = (s: string) => ({ s, n: null, str: true });
const num = (n: number) => ({ s: String(n), n, str: false });

function findFrame(f: FdfFrame, name: string): FdfFrame | undefined {
  if (f.name === name) return f;
  for (const c of f.children) {
    const hit = findFrame(c, name);
    if (hit) return hit;
  }
  return undefined;
}

/** Set (replacing any existing) a property on a frame. */
function setProp(f: FdfFrame | undefined, key: string, args: Array<{ s: string; n: number | null; str: boolean }>): void {
  if (!f) return;
  f.props = f.props.filter((p) => p.key !== key);
  f.props.push({ key, args });
}

function size(f: FdfFrame | undefined, w: number, h: number): void {
  setProp(f, "Width", [num(w)]);
  setProp(f, "Height", [num(h)]);
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
  return { slots: playing, fog: "explored" };
}
