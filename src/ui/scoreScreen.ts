import { blpToCanvas } from "../render/blputil";
import { ScoreScreenScene, type ScoreBar } from "../render/scoreScreenScene";
import { ALLY_FILTER_COLOR } from "../game/allyColor";
import { totalScore, type ScoreRow, type ScoreTable } from "../game/scoreTable";
import { skinVersionSuffix } from "../data/edition";
import { parseWar3Skins, skinValue, WAR3SKINS } from "../data/war3skins";
import type { PlayableRace } from "../data/races";
import type { DataSource } from "../vfs/types";
import type { FdfLibrary } from "./fdf/library";
import type { Arg, FdfFrame } from "./fdf/parser";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import { arg, findFrame, num, setProp, str } from "./mapBrowser";
import { modalOver } from "./modal";

// The SCORE SCREEN (issue #199) — what stands between a FINISHED match and the menu, built from
// the game's own `UI\FrameDef\Glue\ScoreScreen.fdf` and drawn in its own art.
//
// That file declares the furniture and none of the contents, the way Loading.fdf does:
//
//     ScoreScreenBackground / ScoreScreenPageTab   the parchment and the tab flaps — MODELS
//     ScoreScreenRaceArt                           the picture, named at runtime (war3skins)
//     ScoreScreenBarTop                            ONE player row's bar, at TOPLEFT −0.11
//     ScoreScreenTabButton0..3 / TabText0..3       Overview, Units, Heroes, Resources
//     ScoreScreen5ColumnFrame / 4ColumnFrame       the header hot-spots and their captions
//     ScoreScreenTeamsButton, TeamColorButton      sort by team; toggle ally colours
//     ScoreScreenElapsedTimeLabel / Value          "Elapsed Time:"
//     ScoreScreenOkButton                          OK
//
// so every row is stamped here: a bar per player (the models, render/scoreScreenScene.ts), and
// over each bar the name plate's border, the race mark, the team number, the name and the tab's
// figures. The ART is all the game's; the rest of a row's look is measured off the reference
// shots (the four in issue #199) and says so where it is a number.
//
// **The screen is a PICTURE with things printed on it**, exactly like the loading screen, so it
// is mounted `stretchRoot`: the background model is `SetAllPoints` and widens with the window,
// and the header captions — which the BACKGROUND PAINTS the boxes of — have to widen with it.
// Checked against the 16:9 reference: "Units" is centred at 40.75% of the width, which is the
// file's −0.074 off centre stretched and nothing else.
//
// Columns are the game's strings, in the game's order (GlobalStrings.fdf): the Overview tab is
// the FOUR-column layout (`OVERVIEW_COLUMN0..3`, `ScoreScreen-Background`'s `4Button` clip) and
// the other three are FIVE. What fills them is sim/matchStats.ts's to say.

const SCORE_FDF = "UI\\FrameDef\\Glue\\ScoreScreen.fdf";

/** The tab captions' string keys, in tab order — the FDF's own `Text "SCORESCREEN_TAB0"`…. */
const TAB_KEYS = ["SCORESCREEN_TAB0", "SCORESCREEN_TAB1", "SCORESCREEN_TAB2", "SCORESCREEN_TAB3"] as const;
/** The tab captions' x offsets from the background's TOP — the FDF's own, so the selected
 *  caption (`ScoreScreenTabTextSelected`, which the file leaves unplaced) sits where its tab's
 *  plain one would. */
const TAB_X = [-0.20, -0.074, 0.055, 0.18];
const TAB_TEXT_Y = -0.036;

/** One column: its GlobalStrings key and what it prints for a row. */
interface Column {
  key: string;
  value: (r: ScoreRow) => string;
  /** What the column SORTS by, when that is not the printed figure. */
  sort?: (r: ScoreRow) => number;
  /** The Heroes Used column draws icons, not text. */
  heroes?: true;
}

const n = (v: number): string => String(Math.round(v));

