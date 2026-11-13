// The preload of the REPLAY window (issue #158, electron/replayBundles.mjs) — the whole of what
// another version's page may ask of this shell. It is not `preload.cjs` with things removed: it
// is a different bridge, `ow3replay`, with four things on it and no fifth.
//
//   contract   which version of this bridge the shell speaks (the page inside states the one it
//              needs in its bundle's manifest, and a bundle needing a newer one is never opened)
//   version    the OpenWar3 version the replay was recorded on — the one running in this window
//   replay()   the one replay this window was opened for, as bytes
//   exit()     close the window
//
// The page reads the player's Warcraft III through `ow3-install://`, as every OpenWar3 page does,
// and that scheme is read-only. There is no folder picker here, no save, no settings write, no
// replay folder, no match log, no updater and no LAN beacon: a replay window can watch a replay.
//
// THE PLAYER'S OPTIONS are handed in rather than shared. This window's session is in memory and
// starts empty, so before the page's first script runs the options the player has NOW are written
// into this window's own (throwaway) storage — video rungs, volumes, the hotkey scheme — under the
// keys the main page read them from. An older page ignores a key it does not know; a newer one
// takes its own default for a key we did not have. Nothing is ever written back.

const { contextBridge, ipcRenderer } = require("electron");

const boot = ipcRenderer.sendSync("ow3replay:boot");
if (boot) {
  try {
    for (const [key, value] of Object.entries(boot.options ?? {})) {
      if (typeof value === "string") window.localStorage.setItem(key, value);
    }
  } catch {
    /* no storage: the page runs on its own defaults */
  }
  contextBridge.exposeInMainWorld("ow3replay", {
    contract: boot.contract,
    version: boot.version,
    /** The page's frame cap with vsync off — what `ow3native.maxFps` is in the main window. */
    maxFps: boot.maxFps,
    replay: () => ipcRenderer.invoke("ow3replay:replay"),
    exit: () => ipcRenderer.send("ow3replay:exit"),
  });
}
