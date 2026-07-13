import type { DataSource } from "../vfs/types";
import { blpToCanvas } from "../render/blputil";
import { RACES, RACE_LABEL, type Race } from "../data/races";
import { mapSizeLabel, MELEE } from "../data/gameplayConstants";
import { parseMapInfo, type MapInfo } from "../world/mapInfo";
import { readMapPreview, type MapPreview } from "../world/mapPreview";
import { loadUnitRegistry, type UnitRegistry } from "../data/units";
import { MAPS_PREFIX } from "../assets/opfs";
import { PLAYER_COLORS } from "./hud";
import type { FdfFrame } from "./fdf/parser";
import { firstProp, type FdfLibrary } from "./fdf/library";
import { mountFdfScreen, UI_FONT, type FdfScreen } from "./fdf/render";
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
const ICON_FOLDER_UP = "UI\\Widgets\\Glues\\icon-folder-up.blp";
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
  ["open", "Open"],
  ["closed", "Closed"],
  ["computer", "Computer (Normal)"],
];

const HANDICAPS = [100, 90, 80, 70, 60, 50];

/** Every map we have read, path → info. Module-level, so coming back to the Custom Game
 *  screen doesn't re-read and re-parse the whole install's Maps folder a second time. */
const mapCache = new Map<string, MapInfo>();
/** …and the minimap markers of the maps that were actually picked. */
const previewCache = new Map<string, MapPreview | null>();
/** The folders whose maps have all been read — the only ones the list may show (openFolder). */
const readFolders = new Set<string>();
/** The install's unit table, loaded on the first map picked (it says which neutral buildings
 *  earn a minimap glyph). Module-level for the same reason as the map cache. */