const TABS: Column[][] = [
  [
    { key: "OVERVIEW_COLUMN0", value: (r) => n(r.unitScore), sort: (r) => r.unitScore },
    { key: "OVERVIEW_COLUMN1", value: (r) => n(r.heroScore), sort: (r) => r.heroScore },
    { key: "OVERVIEW_COLUMN2", value: (r) => n(r.resourceScore), sort: (r) => r.resourceScore },
    { key: "OVERVIEW_COLUMN3", value: (r) => n(totalScore(r)), sort: totalScore },
  ],
  [
    { key: "UNIT_COLUMN0", value: (r) => n(r.unitsProduced), sort: (r) => r.unitsProduced },
    { key: "UNIT_COLUMN1", value: (r) => n(r.unitsKilled), sort: (r) => r.unitsKilled },
    { key: "UNIT_COLUMN2", value: (r) => n(r.buildingsProduced), sort: (r) => r.buildingsProduced },
    { key: "UNIT_COLUMN3", value: (r) => n(r.buildingsRazed), sort: (r) => r.buildingsRazed },
    { key: "UNIT_COLUMN4", value: (r) => n(r.largestArmy), sort: (r) => r.largestArmy },
  ],
  [
    // Heroes Used sorts by how many heroes, then by the best of them.
    { key: "HEROES_COLUMN0", value: () => "", heroes: true, sort: (r) => r.heroes.length * 1000 + (r.heroes[0]?.level ?? 0) },
    { key: "HEROES_COLUMN1", value: (r) => n(r.heroesKilled), sort: (r) => r.heroesKilled },
    { key: "HEROES_COLUMN2", value: (r) => n(r.itemsObtained), sort: (r) => r.itemsObtained },
    { key: "HEROES_COLUMN3", value: (r) => n(r.mercenariesHired), sort: (r) => r.mercenariesHired },
    { key: "HEROES_COLUMN4", value: (r) => n(r.experienceGained), sort: (r) => r.experienceGained },
  ],
  [
    { key: "RESOURCES_COLUMN0", value: (r) => n(r.goldMined), sort: (r) => r.goldMined },
    { key: "RESOURCES_COLUMN1", value: (r) => n(r.lumberHarvested), sort: (r) => r.lumberHarvested },
    // "sent / received" — sim/matchStats.ts says why that is our reading.
    { key: "RESOURCES_COLUMN2", value: (r) => `${n(r.resourcesSent)} / ${n(r.resourcesReceived)}`, sort: (r) => r.resourcesSent + r.resourcesReceived },
    { key: "RESOURCES_COLUMN3", value: (r) => n(r.techPercent), sort: (r) => r.techPercent },
    { key: "RESOURCES_COLUMN4", value: (r) => n(r.upkeepLost), sort: (r) => r.upkeepLost },
  ],
];

/** The header hot-spots' x offsets from the background's TOP and their widths — ScoreScreen.fdf's
 *  own `ScoreScreen5ColumnButtonN` / `ScoreScreen4ColumnButtonN`. The figures hang under these. */
const COLUMN_X: Record<4 | 5, number[]> = {
  5: [-0.1865, -0.0703, 0.0462, 0.1627, 0.28],
  4: [-0.172, -0.0273, 0.1182, 0.2647],
};
const COLUMN_W: Record<4 | 5, number> = { 5: 0.0935, 4: 0.1225 };

// --- a row, measured -----------------------------------------------------------------------
//
// `ScoreScreen-TopBar.mdx` is 0.0373 tall with its border and 0.032 without; the FDF hangs the
// first from the screen's TOPLEFT at −0.11, and the reference stacks the rest 0.032 apart (36 px
// a row at 675 px, 40 at 768 — each the bar's own 0.032 × the screen's px/unit), so the borders
// overlap and every row shares its neighbour's rule.

