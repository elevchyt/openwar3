import {
  Check, ChevronLeft, ChevronRight, Dices, Download, Globe, Map as MapIcon, User,
  createElement as lucideIcon, type IconNode,
} from "lucide";
import type { DataSource } from "../vfs/types";
import { mountFdfScreen, type FdfScreen, type FdfScreenHandlers } from "./fdf/render";
import type { Arg, FdfFrame } from "./fdf/parser";
import { cloneNamespaced, type FdfLibrary } from "./fdf/library";
import { OW3_STRINGS, REPLAY_BROWSER_DIALOG_OVERRIDE } from "../overrides";
import { blpToCanvas } from "../render/blputil";
import { setGameTip } from "./gameTip";
import { mountWorking } from "./workingIndicator";
import { PLAYER_COLORS } from "./hud";
import { collectionCatalog, type CatalogRace, type ReplayCatalog, type SharedReplay, type SharedSeat } from "./replayCatalog";

// The View Replay screen's way to the REPLAY COLLECTION (replays-server/, docs/replays.md "The
// collection"): a globe button beside the screen's title, and the "Download Replays" dialog it
// opens. Nothing in 1.30.4 has either, so all of it is ours, in the Download Maps dialog's dress
// (ui/mapSitesPanel.ts): the Battle.net dialogue box, glue controls out of StandardTemplates.fdf
// (ReplayBrowserDialog.fdf), Lucide's icons (lucide.dev, ISC) in the label's gold.
//
// It is a TABLE — the developer's pick out of three layouts: a filter over each thing a replay is
// found by (map, player, race, OpenWar3 version), one row a replay, and prev/next PAGES instead
// of a scroll bar. A row says the map, who played and as what, how long, on which version and
// when; its one button brings the replay down into the player's own replay folder, where the
// View Replay list picks it up (`keep`).
//
// A RANDOM player is shown as what the match rolled — the race's symbol, as on the View Replay
// screen's own player list — with a die in front of it, and says both in its hover ("Random —
// rolled Orc"). The race filter's "Random" finds the seats that PICKED Random.

const DIALOG_FDF = "UI\\FrameDef\\Glue\\DialogWar3.fdf";
export const REPLAY_BROWSER_TITLE = "Download Replays";

/** Rows a page: what ReplayBrowserDialog.fdf's `RBResults` holds at `ROW_PITCH`. Ours. */
const PAGE_ROWS = 9;
const ROW_PITCH = 0.032;
/** `RBResults`' width in FDF units — the scale a row's own type is sized from. */
const RESULTS_W = 0.608;

const num = (v: number): Arg => ({ s: String(v), n: v, str: false });
const str = (v: string): Arg => ({ s: v, n: null, str: true });

/** The race menu's entries after "Any race": Random, then the four — with the symbol each wears
 *  (the campaign screens' `<X>Symbol.blp`, as beside a name on the View Replay screen). */
const RACES: Array<{ id: CatalogRace; name: string; symbol?: string }> = [
  { id: "random", name: "Random" },
  { id: "human", name: "Human", symbol: "Human" },
  { id: "orc", name: "Orc", symbol: "Orc" },
  { id: "undead", name: "Undead", symbol: "Undead" },
  { id: "nightelf", name: "Night Elf", symbol: "NightElf" },
];

function findFrame(f: FdfFrame, name: string): FdfFrame | undefined {
  if (f.name === name) return f;
  for (const c of f.children) {
    const hit = findFrame(c, name);
    if (hit) return hit;
  }
  return undefined;
}

/** A Lucide icon, sized and coloured by the label it stands in (style.css `.ow3-sites-icon`). */
function icon(node: IconNode, cls = "ow3-sites-icon"): SVGElement {
  const svg = lucideIcon(node, { "stroke-width": 2.25, "aria-hidden": "true" });
  svg.classList.add(cls);
  return svg;
}

/** Dress the View Replay screen's `ReplayOnlineButton` (ViewReplayScreen.fdf): Lucide's globe
 *  over the plain glue face, as the hotkey editor's cog is put over its button. */
export function dressReplayBrowserButton(btn: HTMLElement): void {
  setGameTip(btn, REPLAY_BROWSER_TITLE);
  if (!btn.querySelector(".ow3-hk-cog")) btn.append(icon(Globe, "ow3-hk-cog"));
}

/** A row's Download button, as the player last left it. */
type RowState = { done: boolean; busy: boolean };

/** What the dialog shows — kept OUTSIDE the screen, because every relayout throws the whole DOM
 *  away and builds it again from this. */
