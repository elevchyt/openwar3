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

contextBridge.exposeInMainWorld("ow3native", {
  /** `{ path, valid }` — the remembered folder, and whether it is still an install. A folder
   *  that has been moved or deleted is reported rather than silently re-asked for, so the
   *  screen can say which one it lost. */
  installPath: () => ipcRenderer.invoke("ow3:install-get"),
  /** Open the OS folder picker. Resolves to the chosen path, or null if the player cancelled
   *  or picked something that is not an install. */
  pickInstall: () => ipcRenderer.invoke("ow3:install-pick"),
  /** Forget the remembered folder, so the next launch asks again. */
  forgetInstall: () => ipcRenderer.invoke("ow3:install-forget"),

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
