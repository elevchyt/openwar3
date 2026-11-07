// The map sites, browsed INSIDE the game (src/ui/mapSitesPanel.ts, the Download Maps dialog).
//
// Hive Workshop and wc3maps cannot be READ by the game — both sit behind Cloudflare's bot check,
// which a plain fetch is refused by, and that check is not ours to get round — and neither may be
// put in an <iframe> (both send `X-Frame-Options: SAMEORIGIN`). What the desktop app CAN do is
// show the real site in a web view of its own, laid exactly over the dialog's tab, so the player
// browses it as they would in a browser without leaving the game. A view is a separate page with
// its own compositor surface, so the page cannot draw over it: the dialog reports where its tab
// is (`ow3:mapsite-view-show` / `-bounds`) and the view is placed and taken away to match.
//
// One view per site, kept while the game runs, so going from Hive to wc3maps and back finds Hive
// where the player left it. All of them share one persistent session (`persist:mapsites`): a Hive
// login or a passed Cloudflare check survives from one visit to the next and never mixes with the
// game page's storage. A view is a plain web page — no preload, no node, no bridge back.
//
// What it DOWNLOADS is the point: a `.w3x`/`.w3m` that finishes is written into the install's
// `Maps\Download\` (electron/install.mjs `writeDownloadedMap`, the folder a LAN download goes to)
// and handed to the page, which adds it to the map list and picks it. Anything else (a .zip, a
// .rar) goes through Chromium's own save dialog — it is the player's file, not a map we can keep.
//
// Three things the page would otherwise lose while a view has the keyboard and the pointer:
// Escape (the dialog's close key — forwarded), the game's own cursor (the page hands over its CSS
// `cursor` and it is inserted into every page the view loads; CLAUDE.md: never an OS cursor), and
// the focus, given back to the game when the view is taken away.

import * as electron from "electron";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { mapSiteOpenable } from "./mapSites.mjs";

const { session, shell } = electron;
const PARTITION = "persist:mapsites";

/** `WebContentsView` (Electron 30+), or the legacy shell's `BrowserView` (Electron 18 —
 *  docs/linux.md), behind the four calls this file makes. */
function makeView() {
  const webPreferences = { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true };
  if (electron.WebContentsView) {
    const view = new electron.WebContentsView({ webPreferences });
    view.setBackgroundColor?.("#000000");
    return {
      webContents: view.webContents,
      attach: (win) => win.contentView.addChildView(view),
      detach: (win) => { try { win.contentView.removeChildView(view); } catch { /* not attached */ } },
      setBounds: (r) => view.setBounds(r),
    };
  }
  const view = new electron.BrowserView({ webPreferences });
  view.setBackgroundColor?.("#000000");
  return {
    webContents: view.webContents,
    attach: (win) => win.addBrowserView(view),
    detach: (win) => { try { win.removeBrowserView(view); } catch { /* not attached */ } },
    setBounds: (r) => view.setBounds(r),
  };
}

/** A downloaded file's name, kept only when it is a plain map file name. */
function mapName(name) {
  const last = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const safe = last.replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim();
  return /\.(w3m|w3x)$/i.test(safe) && safe.length <= 200 ? safe : null;
}

const bounds = (r) => ({
  x: Math.round(Number(r?.x) || 0),
  y: Math.round(Number(r?.y) || 0),
  width: Math.max(1, Math.round(Number(r?.width) || 1)),
  height: Math.max(1, Math.round(Number(r?.height) || 1)),
});

/**
 * Wire the views to `ipcMain`. `save(name, bytes)` keeps a map in the install (and throws when it
 * cannot — the page is told why, and still gets the map for this session).
 */
