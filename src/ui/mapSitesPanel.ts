import {
  Check, Download, ExternalLink, FileUp, Globe, RotateCw, Search,
  createElement as lucideIcon, type IconNode,
} from "lucide";
import type { DataSource } from "../vfs/types";
import { mountFdfScreen, type FdfScreen, type FdfScreenHandlers } from "./fdf/render";
import type { Arg, FdfFrame } from "./fdf/parser";
import { cloneNamespaced, type FdfLibrary } from "./fdf/library";
import { MAP_SITES_DIALOG_OVERRIDE, OW3_STRINGS } from "../overrides";
import { setGameTip } from "./gameTip";
import { mountWorking } from "./workingIndicator";
import {
  MAP_SITES, SHOWN_SITES, askToKeep, canSearchInGame, downloadEpicWar, epicWarThumb, importMapFiles,
  onSiteDownload, onSiteProgress, openMapSite, searchEpicWar, siteById, siteView,
  type ArrivedMap, type EpicWarMap, type MapSiteId, type SiteViewBridge, type SiteViewState, type ViewRect,
} from "./mapSites";

// The map list's way to the map sites (ui/mapSites.ts): a small download glyph at the right end of
// the search box, and the "Download Maps" dialog it opens. Nothing in 1.30.4 has either, so all of
// it is ours — chosen by the developer out of three shapes (a glyph in the search box, a line along
// the list's foot, an offer that appeared only while searching).
//
// The glyph is DISCREET on purpose (the developer's word): the list is for picking a map, and a
// download control competes with every row, so it wears the search box's own dim gold and lights
// only under the pointer. The dialog is the Join Server dialog's chrome (MapSitesDialog.fdf) with
// a tab per site, EpicWar FIRST and open by default, because it is the one the game can search
// and download from in place. Everything in it is a glue control out of StandardTemplates.fdf
// (the bordered glue button, the edit box, the glue scroll bar — see MapSitesDialog.fdf for which
// and why), and the icons on its buttons are Lucide's (lucide.dev, ISC licence — the `lucide`
// package, the same icon set the landing page's React build uses), drawn in the label's own gold:
//
//   · EpicWar — a search field and its results, each with a Download button.
//   · wc3maps — the real site, INSIDE the tab: the desktop app lays a web view of its own over
//     the WHOLE tab (electron/mapSitesView.mjs) with no browser toolbar above it — no address, no
//     back/forward/reload/home (the developer's call: the site is the tab, not a browser in it) —
//     and what the player downloads there lands on the list by itself. A browser has no such view
//     (the site may not be framed),
//     so there the tab offers to open the site in a new tab, and Import takes the file back.
//
// Every map that comes in — a Download, an Import, a file dropped on the dialog, or a site view's
// download — is handed to `arrive`, which puts it on the list and picks it.

/** What the entry needs from the map browser it sits on. */
export interface MapSitesHost {
  vfs: DataSource;
  /** A map has come in: put it on the list and go to it. */
  arrive(m: ArrivedMap): void;
}

const DIALOG_FDF = "UI\\FrameDef\\Glue\\DialogWar3.fdf";

const TITLE = "Download Maps";

/** The entry's glyph: Lucide's `globe` (the developer's pick, after a hand-drawn map scroll and
 *  then `file-down`). Stroked in `currentColor`, so the button's colour is its idle/hover state (style.css). */
function sitesGlyph(): SVGElement {
  const svg = lucideIcon(Globe, { "stroke-width": 2.1, "aria-hidden": "true" });
  svg.classList.add("ow3-sites-glyph");
  return svg;
}

// --- the entry point ---------------------------------------------------------------------

export class MapSitesEntry {
  private readonly el: HTMLButtonElement;
  private list: HTMLElement | null = null;
  private dialog: { close(): void } | null = null;
  private readonly offDownload: () => void;

