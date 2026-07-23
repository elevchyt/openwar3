import type { DataSource } from "../vfs/types";
import { blpToCanvas } from "../render/blputil";
import { mapSizeLabel } from "../data/gameplayConstants";
import { parseMapInfo, type MapInfo } from "../world/mapInfo";
import { readMapPreview, type MapPreview } from "../world/mapPreview";
import { loadUnitRegistry, type UnitRegistry } from "../data/units";
import { MAPS_PREFIX } from "../assets/opfs";
import { PLAYER_COLORS } from "./hud";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import { uiFont, type FdfScreen } from "./fdf/render";
import type { ListItem } from "./fdf/widgets";

// The map browser: the folder-browsing map list (MapListBox.fdf) and the map summary pane
// (MapInfoPane.fdf), which are the SAME two widgets on every screen that picks a map.
//
// This started life inside ui/fdfSkirmish.ts and was lifted out when the LAN create screen
// (ui/fdfLanCreate.ts, UI\FrameDef\Glue\LocalMultiplayerCreate.fdf) turned out to be the
// Custom Game screen's left column and right column with the player rows taken out — the
// engine composes both from the same two files, so we compose them from the same code.
//
// The one thing that is NOT shared is the pane's GEOMETRY. Each screen's FDF sizes its own
// MapInfoPaneContainer and they disagree — Skirmish 0.234×0.2875, LocalMultiplayerCreate
// 0.271×0.323, LocalMultiplayerJoin 0.271×0.223 (a compact summary, too short for a map's
// description at all). So `layoutInfoPane` takes the box it is laying out into rather than
// baking Skirmish's numbers in, and takes the list of stat rows that box has room for.

/** Tileset letter → name, as the World Editor lists them (WorldEditStrings tileset names). */
const TILESETS: Record<string, string> = {
  A: "Ashenvale", B: "Barrens", C: "Felwood", D: "Dungeon", F: "Lordaeron Fall",
  G: "Underground", I: "Icecrown", J: "Dalaran Ruins", K: "Black Citadel",
  L: "Lordaeron Summer", N: "Northrend", O: "Outland", Q: "Village Fall",
  V: "Village", W: "Lordaeron Winter", X: "Dalaran", Y: "Cityscape", Z: "Sunken Ruins",
};

// The list's row icons — the game's own (MapInfoPane.fdf names icon-file-melee for the
// player-count badge; the folder/UMS icons sit beside it in UI\Widgets\Glues).
const ICON_FOLDER = "UI\\Widgets\\Glues\\icon-folder.blp";
const ICON_FOLDER_UP = "UI\\Widgets\\Glues\\icon-folder-up.blp";
const ICON_MELEE = "UI\\Widgets\\Glues\\icon-file-melee.blp";
const ICON_UMS = "UI\\Widgets\\Glues\\icon-file-ums.blp";

/** Every map we have read, path → info. Module-level, so coming back to a map-picking
 *  screen doesn't re-read and re-parse the whole install's Maps folder a second time. */
const mapCache = new Map<string, MapInfo>();
/** …and the minimap markers of the maps that were actually picked. */
const previewCache = new Map<string, MapPreview | null>();
/** The folders whose maps have all been read — the only ones a list may show. */
const readFolders = new Set<string>();
/** The install's unit table, loaded on the first map picked (it says which neutral buildings
 *  earn a minimap glyph). Module-level for the same reason as the map cache. */
let registry: UnitRegistry | null = null;

/** A map the player has settled on: the file, and what is inside it. */
export interface ChosenMap {
  path: string;
  file: File;
  info: MapInfo;
}

/** Read a map's w3i (cached across screens and across visits to a screen). */
export async function readMapInfo(maps: Map<string, File>, path: string): Promise<MapInfo | null> {
  const cached = mapCache.get(path);
  if (cached) return cached;
  const file = maps.get(path);
  if (!file) return null;
  const info = parseMapInfo(new Uint8Array(await file.arrayBuffer()), baseName(path));
  mapCache.set(path, info);
  return info;
}