/** The first bar's top edge, down from the top of the screen — the FDF's `ScoreScreenBarTop`. */
const BAR_TOP = 0.11;
/** `ScoreScreen-TopBar.mdx`'s whole height, border included. */
const BAR_HEIGHT = 0.0373;
/** …and its coloured strip alone, which is also the pitch the rows are stacked at. */
const ROW_PITCH = 0.032;
/** The strip's top edge sits this far under the border's. */
const STRIP_INSET = BAR_HEIGHT - ROW_PITCH;
/** How many rows fit above the OK button — the FDF's scroll bar is 0.38 tall. Past it the screen
 *  stops drawing rows; no stock map seats more than 12, and 12 × 0.032 is 0.384. */
const MAX_ROWS = 12;

/** The name plate's border (`ScoreScreenBannerWin`/`Loss`, a 256×64 strip whose 43-texel band IS
 *  the strip's 0.032): drawn 4:1 at 0.19 wide and centred on the strip, which puts its arrow on
 *  the arrow `scorescreen-bar-background.blp` paints into the plate. Measured. */
const BANNER_W = 0.19;
const BANNER_H = BANNER_W / 4;
/** The race mark (`scorescreen-player-<race>.blp`): a framed portrait 59×36 texels across the
 *  middle of a 64² texture, whose FRAME the references measure at 0.026 × 0.016 (at 4:3 and 16:9
 *  alike, so it stretches with the screen) — which makes the whole texture 0.0282 × 0.0284. The
 *  team number sits INSIDE that frame, in the dark right end of the portrait, centred 0.0245 in,
 *  and the name starts at 0.031. Measured off the reference shots. */
const MARK_X = 0.002;
const MARK_W = 0.0282;
const MARK_H = 0.0284;
const TEAM_CENTRE = 0.0245;
const TEAM_W = 0.008;
const NAME_X = 0.031;
const NAME_W = 0.13;
/** The row's type: the references' capitals stand 0.0078 tall, which `StandardValueTextTemplate`'s
 *  MasterFont sets at 0.012 (its own 0.013 measured 0.0085 here). */
const ROW_FONT = 0.012;
/** The Heroes Used icons: one per hero, the level beside it, as the reference draws them. */
const HERO_ICON = 0.0185;
const HERO_STEP = 0.034;

export interface ScoreScreenOptions {
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  vfs: DataSource;
  table: ScoreTable;
  /** Whose screen this is — that row is printed in gold, and its race picks the picture. Null
   *  for a watcher. */
  localPlayer: number | null;
  onOk: () => void;
}

export interface ScoreScreen {
  dispose(): void;
}

/** Which war3skins section a race's art lives in. */
const SKIN: Record<PlayableRace, string> = { human: "Human", orc: "Orc", undead: "Undead", nightelf: "NightElf" };