  constructor(private readonly host: MapSitesHost) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "ow3-sites-entry";
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.addEventListener("click", () => this.open());
    el.append(sitesGlyph());
    setGameTip(el, TITLE);
    this.el = el;
    // A site view hands its maps back whenever they finish — the dialog may be closed by then.
    this.offDownload = onSiteDownload((m) => this.host.arrive(m));
  }

  /** The screen was (re)built. `findBox` is the search box's own row (ui/mapFind.ts). */
  place(list: HTMLElement | null, findBox: HTMLElement | null): void {
    this.list = list;
    if (findBox && this.el.parentElement !== findBox) findBox.appendChild(this.el);
  }

  open(): void {
    if (this.dialog) return;
    const container = this.list?.closest(".fdf-screen")?.parentElement ?? document.body;
    void showMapSitesDialog({
      container, vfs: this.host.vfs, arrive: (m) => this.host.arrive(m),
      onClosed: () => { this.dialog = null; },
    }).then((d) => { this.dialog = d; });
  }

  dispose(): void {
    this.offDownload();
    this.dialog?.close();
    this.el.remove();
  }
}

// --- the dialog ---------------------------------------------------------------------------

/** One stamped result row's height plus the gap under it — MapSitesDialog.fdf `MapSitesRow`. Ours. */
const ROW_PITCH = 0.047;
/** The glue scroll bar the result list wears (StandardTemplates.fdf: the stepped glue bar, the
 *  one the map list itself has — ListBoxWar3.fdf `ListScrollBar`). */
const RESULTS_SCROLLBAR = "StandardScrollBarTemplate";

const TAB_FRAME: Record<MapSiteId, string> = {
  epicwar: "MapSitesTabEpicWar",
  wc3maps: "MapSitesTabWc3maps",
};
const PAGES = ["MapSitesPageSearch", "MapSitesPageView", "MapSitesPageSite"] as const;
type PageName = (typeof PAGES)[number];

const num = (v: number): Arg => ({ s: String(v), n: v, str: false });
const str = (v: string): Arg => ({ s: v, n: null, str: true });

function findFrame(f: FdfFrame, name: string): FdfFrame | undefined {
  if (f.name === name) return f;
  for (const c of f.children) {
    const hit = findFrame(c, name);
    if (hit) return hit;
  }
  return undefined;
}

/** Drop the named frames from the tree (a page not on show, a note with nothing to say). */
function drop(root: FdfFrame, names: ReadonlySet<string>): void {
  root.children = root.children.filter((c) => !names.has(c.name));
  for (const c of root.children) drop(c, names);
}

/** A Lucide icon, sized and coloured by the label it stands in (style.css `.ow3-sites-icon`). */
function icon(node: IconNode): SVGElement {
  const svg = lucideIcon(node, { "stroke-width": 2.25, "aria-hidden": "true" });
  svg.classList.add("ow3-sites-icon");
  return svg;
}

/** Put an icon into a button's label: in place of the words, or in front of them. */
function iconInto(screen: FdfScreen, textFrame: string, node: IconNode, alone: boolean): void {
  const span = screen.frame(textFrame)?.querySelector("span");
  if (!span) return;
  if (alone) span.replaceChildren(icon(node));
  else span.prepend(icon(node));
  span.classList.toggle("ow3-sites-iconlabel", !alone);
}

/** A result row's Download button, as the player last left it. */
type RowState = { label: string; done: boolean; busy: boolean };

/** What the dialog shows — kept OUTSIDE the screen, because every relayout (a resize, a new set
 *  of results, a site failing) throws the whole DOM away and builds it again from this. */
interface Model {
  tab: MapSiteId;
  query: string;
  /** `null` until a search has answered. */
  results: EpicWarMap[] | null;
  /** What the list says when it has no rows. */
  note: string;
  searching: boolean;
  rows: Map<string, RowState>;
  status: string;
  /** The site view's last report, per site. */
  view: Map<string, SiteViewState>;
}

