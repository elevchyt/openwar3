// The exported game's own server: the build, and the relay, on ONE port.
//
// This is the last row of docs/multiplayer.md's "Running it" table — the shape the dev server
// already has (tools/vite-plugin-relay.ts) moved into a process that ships. The client derives
// its relay address from the page's own origin, so serving both here is not a convenience: it is
// what makes the address DERIVABLE. A second machine that can load the page can by construction
// reach the relay.
//
// Deliberately free of Electron: `main.mjs` is the window and this is the server, so the half
// that has to be verified can be run under plain node (`node electron/serve-check.mjs`) without
// a display. It is also the half a headless dedicated host would keep if we ever want one.
//
// It serves `dist/` — engine code only, no Blizzard content, ever (OpenWar3_PLAN.md §0/§8). The
// dev server's asset route (`/wc3/…`, tools/vite-plugin-dev-install.ts) is `apply: "serve"` and
// therefore does not exist here; assets are read from the player's own install by the renderer.

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, normalize, extname, sep } from "node:path";
import { WebSocketServer } from "ws";
import { RelayCore, PROTOCOL_VERSION } from "../server/rooms.mjs";
import { attachRelay } from "../server/wsAdapter.mjs";
import { describeHost } from "../server/hostInfo.mjs";

/** MUST equal `RELAY_PATH` in src/net/protocol.ts — the same hand-kept pairing the Vite plugin
 *  documents, and for the same reason: this file is outside the app's module graph. */
const RELAY_PATH = "/relay";

/** The port we ASK for. Also the standalone relay's (src/net/protocol.ts DEFAULT_RELAY_PORT):
 *  one process serves both jobs here, so there is one number to know and it is the same one. */
const PREFERRED_PORT = 8787;

const TYPES = new Map(Object.entries({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
}));

/** Resolve a request path inside the build, or null if it climbs out of it. The renderer is our
 *  own code and the server is bound to this machine, but a static server that can be walked out
 *  of is a static server that serves the player's home directory to the LAN. */
function resolveInRoot(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const full = normalize(join(root, decoded));
  return full === root || full.startsWith(root + sep) ? full : null;
}

async function sendFile(res, path) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return false;
  res.writeHead(200, {
    "Content-Type": TYPES.get(extname(path).toLowerCase()) ?? "application/octet-stream",
    "Content-Length": info.size,
    // The build is fingerprinted by Vite except for the entry document, so everything but
    // index.html may be cached hard; index.html must not be, or a patched game keeps booting
    // the old bundle.
    "Cache-Control": path.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
  });
  await new Promise((done) => createReadStream(path).pipe(res).on("finish", done).on("error", done));
  return true;
}

/**
 * Serve `root` and the relay on one port.
 *
 * The port is ASKED FOR rather than demanded: a busy 8787 (a `pnpm relay` left running, a second
 * copy of the game) walks up a few and then takes whatever the OS gives, because a game that
 * refuses to launch over a port is worse than one whose address moved. The address it settled on
 * is returned — until the UDP beacon lands (docs/multiplayer.md), that is the number a second
 * machine types, so it must be reported rather than assumed.
 */
export async function startServer({ root, port = PREFERRED_PORT, host = "0.0.0.0" } = {}) {
  // The handshake tells the client where other machines can reach this game — and, when it
  // cannot be reached at all, that it cannot. We bind every interface, so for the desktop app
  // that means "this computer is not on a network" rather than a switch somebody forgot.
  const core = new RelayCore({
    describeHost: () => {
      const addr = http.address();
      return addr && typeof addr !== "string" ? describeHost("app", host, addr.port) : null;
    },
  });
  const wss = new WebSocketServer({ noServer: true });
  const stopSweep = attachRelay(wss, core);

  const http = createServer((req, res) => {
    const path = resolveInRoot(root, req.url ?? "/");
    if (!path) { res.writeHead(403).end("Forbidden"); return; }
    void (async () => {
      if (await sendFile(res, path)) return;
      if (await sendFile(res, join(path, "index.html"))) return;
      // Single-page fallback: any unmatched route is the app's own.
      if (await sendFile(res, join(root, "index.html"))) return;
      res.writeHead(404).end("Not found");
    })();
  });

  http.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://relay.invalid").pathname;
    if (path !== RELAY_PATH) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  const listen = (p) => new Promise((resolve, reject) => {
    const onError = (err) => { http.off("listening", onListening); reject(err); };
    const onListening = () => { http.off("error", onError); resolve(); };
    http.once("error", onError);
    http.once("listening", onListening);
    http.listen(p, host);
  });

  let bound = null;
  for (const candidate of [port, port + 1, port + 2, port + 3, 0]) {
    try { await listen(candidate); bound = http.address().port; break; }
    catch (err) { if (err.code !== "EADDRINUSE") throw err; }
  }
  if (bound === null) throw new Error("Could not open a port for the game server.");

  return {
    port: bound,
    url: `http://127.0.0.1:${bound}`,
    protocol: PROTOCOL_VERSION,
    async stop() {
      stopSweep();
      wss.close();
      await new Promise((done) => http.close(done));
    },
  };
}