/** Put the score screen up. Resolves once its art is decoded. */
export async function mountScoreScreen(opts: ScoreScreenOptions): Promise<ScoreScreen> {
  const { vfs, table } = opts;
  const skins = (() => {
    const bytes = vfs.rawBytes(WAR3SKINS);
    return bytes ? parseWar3Skins(new TextDecoder("latin1").decode(bytes)) : new Map<string, Map<string, string>>();
  })();
  const skin = (section: string, key: string): string | undefined => skinValue(skins, section, key);

  // The picture: the LOCAL player's race in victory (`ScoreScreenVictory_V1` in its section, the
  // edition's twin on Reign of Chaos), `ScoreScreenDefeat` in defeat. A watcher won nothing and
  // lost nothing, and is shown the side that won.
  const me = table.rows.find((r) => r.player === opts.localPlayer) ?? null;
  const featured = me ?? table.rows.find((r) => r.won) ?? null;
  const victorious = !!featured?.won;
  const raceSection = featured ? SKIN[featured.race] : "Default";
  const art = victorious
    ? skin(raceSection, "ScoreScreenVictory" + skinVersionSuffix()) ?? skin(raceSection, "ScoreScreenVictory")
    : skin("Default", "ScoreScreenDefeat");

  const scene = new ScoreScreenScene(opts.canvas, vfs);
  await scene.load(art ?? null);
  scene.start();

  // …and the race's own victory or defeat theme over it (`VictoryMusic_V1` / `DefeatMusic_V1`,
  // the same versioned keys). Played by the caller, which owns the sound board — see `music`.

  /** The screen's state: which tab, what the rows are sorted by, and whether ally colours are on. */
  let tab = 0;
  /** A column of the tab that is up, or the Teams box. The reference opens on the FIRST column,
   *  highest first — every shot has one header lit and none of them is Teams — and keeps the
   *  column's place when the tab changes (the Heroes tab opens on Heroes Used). */
  let sortBy: number | "team" = 0;
  let allyColors = false;

  const overrides: Record<string, string> = {};
  const hidden: string[] = [];
  const blp = cachedBlp(vfs);

  const sorted = (): ScoreRow[] => {
    const rows = [...table.rows];
    if (sortBy === "team") rows.sort((a, b) => a.team - b.team || a.player - b.player);
    else {
      const col = TABS[tab][Math.min(sortBy, TABS[tab].length - 1)];
      const key = col?.sort ?? (() => 0);
      rows.sort((a, b) => key(b) - key(a) || a.team - b.team || a.player - b.player);
    }
    return rows.slice(0, MAX_ROWS);
  };

  /** The bar colour a row wears: its own, or — with the ally-colour button down — the filter's
   *  three (game/allyColor.ts `ALLY_FILTER_COLOR`: you blue, your allies teal, the rest red). */
  const barColor = (r: ScoreRow): number => {
    if (!allyColors || opts.localPlayer === null) return r.color;
    if (r.player === opts.localPlayer) return ALLY_FILTER_COLOR.self;
    // Allied is TEAMMATE here: the match is over, and the screen sorts and numbers by team too.
    const mine = table.rows.find((x) => x.player === opts.localPlayer);
    return mine && mine.team === r.team ? ALLY_FILTER_COLOR.ally : ALLY_FILTER_COLOR.enemy;
  };

  const lib = { strings: null as FdfLibrary | null };
  const text = (key: string, fallback: string): string => {
    const v = lib.strings?.string(key);
    return v && v !== key ? v : fallback;
  };

  const refresh = (): void => {
    const columns = TABS[tab];
    const width: 4 | 5 = columns.length === 4 ? 4 : 5;
    const rows = sorted();
    // The art: which tab flap is up, which header strip is painted, and one bar per row.
    scene.setTab(tab, width);
    scene.setBars(rows.map((r, i): ScoreBar => ({ y: 0.6 - BAR_TOP - BAR_HEIGHT - i * ROW_PITCH, color: barColor(r) })));
    // The frames that are not this tab's.
    hidden.length = 0;
    hidden.push(width === 4 ? "ScoreScreen5ColumnFrame" : "ScoreScreen4ColumnFrame");
    hidden.push(`ScoreScreenTabText${tab}`); // its gold twin (TabTextSelected) stands in its place
    // No replay is recorded (see ui/fdfViewReplay.ts), so there is nothing to save — the
    // reference shows OK alone in that case too. The scroll bar has nothing to scroll.
    hidden.push("ScoreScreenSaveReplayButton", "ScoreScreenReplaySavedButton", "ScoreScreenScrollBar");
    for (const k of Object.keys(overrides)) delete overrides[k];
    overrides.ScoreScreenTabTextSelected = text(TAB_KEYS[tab], "");
    overrides.ScoreScreenElapsedTimeValue = elapsed(table.elapsed);
    columns.forEach((c, i) => {
      overrides[`ScoreScreen${width}ColumnHeader${i}`] = text(c.key, c.key);
    });
    rows.forEach((r, i) => {
      overrides[`ScoreRowTeam${i}`] = String(r.team + 1);
      overrides[`ScoreRowName${i}`] = r.name;
      columns.forEach((c, j) => {
        if (c.heroes) {
          r.heroes.forEach((h, k) => { overrides[`ScoreRowHeroLevel${i}_${k}`] = String(h.level); });
        } else overrides[`ScoreRowValue${i}_${j}`] = c.value(r);
      });
    });
    screen?.relayout();
  };

  /** OK, however it was pressed — once. The screen then fades to black under the caller (main.ts
   *  `showScoreScreen`), and a second Enter or click in that beat must not ask to leave again. */
  let left = false;
  const ok = (): void => {
    if (left) return;
    left = true;
    opts.onOk();
  };

  let screen: FdfScreen | null = null;
  const built = await mountFdfScreen({
    container: opts.container,
    vfs,
    fdfPath: SCORE_FDF,
    rootFrame: "ScoreScreenFrame",
    stretchRoot: true,
    overlayClass: "fdf-score",
    buildRoot: (l) => {
      lib.strings = l;
      // How much wider than 4:3 the screen is drawn (fdf/layout.ts `stretchBox`) — see the hero icons.
      const c = opts.container;
      const stretch = Math.max(1, (c.clientWidth || innerWidth) / (c.clientHeight || innerHeight) / (4 / 3));
      return buildRoot(l, tab, sorted(), opts.localPlayer, stretch);
    },
    hidden,
    textOverrides: overrides,
    handlers: {
      ScoreScreenOkButton: ok,
      ScoreScreenTabButton0: () => { tab = 0; refresh(); },
      ScoreScreenTabButton1: () => { tab = 1; refresh(); },
      ScoreScreenTabButton2: () => { tab = 2; refresh(); },
      ScoreScreenTabButton3: () => { tab = 3; refresh(); },
      ScoreScreenTeamColorButton: () => { allyColors = !allyColors; refresh(); },
    },
    onBuild: (s) => paint(s),
  });
  screen = built;
  refresh();

  // OK is the screen's only way out, and it answers ENTER and ESCAPE as well as its own "O"
  // (the FDF's ControlShortcutKey, wired by the renderer): the dialog's default button and its
  // cancel are the same button here. Pressed as a CLICK on the button, so the keys make exactly
  // the sound and take exactly the path the mouse does. In the capture phase, so an Enter with
  // the button focused is not answered twice (the button's own keydown handler).
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Enter" && e.key !== "Escape") return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
    if (modalOver(built.element)) return;
    e.preventDefault();
    e.stopPropagation();
    if (left) return;
    built.frame("ScoreScreenOkButton")?.click();
  };
  window.addEventListener("keydown", onKey, true);

  /** Everything a build needs that is not text: the plates, the marks, the hero icons, and which
   *  header box is ticked. */
  function paint(s: FdfScreen): void {
    const rows = sorted();
    const columns = TABS[tab];
    const width = columns.length === 4 ? 4 : 5;
    rows.forEach((r, i) => {
      const plate = skin("Default", r.won ? "ScoreScreenBannerWin" : "ScoreScreenBannerLoss");
      setArt(s.frame(`ScoreRowBanner${i}`), plate ? blp(plate) : null);
      setArt(s.frame(`ScoreRowMark${i}`), blp(skin("Default", `ScoreScreenPlayer${SKIN[r.race]}`) ?? ""));
      const heroCol = columns.findIndex((c) => c.heroes);
      if (heroCol >= 0) r.heroes.forEach((h, k) => setArt(s.frame(`ScoreRowHero${i}_${k}`), blp(h.icon)));
    });
    // The header boxes are radio buttons over the painted strip: the one the rows are sorted by
    // wears its highlight (`CheckBoxCheckHighlight`), and Teams is the first of them.
    const teams = s.checkBox("ScoreScreenTeamsButton");
    if (teams) {
      teams.checked = sortBy === "team";
      teams.onChange = () => { sortBy = "team"; refresh(); };
    }
    columns.forEach((_, i) => {
      const box = s.checkBox(`ScoreScreen${width}ColumnButton${i}`);
      if (!box) return;
      box.checked = sortBy !== "team" && Math.min(sortBy, columns.length - 1) === i;
      box.onChange = () => { sortBy = i; refresh(); };
    });
    setArt(s.frame("ScoreScreenTeamColorIcon"), blp(skin("Default", allyColors ? "MiniMapAllyButtonActiveEnabled" : "MiniMapAllyButtonInactiveEnabled") ?? ""));
  }

  return {
    dispose(): void {
      window.removeEventListener("keydown", onKey, true);
      scene.dispose();
      built.dispose();
    },
  };
}