export async function showMapSitesDialog(opts: {
  container: HTMLElement;
  vfs: DataSource;
  arrive: (m: ArrivedMap) => void;
  onClosed?: () => void;
}): Promise<{ close(): void }> {
  const scrim = document.createElement("div");
  scrim.className = "glue-dialog-scrim dimmed ow3-sites-scrim";
  opts.container.appendChild(scrim);

  const view = siteView();
  const inGame = canSearchInGame();
  const model: Model = {
    tab: "epicwar", query: "", results: null, note: inGame ? "Type a map's name to search EpicWar's archive." : "",
    searching: false, rows: new Map(), status: "", view: new Map(),
  };
  /** The page a tab is drawn with: EpicWar searched in place, a site in the desktop app's view,
   *  or — a browser — a site the game can only open. */
  const pageFor = (id: MapSiteId): PageName =>
    id === "epicwar" ? (inGame ? "MapSitesPageSearch" : "MapSitesPageSite") : view ? "MapSitesPageView" : "MapSitesPageSite";

  // Both of these are read by the renderer on every build, so a row's handler or a button's
  // label is put here BEFORE the relayout that draws it (ui/fdf/render.ts `wireButton`).
  const handlers: FdfScreenHandlers = {};
  const texts: Record<string, string> = {
    MapSitesDialogTitle: TITLE,
    MapSitesDoneButtonText: "Done",
    MapSitesImportButtonText: "Import map file…",
    MapSitesViewRetryText: "Retry",
    MapSitesSiteNote: "Download a map there, then Import it here — or drop the file on this window.",
  };
  for (const site of MAP_SITES) texts[`${TAB_FRAME[site.id]}Text`] = site.name;

  let screen: FdfScreen | null = null;
  let open = true;
  let searchTimer = 0;
  let searchAbort: AbortController | null = null;
  const tracker = view ? new ViewTracker(view, (msg) => say(msg)) : null;

  const say = (msg: string): void => {
    model.status = msg;
    screen?.setText("MapSitesStatus", msg);
  };
  const relayout = (): void => {
    if (!screen) return;
    // A relayout builds a new edit box, so the one the player is typing in has to be handed
    // back its focus and caret.
    const input = searchInput();
    const typing = !!input && document.activeElement === input;
    const caret = typing ? input!.selectionStart : null;
    screen.relayout();
    const next = searchInput();
    if (typing && next) {
      next.focus();
      if (caret !== null) next.setSelectionRange(caret, caret);
    }
  };
  const searchInput = (): HTMLInputElement | null =>
    screen?.frame("MapSitesSearchBox")?.querySelector("input") ?? null;

  // --- the frame tree for this build ---
  const buildRoot = (lib: FdfLibrary): FdfFrame => {
    const root = lib.resolveRoot("MapSitesDialog");
    if (!root) throw new Error("MapSitesDialog.fdf: no MapSitesDialog frame");
    const page = pageFor(model.tab);
    const gone = new Set<string>(PAGES.filter((p) => p !== page));
    if (page === "MapSitesPageSearch") {
      const results = model.results ?? [];
      const host = findFrame(root, "MapSitesResults");
      if (host && results.length) {
        gone.add("MapSitesResultsNote");
        const row = lib.resolveRoot("MapSitesRow");
        results.forEach((m, i) => {
          if (!row) return;
          const r = cloneNamespaced(row, `_r${i}`);
          r.props.push({ key: "SetPoint", args: [str("TOPLEFT"), str("MapSitesResults"), str("TOPLEFT"), num(0), num(-i * ROW_PITCH)] });
          host.children.push(r);
          texts[`MapSitesRowName_r${i}`] = m.title;
          texts[`MapSitesRowMeta_r${i}`] = [m.author && `by ${m.author}`, m.players ? `${m.players} players` : "", m.size, m.category]
            .filter(Boolean).join("  ·  ");
          texts[`MapSitesRowGetText_r${i}`] = rowState(m).label;
          handlers[`MapSitesRowGet_r${i}`] = () => void download(m, i);
        });
        // The bar draws only while the rows overrun the box (ui/fdf/widgets.ts buildScrollFrame).
        const bar = lib.resolveRoot(RESULTS_SCROLLBAR);
        if (bar) {
          bar.name = "MapSitesResultsScrollBar";
          host.children.push(bar);
        }
      }
    }
    if (page === "MapSitesPageView") {
      const st = model.view.get(model.tab);
      if (!st?.failed) gone.add("MapSitesViewRetry");
    }
    drop(root, gone);
    return root;
  };

  const rowState = (m: EpicWarMap): RowState =>
    model.rows.get(m.id) ?? { label: m.playable ? "Download" : "Not a map", done: false, busy: false };

  // --- what each build is filled with ---
  const onBuild = (s: FdfScreen): void => {
    screen = s;
    // The open tab is LATCHED — held pressed, as the Options screen holds its category — and
    // its label takes the template's own FontHighlightColor (white), since a pressed glue face
    // alone barely reads across a row of three.
    for (const site of MAP_SITES) {
      const tab = s.frame(TAB_FRAME[site.id]);
      // A PARKED site (mapSites.ts) keeps its frame in the FDF, so the tabs to its right keep
      // their anchors; it is just not drawn and cannot be pressed.
      if (tab && site.parked) tab.style.visibility = "hidden";
      tab?.classList.add("ow3-sites-tab");
      tab?.classList.toggle("fdf-latched", site.id === model.tab);
    }
    iconInto(s, "MapSitesImportButtonText", FileUp, false);
    setGameTip(s.frame("MapSitesImportButton")!, "Add a .w3x or .w3m you already have to your maps");
    s.setText("MapSitesStatus", model.status);
    const page = pageFor(model.tab);
    if (page === "MapSitesPageSearch") fillSearch(s);
    else if (page === "MapSitesPageView") fillView(s);
    else fillSite(s);
  };

  const fillSearch = (s: FdfScreen): void => {
    const box = s.editBox("MapSitesSearchBox");
    const input = searchInput();
    if (box && input) {
      box.value = model.query;
      input.placeholder = "Search EpicWar";
      input.spellcheck = false;
      input.classList.add("ow3-sites-searchinput");
      const glass = icon(Search);
      glass.classList.add("ow3-sites-glass");
      glass.style.fontSize = input.style.fontSize; // the field's own type, so it scales with the screen
      input.parentElement?.prepend(glass);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !input.value) return; // the dialog's
        e.stopPropagation(); // the screen's accelerators are not this field's letters
        if (e.key === "Enter") { e.preventDefault(); runSearch(); }
        if (e.key === "Escape") { e.preventDefault(); input.value = ""; model.query = ""; }
      });
      box.onChange = (v) => {
        model.query = v;
        window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(runSearch, 450);
      };
    }
    s.setText("MapSitesResultsNote", model.note);
    if (model.searching) {
      const host = s.frame("MapSitesResultsBackdrop");
      if (host) mountWorking(host);
    }
    (model.results ?? []).forEach((m, i) => {
      const thumb = s.frame(`MapSitesRowThumb_r${i}`);
      if (thumb) {
        const img = document.createElement("img");
        img.className = "ow3-sites-thumb";
        img.alt = "";
        void epicWarThumb(m).then((url) => { if (url) img.src = url; });
        thumb.append(img);
      }
      s.frame(`MapSitesRow_r${i}`)?.classList.add("ow3-sites-row");
      const st = rowState(m);
      const btn = `MapSitesRowGet_r${i}`;
      s.setEnabled(btn, m.playable && !st.busy && !st.done);
      if (m.playable) iconInto(s, `MapSitesRowGetText_r${i}`, st.done ? Check : Download, false);
      s.frame(btn)?.classList.toggle("ow3-sites-done", st.done);
      if (!m.playable) setGameTip(s.frame(btn)!, `${m.fileName} is not a .w3x or .w3m map`);
    });
  };

  const fillView = (s: FdfScreen): void => {
    const site = siteById(model.tab);
    handlers.MapSitesViewRetry = () => view!.nav("reload");
    iconInto(s, "MapSitesViewRetryText", RotateCw, false);
    paintView(s);
    const port = s.frame("MapSitesViewport");
    if (port && tracker) tracker.place(site.id, site.home, port, () => !model.view.get(site.id)?.failed);
  };

  /** The note under the view, in place — the view reports far too often (every
   *  load start and stop of Cloudflare's interstitial) for each report to be a relayout. */
  const paintView = (s: FdfScreen): void => {
    const site = siteById(model.tab);
    const st = model.view.get(site.id);
    s.frame("MapSitesPageView")?.classList.toggle("ow3-sites-loading", !!st?.loading);
    s.setText("MapSitesViewNote", st?.failed ? `Could not reach ${site.name} (${st.failed}).` : `Loading ${site.name}…`);
  };

  const fillSite = (s: FdfScreen): void => {
    const site = siteById(model.tab);
    s.setText("MapSitesSiteName", site.name);
    s.setText("MapSitesSiteBlurb", site.blurb);
    s.setText("MapSitesSiteOpenText", `Open ${site.name}`);
    iconInto(s, "MapSitesSiteOpenText", ExternalLink, false);
    s.setText("MapSitesSiteHost", new URL(site.home).hostname);
    handlers.MapSitesSiteOpen = () => openMapSite(site);
  };

  // --- what the player does ---
  const selectTab = (id: MapSiteId): void => {
    if (id === model.tab) return;
    tracker?.leave();
    model.tab = id;
    say(id !== "epicwar" && view ? "Maps you download here are added to your list automatically." : "");
    relayout();
    if (pageFor(id) === "MapSitesPageSearch") requestAnimationFrame(() => searchInput()?.focus());
  };
  for (const site of SHOWN_SITES) handlers[TAB_FRAME[site.id]] = () => selectTab(site.id);

  const runSearch = (): void => {
    window.clearTimeout(searchTimer);
    const q = model.query.trim();
    searchAbort?.abort();
    if (!q) return;
    const abort = (searchAbort = new AbortController());
    model.searching = true;
    model.results = [];
    model.note = "";
    relayout();
    searchEpicWar(q, abort.signal)
      .then((maps) => {
        if (!open || abort.signal.aborted) return;
        model.results = maps;
        model.note = maps.length ? "" : `Nothing on EpicWar matches "${q}".`;
      })
      .catch((err: Error) => {
        if (!open || abort.signal.aborted) return;
        model.results = [];
        model.note = `Could not reach EpicWar: ${err.message}`;
      })
      .finally(() => {
        if (!open || abort.signal.aborted) return;
        model.searching = false;
        // A new list starts at its top (the renderer otherwise keeps the old scroll).
        const v = screen?.frame("MapSitesResults")?.querySelector<HTMLElement>(":scope > .fdf-scroll-view");
        if (v) v.scrollTop = 0;
        relayout();
      });
  };

  /** Show a row's button as it now is, without a relayout (the list keeps its scroll). */
  const paintRow = (m: EpicWarMap, i: number, st: RowState): void => {
    model.rows.set(m.id, st);
    texts[`MapSitesRowGetText_r${i}`] = st.label;
    if (!screen) return;
    screen.setText(`MapSitesRowGetText_r${i}`, st.label);
    iconInto(screen, `MapSitesRowGetText_r${i}`, st.done ? Check : Download, false);
    screen.setEnabled(`MapSitesRowGet_r${i}`, !st.busy && !st.done);
    screen.frame(`MapSitesRowGet_r${i}`)?.classList.toggle("ow3-sites-done", st.done);
  };

  const download = async (m: EpicWarMap, i: number): Promise<void> => {
    const keep = askToKeep(); // inside the click: the browser's folder grant needs the gesture
    paintRow(m, i, { label: "Downloading…", busy: true, done: false });
    try {
      await keep;
      const got = await downloadEpicWar(m);
      opts.arrive(got);
      paintRow(m, i, { label: "Added", busy: false, done: true });
      say(got.saveError ? `Added ${got.file.name} for this session only: ${got.saveError}` : `Added ${got.file.name} to Maps\\Download.`);
    } catch (err) {
      paintRow(m, i, { label: "Retry", busy: false, done: false });
      say(`Could not download ${m.fileName}: ${(err as Error).message}`);
    }
  };

  // Import: the glue button opens a hidden file input (it is inside the click, as a picker must be).
  const picker = Object.assign(document.createElement("input"), { type: "file", accept: ".w3x,.w3m", multiple: true });
  picker.hidden = true;
  picker.addEventListener("change", () => {
    const files = [...(picker.files ?? [])];
    picker.value = "";
    if (files.length) void runImport(files, opts.arrive, say);
  });
  scrim.append(picker);
  handlers.MapSitesImportButton = () => picker.click();

  // --- the shell's reports ---
  const offs: Array<() => void> = [];
  offs.push(onSiteProgress((p) => {
    if (p.failed) say(`${p.name} did not download (${p.failed}).`);
    else if (p.total) say(`Downloading ${p.name} — ${Math.floor((100 * (p.received ?? 0)) / p.total)}%`);
    else say(`Downloading ${p.name}…`);
  }));
  // The map itself goes to the list through the entry (`MapSitesEntry`); this only SAYS so.
  offs.push(onSiteDownload((m) => {
    say(m.saveError ? `Added ${m.file.name} for this session only: ${m.saveError}` : `Added ${m.file.name} to Maps\\Download.`);
  }));
  if (view) {
    offs.push(view.onState((st) => {
      const was = model.view.get(st.key);
      model.view.set(st.key, st);
      if (st.key !== model.tab || !screen) return;
      // A failure (or its end) changes what the page HAS — the Retry button — so that one is a
      // relayout; everything else is painted in place.
      if (!!was?.failed !== !!st.failed) relayout();
      else paintView(screen);
      if (st.failed) say(`${siteById(model.tab).name} could not be reached. Check your connection, then press Retry.`);
      else if (st.checking) say(`${siteById(model.tab).name} is checking the connection (Cloudflare) — this takes a few seconds.`);
      else if (!st.loading) say("Maps you download here are added to your list automatically.");
    }));
    offs.push(view.onEscape(() => close()));
  }

  const close = (): void => {
    if (!open) return;
    open = false;
    window.removeEventListener("keydown", onKey, true);
    window.clearTimeout(searchTimer);
    searchAbort?.abort();
    for (const off of offs) off();
    tracker?.leave();
    screen?.dispose();
    scrim.remove();
    opts.onClosed?.();
  };
  handlers.MapSitesDoneButton = close;
  const onKey = (e: KeyboardEvent): void => {
    // Typing in the search field is the field's; only Escape is the dialog's.
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  window.addEventListener("keydown", onKey, true);
  // No close on a click at the scrim: a modal leaves through Done or Escape, never through a
  // stray click on the background (or on a gap between the dialog's own frames).
  wireDrop(scrim, opts.arrive, say);

  try {
    screen = await mountFdfScreen({
      container: scrim,
      vfs: opts.vfs,
      fdfPath: DIALOG_FDF,
      rootFrame: "MapSitesDialog",
      overrides: [OW3_STRINGS, MAP_SITES_DIALOG_OVERRIDE],
      buildRoot,
      centerRoot: true,
      textOverrides: texts,
      handlers,
      // The field takes letters; no button here has an accelerator worth the collision.
      noShortcutKeys: true,
      onBuild,
    });
  } catch (err) {
    close();
    throw err;
  }
  if (pageFor(model.tab) === "MapSitesPageSearch") requestAnimationFrame(() => searchInput()?.focus());
  return { close };
}

