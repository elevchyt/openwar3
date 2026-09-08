import type { Plugin, ViteDevServer, PreviewServer } from "vite";
import type { Server } from "node:http";

/**
 * Mount the relay on the dev server's OWN port, at `/relay`.
 *
 * **Why.** LAN play used to be two processes on two ports: `pnpm dev` for the page and
 * `pnpm relay` for the wire. That is two things to start, two firewall holes to open, and one
 * more way for a playtest to fail — a page that loads perfectly and a game list that stays
 * empty, because the second process was never started or its port was never opened. The relay
 * core is socket-free (`server/rooms.mjs`) and its wire adapter is shared
 * (`server/wsAdapter.mjs`), so mounting it on a server that already exists costs this file.
 *
 * With it, a LAN game is `pnpm dev --host` and nothing else: the client derives its relay URL
 * from the page's own origin (`defaultRelayUrl` in src/net/transport.ts), so a second machine
 * that can load the page can by construction reach the relay — no second port to guess, and no
 * `localhost` that silently resolves to the VISITOR's box.
 *
 * `apply: "serve"` for the same reason `devInstall` carries it: a static build has no server to
 * mount anything on. The standalone `server/relay.mjs` remains the artifact that deploys to a
 * cloud box for internet play, and `pnpm relay` still works for anything that wants the relay
 * without a dev server.
 *
 * **The upgrade dance.** Vite runs its own HMR WebSocket on this same HTTP server, so we cannot
 * take the server over — `noServer: true` plus our own `upgrade` listener, claiming ONLY our
 * path. Vite's listener claims only upgrades whose `sec-websocket-protocol` is `vite-hmr` AND
 * whose path is the HMR path, and ignores everything else, so the two coexist without either
 * having to know about the other. Claiming too broadly here would eat HMR and turn every source
 * edit into a manual reload.
 */

/** MUST equal `RELAY_PATH` in src/net/protocol.ts — hand-kept in sync, like `PROTOCOL_VERSION`
 *  between that file and `server/rooms.mjs`, and for the same reason: this file is loaded by
 *  Vite's config, outside the app's module graph. */
const RELAY_PATH = "/relay";

export function relay(): Plugin {
  const mount = async (server: ViteDevServer | PreviewServer): Promise<void> => {
    const httpServer = server.httpServer as Server | null;
    if (!httpServer) return; // middleware mode: no server of ours to mount on

    // Imported here rather than at module scope so `pnpm build` never touches `ws` (a
    // devDependency) — and so a config load costs nothing when the plugin will not be used.
    const { WebSocketServer } = await import("ws");
    const { RelayCore } = await import("../server/rooms.mjs");
    const { attachRelay } = await import("../server/wsAdapter.mjs");
    const { describeHost } = await import("../server/hostInfo.mjs");

    // What the handshake tells the client about this machine's reachability. Asked of the
    // server we are mounted on, per connection, because the answer is ITS binding: `pnpm dev`
    // without `--host` listens on 127.0.0.1 and no game created here can be seen by anybody —
    // which is invisible from the page, and the single most likely way a LAN session fails.
    const host = (): unknown => {
      const addr = httpServer.address();
      if (!addr || typeof addr === "string") return null;
      return describeHost("dev", addr.address, addr.port);
    };

    const wss = new WebSocketServer({ noServer: true });
    const stop = attachRelay(wss, new RelayCore({ describeHost: host }));

    httpServer.on("upgrade", (req, socket, head) => {
      // `req.url` is a path here, never absolute; the base is only to satisfy the parser.
      const path = new URL(req.url ?? "/", "http://relay.invalid").pathname;
      if (path !== RELAY_PATH) return; // not ours — Vite's HMR listener, or nobody's
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });

    // A dev server restart (config edit) closes this one; the sweep must go with it.
    httpServer.on("close", () => { stop(); wss.close(); });
  };

  return {
    name: "openwar3-relay",
    apply: "serve",
    // Both hooks, so `pnpm preview` — the build served the way an export will be — is LAN-
    // playable too. That is the launcher's job in miniature, and the shape the Electron main
    // process will take: serve the build, run the relay beside it, one port.
    configureServer: mount,
    configurePreviewServer: mount,
  };
}