let registry: UnitRegistry | null = null;

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
  const entries = mapEntries(maps);
  const icons = loadIcons(vfs);
  const minimapIcons = loadMinimapIcons(vfs);
  // The folder the list is showing. WC3 opens on the expansion's own maps folder — that is
  // where a Frozen Throne install's melee maps live.
  let cwd = entries.some((e) => e.folder.toLowerCase() === "frozenthrone") ? "FrozenThrone" : "";
  let strings: FdfLibrary | null = null; // for "(up one level)" — GlobalStrings' UP_ONE_LEVEL

  // Screen state. The FDF screen rebuilds its DOM on every resize, so this — not the DOM —
  // is the source of truth; `onBuild` re-fills the widgets from it each time.
  let selected: { path: string; file: File; info: MapInfo } | null = null;
  let preview: MapPreview | null = null; // the selected map's minimap markers
  let slots: Slot[] = [];
  let groups: Group[] = []; // the player rows, under the map's own force headings
  let maxSlots = 0;
  let localIndex = 0; // which row is YOU — the first slot the map lets a human take
  let listScroll = 0; // where the map list stands, kept across the screen's rebuilds
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

  /** The chosen map's preview markers (gold mines, shops, start locations). Reading them
   *  means unpacking the map's terrain header and its placed units, so it happens for the
   *  ONE map the player picked — never for the whole folder the list is showing. */
  const readPreview = (path: string, file: File): void => {
    const cached = previewCache.get(path);
    if (cached !== undefined) { preview = cached; return; }
    preview = null;
    void (async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      registry ??= loadUnitRegistry(vfs);
      const read = readMapPreview(bytes, (id) => registry?.get(id)?.minimapIcon ?? false);
      previewCache.set(path, read);
      if (!alive || selected?.path !== path) return;
      preview = read;
      if (selected) fillMapInfo(screen, selected.info, preview, minimapIcons);
    })();
  };

  const chooseMap = async (path: string, screen: FdfScreen): Promise<void> => {
    const file = maps.get(path);
    const info = await readMap(path);
    if (!file || !info) return;
    selected = { path, file, info };
    readPreview(path, file);
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
    // The whole screen is rebuilt below (the rows and their headings are frames, and there
    // are now a different number of them), which throws the map list's DOM away with it.
    // Remember where the list stood so it comes back exactly there.
    listScroll = screen.list("MapListBox")?.scrollTop ?? 0;
    screen.relayout();
  };

  /**
   * Walk into a folder (or back out of one): the list is a directory browser.
   *
   * A folder is READ BEFORE it is shown. Every row's name, icon and player count live inside
   * the map file, and the maps are what the folder is sorted BY — so posting the rows first
   * and refreshing them as the reads landed meant the player watched "(4)LostTemple" become
   * "Lost Temple" and jump up the list under their cursor. The list goes quiet (empty, and
   * answering nothing) until its folder is in, and then it is right the first time.
   */
  const openFolder = async (folder: string, screen: FdfScreen): Promise<void> => {
    cwd = folder;
    listScroll = 0; // a new folder starts at its top
    fillList(screen); // empty + disabled: this folder has not been read yet
    await readFolder(folder);
    if (!alive || cwd !== folder) return; // the player left, or moved on to another folder
    fillList(screen);
  };

  const screen = await mountFdfScreen({
    container,
    vfs,
    fdfPath: "UI\\FrameDef\\Glue\\Skirmish.fdf",
    rootFrame: "Skirmish",
    includeFdf: [MAP_LIST_FDF, MAP_INFO_FDF, PLAYER_SLOT_FDF],
    // The engine composes this screen from four files; so do we.
    buildRoot: (lib) => { strings = lib; return buildSkirmishRoot(lib, groups); },
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

  void openFolder(cwd, screen);

  return screen;

  /**
   * Read every map in `folder`: a row shows the map's OWN name ("Booty Bay", not
   * "(2)BootyBay"), its player count and whether it is melee or custom, and all four live
   * INSIDE the map file. Each map is read once — `mapCache` is module-level, so a folder
   * visited twice is instant the second time.
   */
  async function readFolder(folder: string): Promise<void> {
    for (const e of entries.filter((x) => x.folder === folder)) {
      if (!alive) return; // the player left; stop reading files for a screen that is gone
      try {
        const info = await readMap(e.path);
        if (!info) continue;
        e.label = info.name || e.label;
        e.melee = info.isMelee;
        if (info.maxPlayers) e.players = info.maxPlayers;
      } catch (err) {
        console.warn(`[OpenWar3] couldn't read ${e.path}:`, err);
      }
    }
    if (alive) readFolders.add(folder);
  }

  /** Put the current folder's rows in the list box, where the player left it. A folder whose
   *  maps are still being read shows nothing and takes no clicks — see openFolder. */
  function fillList(s: FdfScreen): void {
    const list = s.list("MapListBox");
    if (!list) return;
    const ready = readFolders.has(cwd);
    const upOneLevel = strings?.string("UP_ONE_LEVEL") ?? "(up one level)";
    list.setItems(ready ? folderRows(entries, cwd).map((r) => toListItem(r, icons, upOneLevel)) : []);
    list.setEnabled(ready);
    if (selected) list.select(selected.path);
    list.scrollTop = listScroll;
  }

  /** (Re)fill every widget from the state above — called after each build/rebuild. */
  function fill(s: FdfScreen): void {
    const list = s.list("MapListBox");
    if (list) {
      fillList(s);
      // A single click only ever SELECTS a row. Opening one takes a second click: a folder
      // is walked into on a double-click, a map is played on one.
      list.onChange = (value) => { if (!value.startsWith("folder:")) void chooseMap(value, s); };
      list.onActivate = (value) => {
        if (value.startsWith("folder:")) void openFolder(value.slice("folder:".length), s);
        else start();
      };
    }
    // Nothing picked yet: no map to start.
    s.setEnabled("PlayGameButton", !!selected);
    // Advanced Options (handicaps, random races, tournament rules…) is a screen of its own
    // that we don't have. Grey it out rather than leave a button that answers to nothing.
    s.setEnabled("MapInfoButton", false);
    if (!selected) return;

    fillMapInfo(s, selected.info, preview, minimapIcons);
    // The map names its own forces ("Forest Task Force", "Monolithic Creeps"); the frames are
    // there, this puts the names in them.
    groups.forEach((g, i) => { if (g.name) s.setText(forceLabelName(i), g.name); });

    const teams = teamOptions(maxSlots);
    const fixed = selected.info.fixedPlayerSettings;
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

/** Fill the map-info pane: the badge, minimap, the three stat rows and the blurb. */
function fillMapInfo(s: FdfScreen, info: MapInfo, preview: MapPreview | null, icons: MinimapIcons): void {
  s.setText("MaxPlayersValue", String(info.maxPlayers));
  s.setText("MapNameValue", info.name);
  s.setText("SuggestedPlayersValue", info.recommendedPlayers || `${info.maxPlayers} players`);
  // "Map Size" is a WORD, not a measurement: the game buckets a map by its player count
  // (UI\MiscData.txt [BattleNetCustomFilter]), which is how a 1v1 reads "Small".
  s.setText("MapSizeValue", mapSizeLabel(info.maxPlayers));
  s.setText("MapTilesetValue", TILESETS[info.tileset] ?? info.tileset ?? "—");
  s.setText("MapDescValue", info.description || "");
  centreNameRow(s);

  // The minimap comes out of the MAP's own archive, not the install's, so it can't go
  // through the renderer's VFS-path sprite table — paint it straight onto the SPRITE frame.
  const el = s.frame("MinimapImage");
  if (!el) return;
  const canvas = info.minimap ? blpToCanvas(info.minimap) : null;
  if (canvas && preview) drawPreviewMarkers(canvas, info, preview, icons);
  el.style.background = canvas ? `url(${canvas.toDataURL()}) center/contain no-repeat` : "#000";
}

/**
 * Centre the name row — the player-count badge, the map's name, the author's badge — as one
 * group over the pane. The engine sizes a TEXT frame to its TEXT and then anchors it, so the
 * three sit shoulder to shoulder whatever the name's length; our layout solver gives a text
 * frame a fixed box instead, so the row has to be measured once the name is in.
 *
 * A name too long for the pane WRAPS ("Funny Bunny's Egg Hunt" wants two lines) and the row
 * grows UPWARDS to hold it — its bottom stays where it was, so the minimap below never moves.
 * (Clipping the overflow, which is what a fixed box does, hid half the name.)
 */
function centreNameRow(s: FdfScreen): void {
  const badge = s.frame("MaxPlayersIcon");
  const name = s.frame("MapNameValue");
  const author = s.frame("AuthIcon");
  const pane = s.frame("MapInfoPane");
  const span = name?.querySelector("span");
  if (!badge || !name || !author || !pane || !span) return;

  // The box the FDF gave the name, kept aside: every fill starts from it, or a two-line name
  // would leave the row taller for the one-line name after it.
  const baseTop = parseFloat(name.dataset.baseTop ?? (name.dataset.baseTop = name.style.top));
  const baseH = parseFloat(name.dataset.baseH ?? (name.dataset.baseH = name.style.height));

  const gap = badge.offsetWidth * 0.13; // the FDF's 0.0025 against the badge's own 0.01875
  const room = pane.clientWidth - 2 * (badge.offsetWidth + gap);

  span.style.whiteSpace = "nowrap"; // measure the name as ONE line…
  const natural = Math.ceil(span.getBoundingClientRect().width);
  span.style.whiteSpace = "";
  const width = Math.min(natural, Math.floor(room)); // …and give it that, or the room it has

  name.style.width = `${width}px`;
  const height = Math.max(baseH, Math.ceil(span.getBoundingClientRect().height) + 2);
  name.style.height = `${height}px`;
  name.style.top = `${baseTop + baseH - height}px`; // grow up: the row's BOTTOM is the anchor

  const left = Math.round((pane.clientWidth - (badge.offsetWidth + gap + width + gap + author.offsetWidth)) / 2);
  badge.style.left = `${left}px`;
  name.style.left = `${left + badge.offsetWidth + gap}px`;
  author.style.left = `${left + badge.offsetWidth + gap + width + gap}px`;
  // The badges sit on the middle of the name, however many lines it runs to.
  const middle = baseTop + baseH - height / 2;
  badge.style.top = `${middle - badge.offsetHeight / 2}px`;
  author.style.top = `${middle - author.offsetHeight / 2}px`;
}

/** Stamp the lobby's markers onto a copy of the map's own minimap picture. */
function drawPreviewMarkers(canvas: HTMLCanvasElement, info: MapInfo, preview: MapPreview, icons: MinimapIcons): void {
  const g = canvas.getContext("2d");
  if (!g) return;
  // The picture covers the whole terrain rect, so world → picture is a straight remap
  // (north is up: the minimap's +v runs the other way from the world's +y).
  const stamp = (art: HTMLCanvasElement | null, x: number, y: number, size: number, tint?: string): void => {
    if (!art) return;
    const px = ((x - preview.minX) / preview.width) * canvas.width;
    const py = (1 - (y - preview.minY) / preview.height) * canvas.height;
    if (px < 0 || py < 0 || px > canvas.width || py > canvas.height) return;
    g.drawImage(tint ? tinted(art, tint) : art, px - size / 2, py - size / 2, size, size);
  };
  const s = canvas.width * 0.05; // the reference's glyphs are ~1/20th of the picture across
  for (const m of preview.markers) {
    stamp(m.kind === "gold" ? icons.gold : icons.building, m.x, m.y, s);
  }
  // Start locations last and larger — the one thing on this map you are looking for.
  for (const slot of info.slots) {
    stamp(icons.start, slot.startX, slot.startY, s * 1.2, PLAYER_COLORS[slot.id % PLAYER_COLORS.length]);
  }
}

/** A white glyph (MinimapIconStartLoc is a mask) painted in a player's colour. */
function tinted(art: HTMLCanvasElement, colour: string): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = art.width;
  out.height = art.height;
  const g = out.getContext("2d");
  if (!g) return out;
  g.drawImage(art, 0, 0);
  g.globalCompositeOperation = "source-in"; // keep the mask's alpha, replace its colour
  g.fillStyle = colour;
  g.fillRect(0, 0, out.width, out.height);
  return out;
}

/** The lobby preview's glyphs — the RoC icon set the engine keeps for this screen. */
interface MinimapIcons {
  gold: HTMLCanvasElement | null;
  building: HTMLCanvasElement | null;
  start: HTMLCanvasElement | null;
}

function loadMinimapIcons(vfs: DataSource): MinimapIcons {
  const icon = (path: string): HTMLCanvasElement | null => {
    const bytes = vfs.rawBytes(path);
    return bytes ? blpToCanvas(bytes) : null;
  };
  return {
    gold: icon("UI\\MiniMap\\MiniMapIcon\\MinimapIconGold.blp"),
    building: icon("UI\\MiniMap\\MiniMapIcon\\MinimapIconNeutralBuilding.blp"),
    start: icon("UI\\MiniMap\\MiniMapIcon\\MinimapIconStartLoc.blp"),
  };
}

// --- the map list ------------------------------------------------------------------
//
// The reference's list is a FOLDER BROWSER, not a flat index: it shows one directory at a
// time — "(up one level)", then the sub-folders, then that folder's maps — and the maps are
// ordered by how many players they take (the 2-player maps, then the 4s, then the 6s), with
// the count printed inside the row's own melee badge.

interface MapEntry {
  path: string; // key into the maps table ("Maps\\FrozenThrone\\(2)EchoIsles.w3x")
  folder: string; // "" for the top level
  label: string; // the file's stem to begin with, replaced by the map's own name
  /** Max players. Blizzard's maps carry it in the file name — "(2)EchoIsles" — which is what
   *  the list can sort on before a single map has been read; the map's own w3i replaces it. */
  players: number;
  melee: boolean; // drives the row icon; only known once the map has been read
}

/** Every playable map in the install, with the folder it lives in. */
function mapEntries(maps: Map<string, File>): MapEntry[] {
  const all: MapEntry[] = [...maps.keys()].map((path) => {
    const parts = path.slice(MAPS_PREFIX.length).split("\\");
    const label = baseName(path);
    return {
      path,
      folder: parts.slice(0, -1).join("\\"),
      label,
      players: parseInt(/^\((\d+)\)/.exec(label)?.[1] ?? "0", 10),
      melee: true,
    };
  });
  // Campaign maps aren't skirmish maps — the Campaign screen is a different menu.
  return all.filter((e) => !/(^|\\)campaign(\\|$)/i.test(e.folder));
}

/** The rows for one folder: (up one level), the sub-folders, then the maps. */
function folderRows(entries: MapEntry[], cwd: string): Array<MapEntry | FolderRow> {
  const inCwd = entries.filter((e) => e.folder === cwd);
  const prefix = cwd ? `${cwd}\\` : "";
  const subFolders = [...new Set(
    entries
      .filter((e) => e.folder.startsWith(prefix) && e.folder !== cwd)
      .map((e) => e.folder.slice(prefix.length).split("\\")[0]),
  )].sort();

  const rows: Array<MapEntry | FolderRow> = [];
  if (cwd) rows.push({ folder: parentOf(cwd), up: true });
  for (const name of subFolders) rows.push({ folder: prefix + name, up: false });
  // Ascending by player count, then by name — the reference's order.
  rows.push(...inCwd.sort((a, b) => a.players - b.players || a.label.localeCompare(b.label)));
  return rows;
}

/** A folder row in the list: either a sub-folder, or the "(up one level)" row. */
interface FolderRow {
  folder: string;
  up: boolean;
}

const isFolder = (r: MapEntry | FolderRow): r is FolderRow => (r as FolderRow).up !== undefined;

/** A folder row's value — what the list hands back when it is clicked. */
const folderValue = (r: FolderRow): string => `folder:${r.folder}`;

function parentOf(folder: string): string {
  const parts = folder.split("\\");
  return parts.slice(0, -1).join("\\");
}

function toListItem(r: MapEntry | FolderRow, icons: Icons, upOneLevel: string): ListItem {
  if (isFolder(r)) {
    return {
      value: folderValue(r),
      label: r.up ? upOneLevel : (r.folder.split("\\").pop() ?? r.folder),
      icon: r.up ? icons.up : icons.folder,
    };
  }
  return { value: r.path, label: r.label, icon: icons.map(r.melee, r.players) };
}

interface Icons {
  folder: HTMLCanvasElement | null;
  up: HTMLCanvasElement | null;
  /** A map's badge with its player count printed in it (as MapInfoPane's own MaxPlayersIcon
   *  does — the same art, the same number over it). Melee maps wear the crossed-swords icon
   *  and custom ones the cog, but BOTH carry the count: a custom map takes players too. */
  map(melee: boolean, players: number): HTMLCanvasElement | null;
}

function loadIcons(vfs: DataSource): Icons {
  const icon = (path: string): HTMLCanvasElement | null => {
    const bytes = vfs.rawBytes(path);
    return bytes ? blpToCanvas(bytes) : null;
  };
  const art = { melee: icon(ICON_MELEE), ums: icon(ICON_UMS) };
  const badges = new Map<string, HTMLCanvasElement | null>();
  return {
    folder: icon(ICON_FOLDER),
    up: icon(ICON_FOLDER_UP),
    map(melee: boolean, players: number): HTMLCanvasElement | null {
      const key = `${melee ? "m" : "u"}${players}`;
      if (!badges.has(key)) {
        const base = melee ? art.melee : art.ums;
        badges.set(key, base ? countBadge(base, players) : null);
      }
      return badges.get(key) ?? null;
    },
  };
}

/** The count in a badge is the FDF's own label gold (FontColor 0.99 0.827 0.0705), the
 *  colour every label on these screens is written in — not white. */
const BADGE_GOLD = "#fcd312";

/** The melee badge with `players` stamped in the middle of it. */
function countBadge(art: HTMLCanvasElement, players: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = art.width;
  canvas.height = art.height;
  const g = canvas.getContext("2d");
  if (!g) return canvas;
  g.drawImage(art, 0, 0);
  if (players > 0) {
    g.font = `bold ${Math.round(canvas.height * 0.5)}px ${UI_FONT}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineWidth = 4;
    g.strokeStyle = "rgba(0, 0, 0, 0.9)";
    g.strokeText(String(players), canvas.width / 2, canvas.height * 0.53);
    g.fillStyle = BADGE_GOLD;
    g.fillText(String(players), canvas.width / 2, canvas.height * 0.53);
  }
  return canvas;
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
function buildSkirmishRoot(lib: FdfLibrary, groups: Group[]): FdfFrame {
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
/** Start Game / Cancel: the width of the ornate base, and the button's share of it. The base
 *  fills the slot the chrome leaves it; the button fills the base but for the fleur on its
 *  left and a hair of margin on its right — measured off the reference, where the blue face
 *  runs nearly the whole width of the dark base it sits in. */
const BOTTOM_BUTTON_BASE_W = 0.278;
const BUTTON_TO_BASE = 0.79;

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

/** Slide a frame along x (+y is up), keeping the anchor the FDF gave it. */
function nudgeX(f: FdfFrame | undefined, dx: number): void { nudge(f, 3, dx); }
function nudgeY(f: FdfFrame | undefined, dy: number): void { nudge(f, 4, dy); }

function nudge(f: FdfFrame | undefined, arg: number, by: number): void {
  const point = f && firstProp(f, "SetPoint");
  if (!point || point.args.length < 5) return;
  point.args[arg] = num((point.args[arg].n ?? 0) + by);
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

  // The name row: the player-count badge, then the map's name, then the author badge — the
  // FDF chains all three to each other, so only the badge needs placing, and the row is
  // re-centred on the name's real width once it is in (centreNameRow).
  setProp(findFrame(pane, "MaxPlayersIcon"), "SetPoint", [arg("TOPLEFT"), str("MapInfoPane"), arg("TOPLEFT"), num(0.03), num(-0.004)]);
  size(findFrame(pane, "MapNameValue"), 0.14, 0.019);
  // The count sits INSIDE its badge: the engine sizes the TEXT frame to its digit and then
  // centres it on the icon, which for a frame we size to the icon is the same as centring
  // the text in it. (Left as it comes off StandardSmallTextTemplate, the digit lands on the
  // badge's left rim.)
  const count = findFrame(pane, "MaxPlayersValue");
  size(count, 0.01875, 0.01875);
  setProp(count, "FontJustificationH", [arg("JUSTIFYCENTER")]);

  setProp(findFrame(pane, "MinimapImage"), "SetPoint", [arg("TOP"), str("MapInfoPane"), arg("TOP"), num(0), num(-MINIMAP_TOP)]);

  // The stat rows: label left, value right-justified over the same box (the value's own
  // `SetPoint TOPLEFT <label> TOPLEFT` + JUSTIFYRIGHT is the FDF's own idiom). The block is
  // narrower than the pane and centred in it, so the label and its value read as a pair
  // rather than being flung against the panel's two edges.
  let prev = "";
  let bottom = ROWS_TOP;
  for (const [name, gap] of INFO_ROWS) {
    const row = findFrame(pane, name);
    if (!row) continue;
    size(row, ROW_W, ROW_H);
    if (prev) setProp(row, "SetPoint", [arg("TOPLEFT"), str(prev), arg("BOTTOMLEFT"), num(0), num(-gap)]);
    else setProp(row, "SetPoint", [arg("TOPLEFT"), str("MapInfoPane"), arg("TOPLEFT"), num(ROW_X), num(-ROWS_TOP)]);
    // The FDF sits these rows' text on the BOTTOM of their box (JUSTIFYBOTTOM), which is
    // where the tails of "Suggested Players:" kept meeting the clip. Both halves of a row
    // centre in it instead — they keep their common baseline, and the type keeps its tails.
    setProp(row, "FontJustificationV", [arg("JUSTIFYMIDDLE")]);
    // …the description's "value" is the blurb, though: it is a paragraph, not a value on the
    // end of a line. It keeps its own box (below) and its own JUSTIFYTOP — a paragraph starts
    // at the top of its box and grows down, it does not float in the middle of it.
    if (name !== "MapDescLabel") {
      const value = findFrame(pane, name.replace(/Label$/, "Value"));
      size(value, ROW_W, ROW_H);
      setProp(value, "FontJustificationV", [arg("JUSTIFYMIDDLE")]);
    }
    bottom += gap + ROW_H;
    prev = name;
  }
  // The blurb wraps under its label (the FDF anchors it there itself) and fills what is left
  // of the pane — no more. The pane ENDS where the Advanced Options button begins, so a box
  // any deeper would spill the map's description over the button (a long one, like
  // Turtle Rock's, runs to eight lines). A word too many is clipped, exactly as the engine's
  // FIXEDSIZE text frames clip: the size of the type is not up for negotiation.
  const desc = findFrame(pane, "MapDescValue");
  size(desc, ROW_W, DESC_BOTTOM - bottom - DESC_GAP);
  setProp(desc, "FrameFont", [str("MasterFont"), num(DESC_FONT), str("")]);
  return pane;
}

// The pane's own box (Skirmish.fdf's MapInfoPaneContainer) — every row below is laid out
// against it, and the description gets whatever it leaves.
const PANE_W = 0.234375;
const PANE_H = 0.2875;
/** The minimap, and the stat rows under it — both a little higher than the FDF's own
 *  geometry puts them, to leave the blurb the room a Blizzard-length one needs. */
const MINIMAP_TOP = 0.026;
const ROWS_TOP = 0.162; // where "Suggested Players:" starts, below the minimap
/** The stat block: all but the last hair of the pane's width, and centred in it. */
const ROW_W = 0.2325;
const ROW_X = (PANE_W - ROW_W) / 2;
/** Tall enough for the type it holds — a row cropped to the FDF's 0.015 ate the descenders
 *  of "Suggested Players:" (our text frames clip; they do not spill). */
const ROW_H = 0.019;
const DESC_GAP = 0.002; // MapDescValue's own SetPoint TOP, MapDescLabel BOTTOM, 0, -0.002
/** How far below the pane's top the blurb may run: a shade past the pane's own box, into
 *  the gap Skirmish.fdf leaves between it and the Advanced Options base. Echo Isles' five
 *  lines want it; the button still sits clear underneath. */
const DESC_BOTTOM = PANE_H + 0.014;
/** The blurb's type size. The FDF's StandardSmallTextTemplate says 0.011, but that is sized
 *  for WC3's own font; ours sets wider, so a Blizzard-length description would not fit the
 *  box the game gives it. Smaller type, same box — the reference's proportions survive. */
const DESC_FONT = 0.0085;

/** The map-info pane's stat rows, in order, with the gap above each. */
const INFO_ROWS: Array<[string, number]> = [
  ["SuggestedPlayersLabel", 0],
  ["MapSizeLabel", 0.001],
  ["MapTilesetLabel", 0.001],
  ["MapDescLabel", 0.006],
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
