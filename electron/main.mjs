// OpenWar3 as a desktop app — the window, and nothing else. The server is `server.mjs`.
//
// **Why a native shell at all** (docs/multiplayer.md "Running it", OpenWar3_PLAN.md §8): two
// things the browser cannot do, and both of them are what LAN play actually feels like.
//   • A page cannot LISTEN on a socket, so hosting needs a process. Here it is one, and the
//     player starts it by starting the game — no terminal, no second command.
//   • A page cannot send a UDP DATAGRAM, so games cannot announce themselves the way real WC3's
//     do. That beacon is the next step and this is the process that will carry it.
// A third, unrelated to the wire, is the native install path: no picker, no OPFS quota.
//
// The window loads over HTTP from our own server rather than from `file://`, deliberately:
//   • the renderer bundle stays byte-identical to the browser build — one artifact, no shell
//     branch inside the game;
//   • `defaultRelayUrl()` derives its address from `window.location`, which needs an origin;
//   • the port a peer connects to is the SAME port, so a second machine can join this game from
//     a plain browser. That falls out for free and is worth keeping.

import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { startServer } from "./server.mjs";
import { installVersion, looksLikeInstall, serveInstall, REQUIRED_VERSION } from "./install.mjs";
import { startBeacon } from "./beacon.mjs";
import { startUpdates } from "./updates.mjs";
import { PROTOCOL_VERSION } from "../server/rooms.mjs";
import { readSettings, useSettingsDir, writeSettings } from "./settings.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, "..", "dist");

/** The scheme the page reads the player's install through (electron/install.mjs). It is NOT a
 *  server: it lives inside this app's session, so the bytes never touch a socket and no other
 *  machine can address them — which is what lets the desktop app read an install at all while
 *  the page it serves is LAN-facing.
 *
 *  Registered before `ready` because that is the only time Chromium accepts it. `standard` gives
 *  it an origin (so a page may fetch it), `supportFetchAPI` is the fetch itself, and `stream` is
 *  what makes a ranged read of a gigabyte file a stream rather than a buffer. */