/**
 * The folder-browsing map list and the summary pane beside it, as one piece of state.
 *
 * A screen owns one of these, points `onChange` at its own re-fill, and calls `fill(screen)`
 * from `onBuild` — the FDF screen rebuilds its DOM on every resize, so this object, not the
 * DOM, is where "which folder, which map" lives.
 */
export class MapBrowser {
  private readonly entries: MapEntry[];
  private readonly icons: Icons;
  private readonly minimapIcons: MinimapIcons;
  /** The folder the list is showing. */
  cwd: string;
  /** The map the player picked, or null while none is. */
  selected: ChosenMap | null = null;
  private preview: MapPreview | null = null; // the selected map's minimap markers
  private listScroll = 0; // where the list stands, kept across the screen's rebuilds
  private alive = true; // cleared on dispose, so background reads stop
  private strings: FdfLibrary | null = null; // for "(up one level)" — GlobalStrings

  /** A map was picked, or a folder finished reading: the screen should re-fill itself.
   *  A screen whose frames DEPEND on the map (the Custom Game screen's player rows) relayouts
   *  from here instead. */
  onChange: () => void = () => {};
  /** A map row was activated (double-clicked / Enter) — the screen's "play this one". */
  onActivate: () => void = () => {};

  constructor(
    private readonly vfs: DataSource,
    private readonly maps: Map<string, File>,
  ) {
    this.entries = mapEntries(maps);
    this.icons = loadIcons(vfs);
    this.minimapIcons = loadMinimapIcons(vfs);
    // WC3 opens on the expansion's own maps folder — that is where a Frozen Throne
    // install's melee maps live.
    this.cwd = this.entries.some((e) => e.folder.toLowerCase() === "frozenthrone") ? "FrozenThrone" : "";
  }

  /** Hand over the screen's FDF library, for the strings the list shows. */
  useStrings(lib: FdfLibrary): void {
    this.strings = lib;
  }

  /** Pick a map: reads its w3i and kicks off its minimap preview. */
  async choose(path: string): Promise<void> {
    const file = this.maps.get(path);
    const info = await readMapInfo(this.maps, path);
    if (!file || !info || !this.alive) return;
    this.selected = { path, file, info };
    this.readPreview(path, file);
    this.onChange();
  }

  /**
   * Walk into a folder (or back out of one): the list is a directory browser.
   *
   * A folder is READ BEFORE it is shown. Every row's name, icon and player count live inside
   * the map file, and the maps are what the folder is sorted BY — so posting the rows first
   * and refreshing them as the reads landed meant the player watched "(4)LostTemple" become
   * "Lost Temple" and jump up the list under their cursor. The list goes quiet (empty, and
   * answering nothing) until its folder is in, and then it is right the first time.
   */
  async openFolder(folder: string): Promise<void> {
    this.cwd = folder;
    this.listScroll = 0; // a new folder starts at its top
    this.onChange(); // empty + disabled: this folder has not been read yet
    await this.readFolder(folder);
    if (!this.alive || this.cwd !== folder) return; // the player left, or moved on
    this.onChange();
  }

  /** Fill the map list and the summary pane on `s`. Call from the screen's `onBuild`. */
  fill(s: FdfScreen): void {
    this.fillList(s);
    if (this.selected) this.fillInfo(s);
    else clearMapInfo(s);
  }

  /** Put the current folder's rows in the list box, where the player left it, and wire it.
   *  A folder whose maps are still being read shows nothing and takes no clicks. */
  private fillList(s: FdfScreen): void {
    const list = s.list("MapListBox");
    if (!list) return;
    const ready = readFolders.has(this.cwd);
    const upOneLevel = this.strings?.string("UP_ONE_LEVEL") ?? "(up one level)";
    list.setItems(ready ? folderRows(this.entries, this.cwd).map((r) => toListItem(r, this.icons, upOneLevel)) : []);
    list.setEnabled(ready);
    if (this.selected) list.select(this.selected.path);
    list.scrollTop = this.listScroll;
    // A single click only ever SELECTS a row. Opening one takes a second click: a folder
    // is walked into on a double-click, a map is played on one.
    list.onChange = (value) => {
      if (value.startsWith("folder:")) return;
      // The whole screen may be rebuilt from onChange (the Custom Game screen's rows are
      // frames, and there are now a different number of them), which throws the list's DOM
      // away with it. Remember where it stood so it comes back exactly there.
      this.listScroll = s.list("MapListBox")?.scrollTop ?? 0;
      void this.choose(value);
    };
    list.onActivate = (value) => {
      if (value.startsWith("folder:")) void this.openFolder(value.slice("folder:".length));
      else this.onActivate();
    };
  }

