import { blpToCanvas } from "../render/blputil";
import { LoadingScene } from "../render/loadingScene";
import {
  GENERIC_LOADING_SCREEN, loadLoadingScreens, multiplayerLoadingScreen,
  type LoadingScreenDef,
} from "../data/loadingScreens";
import { RACE_LABEL, type Race } from "../data/races";
import type { DataSource } from "../vfs/types";
import type { MapInfo } from "../world/mapInfo";
import { cloneNamespaced, FdfLibrary } from "./fdf/library";
import type { FdfFrame } from "./fdf/parser";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import type { MapPreview } from "../world/mapPreview";
import type { MeleeConfig, SlotConfig } from "./lobby";
import {
  adopt, arg, drawPreviewMarkers, findFrame, loadMinimapIcons, num, setProp, str,
  type MinimapIcons,
} from "./mapBrowser";

// The LOADING SCREEN (issue #78) — what stands between the menus and the match, built from
// the game's own `UI\FrameDef\Glue\Loading.fdf`.
//
// That file declares the screen and fills almost none of it, the same way Skirmish.fdf and
// GameChatroom.fdf do:
//
//     Frame "SPRITE" "LoadingBackground"       ← the picture (render/loadingScene.ts)
//     Frame "SPRITE" "LoadingBar"              ← …and the load bar over it, with its caption
//     Frame "FRAME"  "LoadingCustomPanel"      ← title / subtitle / blurb, from the MAP's w3i
//     Frame "FRAME"  "LoadingMeleePanel"       ← minimap, map name, game type, the roster
//     Frame "FRAME"  "LoadingPlayerSlot"       ← one stamped per player, at top level
//
// The two panels are alternatives, not layers: a MELEE game gets the roster (the reference
// screenshot — a minimap on the left, the players grouped under "Team 1"/"Team 2"), and
// everything else — a scenario, and every campaign chapter — gets the custom panel's three
// lines of text on the right of the art. WC3 hides whichever it isn't showing; so do we.
//
// **The screen is a PICTURE with things printed on it**, which is why it is the one screen
// mounted with `stretchRoot` (see fdf/layout.ts `stretchBox`): its background sprite is
// `SetAllPoints`, so on a wide screen the art widens, and the minimap and the roster and the
// bar have to widen with it or they stop sitting where the art says they sit. Checked against
// the reference shot at 16:10 — the minimap frame, a square 0.16 × 0.16 in the file, is drawn
// there 1.2× wider than tall, which is exactly that stretch and nothing else.

const LOADING_FDF = "UI\\FrameDef\\Glue\\Loading.fdf";

/** The pitch of the roster: one player row, and one team heading over a run of them. The row
 *  itself is the FDF's own 0.0217 tall; the rest is the gap the reference leaves between the
 *  name plates, and a heading is a line of `StandardLabelTextTemplate` (0.013) plus its lead. */
const ROW_PITCH = 0.03;
const HEADING_PITCH = 0.0175;

/**
 * How far the bar's caption drops from the point `Loading.fdf` anchors it at, in world units.
 *
 * OUR correction, not the file's: WC3 centres the glyph RUN in the bar, and CSS centres the
 * LINE BOX. A line box carries descent space under the baseline that an all-caps string
 * ("L  O  A  D  I  N  G", "WAITING FOR OTHER PLAYERS") never occupies, so centring the box
 * leaves the caps sitting high in it — measured at 720p, the caps spanned y 636…646 against a
 * bar whose fill quad centres on 643. A fifth of the type size puts them back on it, and being
 * a fraction of the FONT rather than a pixel count it holds at every resolution.
 */
const BAR_TEXT_NUDGE = 0.2 * 0.013; // 0.013 is StandardLabelTextTemplate's own FrameFont size

export interface LoadingScreenOptions {
  container: HTMLElement;
  /** The canvas the background art and the load bar are drawn into. */
  canvas: HTMLCanvasElement;
  vfs: DataSource;
  /** The map about to be played — its minimap, its name, and what it says its screen is. */
  info: MapInfo;
  /** The seating, for the roster and for whose race the melee screen wears. */
  config: MeleeConfig;
  /**
   * The CAMPAIGN's own title lines, when there are any. A chapter's w3i carries them too, but
   * the campaign index is the better source for the same reason it is for the quest log's
   * header: the map calls itself "NightElfX01" and the index calls it "Rise of the Naga".
   */
  title?: string;
  subtitle?: string;
}