/** The music the screen plays: the featured race's victory or defeat theme (war3skins, versioned
 *  like every other theme there — see ui/glueAudio.ts). */
export function scoreScreenMusic(vfs: DataSource, table: ScoreTable, localPlayer: number | null): string | null {
  const bytes = vfs.rawBytes(WAR3SKINS);
  if (!bytes) return null;
  const skins = parseWar3Skins(new TextDecoder("latin1").decode(bytes));
  const me = table.rows.find((r) => r.player === localPlayer) ?? table.rows.find((r) => r.won) ?? null;
  const section = me ? SKIN[me.race] : "Default";
  const key = (me?.won ? "VictoryMusic" : "DefeatMusic") + skinVersionSuffix();
  const path = skinValue(skins, section, key)?.split(";")[0];
  return path && vfs.exists(path) ? path : null;
}

/** "Elapsed Time:" — always h:mm:ss, as the reference prints it ("0:12:52", "1:36:41"). */
function elapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const two = (v: number): string => String(v).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}

function cachedBlp(vfs: DataSource): (path: string) => string | null {
  const cache = new Map<string, string | null>();
  return (path) => {
    if (!path) return null;
    if (cache.has(path)) return cache.get(path)!;
    const bytes = vfs.rawBytes(path);
    const canvas = bytes ? blpToCanvas(bytes) : null;
    const url = canvas ? canvas.toDataURL() : null;
    cache.set(path, url);
    return url;
  };
}