  /** Paint the chosen map into the summary pane. */
  private fillInfo(s: FdfScreen): void {
    if (this.selected) fillMapInfo(s, this.selected.info, this.preview, this.minimapIcons);
  }

  /**
   * The chosen map's preview markers (gold mines, shops, start locations). Reading them
   * means unpacking the map's terrain header and its placed units, so it happens for the
   * ONE map the player picked — never for the whole folder the list is showing.
   */
  private readPreview(path: string, file: File): void {
    const cached = previewCache.get(path);
    if (cached !== undefined) { this.preview = cached; return; }
    this.preview = null;
    void (async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      registry ??= loadUnitRegistry(this.vfs);
      const read = readMapPreview(bytes, (id) => registry?.get(id)?.minimapIcon ?? false);
      previewCache.set(path, read);
      if (!this.alive || this.selected?.path !== path) return;
      this.preview = read;
      this.onChange();
    })();
  }

  /**
   * Read every map in `folder`: a row shows the map's OWN name ("Booty Bay", not
   * "(2)BootyBay"), its player count and whether it is melee or custom, and all four live
   * INSIDE the map file. Each map is read once — the caches are module-level, so a folder
   * visited twice is instant the second time.
   */
  private async readFolder(folder: string): Promise<void> {
    for (const e of this.entries.filter((x) => x.folder === folder)) {
      if (!this.alive) return; // the player left; stop reading files for a screen that is gone
      try {
        const info = await readMapInfo(this.maps, e.path);
        if (!info) continue;
        e.label = info.name || e.label;
        e.melee = info.isMelee;
        if (info.maxPlayers) e.players = info.maxPlayers;
      } catch (err) {
        console.warn(`[OpenWar3] couldn't read ${e.path}:`, err);
      }
    }
    if (this.alive) readFolders.add(folder);
  }

  dispose(): void {
    this.alive = false;
  }
}

// --- the map summary pane -----------------------------------------------------------

/** The frames of the pane that are a MAP's: the name row over the minimap (player-count
 *  badge, name, author badge) and the value half of each stat row. Until one is picked the
 *  pane is only its frame and its labels. */
const NAME_ROW = ["MaxPlayersIcon", "MapNameValue", "AuthIcon"];
const VALUES = ["SuggestedPlayersValue", "MapSizeValue", "MapTilesetValue", "MapDescValue"];

/** No map picked: an empty minimap box under bare labels — nothing of a map is on show, so
 *  the badges that describe one are not either (they are frames, not text, so they are
 *  hidden rather than emptied). */
export function clearMapInfo(s: FdfScreen): void {
  for (const name of NAME_ROW) {
    const el = s.frame(name);
    if (el) el.style.display = "none";
  }
  for (const name of VALUES) s.setText(name, "");
  const minimap = s.frame("MinimapImage");
  if (minimap) minimap.style.background = "none"; // the cover frame's empty box, not a black one
}