export interface LoadingScreen {
  /** Move the bar. `0` is empty, `1` full. */
  setProgress(p: number): void;
  /**
   * OUR load is done: the bar fills, and the caption becomes "WAITING FOR OTHER PLAYERS" if any
   * seat is still dark — which is exactly what the reference says while it holds for the last
   * machine to arrive (`LOADING_WAITING_FOR_PLAYERS`).
   */
  finish(): void;
  /** A remote machine reported in (src/game/loadGate.ts): light the seat its peer sits in, and
   *  drop the waiting caption once nobody is left to wait for. */
  setPeerReady(peer: number): void;
  /** The map's own gold mines, shops and start locations, once its bytes have been read —
   *  stamped onto the minimap picture exactly as the lobby's preview stamps them. */
  setMinimapPreview(preview: MapPreview | null): void;
  dispose(): void;
}

/** Put the loading screen up. Resolves once its art is decoded, so the caller reveals a
 *  finished picture rather than a black frame that fills in a beat later. */
export async function mountLoadingScreen(opts: LoadingScreenOptions): Promise<LoadingScreen> {
  const { vfs, info, config } = opts;

  const scene = new LoadingScene(opts.canvas, vfs);
  await scene.load(await chooseBackground(vfs, info, config));
  scene.start();

  const rows = rosterRows(config);
  const melee = info.isMelee;
  // GlobalStrings.fdf, read up front — for the handful of captions the ENGINE fills in rather
  // than the FDF ("Team %d", "Computer", the game types), and BEFORE the screen is mounted
  // because those captions have to be in hand as `textOverrides` (see `captions`).
  const lib = new FdfLibrary(vfs);
  await lib.load(LOADING_FDF);

  /**
   * Which seats wear the green band — `LoadingPlayerSlotReadyHighlight`, the reference's
   * "this one is in" marker.
   *
   * Lit from the first frame for every seat THIS MACHINE can vouch for: a COMPUTER (there is
   * nobody to wait for and nothing for it to load), our own (we are plainly here), and any
   * human seat with no relay peer behind it — a single-player game's rows are ours as much as
   * the computers' are. What is left is exactly the OTHER machines in a LAN game, and each of
   * those lights when its own `ready` reaches us (src/game/loadGate.ts).
   *
   * A `Set` of row indices rather than a class left on the DOM, because the screen rebuilds
   * itself on every resize and the bands have to come back with it — which is also why this
   * is declared BEFORE the mount: `onBuild` fires from inside it.
   */
  const ready = new Set<number>();
  const local = localSlot(config)?.id;
  rows.forEach((row, i) => {
    const remote = row.slot.peer !== undefined && row.slot.id !== local;
    if (!remote || row.slot.controller === "computer") ready.add(i);
  });

  /** Mutable on purpose: `mountFdfScreen` re-reads this on every build, which is how the load
   *  bar's caption can change and be re-measured for its new string (see `setCaption`). */
  const overrides = captions(opts, rows, melee, (k, f) => string(lib, k, f));

  // The minimap's markers arrive a beat after the screen does — they are read out of the map
  // file, which is the first thing the load does — so they live here and are re-stamped by
  // every build (a resize rebuilds the DOM and would otherwise drop them).
  const icons = melee ? loadMinimapIcons(vfs) : null;
  let preview: MapPreview | null = null;

  const screen = await mountFdfScreen({
    container: opts.container,
    vfs,
    fdfPath: LOADING_FDF,
    rootFrame: "Loading",
    // The picture's own coordinate space, stretched to the screen — see the file header.
    stretchRoot: true,
    // …and it must survive `body.in-game`, which the match sets on its way in while this is
    // still the only thing on screen (style.css hides the GLUE screens on that class).
    overlayClass: "fdf-loading",
    buildRoot: (built) => buildLoadingRoot(built, rows, melee),
    hidden: [melee ? "LoadingCustomPanel" : "LoadingMeleePanel"],
    /**
     * Every caption goes in as an OVERRIDE rather than being written in afterwards, because
     * these frames declare no size and the layout is what gives them one: a TEXT frame with a
     * Width and no Height wraps to that width and is as tall as the wrap makes it. Set the
     * text after the layout has run and the box was measured against an EMPTY string — which
     * is one line tall, and a campaign chapter's blurb is five, so four of them are clipped
     * away and the one that survives sits half out of the box.
     */
    textOverrides: overrides,
    onBuild: (s) => {
      if (!melee) return;
      paintMinimap(s, info, preview, icons);
      paintReady(s, ready);
    },
  });

  /** Our own load is over — which is what turns "L O A D I N G" into the waiting caption. */
  let loaded = false;

  /**
   * The bar's caption: the file's own while we are loading, and the game's own waiting line
   * once WE are done and somebody else is not (both are GlobalStrings keys `Loading.fdf`
   * already names).
   *
   * Swapped through the overrides and a RELAYOUT rather than through `setText`, because
   * `LoadingBarText` declares no Width: the engine auto-sizes a TEXT frame to its string and so
   * do we, at layout time. Write the longer caption straight into the box measured for
   * "L O A D I N G" and it is clipped to about "WAITING FOR OTH".
   */
  const setCaption = (key: string, fallback: string): void => {
    const next = string(lib, key, fallback);
    if (overrides.LoadingBarText === next) return;
    overrides.LoadingBarText = next;
    screen.relayout();
  };
  const refreshCaption = (): void => {
    // Only ever forwards. The last player arriving does NOT put "L O A D I N G" back up: our
    // load finished a moment ago, so that would be a lie, and the screen is on its way out
    // anyway — a caption that flips back for the beat before the match appears is just flicker.
    if (loaded && ready.size < rows.length) setCaption("LOADING_WAITING_FOR_PLAYERS", "WAITING FOR OTHER PLAYERS");
    else if (!loaded) setCaption("LOADING_LOADING", "L  O  A  D  I  N  G");
  };

  return {
    setProgress: (p) => scene.setProgress(p),
    finish(): void {
      loaded = true;
      scene.setProgress(1);
      refreshCaption();
    },
    setPeerReady(peer): void {
      rows.forEach((row, i) => { if (row.slot.peer === peer) ready.add(i); });
      paintReady(screen, ready);
      refreshCaption();
    },
    setMinimapPreview(next): void {
      preview = next;
      if (melee) paintMinimap(screen, info, preview, icons);
    },
    dispose(): void {
      scene.dispose();
      screen.dispose();
    },
  };
}

