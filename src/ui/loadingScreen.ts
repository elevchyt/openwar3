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
import type { MeleeConfig, SlotConfig } from "./lobby";
import { adopt, arg, num, setProp, str } from "./mapBrowser";

// The LOADING SCREEN (issue #110) — what stands between the menus and the match, built from
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
  /** The load is done: every seat lights up its "ready" band, as the reference's do. */
  finish(): void;
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
    textOverrides: captions(opts, rows, melee, (k, f) => string(lib, k, f)),
    onBuild: (s) => { if (melee) paintMinimap(s, info); },
  });

  let ready = false;
  const markReady = (): void => {
    for (let i = 0; i < rows.length; i++) {
      screen.frame(`LoadingPlayerSlotReadyHighlight${i}`)?.classList.add("fdf-highlight-on");
    }
  };

  return {
    setProgress: (p) => scene.setProgress(p),
    finish(): void {
      if (ready) return;
      ready = true;
      scene.setProgress(1);
      markReady();
    },
    dispose(): void {
      scene.dispose();
      screen.dispose();
    },
  };
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

/** The race the melee screen wears: THIS machine's seat. `random` is a screen of its own —
 *  the art is a question mark, not a rolled race, because the roll is the match's secret. */
function localRace(config: MeleeConfig): Race {
  const mine = config.localPlayer !== undefined
    ? config.slots.find((s) => s.id === config.localPlayer)
    : config.slots.find((s) => s.controller === "user");
  return mine?.race ?? "random";
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
  if (!melee) {
    // The custom panel: the three lines the MAP carries, with the campaign index's title
    // winning where it has one, and the map's own name standing in for a scenario that
    // filled none of them.
    return {
      LoadingTitleText: opts.title || info.loading.title || info.name,
      LoadingSubtitleText: opts.subtitle || info.loading.subtitle,
      LoadingText: info.loading.text,
    };
  }
  const out: Record<string, string> = {
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

/** The map's own minimap image (war3mapMap.blp), which is what the reference shows here. It
 *  is bytes out of the MAP archive rather than a path in the install, so it can't ride in on
 *  `mountFdfScreen`'s `sprites` and is painted onto the frame after each build. */
function paintMinimap(s: FdfScreen, info: MapInfo): void {
  const art = info.minimap ? blpToCanvas(info.minimap) : null;
  const box = s.frame("MinimapImage");
  if (art && box) box.style.background = `url(${art.toDataURL()}) 0 0/100% 100% no-repeat`;
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