/** A drop of map files anywhere on `el` imports them. */
function wireDrop(el: HTMLElement, arrive: (m: ArrivedMap) => void, say: (msg: string) => void): void {
  el.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    el.classList.add("ow3-sites-dropping");
  });
  el.addEventListener("dragleave", (e) => { if (e.target === el) el.classList.remove("ow3-sites-dropping"); });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("ow3-sites-dropping");
    const files = e.dataTransfer?.files;
    if (files?.length) void runImport([...files], arrive, say);
  });
}

async function runImport(files: File[], arrive: (m: ArrivedMap) => void, say: (msg: string) => void): Promise<void> {
  await askToKeep();
  const { kept, refused } = await importMapFiles(files);
  for (const m of kept) arrive(m);
  const unsaved = kept.find((m) => m.saveError);
  say([
    kept.length ? `Added ${kept.map((m) => m.file.name).join(", ")}.` : "",
    refused.length ? `Not a map file: ${refused.join(", ")}.` : "",
    unsaved ? `Kept for this session only: ${unsaved.saveError}` : "",
  ].filter(Boolean).join(" "));
}

// --- a site, shown in the tab (desktop app) ----------------------------------------------

/**
 * Keeps the desktop app's web view exactly on the viewport frame — through the dialog's fade-in,
 * a window resize and every relayout (each of which builds a NEW viewport element) — and takes it
 * away the moment the tab is left or the dialog closes. The view is a separate surface the page
 * cannot draw over, which is why it must never be left anywhere else.
 */