function setArt(el: HTMLElement | null, url: string | null): void {
  if (!el) return;
  el.style.background = url ? `url(${url}) center/100% 100% no-repeat` : "";
}

/**
 * ScoreScreen.fdf's frame with this tab's rows stamped onto it, and the selected tab's gold
 * caption placed over its flap.
 */
function buildRoot(lib: FdfLibrary, tab: number, rows: ScoreRow[], localPlayer: number | null, stretch: number): FdfFrame {
  const root = lib.resolveRoot("ScoreScreenFrame");
  if (!root) throw new Error("ScoreScreen.fdf: no ScoreScreenFrame frame");
  const panel = findFrame(root, "ScoreScreenMainPanel") ?? root;
  // The file hangs a SCROLLBAR off the panel for a roster longer than the page, which the
  // renderer turns into a scrolling FRAME (fdf/render.ts) — a scroll bar standing at the screen's
  // right edge over the art. Twelve seats fit (see MAX_ROWS), so there is never anything to
  // scroll, and the reference shows no bar.
  panel.children = panel.children.filter((c) => c.type !== "SCROLLBAR");

  // The selected tab's caption — `ScoreScreenTabTextSelectedTemplate`, larger and brighter —
  // which the file declares and leaves for the engine to put over whichever tab is up.
  setProp(findFrame(root, "ScoreScreenTabTextSelected"), "SetPoint", [
    arg("TOP"), str("ScoreScreenBackground"), arg("TOP"), num(TAB_X[tab]), num(TAB_TEXT_Y),
  ]);

  // The ally-colour button wears the minimap button's own face (MiniMapAllyButton*), which is the
  // gold pauldron the reference shows on it; a child frame so the backdrop's border stays on top.
  const colorButton = findFrame(root, "ScoreScreenTeamColorButton");
  if (colorButton) colorButton.children.push(blank("ScoreScreenTeamColorIcon", [
    arg("CENTER"), str("ScoreScreenTeamColorButton"), arg("CENTER"), num(0), num(0),
  ], 0.016, 0.016));

  const columns = TABS[tab];
  const width: 4 | 5 = columns.length === 4 ? 4 : 5;
  rows.forEach((r, i) => {
    // The strip's middle, down from the top of the screen.
    const mid = BAR_TOP + STRIP_INSET + ROW_PITCH / 2 + i * ROW_PITCH;
    const at = (x: number): Arg[] => [
      arg("LEFT"), str("ScoreScreenFrame"), arg("TOPLEFT"), num(x), num(-mid),
    ];
    panel.children.push(blank(`ScoreRowBanner${i}`, at(0), BANNER_W, BANNER_H));
    panel.children.push(blank(`ScoreRowMark${i}`, at(MARK_X), MARK_W, MARK_H));
    // Your own row is printed in the label gold (StandardLabelTextTemplate), everybody else's in
    // the value white — the reference's "WildKard" against "Sorcerers' League".
    const gold = r.player === localPlayer;
    const style = gold ? "StandardLabelTextTemplate" : "StandardValueTextTemplate";
    panel.children.push(label(lib, `ScoreRowTeam${i}`, style, at(TEAM_CENTRE - TEAM_W / 2), TEAM_W, ROW_PITCH, ROW_FONT, "JUSTIFYCENTER"));
    panel.children.push(label(lib, `ScoreRowName${i}`, style, at(NAME_X), NAME_W, ROW_PITCH, ROW_FONT, "JUSTIFYLEFT"));
    columns.forEach((c, j) => {
      const cx = 0.4 + COLUMN_X[width][j]; // the header box's centre, from the screen's left
      if (c.heroes) {
        // An icon is a GLYPH, not part of the picture: the 16:9 reference draws it square where
        // the row it sits in is stretched, so its width is taken back out of the stretch. Its
        // PLACE stretches like everything else (the three sit 0.035 apart at either aspect).
        const iconW = HERO_ICON / stretch;
        r.heroes.slice(0, 3).forEach((_, k) => {
          const x = cx - COLUMN_W[width] / 2 + 0.006 + k * HERO_STEP;
          panel.children.push(blank(`ScoreRowHero${i}_${k}`, at(x), iconW, HERO_ICON));
          panel.children.push(label(lib, `ScoreRowHeroLevel${i}_${k}`, style, at(x + iconW + 0.002), 0.012, ROW_PITCH, ROW_FONT, "JUSTIFYLEFT"));
        });
        return;
      }
      panel.children.push(label(
        lib, `ScoreRowValue${i}_${j}`, style,
        [arg("CENTER"), str("ScoreScreenFrame"), arg("TOPLEFT"), num(cx), num(-mid)],
        COLUMN_W[width], ROW_PITCH, ROW_FONT, "JUSTIFYCENTER",
      ));
    });
  });
  return root;
}

/** An empty FRAME to paint a picture into (`setArt`). */
function blank(name: string, point: Arg[], w: number, h: number): FdfFrame {
  return {
    type: "FRAME", name, inherits: null, withChildren: false, children: [],
    props: [
      { key: "SetPoint", args: point },
      { key: "Width", args: [num(w)] },
      { key: "Height", args: [num(h)] },
    ],
  };
}

/** A TEXT frame off one of the game's own text templates, placed and sized for a row. */
function label(
  lib: FdfLibrary, name: string, template: string, point: Arg[],
  w: number, h: number, size: number, justify: string,
): FdfFrame {
  const f = lib.resolveRoot(template) ?? {
    type: "TEXT", name, inherits: null, withChildren: false, children: [], props: [],
  };
  f.name = name;
  setProp(f, "SetPoint", point);
  setProp(f, "Width", [num(w)]);
  setProp(f, "Height", [num(h)]);
  setProp(f, "FontJustificationH", [arg(justify)]);
  const font = f.props.find((p) => p.key === "FrameFont");
  if (font && font.args[1]) font.args[1] = num(size);
  return f;
}
