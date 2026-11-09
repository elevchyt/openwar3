import type { DataSource } from "../vfs/types";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import { MAP_SITES_DIALOG_OVERRIDE, OW3_STRINGS } from "../overrides";
import { setGameTip } from "./gameTip";
import { mountWorking } from "./workingIndicator";
import {
  MAP_SITES, askToKeep, canSearchInGame, downloadEpicWar, epicWarThumb, importMapFiles,
  onSiteDownload, onSiteProgress, openMapSite, searchEpicWar, siteById, siteView,
  type ArrivedMap, type EpicWarMap, type MapSite, type MapSiteId, type SiteViewBridge, type ViewRect,
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
// and download from in place:
//
//   · EpicWar — a search field and its results, each with a Download button.
//   · Hive Workshop, wc3maps — the real site, INSIDE the tab: the desktop app lays a web view of
//     its own over the tab's viewport (electron/mapSitesView.mjs), and what the player downloads
//     there lands on the list by itself. A browser has no such view (neither site may be framed),
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

/** The dialog's box, in screen units — as large as a 4:3 screen comfortably holds, because two of
 *  its tabs are a whole website. Ours. */
const DIALOG_W = 0.7;
const DIALOG_H = 0.5;
/** The body's margins inside the box: title above, Done below (MapSitesDialog.fdf). */
const BODY_X = 0.04;
const BODY_TOP = 0.056;
const BODY_BOTTOM = 0.066;

const TITLE = "Download Maps";

/** The entry's glyph: a map SCROLL with a down-arrow on it — ours, picked by the developer out of
 *  six drawn candidates (tray, cloud, folded map, map + arrow, globe + arrow, scroll), as the one
 *  that says "maps" in the game's own idiom and still reads as a download. Stroked in
 *  `currentColor`, so the button's colour is its idle/hover state (style.css). */
const SITES_GLYPH =
  '<svg class="ow3-sites-glyph" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"' +
  ' stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M18 16V5a2 2 0 0 0-2-2H4.5"/>' +
  '<path d="M8 21h12a2 2 0 0 0 2-2v-.5a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v.5a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2h4"/>' +
  '<path d="M12 6.5v6.5"/><path d="M9.5 10.5 12 13l2.5-2.5"/></svg>';

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
    el.insertAdjacentHTML("beforeend", SITES_GLYPH);
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

/** Set a frame's Width and Height. mapBrowser's `size`, restated: the map browser imports this
 *  module, and the build refuses a cycle (tools/import-cycle-test.mjs). */
function sizeFrame(f: FdfFrame | undefined, w: number, h: number): void {
  if (!f) return;
  const n = (v: number) => [{ s: String(v), n: v, str: false }];
  f.props = f.props.filter((p) => p.key !== "Width" && p.key !== "Height");
  f.props.push({ key: "Width", args: n(w) }, { key: "Height", args: n(h) });
}

function buildRoot(lib: FdfLibrary): FdfFrame {
  const root = lib.resolveRoot("MapSitesDialog");
  if (!root) throw new Error("MapSitesDialog.fdf: no MapSitesDialog frame");
  sizeFrame(root, DIALOG_W, DIALOG_H);
  sizeFrame(root.children.find((c) => c.name === "MapSitesBody"), DIALOG_W - 2 * BODY_X, DIALOG_H - BODY_TOP - BODY_BOTTOM);
  return root;
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
  let screen: FdfScreen | null = null;
  let body: TabbedBody | null = null;
  let open = true;

  const close = (): void => {
    if (!open) return;
    open = false;
    window.removeEventListener("keydown", onKey, true);
    body?.dispose();
    screen?.dispose();
    scrim.remove();
    opts.onClosed?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    // Typing in the search field is the field's; only Escape is the dialog's.
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  window.addEventListener("keydown", onKey, true);
  scrim.addEventListener("mousedown", (e) => { if (e.target === scrim) close(); });
  wireDrop(scrim, opts.arrive, (msg) => body?.status(msg));

  try {
    screen = await mountFdfScreen({
      container: scrim,
      vfs: opts.vfs,
      fdfPath: DIALOG_FDF,
      rootFrame: "MapSitesDialog",
      overrides: [OW3_STRINGS, MAP_SITES_DIALOG_OVERRIDE],
      buildRoot,
      centerRoot: true,
      textOverrides: {
        MapSitesDialogTitle: TITLE,
        MapSitesDoneButtonText: "Done",
      },
      handlers: { MapSitesDoneButton: close },
      onBuild: (s) => {
        screen = s;
        const host = s.frame("MapSitesBody");
        if (!host) return;
        // The body is DOM, sized off the FDF box it fills: one screen unit is the box's height
        // over the body's, and the type is a hair over the tooltip's 0.011 (UI\MiscUI.txt
        // [FontHeights]) — the results are read at arm's length, a tooltip at the cursor.
        const unit = host.clientHeight / (DIALOG_H - BODY_TOP - BODY_BOTTOM);
        if (!body) body = new TabbedBody(opts.arrive, close);
        body.mount(host, unit * 0.0115);
      },
    });
  } catch (err) {
    close();
    throw err;
  }
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

/** "Import map file…": a link-styled button over a hidden file input. */
function importButton(arrive: (m: ArrivedMap) => void, say: (msg: string) => void): HTMLElement {
  const input = Object.assign(document.createElement("input"), { type: "file", accept: ".w3x,.w3m", multiple: true });
  input.hidden = true;
  input.addEventListener("change", () => {
    const files = [...(input.files ?? [])];
    input.value = "";
    if (files.length) void runImport(files, arrive, say);
  });
  const b = textButton("Import map file…", () => input.click(), "ow3-sites-link");
  setGameTip(b, "Add a .w3x or .w3m you already have to your maps");
  const wrap = document.createElement("span");
  wrap.append(b, input);
  return wrap;
}

function textButton(label: string, onClick: () => void, cls = "ow3-sites-btn"): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

const div = (cls: string, text?: string): HTMLDivElement => {
  const d = document.createElement("div");
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
};

/** A tab's content. `shown` runs once it is in the DOM and laid out. */
interface TabPage {
  readonly root: HTMLElement;
  shown(): void;
  dispose(): void;
}

/** The dialog's body: one tab per site, EpicWar first, and a foot with Import and a status line. */
class TabbedBody {
  private readonly root = div("ow3-sites-body");
  private readonly tabs = div("ow3-sites-tabs");
  private readonly page = div("ow3-sites-page");
  private readonly foot = div("ow3-sites-foot");
  private readonly line = div("ow3-sites-status");
  private tab: MapSiteId = "epicwar";
  private current: TabPage | null = null;
  private readonly offProgress: () => void;
  private readonly offArrived: () => void;

  constructor(private readonly arrive: (m: ArrivedMap) => void, private readonly close: () => void) {
    for (const site of MAP_SITES) {
      const t = textButton(site.name, () => this.select(site.id), "ow3-sites-tab");
      t.dataset.site = site.id;
      this.tabs.append(t);
    }
    this.foot.append(importButton(arrive, (m) => this.status(m)), this.line);
    this.root.append(this.tabs, this.page, this.foot);
    this.offProgress = onSiteProgress((p) => {
      if (p.failed) this.status(`${p.name} did not download (${p.failed}).`);
      else if (p.total) this.status(`Downloading ${p.name} — ${Math.floor((100 * (p.received ?? 0)) / p.total)}%`);
      else this.status(`Downloading ${p.name}…`);
    });
    // The map itself goes to the list through the entry (`MapSitesEntry`); this only SAYS so.
    this.offArrived = onSiteDownload((m) => {
      this.status(m.saveError ? `Added ${m.file.name} for this session only: ${m.saveError}` : `Added ${m.file.name} to Maps\\Download.`);
    });
    this.paint();
  }

  mount(host: HTMLElement, fontPx: number): void {
    this.root.style.fontSize = `${fontPx}px`;
    host.append(this.root);
    this.current?.shown();
  }

  status(msg: string): void { this.line.textContent = msg; }

  dispose(): void {
    this.offProgress();
    this.offArrived();
    this.current?.dispose();
  }

  private select(id: MapSiteId): void {
    if (id === this.tab) return;
    this.tab = id;
    this.paint();
    if (this.root.isConnected) this.current?.shown();
  }

  private paint(): void {
    for (const t of this.tabs.children) (t as HTMLElement).classList.toggle("on", (t as HTMLElement).dataset.site === this.tab);
    this.current?.dispose();
    const site = siteById(this.tab);
    const view = siteView();
    const say = (m: string): void => this.status(m);
    this.current = site.id === "epicwar" && canSearchInGame()
      ? new EpicWarSearch(this.arrive, say)
      : view && site.id !== "epicwar"
        ? new SiteViewPage(site, view, say, this.close)
        : sitePage(site);
    this.status(site.id !== "epicwar" && view ? "Maps you download here are added to your list automatically." : "");
    this.page.replaceChildren(this.current.root);
  }
}

/** A site the game can neither search nor show (a browser): what it is, and a way to open it. */
function sitePage(site: MapSite): TabPage {
  const root = div("ow3-sites-sitepage");
  root.append(
    div("ow3-sites-sitename", site.name),
    div("ow3-sites-blurb", site.blurb),
    textButton(`Open ${site.name}`, () => openMapSite(site)),
    div("ow3-sites-note", "Download a map there, then Import it here — or drop the file on this window."),
    div("ow3-sites-host", new URL(site.home).hostname),
  );
  return { root, shown: () => {}, dispose: () => {} };
}

// --- a site, shown in the tab (desktop app) ----------------------------------------------

/**
 * The real site inside the tab: a toolbar of ours (Back, Forward, Reload, Home, where it is, and
 * the way out to the player's own browser) over a VIEWPORT the desktop app lays its web view on.
 * The view is a separate surface the page cannot draw over, so this keeps it exactly on the
 * viewport — through the dialog's fade-in, a window resize and a relayout — and takes it away
 * the moment the tab is left or the dialog closes.
 */
class SiteViewPage implements TabPage {
  readonly root = div("ow3-sites-viewpage");
  private readonly viewport = div("ow3-sites-viewport");
  private readonly where = div("ow3-sites-where");
  private readonly back: HTMLButtonElement;
  private readonly forward: HTMLButtonElement;
  private readonly offs: Array<() => void> = [];
  private readonly resize = new ResizeObserver(() => this.sync());
  private last = "";
  private raf = 0;
  private alive = true;
  private placed = false;

  constructor(
    private readonly site: MapSite,
    private readonly view: SiteViewBridge,
    private readonly say: (msg: string) => void,
    close: () => void,
  ) {
    const bar = div("ow3-sites-viewbar");
    const icon = (glyph: string, tip: string, what: Parameters<SiteViewBridge["nav"]>[0]): HTMLButtonElement => {
      const b = textButton(glyph, () => view.nav(what), "ow3-sites-navbtn");
      setGameTip(b, tip);
      return b;
    };
    this.back = icon("‹", "Back", "back");
    this.forward = icon("›", "Forward", "forward");
    const out = textButton("Open in browser ↗", () => view.nav("external"), "ow3-sites-link");
    setGameTip(out, "Open this page in your own web browser");
    bar.append(this.back, this.forward, icon("⟳", "Reload", "reload"), icon("⌂", `${site.name} home`, "home"), this.where, out);
    this.viewport.append(div("ow3-sites-viewwait", `Loading ${site.name}…`));
    this.root.append(bar, this.viewport);
    this.where.textContent = new URL(site.home).hostname;
    this.back.disabled = this.forward.disabled = true;
    this.offs.push(
      view.onState((s) => { if (s.key === this.site.id) this.paintState(s.url, s.loading, s.canGoBack, s.canGoForward); }),
      view.onEscape(close),
    );
    window.addEventListener("resize", this.onResize);
  }

  shown(): void {
    this.resize.observe(this.viewport);
    this.follow();
  }

  dispose(): void {
    this.alive = false;
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    window.removeEventListener("resize", this.onResize);
    for (const off of this.offs) off();
    this.view.hide();
  }

  private readonly onResize = (): void => this.follow();

  /** Track the viewport every frame for a moment: the dialog fades and settles in, and a
   *  relayout moves it without resizing it, which no observer reports. */
  private follow(): void {
    const until = performance.now() + 700;
    const step = (): void => {
      if (!this.alive) return;
      this.sync();
      if (performance.now() < until) this.raf = requestAnimationFrame(step);
    };
    cancelAnimationFrame(this.raf);
    step();
  }

  private sync(): void {
    if (!this.alive || !this.viewport.isConnected) return;
    const r = this.viewport.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const rect: ViewRect = { x: r.left, y: r.top, width: r.width, height: r.height };
    const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
    if (key === this.last) return;
    this.last = key;
    if (!this.placed) {
      this.placed = true;
      // The game's own cursor goes over with it: the view is a page of its own, and would
      // otherwise wear the operating system's (CLAUDE.md — never an OS cursor).
      const cursor = getComputedStyle(document.body).cursor;
      this.view.show(this.site.id, this.site.home, rect, cursor).catch((err: Error) => {
        this.say(`Could not open ${this.site.name}: ${err.message}`);
      });
    } else {
      this.view.bounds(rect);
    }
  }

  private paintState(url: string, loading: boolean, canBack: boolean, canForward: boolean): void {
    this.back.disabled = !canBack;
    this.forward.disabled = !canForward;
    this.root.classList.toggle("loading", loading);
    try {
      const u = new URL(url);
      this.where.textContent = `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`;
    } catch {
      this.where.textContent = url;
    }
  }
}

// --- EpicWar, searched in place ------------------------------------------------------------

class EpicWarSearch implements TabPage {
  readonly root = div("ow3-sites-search");
  private readonly input = document.createElement("input");
  private readonly list = div("ow3-sites-results");
  private abort: AbortController | null = null;
  private timer = 0;
  private alive = true;

  constructor(
    private readonly arrive: (m: ArrivedMap) => void,
    private readonly say: (msg: string) => void,
  ) {
    const box = div("ow3-sites-field");
    box.append(Object.assign(document.createElement("span"), { className: "ow3-find-glass" }));
    this.input.className = "ow3-sites-input";
    this.input.placeholder = "Search EpicWar";
    this.input.spellcheck = false;
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.input.value) return; // the dialog's
      e.stopPropagation(); // the screen's accelerators are not this field's letters
      if (e.key === "Enter") { e.preventDefault(); this.run(); }
      if (e.key === "Escape") { e.preventDefault(); this.input.value = ""; }
    });
    this.input.addEventListener("input", () => {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.run(), 450);
    });
    box.append(this.input);
    this.root.append(box, this.list);
    this.list.append(div("ow3-sites-empty", "Type a map's name to search EpicWar's archive."));
  }

  shown(): void { requestAnimationFrame(() => this.input.focus()); }

  dispose(): void {
    this.alive = false;
    window.clearTimeout(this.timer);
    this.abort?.abort();
  }

  private run(): void {
    window.clearTimeout(this.timer);
    const q = this.input.value.trim();
    this.abort?.abort();
    if (!q) return;
    const abort = (this.abort = new AbortController());
    this.list.replaceChildren();
    mountWorking(this.list);
    searchEpicWar(q, abort.signal)
      .then((maps) => { if (this.alive && !abort.signal.aborted) this.paint(maps, q); })
      .catch((err: Error) => {
        if (!this.alive || abort.signal.aborted) return;
        this.list.replaceChildren(div("ow3-sites-empty", `Could not reach EpicWar: ${err.message}`));
      });
  }

  private paint(maps: EpicWarMap[], q: string): void {
    this.list.replaceChildren();
    if (!maps.length) {
      this.list.append(div("ow3-sites-empty", `Nothing on EpicWar matches "${q}".`));
      return;
    }
    for (const m of maps) this.list.append(this.row(m));
  }

  private row(m: EpicWarMap): HTMLElement {
    const row = div(`ow3-sites-result${m.playable ? "" : " ow3-sites-dead"}`);
    const img = document.createElement("img");
    img.className = "ow3-sites-thumb";
    img.alt = "";
    void epicWarThumb(m).then((url) => { if (url) img.src = url; });
    const text = div("ow3-sites-text");
    const meta = [m.author && `by ${m.author}`, m.players ? `${m.players} players` : "", m.size, m.category]
      .filter(Boolean).join("  ·  ");
    text.append(div("ow3-sites-name", m.title), div("ow3-sites-meta", meta));
    const btn = textButton(m.playable ? "Download" : "Not a map", () => void this.download(m, btn));
    btn.disabled = !m.playable;
    if (!m.playable) setGameTip(btn, `${m.fileName} is not a .w3x or .w3m map`);
    row.append(img, text, btn);
    return row;
  }

  private async download(m: EpicWarMap, btn: HTMLButtonElement): Promise<void> {
    const keep = askToKeep(); // inside the click: the browser's folder grant needs the gesture
    btn.disabled = true;
    btn.textContent = "Downloading…";
    try {
      await keep;
      const got = await downloadEpicWar(m);
      this.arrive(got);
      btn.textContent = "Added ✓";
      btn.classList.add("done");
      this.say(got.saveError ? `Added ${got.file.name} for this session only: ${got.saveError}` : `Added ${got.file.name} to Maps\\Download.`);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Retry";
      this.say(`Could not download ${m.fileName}: ${(err as Error).message}`);
    }
  }
}