/** Put the green band on the seats in `ready` and take it off the rest. */
function paintReady(s: FdfScreen, ready: ReadonlySet<number>): void {
  for (let i = 0; ; i++) {
    const band = s.frame(`LoadingPlayerSlotReadyHighlight${i}`);
    if (!band) return;
    band.classList.toggle("fdf-highlight-on", ready.has(i));
  }
}

/**
 * Which picture goes up, in the order the engine settles it:
 *
 *   1. the map's OWN imported model, if it shipped one — a map that imported art means it;
 *   2. the `[LoadingScreens]` row it named (`MapLoadingScreen.screen`) — every campaign
 *      chapter, and any scenario that picked one in the editor;
 *   3. on a melee map, which names neither, the LOCAL player's race — `Load-Multiplayer-Orc`
 *      and friends, `-Random` included, because that screen is about who you are;
 *   4. and failing all of it, the generic screen.
 */
async function chooseBackground(
  vfs: DataSource, info: MapInfo, config: MeleeConfig,
): Promise<{ path: string; sequence: number }> {
  if (info.loading.model && vfs.exists(info.loading.model)) {
    return { path: info.loading.model, sequence: 0 };
  }
  if (info.loading.screen >= 0) {
    const table: LoadingScreenDef[] = await loadLoadingScreens(vfs);
    const def = table[info.loading.screen];
    // The sequence is half the row: one campaign background serves a whole campaign and the
    // clip is what lights up THIS chapter's location on the map (data/loadingScreens.ts).
    if (def && vfs.exists(def.model)) return { path: def.model, sequence: def.sequence };
  }
  if (info.isMelee) {
    const path = multiplayerLoadingScreen(localRace(config));
    if (vfs.exists(path)) return { path, sequence: 0 };
  }
  return { path: GENERIC_LOADING_SCREEN, sequence: 0 };
}

/** THIS MACHINE's seat. `localPlayer` states it in a LAN match, where every human slot says
 *  `user` and only that field tells two clients apart; single player has one and needs none. */
function localSlot(config: MeleeConfig): SlotConfig | undefined {
  return config.localPlayer !== undefined
    ? config.slots.find((s) => s.id === config.localPlayer)
    : config.slots.find((s) => s.controller === "user");
}

