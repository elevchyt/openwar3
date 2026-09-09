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
});