export function wireMapSiteViews(ipcMain, BrowserWindow, save) {
  /** site key → { view, game, home } */
  const views = new Map();
  let shown = null; // the key on screen
  let cursorCss = "";
  let downloadsWired = false;

  const gameOf = (event) => BrowserWindow.fromWebContents(event.sender);
  const tell = (game, channel, ...args) => { if (game && !game.isDestroyed()) game.webContents.send(channel, ...args); };

  const state = (key) => {
    const v = views.get(key);
    if (!v) return;
    const wc = v.view.webContents;
    const nav = wc.navigationHistory ?? wc; // Electron 32+ moved these; the legacy shell has the old ones
    tell(v.game, "ow3:mapsite-view-state", {
      key,
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: nav.canGoBack(),
      canGoForward: nav.canGoForward(),
    });
  };

  const wireDownloads = () => {
    if (downloadsWired) return;
    downloadsWired = true;
    session.fromPartition(PARTITION).on("will-download", (_event, item, wc) => {
      const name = mapName(item.getFilename());
      if (!name) return; // not a map: Chromium's own save dialog
      const game = [...views.values()].find((v) => v.view.webContents === wc)?.game
        ?? [...views.values()][0]?.game;
      const tmp = join(tmpdir(), `ow3-map-${Date.now()}-${name}`);
      item.setSavePath(tmp);
      item.on("updated", () => {
        tell(game, "ow3:mapsite-progress", { name, received: item.getReceivedBytes(), total: item.getTotalBytes() });
      });
      item.once("done", async (_e, result) => {
        try {
          if (result !== "completed") {
            tell(game, "ow3:mapsite-progress", { name, failed: result });
            return;
          }
          const bytes = new Uint8Array(await readFile(tmp));
          let saveError = null;
          try { await save(name, bytes); } catch (err) { saveError = err instanceof Error ? err.message : String(err); }
          tell(game, "ow3:mapsite-downloaded", name, bytes, saveError);
        } finally {
          void rm(tmp, { force: true });
        }
      });
    });
  };

  const insertCursor = (wc) => {
    if (cursorCss) void wc.insertCSS(`*, *::before, *::after { cursor: ${cursorCss} !important; }`).catch(() => {});
  };

  const viewFor = (key, home, game) => {
    let v = views.get(key);
    if (v && !v.view.webContents.isDestroyed()) { v.game = game; return v; }
    const view = makeView();
    v = { view, game, home };
    views.set(key, v);
    const wc = view.webContents;
    // A link that wants a new window stays in this view: the player is in a dialog, and a
    // second window would be outside the game again.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void wc.loadURL(url);
      return { action: "deny" };
    });
    wc.on("dom-ready", () => insertCursor(wc));
    for (const ev of ["did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page", "page-title-updated"]) {
      wc.on(ev, () => state(key));
    }
    // Escape is the DIALOG's key, and the view has the keyboard while the player is in it.
    wc.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "Escape") {
        event.preventDefault();
        tell(v.game, "ow3:mapsite-view-escape");
      }
    });
    void wc.loadURL(home);
    return v;
  };

  const hide = () => {
    if (shown === null) return;
    const v = views.get(shown);
    shown = null;
    if (v && v.game && !v.game.isDestroyed()) {
      v.view.detach(v.game);
      v.game.webContents.focus();
    }
  };

  ipcMain.handle("ow3:mapsite-view-show", (event, key, home, rect, cursor) => {
    key = String(key);
    home = String(home);
    if (!mapSiteOpenable(home)) throw new Error("Not a map site.");
    if (typeof cursor === "string" && cursor && cursor !== cursorCss) cursorCss = cursor;
    wireDownloads();
    const game = gameOf(event);
    if (!game) return;
    if (shown !== null && shown !== key) hide();
    const v = viewFor(key, home, game);
    v.view.setBounds(bounds(rect));
    if (shown !== key) {
      v.view.attach(game);
      shown = key;
      insertCursor(v.view.webContents);
    }
    state(key);
  });
  ipcMain.on("ow3:mapsite-view-bounds", (_event, rect) => {
    if (shown !== null) views.get(shown)?.view.setBounds(bounds(rect));
  });
  ipcMain.on("ow3:mapsite-view-hide", () => hide());
  ipcMain.on("ow3:mapsite-view-nav", (_event, what) => {
    const v = shown !== null ? views.get(shown) : null;
    if (!v) return;
    const wc = v.view.webContents;
    const nav = wc.navigationHistory ?? wc;
    if (what === "back" && nav.canGoBack()) nav.goBack();
    else if (what === "forward" && nav.canGoForward()) nav.goForward();
    else if (what === "reload") wc.reload();
    else if (what === "home") void wc.loadURL(v.home);
    // The page the player is on, in their own browser — a site's login through a password
    // manager, say. Only an http(s) address is ever handed to the shell.
    else if (what === "external" && /^https?:\/\//.test(wc.getURL())) void shell.openExternal(wc.getURL());
  });
}