/** The race the melee screen wears: this machine's own. `random` is a screen of its own —
 *  the art is a question mark, not a rolled race, because the roll is the match's secret. */
function localRace(config: MeleeConfig): Race {
  return localSlot(config)?.race ?? "random";
}

/** One line of the roster: a player, or the heading over a team's run of them. */
interface RosterRow {
  slot: SlotConfig;
  /** The team this row opens, when it is the first of that team — else null. */
  heading: number | null;
}

/**
 * The roster, grouped by TEAM in team order — which is how the reference lists it, under
 * "Team 1" / "Team 2" headings.
 *
 * Only SEATED players are on it: a map's neutral and rescuable players ride in the config
 * (see MapInfo.neutralPlayers) and are nobody's seat, so the reference shows no row for them
 * any more than the lobby does.
 */
function rosterRows(config: MeleeConfig): RosterRow[] {
  const seated = config.slots.filter((s) => s.controller === "user" || s.controller === "computer");
  const teams = [...new Set(seated.map((s) => s.team))].sort((a, b) => a - b);
  const out: RosterRow[] = [];
  for (const team of teams) {
    let first = true;
    for (const slot of seated.filter((s) => s.team === team)) {
      out.push({ slot, heading: first ? team : null });
      first = false;
    }
  }
  // A one-team map is not a team game, and the reference prints no heading over a roster that
  // has nothing to divide (a melee map's forces are one nameless force — MapInfo.forces).
  return teams.length > 1 ? out : out.map((r) => ({ ...r, heading: null }));
}

/** Loading.fdf plus a stamped `LoadingPlayerSlot` per player in the melee panel's container. */
function buildLoadingRoot(lib: FdfLibrary, rows: RosterRow[], melee: boolean): FdfFrame {
  const root = lib.resolveRoot("Loading");
  if (!root) throw new Error("Loading.fdf: no Loading frame");
  if (melee) adopt(root, "LoadingMeleePlayerContainer", buildRoster(lib, rows));
  // The file's own `SetPoint BOTTOM, "Loading", BOTTOM, 0.0, 0.057`, dropped by the caps
  // correction — see BAR_TEXT_NUDGE.
  setProp(findFrame(root, "LoadingBarText"), "SetPoint", [
    arg("BOTTOM"), str("Loading"), arg("BOTTOM"), num(0), num(0.057 - BAR_TEXT_NUDGE),
  ]);
  return root;
}

/**
 * The player rows, stacked and CENTRED on the container's anchor.
 *
 * `LoadingMeleePlayerContainer` declares a Width and no Height and anchors its own LEFT point
 * — a zero-height line the engine hangs the roster off — so the block is centred on it rather
 * than hung from a top edge. That is what keeps a two-player game and an eight-player one both
 * sitting in the middle of the panel the background art paints.
 */
function buildRoster(lib: FdfLibrary, rows: RosterRow[]): FdfFrame[] {
  const slot = lib.resolveRoot("LoadingPlayerSlot");
  if (!slot) return [];
  const height = rows.reduce((h, r) => h + ROW_PITCH + (r.heading === null ? 0 : HEADING_PITCH), 0);

  const built: FdfFrame[] = [];
  let y = 0;
  rows.forEach((row, i) => {
    if (row.heading !== null) {
      const label = lib.resolveRoot("StandardLabelTextTemplate");
      if (label) {
        label.name = `LoadingTeamLabel${i}`;
        setProp(label, "Width", [num(0.2)]);
        setProp(label, "Height", [num(HEADING_PITCH)]);
        place(label, height / 2 - y);
        built.push(label);
        y += HEADING_PITCH;
      }
    }
    // Every child of the row anchors to the row BY NAME, so each copy has to carry its own
    // names or all eight rows chain off the last one's widgets (see cloneNamespaced).
    const clone = cloneNamespaced(slot, String(i));
    place(clone, height / 2 - y);
    built.push(clone);
    y += ROW_PITCH;
  });
  return built;

  function place(f: FdfFrame, dy: number): void {
    setProp(f, "SetPoint", [
      arg("TOPLEFT"), str("LoadingMeleePlayerContainer"), arg("LEFT"), num(0), num(dy),
    ]);
  }
}

