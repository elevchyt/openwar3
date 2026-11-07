// The ONE bridge between the game page and the desktop shell.
//
// The renderer is a web page and gets no privileges (`nodeIntegration: false`,
// `contextIsolation: true`) — it reads the player's install through the same fetch it would use
// on the web, against the app's own `ow3-install://` scheme. What it cannot do from a page is
// the two things that are the SHELL's: ask the operating system for a folder, and remember the
// answer past this window. So those, and nothing else, are exposed here by name.
//
// No general "read this file" call is offered, and none should be: that would hand the page an
// arbitrary-read primitive to make the protocol handler's path checks pointless.

const { contextBridge, ipcRenderer } = require("electron");

/** Subscribe to a shell message; returns the unsubscribe. */
function listen(channel, fn) {
  const handler = (_event, ...args) => fn(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const maxFpsArg = process.argv.find((arg) => arg.startsWith("--ow3-max-fps="));

contextBridge.exposeInMainWorld("ow3native", {
  /** The frame-rate cap the page keeps (src/render/frameCap.ts), because the shell turned vsync
   *  off (electron/main.mjs). A number, not a call: it is fixed for the life of the window. 0 when
   *  vsync is on. */
  maxFps: maxFpsArg ? Number(maxFpsArg.slice("--ow3-max-fps=".length)) : 0,
  /** Options → Video → "Vertical Sync", which the SHELL keeps because it is a launch switch.
   *  `get` is the saved choice; `set` saves one for the next launch. */
  vsync: {
    get: () => ipcRenderer.invoke("ow3:vsync-get"),
    set: (on) => ipcRenderer.invoke("ow3:vsync-set", on === true),
  },
  /**
   * The window is closing (Alt+F4, the X, Exit Program). `fn` is the page's goodbye — a LAN
   * player's `leave` to the relay, so the room hears a departure rather than a drop — and the
   * shell holds the close until it settles (electron/main.mjs `CLOSE_GRACE_MS` at most).
   */
  onClosing: (fn) => {
    ipcRenderer.on("ow3:closing", async () => {
      try {
        await fn();
      } finally {
        ipcRenderer.send("ow3:close-ready");
      }
    });
  },
  /** Quit and start the game again — how a saved vsync choice is applied without the player
   *  having to do it by hand. */
  relaunch: () => ipcRenderer.invoke("ow3:relaunch"),
  /** `{ path, valid }` — the remembered folder, and whether it is still an install. A folder
   *  that has been moved or deleted is reported rather than silently re-asked for, so the
   *  screen can say which one it lost. */
  installPath: () => ipcRenderer.invoke("ow3:install-get"),
  /** Open the OS folder picker. Resolves to the chosen path, or null if the player cancelled
   *  or picked something that is not an install. */
  pickInstall: () => ipcRenderer.invoke("ow3:install-pick"),
  /** "Download game files": ask where to put it, then fetch an install from the first of
   *  `sources` that works (src/assets/downloadInstall.ts `GameFilesSource` — plain data, the
   *  page's list) and unpack it there. `onProgress` gets `{ fraction, received, total, source }`.
   *  Resolves to the folder — now the remembered one — or null if the player cancelled the
   *  folder dialog. */
  downloadInstall: async (sources, onProgress) => {
    const handler = (_event, progress) => onProgress?.(progress);
    ipcRenderer.on("ow3:install-download-progress", handler);
    try {
      return await ipcRenderer.invoke("ow3:install-download", sources);
    } finally {
      ipcRenderer.off("ow3:install-download-progress", handler);
    }
  },
  /** The load gate's Cancel during that download: abort the transfer mid-flight. The handler's
   *  in-flight download then throws, the staging folder is wiped and the invoke rejects. */
  cancelDownload: () => ipcRenderer.send("ow3:install-download-cancel"),
  /** Forget the remembered folder, so the next launch asks again. */
  forgetInstall: () => ipcRenderer.invoke("ow3:install-forget"),
  /** Write the folder's CustomKeys.txt — the hotkey editor's Save (issue #156). ONE named file
   *  the shell resolves inside the install itself; the page names no path, so this is not the
   *  general write primitive the note above rules out. */
  saveCustomKeys: (bytes) => ipcRenderer.invoke("ow3:customkeys-save", bytes),
  /**
   * The MATCH LOG (src/game/matchLog.ts): `begin(map)` opens a file in the OpenWar3 data folder's
   * `.logs/` and resolves to its id (null if the disk said no), `append(id, text)` adds whole
   * lines to it, and `end(id)` closes it. The page names a map, never a path — the shell picks
   * the file, and rolls it over at about a megabyte (electron/logStore.mjs).
   */
  matchLog: {
    begin: (map) => ipcRenderer.invoke("ow3:log-begin", String(map ?? "")),
    append: (id, text) => ipcRenderer.send("ow3:log-append", String(id), String(text ?? "")),
    end: (id) => ipcRenderer.invoke("ow3:log-end", String(id)),
  },
  /** Keep a map a LAN game handed us, in the install's Maps\Download\ (src/assets/downloadedMaps.ts).
   *  The page names a FILE, never a folder: the shell puts it in that one folder or nowhere. */
  saveMap: (name, bytes) => ipcRenderer.invoke("ow3:map-save", String(name), bytes),
  /**
   * The map list's Download Maps dialog (src/ui/mapSites.ts, electron/mapSitesView.mjs).
   * `fetch` reads an EpicWar page or file — the shell refuses any other address
   * (electron/mapSites.mjs). `view` shows a map site INSIDE the dialog: `show` places the site's
   * own web view over `rect` (page pixels), `bounds` moves it, `hide` takes it away, `nav` is the
   * dialog's Back / Forward / Reload / Home / Open-in-browser, `onState` hears where it is, and
   * `onEscape` the Escape the view swallowed. `onProgress` and `onDownloaded` hear the maps it
   * downloads — already written into Maps\Download\ (`saveError` says why when they could not be).
   */
  mapSites: {
    fetch: (url) => ipcRenderer.invoke("ow3:mapsite-fetch", String(url)),
    view: {
      show: (key, home, rect, cursor) => ipcRenderer.invoke("ow3:mapsite-view-show", String(key), String(home), rect, String(cursor ?? "")),
      bounds: (rect) => ipcRenderer.send("ow3:mapsite-view-bounds", rect),
      hide: () => ipcRenderer.send("ow3:mapsite-view-hide"),
      nav: (what) => ipcRenderer.send("ow3:mapsite-view-nav", String(what)),
      onState: (fn) => listen("ow3:mapsite-view-state", (state) => fn(state)),
      onEscape: (fn) => listen("ow3:mapsite-view-escape", () => fn()),
    },
    onProgress: (fn) => listen("ow3:mapsite-progress", (p) => fn(p)),
    onDownloaded: (fn) => listen("ow3:mapsite-downloaded", (name, bytes, saveError) => fn(name, bytes, saveError)),
  },

  /**
   * The OpenWar3s this machine can hear on the local network (electron/beacon.mjs), pushed as
   * the set changes. Each is `{ id, url }`, the url being one `LanLobby.addRelay` takes.
   *
   * A page cannot send or receive a datagram, which is the whole reason this call exists: it is
   * the one thing the desktop shell knows that the game cannot find out for itself. Nothing but
   * an ADDRESS crosses — no game state travels in a broadcast, and a beacon is never trusted for
   * anything except where to knock.
   *
   * Returns its own unsubscribe, because a listener that outlives the screen that made it would
   * keep a disposed lobby alive. Pair it with `servers()` for what is already known: the push
   * fires on CHANGE, so a subscriber that arrives after the beacon found somebody hears nothing.
   */
  servers: () => ipcRenderer.invoke("ow3:servers-now"),

  onServers: (fn) => {
    const handler = (_event, peers) => fn(peers);
    ipcRenderer.on("ow3:servers", handler);
    return () => ipcRenderer.off("ow3:servers", handler);
  },

  /**
   * The updater (electron/updates.mjs). `state()` is `{ phase, version, percent, error }`.
   * Nothing is fetched until `download()` and nothing replaces this build until `install()`, so
   * neither can happen to a player who did not ask: the game asks once, and then does both
   * behind a screen that says so (src/ui/updateOverlay.ts).
   */
  update: {
    state: () => ipcRenderer.invoke("ow3:update-state"),
    download: () => ipcRenderer.invoke("ow3:update-download"),
    install: () => ipcRenderer.invoke("ow3:update-install"),
    onChange: (fn) => {
      const handler = (_event, next) => fn(next);
      ipcRenderer.on("ow3:update", handler);
      return () => ipcRenderer.off("ow3:update", handler);
    },
  },
});