const INSTALL_SCHEME = "ow3-install";
protocol.registerSchemesAsPrivileged([
  {
    scheme: INSTALL_SCHEME,
    // `corsEnabled` is the one that is easy to leave out and impossible to diagnose from here:
    // the page is served over http from our own port, so reaching another scheme is a
    // CROSS-ORIGIN fetch. Without it the renderer says "Failed to fetch" and the main process
    // says nothing at all, which reads exactly like a handler that was never registered.
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

// The desktop app boots straight into the menu when it already knows where the install is —
// there is no folder picker to click, and so no click to open the autoplay gate with. On the web
// that gate is the browser's to enforce and the load button pays for it; here the shell can say
// what it is, and a game that starts silent because nobody pressed anything is not one.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

/** Point the window at a running `pnpm dev` instead of the build. In that mode we start NO
 *  server of our own: the dev server is already carrying the relay at its own origin
 *  (tools/vite-plugin-relay.ts), and a second relay on a second port would be one the page never
 *  connects to — two rooms tables, one of them invisible, which is the confusing kind of bug. */
const DEV_URL = process.env.OPENWAR3_DEV_URL || (process.env.OPENWAR3_DEV ? "http://localhost:5173" : null);

/** A game window, not a browser window: no menu bar, and the world's own black behind it so a
 *  slow first paint is not a white flash. */
function createWindow(url) {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(here, "preload.cjs"),
      // The renderer is a WEB PAGE and gets no privileges: it reads the player's install with
      // the same fetch it would use on the web, against this app's own scheme. What it cannot do
      // from a page — ask the OS for a folder, and remember the answer past this window — is the
      // whole of `preload.cjs`: three named calls, no node in the renderer, and deliberately no
      // general "read this file", which would make the protocol handler's path checks pointless.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  // A link out of the game opens in the player's browser, never in a second game window.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });
  void win.loadURL(url);
  return win;
}

let server = null;
let beacon = null;
let updates = null;
/** The last update state pushed, so a page that starts listening late is told at once — the same
 *  rule the beacon's own list follows, and for the same reason: the check finishes long before
 *  the game is on screen. */
let updateState = null;
/** The machines heard on the network, kept here so a window that opens (or reloads) is told at
 *  once rather than at the next beat. */
let heard = [];

/** The remembered install, and whether it is still usable. A folder that has been MOVED and one
 *  that has been PATCHED to another version are both unusable and are not the same news, so the
 *  answer carries enough for the game to say which happened (src/ui/gate.ts). */
const currentInstall = () => {
  // `OPENWAR3_INSTALL` is the same variable the dev server's asset route reads
  // (tools/vite-plugin-dev-install.ts) and it is here for the same reason: so the app can be
  // driven without a human at a folder dialog, which a native dialog cannot be automated past.
  // It is a FALLBACK, under what the player actually chose, and a packaged launch has no such
  // variable — nothing about it changes what a shipped app does.
  const path = readSettings().installPath ?? process.env.OPENWAR3_INSTALL ?? null;
  return {
    path,
    valid: !!path && looksLikeInstall(path),
    /** The folder is still THERE — told apart from "there but the wrong build". */
    present: !!path && existsSync(path),
    version: path ? installVersion(path) : null,
  };
};

app.whenReady().then(async () => {
  useSettingsDir(app.getPath("userData"));

  // The install, served to the page over the app's own scheme. The root is read PER REQUEST
  // rather than captured, so choosing a different folder takes effect without a relaunch.
  protocol.handle(INSTALL_SCHEME, (request) => serveInstall(currentInstall().path, request));

  ipcMain.handle("ow3:install-get", () => currentInstall());
  ipcMain.handle("ow3:install-pick", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Select your Warcraft III folder",
      properties: ["openDirectory"],
      defaultPath: readSettings().installPath || undefined,
    });
    const picked = canceled ? null : filePaths[0];
    // A folder that is not an install is refused HERE, where the disk is: the page would have to
    // mount it to find out, and "that is not a Warcraft III folder" is a better answer than a
    // mount failing three steps later.
    if (!picked || !looksLikeInstall(picked)) return null;
    writeSettings({ installPath: picked });
    return picked;
  });
  ipcMain.handle("ow3:install-forget", () => { writeSettings({ installPath: null }); });
  // Asked by a page that has just started listening. The push below only fires when the SET
  // CHANGES, and the game subscribes when the LAN screen opens — long after the beacon found
  // whoever was already there — so without this a machine that has been quietly present the
  // whole time is never mentioned.
  ipcMain.handle("ow3:servers-now", () => heard);

  // Updates. Both decisions are the PLAYER's — nothing downloads until they ask and nothing
  // installs until they ask again — so all three of these are things the game calls, never
  // things that happen to it.
  updates = startUpdates({
    // Unpackaged only — see `startUpdates`. A shipped app has no way to be told this.
    fakeVersion: app.isPackaged ? null : process.env.OPENWAR3_FAKE_UPDATE || null,
    onChange: (next) => {
      updateState = next;
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send("ow3:update", next);
    },
  });
  ipcMain.handle("ow3:update-state", () => updateState ?? updates.state);
  ipcMain.handle("ow3:update-download", () => { updates.download(); });
  ipcMain.handle("ow3:update-install", () => { updates.install(); });
  // Only a PACKAGED app has a release to compare itself against; a dev run has no
  // `app-update.yml` and the updater says so at length. Checked at start, as asked, because a
  // player who is about to sit down for an hour is the one who wants to know.
  if (app.isPackaged) void updates.check();

  let url = DEV_URL;
  if (!url) {
    if (!existsSync(join(DIST, "index.html"))) {
      throw new Error("No build to serve. Run `pnpm build` first, or `pnpm app:dev` against a running dev server.");
    }
    server = await startServer({ root: DIST });
    url = server.url;
    // The address is printed because until the beacon lands it is the number the OTHER machine
    // types, and the port is only USUALLY 8787 (server.mjs walks if it is taken). The protocol
    // version is printed beside it because that is what a mismatched build fails on, and the
    // beacon will carry it for exactly that reason.
    console.log(`[OpenWar3] serving on ${server.url} — LAN players join at http://<this machine's ip>:${server.port} (protocol ${server.protocol})`);
  }
  const install = currentInstall();
  // Three different pieces of news, said as three: it is there, it is gone, or it is there and
  // is the wrong Warcraft III (src/vfs/version.ts). The screen draws the same distinction.
  console.log(install.valid
    ? `[OpenWar3] install: ${install.path} (${install.version})`
    : !install.path
      ? "[OpenWar3] no install remembered — the game will ask for it"
      : !install.present
        ? `[OpenWar3] install: ${install.path} — NOT FOUND, the game will ask for it`
        : `[OpenWar3] install: ${install.path} is ${install.version ?? "an unknown version"}, not ${REQUIRED_VERSION} — the game will ask for another`);

  // Announce this game on the subnet and listen for others (electron/beacon.mjs). This is the
  // half of LAN play a page cannot do at all, and it is why the export is native: with it,
  // nobody types an address. In DEV MODE the page is the dev server's, whose relay is on ITS
  // port — so there is nothing of ours here worth announcing, and we listen only.
  beacon = startBeacon({
    protocol: PROTOCOL_VERSION,
    port: () => server?.port ?? 0,
    onChange: (peers) => {
      heard = peers;
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send("ow3:servers", peers);
    },
  });

  createWindow(url);

  // macOS: the app outlives its windows.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(url);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Closing the game closes the room: the relay's own rule is that a host's departure ends the
// room (server/rooms.mjs), and this process IS the host's relay. Stopping it here rather than
// letting the process die takes every socket down cleanly, so a client is told rather than left
// to a heartbeat.
app.on("before-quit", async (e) => {
  if (!server) return;
  const closing = server;
  server = null;
  beacon?.close();
  beacon = null;
  e.preventDefault();
  await closing.stop().catch(() => {});
  app.quit();
});