class ViewTracker {
  private el: HTMLElement | null = null;
  private key: string | null = null;
  private home = "";
  private wanted: () => boolean = () => true;
  private readonly resize = new ResizeObserver(() => this.sync());
  private last = "";
  private raf = 0;
  private placed = false;

  constructor(private readonly view: SiteViewBridge, private readonly say: (msg: string) => void) {
    window.addEventListener("resize", this.onResize);
  }

  /** Lay `key`'s view over `el` (a freshly built viewport). `wanted` says whether it should be on
   *  screen at all — not while the shell reports it failed, when the dialog's Retry is there. */
  place(key: string, home: string, el: HTMLElement, wanted: () => boolean): void {
    if (this.key !== key) { this.leave(); this.key = key; }
    this.home = home;
    this.wanted = wanted;
    this.resize.disconnect();
    this.el = el;
    this.last = "";
    this.resize.observe(el);
    this.follow();
  }

  leave(): void {
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.el = null;
    if (this.placed) this.view.hide();
    this.placed = false;
    this.key = null;
    this.last = "";
  }

  private readonly onResize = (): void => this.follow();

  /** Track the viewport every frame for a moment: the dialog fades and settles in, and a
   *  relayout moves it without resizing it, which no observer reports. */
  private follow(): void {
    const until = performance.now() + 700;
    const step = (): void => {
      if (!this.el) return;
      this.sync();
      if (performance.now() < until) this.raf = requestAnimationFrame(step);
    };
    cancelAnimationFrame(this.raf);
    step();
  }

  private sync(): void {
    const el = this.el;
    if (!el || !el.isConnected || !this.key) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const rect: ViewRect = { x: r.left, y: r.top, width: r.width, height: r.height };
    const at = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
    if (at === this.last) return;
    this.last = at;
    if (!this.placed) {
      this.placed = true;
      const key = this.key;
      // The game's own cursor goes over with it: the view is a page of its own, and would
      // otherwise wear the operating system's (CLAUDE.md — never an OS cursor).
      const cursor = getComputedStyle(document.body).cursor;
      this.view.show(key, this.home, rect, cursor).catch((err: Error) => {
        this.say(`Could not open the site: ${err.message}`);
      });
    } else if (this.wanted()) {
      this.view.bounds(rect);
    }
  }
}