/** Everything this screen prints, by frame name — see the `textOverrides` note at the mount. */
function captions(
  opts: LoadingScreenOptions, rows: RosterRow[], melee: boolean, text: Strings,
): Record<string, string> {
  const { info, config } = opts;
  // The bar's caption is the FDF's own `Text "LOADING_LOADING"` — stated here anyway so that
  // the one caption that CHANGES is owned by the overrides from the first build (`setCaption`).
  const bar = { LoadingBarText: text("LOADING_LOADING", "L  O  A  D  I  N  G") };
  if (!melee) {
    // The custom panel: the three lines the MAP carries, with the campaign index's title
    // winning where it has one, and the map's own name standing in for a scenario that
    // filled none of them.
    return {
      ...bar,
      LoadingTitleText: opts.title || info.loading.title || info.name,
      LoadingSubtitleText: opts.subtitle || info.loading.subtitle,
      LoadingText: info.loading.text,
    };
  }
  const out: Record<string, string> = {
    ...bar,
    LoadingMeleeMapName: config.mapName ?? info.name,
    LoadingMeleeGameTypeValue: gameType(rows, text),
  };
  rows.forEach((row, i) => {
    if (row.heading !== null) {
      out[`LoadingTeamLabel${i}`] = text("TEAM_FORMAT", "Team %d").replace("%d", String(row.heading + 1));
    }
    out[`LoadingPlayerSlotName${i}`] = playerLabel(row.slot, text);
    out[`LoadingPlayerSlotRace${i}`] = RACE_LABEL[row.slot.race];
    // LoadingPlayerSlotLevel is the ladder level Battle.net puts beside a name. A local game
    // has no ladder, so it stays empty — as it does in the real client's local games.
  });
  return out;
}

/**
 * The map's own minimap image (war3mapMap.blp) with the lobby's own glyphs stamped on it — a
 * ball on every gold mine, a house on every neutral building the unit table marks as worth
 * visiting, and each start location as a cross in that player's colour (world/mapPreview.ts).
 * The reference's loading screen carries the same three, and it is the same drawing code the
 * Custom Game screen's preview uses, because it is the same picture.
 *
 * Painted onto the frame rather than declared as a sprite: the picture is bytes out of the MAP
 * archive, not a path in the install, so it cannot ride in on `mountFdfScreen`'s `sprites`.
 */
function paintMinimap(
  s: FdfScreen, info: MapInfo, preview: MapPreview | null, icons: MinimapIcons | null,
): void {
  const art = info.minimap ? blpToCanvas(info.minimap) : null;
  const box = s.frame("MinimapImage");
  if (!art || !box) return;
  if (preview && icons) drawPreviewMarkers(art, info, preview, icons);
  box.style.background = `url(${art.toDataURL()}) 0 0/100% 100% no-repeat`;
}

/** A GlobalStrings lookup with a literal to fall back on. */
type Strings = (key: string, fallback: string) => string;

/** `FdfLibrary.string` answers with the KEY itself when it has no such entry; this answers
 *  with something printable instead. */
function string(lib: FdfLibrary, key: string, fallback: string): string {
  const value = lib.string(key);
  return value === key ? fallback : value;
}

/** Who is in the seat: their own name, else what they are. */
function playerLabel(slot: SlotConfig, text: Strings): string {
  if (slot.playerName) return slot.playerName;
  if (slot.controller === "computer") return text("COMPUTER", "Computer");
  return `${text("PLAYER", "Player")} ${slot.id + 1}`;
}

/**
 * What the "Game Type:" line reads.
 *
 * The field exists for Battle.net, where it names the ladder type, and the three names it can
 * take are all in the game's own GlobalStrings — `ONE_ON_ONE`, `FREE_FOR_ALL`, `MELEE`. A local
 * game has no ladder to ask, so the SEATING answers instead: two players on two sides is a
 * one-on-one, three or more each on their own side is a free-for-all, and anything with a team
 * in it is melee. (Only a melee map ever shows this line at all — a scenario gets the custom
 * panel, which has no such row.)
 */
function gameType(rows: RosterRow[], text: Strings): string {
  const teams = new Set(rows.map((r) => r.slot.team)).size;
  if (rows.length === 2 && teams === 2) return text("ONE_ON_ONE", "One on One");
  if (teams === rows.length && rows.length > 2) return text("FREE_FOR_ALL", "Free For All");
  return text("MELEE", "Melee");
}