/** Fill the map-info pane: the badge, minimap, the three stat rows and the blurb. */
export function fillMapInfo(s: FdfScreen, info: MapInfo, preview: MapPreview | null, icons: MinimapIcons): void {
  for (const name of NAME_ROW) {
    const el = s.frame(name);
    if (el) el.style.display = ""; // back from the empty state — and before centreNameRow measures them
  }
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
export interface MinimapIcons {
  gold: HTMLCanvasElement | null;
  building: HTMLCanvasElement | null;
  start: HTMLCanvasElement | null;
}

export function loadMinimapIcons(vfs: DataSource): MinimapIcons {
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
    g.font = `bold ${Math.round(canvas.height * 0.5)}px ${uiFont()}`;
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

export function baseName(path: string): string {
  const file = path.split("\\").pop() ?? path;
  return file.replace(/\.(w3m|w3x)$/i, "");
}

// --- laying out the summary pane ----------------------------------------------------

/** The stat rows a pane can carry, in order, with the gap above each. A pane too short for
 *  the blurb (LocalMultiplayerJoin's compact summary) asks for the first three. */
export const INFO_ROWS: Array<[string, number]> = [
  ["SuggestedPlayersLabel", 0],
  ["MapSizeLabel", 0.001],
  ["MapTilesetLabel", 0.001],
  ["MapDescLabel", 0.006],
];

/** The pane frames a screen must hide when its pane carries only some of INFO_ROWS — pass
 *  these to `mountFdfScreen`'s `hidden`, alongside the same `rows` given to layoutInfoPane. */
export function paneRowsToHide(rows: Array<[string, number]>): string[] {
  return INFO_ROWS
    .filter(([name]) => !rows.some(([kept]) => kept === name))
    .flatMap(([name]) => [name, name.replace(/Label$/, "Value")]);
}

/** The pane box `layoutInfoPane` is laying out into — its own screen's MapInfoPaneContainer. */
export interface PaneBox {
  /** The container's Width/Height, straight out of that screen's FDF. */
  w: number;
  h: number;
  /** Which of INFO_ROWS this pane has room for. Defaults to all four. */
  rows?: Array<[string, number]>;
  /** How far past the pane's own bottom the blurb may run, into whatever gap the screen
   *  leaves under it. Skirmish leaves a shade before the Advanced Options base. */
  descOverhang?: number;
}

/**
 * Anchor the map-info pane's rows. MapInfoPane.fdf gives the badge, the minimap and the
 * label/value pairs, but only the pairs are anchored to EACH OTHER — where any of it sits
 * in the pane is decided by the engine, so we decide it here (matched to the reference:
 * name badge, minimap, three stat rows, then the blurb).
 *
 * The vertical geometry is FIXED, not scaled to the pane's height, even though the three
 * screens that mount this pane size their containers differently (see the file header). The
 * top block — name row, minimap, stat rows — is a stack of fixed-size art and one-line text
 * that means the same thing at any pane height, and it needs 0.162 + its rows whoever asks.
 * Only the DESCRIPTION is elastic, so a taller pane spends its extra height there and a pane
 * too short for a description does not ask for one (`box.rows`).
 *
 * Scaling it instead pulled the minimap up into the map's name on the short LAN pane.
 */
export function layoutInfoPane(pane: FdfFrame, box: PaneBox): FdfFrame {
  setProp(pane, "SetAllPoints", []);
  const rows = box.rows ?? INFO_ROWS;

  // NOTE: a row this pane has no room for must ALSO be named in the screen's `hidden` list —
  // see `paneRowsToHide`. MapInfoPane.fdf anchors only the label/value PAIRS to each other,
  // never to the pane, so an unplaced row lands at the pane's origin and prints itself over
  // the rows that ARE placed. (Sizing it to nothing is not enough: our text frames overflow a
  // zero box rather than clipping it, so the LAN summary wore Echo Isles' description across
  // its map name.)

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
  const rowW = box.w - 2 * ROW_MARGIN;
  let prev = "";
  let bottom = ROWS_TOP;
  for (const [name, gap] of rows) {
    const row = findFrame(pane, name);
    if (!row) continue;
    size(row, rowW, ROW_H);
    if (prev) setProp(row, "SetPoint", [arg("TOPLEFT"), str(prev), arg("BOTTOMLEFT"), num(0), num(-gap)]);
    else setProp(row, "SetPoint", [arg("TOPLEFT"), str("MapInfoPane"), arg("TOPLEFT"), num(ROW_MARGIN), num(-ROWS_TOP)]);
    // The FDF sits these rows' text on the BOTTOM of their box (JUSTIFYBOTTOM), which is
    // where the tails of "Suggested Players:" kept meeting the clip. Both halves of a row
    // centre in it instead — they keep their common baseline, and the type keeps its tails.
    setProp(row, "FontJustificationV", [arg("JUSTIFYMIDDLE")]);
    // …the description's "value" is the blurb, though: it is a paragraph, not a value on the
    // end of a line. It keeps its own box (below) and its own JUSTIFYTOP — a paragraph starts
    // at the top of its box and grows down, it does not float in the middle of it.
    if (name !== "MapDescLabel") {
      const value = findFrame(pane, name.replace(/Label$/, "Value"));
      size(value, rowW, ROW_H);
      setProp(value, "FontJustificationV", [arg("JUSTIFYMIDDLE")]);
    }
    bottom += gap + ROW_H;
    prev = name;
  }

  // The blurb wraps under its label (the FDF anchors it there itself) and fills what is left
  // of the pane — no more. The pane ENDS where whatever sits under it begins, so a box any
  // deeper would spill the map's description over it (a long one, like Turtle Rock's, runs to
  // eight lines). A word too many is clipped, exactly as the engine's FIXEDSIZE text frames
  // clip: the size of the type is not up for negotiation.
  const desc = findFrame(pane, "MapDescValue");
  const room = box.h + (box.descOverhang ?? 0) - bottom - DESC_GAP;
  size(desc, rowW, Math.max(0, room));
  setProp(desc, "FrameFont", [str("MasterFont"), num(DESC_FONT), str("")]);
  return pane;
}

/** The minimap, and the stat rows under it — both a little higher than the FDF's own
 *  geometry puts them, to leave the blurb the room a Blizzard-length one needs. */
const MINIMAP_TOP = 0.026;
const ROWS_TOP = 0.162; // where "Suggested Players:" starts, below the minimap
/** The stat block is all but the last hair of the pane's width, centred in it. */
const ROW_MARGIN = 0.0009375;
/** Tall enough for the type it holds — a row cropped to the FDF's 0.015 ate the descenders
 *  of "Suggested Players:" (our text frames clip; they do not spill). */
const ROW_H = 0.019;
const DESC_GAP = 0.002; // MapDescValue's own SetPoint TOP, MapDescLabel BOTTOM, 0, -0.002
/** The blurb's type size. The FDF's StandardSmallTextTemplate says 0.011, but that is sized
 *  for WC3's own font; ours sets wider, so a Blizzard-length description would not fit the
 *  box the game gives it. Smaller type, same box — the reference's proportions survive. */
const DESC_FONT = 0.0085;

// --- small FdfFrame helpers ---------------------------------------------------------
//
// Shared by every screen that composes itself out of the game's own templates.

export const arg = (s: string) => ({ s, n: null, str: false });
export const str = (s: string) => ({ s, n: null, str: true });
export const num = (n: number) => ({ s: String(n), n, str: false });

export function findFrame(f: FdfFrame, name: string): FdfFrame | undefined {
  if (f.name === name) return f;
  for (const c of f.children) {
    const hit = findFrame(c, name);
    if (hit) return hit;
  }
  return undefined;
}

/** Set (replacing any existing) a property on a frame. */
export function setProp(f: FdfFrame | undefined, key: string, args: Array<{ s: string; n: number | null; str: boolean }>): void {
  if (!f) return;
  f.props = f.props.filter((p) => p.key !== key);
  f.props.push({ key, args });
}

export function size(f: FdfFrame | undefined, w: number, h: number): void {
  setProp(f, "Width", [num(w)]);
  setProp(f, "Height", [num(h)]);
}

/** Put `children` inside the named container frame. */
export function adopt(root: FdfFrame, container: string, children: FdfFrame[]): void {
  const target = findFrame(root, container);
  if (target) target.children.push(...children);
}

/**
 * Slide a frame along x (or y), keeping the anchor the FDF gave it.
 *
 * Every glue screen needs this for the same reason: the right-hand chrome is a 3D model
 * (render/menuScene.ts) stretched to frame a 16:9 screen, so its panels sit a little left of
 * where these 4:3-authored FDFs put their contents.
 */
export function nudgeX(f: FdfFrame | undefined, dx: number): void { nudge(f, 3, dx); }
export function nudgeY(f: FdfFrame | undefined, dy: number): void { nudge(f, 4, dy); }

function nudge(f: FdfFrame | undefined, index: number, by: number): void {
  const point = f?.props.find((p) => p.key === "SetPoint");
  if (!point || point.args.length < 5) return;
  point.args[index] = num((point.args[index].n ?? 0) + by);
}