interface Model {
  player: string;
  map: string;
  race: CatalogRace | "";
  version: string;
  page: number;
  rows: SharedReplay[];
  total: number;
  versions: string[];
  loading: boolean;
  note: string;
  got: Map<string, RowState>;
  status: string;
}

function mmss(sec: number): string {
  return sec > 0 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}` : "—";
}
function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
/** The file a downloaded replay is kept as: the map and when it was played, the way the game's
 *  own autosaved replays are named. */
function fileName(r: SharedReplay): string {
  const d = new Date(r.recordedAt);
  const p = (n: number): string => String(n).padStart(2, "0");
  const when = Number.isNaN(d.getTime()) ? "" : ` ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  return `${r.map || "Replay"}${when}.o3r`;
}

export async function showReplayBrowser(opts: {
  container: HTMLElement;
  vfs: DataSource;
  catalog?: ReplayCatalog;
  /** Keep a downloaded replay; resolves to the name it is listed under, or null when it could
   *  not be kept. */
  keep: (name: string, bytes: Uint8Array) => Promise<string | null>;
  onClosed?: () => void;
}): Promise<{ close(): void }> {
  const catalog = opts.catalog ?? collectionCatalog();
  const scrim = document.createElement("div");
  scrim.className = "glue-dialog-scrim dimmed ow3-sites-scrim ow3-rb";
  opts.container.appendChild(scrim);

  const model: Model = {
    player: "", map: "", race: "", version: "", page: 0, rows: [], total: 0, versions: [],
    loading: true, note: "", got: new Map(), status: "",
  };
  // Both are read by the renderer on every build, so a row's handler is put here BEFORE the
  // relayout that draws it (ui/fdf/render.ts `wireButton`).
  const handlers: FdfScreenHandlers = {};
  const texts: Record<string, string> = {
    ReplayBrowserTitle: REPLAY_BROWSER_TITLE,
    RBDoneButtonText: "Done",
    RBPrevText: "",
    RBNextText: "",
  };

  /** Race symbols as data URLs, decoded once per dialog. */
  const symbols = new Map<string, string>();
  const symbolOf = (race: string): string => {
    let url = symbols.get(race);
    if (url === undefined) {
      const name = RACES.find((r) => r.id === race)?.symbol;
      const bytes = name ? opts.vfs.rawBytes(`UI\\Glues\\Loading\\Backgrounds\\Campaigns\\${name}Symbol.blp`) : null;
      const c = bytes ? blpToCanvas(bytes) : null;
      symbols.set(race, (url = c ? c.toDataURL() : ""));
    }
    return url;
  };
  const raceName = (race: string): string => RACES.find((r) => r.id === race)?.name ?? race;

  let screen: FdfScreen | null = null;
  let open = true;
  let timer = 0;
  let abort: AbortController | null = null;

  const pages = (): number => Math.max(1, Math.ceil(model.total / PAGE_ROWS));
  const say = (msg: string): void => { model.status = msg; paintStatus(); };
  /** The foot's line: the last thing that happened, else where in the list this page is. */
  const paintStatus = (): void => {
    const first = model.page * PAGE_ROWS;
    const count = model.total ? `${first + 1}–${first + model.rows.length} of ${model.total} replay${model.total === 1 ? "" : "s"}` : "";
    screen?.setText("RBStatus", model.status || count);
  };

  const relayout = (): void => {
    if (!screen) return;
    // A relayout builds new edit boxes: the one being typed in gets its focus and caret back.
    const active = document.activeElement as HTMLInputElement | null;
    const box = active?.closest<HTMLElement>("[data-frame]")?.dataset.frame;
    const caret = active?.selectionStart ?? null;
    screen.relayout();
    const next = box ? screen.frame(box)?.querySelector("input") : null;
    if (next) {
      next.focus();
      if (caret !== null) next.setSelectionRange(caret, caret);
    }
  };

  const query = (): void => {
    window.clearTimeout(timer);
    abort?.abort();
    const mine = (abort = new AbortController());
    model.loading = true;
    const back = screen?.frame("RBResultsBackdrop");
    if (back && !back.querySelector(".ow3-working")) mountWorking(back);
    catalog.search({ player: model.player.trim(), map: model.map.trim(), race: model.race, version: model.version, page: model.page, pageSize: PAGE_ROWS }, mine.signal).then(
      (res) => {
        if (!open || mine.signal.aborted) return;
        // The last page went away under a filter change made elsewhere: step back onto one.
        const last = Math.max(0, Math.ceil(res.total / PAGE_ROWS) - 1);
        if (model.page > last) { model.page = last; return query(); }
        Object.assign(model, { rows: res.rows, total: res.total, versions: res.versions, loading: false });
        model.note = res.total ? "" : model.player || model.map || model.race || model.version ? "No replay matches these filters." : "No replays have been shared yet.";
        relayout();
      },
      (err: Error) => {
        if (!open || mine.signal.aborted) return;
        Object.assign(model, { rows: [], total: 0, loading: false, note: `Could not reach the replay collection: ${err.message}` });
        relayout();
      },
    );
  };
  /** A filter changed: back to the first page — at once, or once the typing has paused. */
  const refilter = (wait = 0): void => {
    model.page = 0;
    model.status = "";
    window.clearTimeout(timer);
    if (wait) timer = window.setTimeout(query, wait);
    else query();
  };

  // --- the frame tree for this build ---
  const buildRoot = (lib: FdfLibrary): FdfFrame => {
    const root = lib.resolveRoot("ReplayBrowserDialog");
    if (!root) throw new Error("ReplayBrowserDialog.fdf: no ReplayBrowserDialog frame");
    const host = findFrame(root, "RBResults");
    const row = lib.resolveRoot("RBRow");
    if (host && row) {
      model.rows.forEach((r, i) => {
        const c = cloneNamespaced(row, `_r${i}`);
        c.props.push({ key: "SetPoint", args: [str("TOPLEFT"), str("RBResults"), str("TOPLEFT"), num(0), num(-i * ROW_PITCH)] });
        host.children.push(c);
        texts[`RBRowGetText_r${i}`] = "";
        handlers[`RBRowGet_r${i}`] = () => void download(r, i);
      });
    }
    return root;
  };

  const rowState = (r: SharedReplay): RowState => model.got.get(r.id) ?? { done: false, busy: false };

  // --- a row's pieces ---
  const el = (tag: string, cls: string, text?: string): HTMLElement => {
    const e = document.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  /** A seat's race: the symbol of the race it PLAYED, with a die in front when it was rolled. */
  const raceMark = (seat: SharedSeat): HTMLElement => {
    const wrap = el("span", "ow3-rb-race");
    const url = symbolOf(seat.race);
    if (seat.random) wrap.append(icon(Dices, "ow3-rb-die"));
    if (url) wrap.append(Object.assign(document.createElement("img"), { src: url, alt: "" }));
    // A race with no symbol (a custom map's own) is told by the die alone, or not at all.
    if (!seat.random && !url) return wrap;
    setGameTip(wrap, seat.random ? `Random — rolled ${raceName(seat.race)}` : raceName(seat.race));
    return wrap;
  };

  const seatEl = (seat: SharedSeat): HTMLElement => {
    const s = el("span", "ow3-rb-seat");
    const swatch = el("span", "ow3-rb-swatch");
    swatch.style.background = PLAYER_COLORS[seat.color] ?? "#888";
    s.append(swatch, el("span", `ow3-rb-name${seat.computer ? " ow3-rb-cpu" : ""}`, seat.name), raceMark(seat));
    return s;
  };

  /** The players on one line (two when they do not fit — past that, `fitCrowd`): team against team. */
  const matchup = (r: SharedReplay): HTMLElement => {
    const line = el("div", "ow3-rb-matchup");
    const teams = [...new Set(r.seats.map((s) => s.team))].sort((a, b) => a - b);
    teams.forEach((team, i) => {
      if (i) line.append(el("span", "ow3-rb-vs", "vs"));
      const t = el("span", "ow3-rb-team");
      for (const s of r.seats.filter((x) => x.team === team)) t.append(seatEl(s));
      line.append(t);
    });
    return line;
  };

  // --- a CROWDED match: its players do not fit the row's two lines ---
  // The row is a fixed height (a page is `PAGE_ROWS` of them), so a 6v6 laid out name by name
  // ran up over the header and down over the row below. Such a row is redrawn as CHIPS — a seat
  // is its colour and its race, its name is the chip's hover — behind the kind of match it was.
  // The developer's pick out of three (fold alike computers into "×5"; a one-line summary).

  const teamsOf = (r: SharedReplay): SharedSeat[][] => {
    const ids = [...new Set(r.seats.map((s) => s.team))].sort((a, b) => a - b);
    return ids.map((t) => r.seats.filter((s) => s.team === t));
  };
  const isFfa = (teams: SharedSeat[][]): boolean => teams.length > 2 && teams.every((t) => t.length === 1);
  /** "6v6", "2v2v2v2", "12-player FFA". */
  const formatOf = (teams: SharedSeat[][]): string =>
    isFfa(teams) ? `${teams.length}-player FFA` : teams.map((t) => t.length).join("v");

  const chipsOf = (r: SharedReplay): HTMLElement => {
    const line = el("div", "ow3-rb-matchup ow3-rb-chips");
    const teams = teamsOf(r);
    line.append(el("span", "ow3-rb-format", formatOf(teams)));
    // A free-for-all is one run of chips: the format in front already says nobody was allied.
    (isFfa(teams) ? [r.seats] : teams).forEach((team, i) => {
      if (i) line.append(el("span", "ow3-rb-vs", "vs"));
      const t = el("span", "ow3-rb-team");
      for (const s of team) {
        const chip = el("span", `ow3-rb-chip${s.computer ? " cpu" : ""}`);
        chip.style.setProperty("--seat", PLAYER_COLORS[s.color] ?? "#888");
        const url = symbolOf(s.race);
        if (s.random) chip.append(icon(Dices, "ow3-rb-die"));
        // A race with no symbol (a custom map's own) keeps the chip's size with an empty face.
        chip.append(url ? Object.assign(document.createElement("img"), { src: url, alt: "" }) : el("span", "ow3-rb-chip-blank"));
        setGameTip(chip, `${s.name} — ${s.random ? `Random, rolled ${raceName(s.race)}` : raceName(s.race)}`);
        t.append(chip);
      }
      line.append(t);
    });
    return line;
  };

  /** The row's players ran past its two lines: lay them out as chips. Measured, not counted —
   *  four long names overflow where eight short ones would not. */
  const fitCrowd = (body: HTMLElement, r: SharedReplay): void => {
    const line = body.querySelector<HTMLElement>(".ow3-rb-matchup");
    if (line && line.scrollHeight > body.clientHeight + 1) line.replaceWith(chipsOf(r));
  };

  const fillBody = (body: HTMLElement, r: SharedReplay): void => {
    body.classList.add("ow3-rb-body");
    const version = el("span", "ow3-rb-version", r.version);
    setGameTip(version, `Recorded on OpenWar3 ${r.version}`);
    const date = el("span", "ow3-rb-date", shortDate(r.recordedAt));
    const when = new Date(r.recordedAt);
    if (!Number.isNaN(when.getTime())) setGameTip(date, when.toLocaleString());
    body.append(el("span", "ow3-rb-map", r.map), matchup(r), el("span", "ow3-rb-len", mmss(r.lengthSec)), version, date);
  };

  /** A row's Download button as it now is — in place, so the page keeps everything else. */
  const paintGet = (s: FdfScreen, r: SharedReplay, i: number): void => {
    const st = rowState(r);
    const btn = `RBRowGet_r${i}`;
    s.frame(`RBRowGetText_r${i}`)?.querySelector("span")?.replaceChildren(icon(st.done ? Check : Download));
    s.setEnabled(btn, !st.busy && !st.done);
    const b = s.frame(btn);
    b?.classList.toggle("ow3-sites-done", st.done);
    if (b) setGameTip(b, st.done ? "In your replays" : st.busy ? "Downloading…" : "Download to your replays");
  };

  const editBox = (s: FdfScreen, name: string, hint: string, glyph: IconNode, get: () => string, set: (v: string) => void): void => {
    const box = s.editBox(name);
    const input = s.frame(name)?.querySelector("input");
    if (!box || !input) return;
    box.value = get();
    input.placeholder = hint;
    input.spellcheck = false;
    input.classList.add("ow3-sites-searchinput");
    const g = icon(glyph);
    g.classList.add("ow3-sites-glass");
    g.style.fontSize = input.style.fontSize; // the field's own type, so it scales with the screen
    input.parentElement?.prepend(g);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !input.value) return; // the dialog's
      e.stopPropagation(); // the screen's accelerators are not this field's letters
      if (e.key === "Enter") { e.preventDefault(); refilter(); }
      if (e.key === "Escape") { e.preventDefault(); input.value = ""; set(""); refilter(); }
    });
    box.onChange = (v) => { set(v); refilter(350); };
  };

  // --- what each build is filled with ---
  const onBuild = (s: FdfScreen): void => {
    screen = s;
    s.setText("RBNote", model.loading ? "" : model.note);
    const note = s.frame("RBNote");
    if (note) note.hidden = model.rows.length > 0;

    // The table's own type follows the screen: one FDF unit, in pixels, off the rows' frame.
    const results = s.frame("RBResults");
    const unit = results ? results.getBoundingClientRect().width / RESULTS_W : 1000;
    const ref = s.frame("RBStatus");
    const family = ref ? getComputedStyle(ref.querySelector("span") ?? ref).fontFamily : "";
    for (const name of ["RBResults", "RBHead"]) {
      const f = s.frame(name);
      if (!f) continue;
      f.style.fontFamily = family;
      f.style.fontSize = `${0.0108 * unit}px`;
    }

    editBox(s, "RBMapBox", "Map", MapIcon, () => model.map, (v) => { model.map = v; });
    editBox(s, "RBPlayerBox", "Player", User, () => model.player, (v) => { model.player = v; });
    const raceMenu = s.popup("RBRaceMenu");
    if (raceMenu) {
      raceMenu.setOptions([{ value: "", label: "Any race" }, ...RACES.map((r) => ({ value: r.id, label: r.name }))]);
      raceMenu.value = model.race;
      raceMenu.onChange = (v) => { model.race = v as CatalogRace | ""; refilter(); };
    }
    const versionMenu = s.popup("RBVersionMenu");
    if (versionMenu) {
      versionMenu.setOptions([{ value: "", label: "Any version" }, ...model.versions.map((v) => ({ value: v, label: `OpenWar3 ${v}` }))]);
      versionMenu.value = model.version;
      versionMenu.onChange = (v) => { model.version = v; refilter(); };
    }

    const head = s.frame("RBHead");
    if (head) {
      head.classList.add("ow3-rb-body", "ow3-rb-head");
      head.append(el("span", "ow3-rb-map", "Map"), el("div", "ow3-rb-matchup", "Players"), el("span", "ow3-rb-len", "Length"), el("span", "ow3-rb-version", "Version"), el("span", "ow3-rb-date", "Played"));
    }
    model.rows.forEach((r, i) => {
      s.frame(`RBRow_r${i}`)?.classList.add("ow3-sites-row");
      const body = s.frame(`RBRowBody_r${i}`);
      if (body) { fillBody(body, r); fitCrowd(body, r); }
      paintGet(s, r, i);
    });
    if (model.loading) {
      const back = s.frame("RBResultsBackdrop");
      if (back) mountWorking(back);
    }

    // The pager: an arrow either side of "page / pages".
    for (const [name, node, tip] of [["RBPrev", ChevronLeft, "Previous page"], ["RBNext", ChevronRight, "Next page"]] as const) {
      s.frame(`${name}Text`)?.querySelector("span")?.replaceChildren(icon(node));
      const b = s.frame(name);
      if (b) setGameTip(b, tip);
    }
    s.setEnabled("RBPrev", model.page > 0);
    s.setEnabled("RBNext", model.page < pages() - 1);
    s.setText("RBPageText", model.total ? `${model.page + 1} / ${pages()}` : "");
    paintStatus();
  };

  const turn = (by: number): void => {
    const to = model.page + by;
    if (to < 0 || to > pages() - 1 || model.loading) return;
    model.page = to;
    model.status = "";
    query();
  };
  handlers.RBPrev = () => turn(-1);
  handlers.RBNext = () => turn(1);

  const download = async (r: SharedReplay, i: number): Promise<void> => {
    const paint = (st: RowState): void => {
      model.got.set(r.id, st);
      if (screen && model.rows[i]?.id === r.id) paintGet(screen, r, i);
    };
    paint({ busy: true, done: false });
    try {
      const bytes = await catalog.download(r);
      const kept = await opts.keep(fileName(r), bytes);
      if (!kept) throw new Error("it could not be saved");
      paint({ busy: false, done: true });
      say(`Added "${kept.replace(/\.o3r$/i, "")}" to your replays.`);
    } catch (err) {
      paint({ busy: false, done: false });
      say(`Could not download the replay: ${(err as Error).message}`);
    }
  };

  const close = (): void => {
    if (!open) return;
    open = false;
    window.removeEventListener("keydown", onKey, true);
    window.clearTimeout(timer);
    abort?.abort();
    screen?.dispose();
    scrim.remove();
    opts.onClosed?.();
  };
  handlers.RBDoneButton = close;
  // Typing in a field is the field's; only Escape is the dialog's. No close on a click at the
  // scrim either: a modal leaves through Done or Escape.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  window.addEventListener("keydown", onKey, true);

  try {
    screen = await mountFdfScreen({
      container: scrim,
      vfs: opts.vfs,
      fdfPath: DIALOG_FDF,
      rootFrame: "ReplayBrowserDialog",
      overrides: [OW3_STRINGS, REPLAY_BROWSER_DIALOG_OVERRIDE],
      buildRoot,
      centerRoot: true,
      textOverrides: texts,
      handlers,
      // The fields take letters; no button here has an accelerator worth the collision.
      noShortcutKeys: true,
      onBuild,
    });
  } catch (err) {
    close();
    throw err;
  }
  query();
  return { close };
}
