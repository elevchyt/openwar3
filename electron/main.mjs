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

import { app, BrowserWindow, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { startServer } from "./server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, "..", "dist");

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
      // The renderer is a WEB PAGE and gets no privileges: it reads the player's install through
      // the same browser APIs it uses on the web, and everything it needs from this process
      // arrives over the same origin any other client uses. Nothing here is a step toward a
      // preload bridge — if the desktop build ever needs one (the native install path will), it
      // gets an explicit, named channel rather than node in the renderer.
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

app.whenReady().then(async () => {
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
  e.preventDefault();
  await closing.stop().catch(() => {});
  app.quit();
});
