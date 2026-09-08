// The relay's WEBSOCKET adapter: JSON framing, parse errors, and liveness. Nothing else.
//
// `rooms.mjs` is the rule and knows no bytes; this file is the wire and knows no rooms. That
// split was already made once (docs/multiplayer.md Phase E item 8) so the routing table could
// run in-process for tests as well as over sockets. This file is the same move one level down,
// for the same reason: there are now THREE places that speak WebSocket to a `RelayCore` —
//
//   • `relay.mjs`                — the standalone server, the thing that deploys to a cloud box
//   • `tools/vite-plugin-relay`  — the relay mounted on the dev server, so LAN play is one port
//   • a launcher / Electron main — the exported game, serving the build beside the relay
//
// — and "which sockets are dead" is a subtle enough question to be worth having ONE answer to.
// Written before there were three, when there were two, because the second one is where a
// duplicate starts drifting from the original.

/**
 * Wire a `ws` server up to a `RelayCore`. The server may be port-bound (`relay.mjs`) or in
 * `noServer` mode with somebody else routing upgrades to it (the Vite plugin) — an adapter
 * that only ever sees `connection` does not care which.
 *
 * `heartbeatMs` is how often every socket is pinged. A socket that has not answered the
 * PREVIOUS ping by the time the next is due is terminated, so a dead peer is noticed within
 * 2 beats. Overridable so `tools/relay-test.mjs` can watch a reaping happen in under a second.
 *
 * Returns a `stop()` that clears the sweep — a dev server that restarts must not leave one
 * ticking over a `wss` nobody reads.
 */
export function attachRelay(wss, core, { heartbeatMs = 15_000 } = {}) {
  wss.on("connection", (ws) => {
    const conn = {
      send: (msg) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
    };
    core.connect(conn);

    // Liveness. A clean `close` is the easy case and `rooms.mjs` already handles it; the case
    // that leaks is a peer that STOPS EXISTING without closing — force-killed tab, closed laptop
    // lid, wifi pulled at the physical layer. TCP will sit on that socket for many minutes, and
    // for all of them the relay believes the peer is present: the room stays listed, full, and
    // unjoinable. That was seen live — a room in the games list whose both tabs had been shut
    // minutes earlier. A ping the peer never answers is the only thing that tells them apart.
    //
    // The browser needs no code for this: answering a ping frame with a pong is the WebSocket
    // protocol's own job (RFC 6455 §5.5.3), done under the client API, so `ws.ping()` reaches
    // even a page whose JS is wedged. What it cannot reach is a page that is GONE — which is
    // exactly the distinction being drawn.
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        // A parse failure is a WIRE fault, so it is answered here rather than in the core —
        // the core only ever sees messages that already parsed.
        return conn.send({ t: "error", message: "Malformed message." });
      }
      core.handle(conn, msg);
    });

    ws.on("close", () => core.disconnect(conn));
    ws.on("error", () => core.disconnect(conn));
  });

  // The sweep TERMINATES rather than closes, and then does nothing else: `terminate()` destroys
  // the socket, which fires `close`, which runs the existing `core.disconnect` path — the same
  // one a clean departure takes. That path is correct and stays untouched (a dropped non-host
  // holds its slot under its token; a dropped host closes the room), so the heartbeat's whole
  // job is to make it FIRE. A room reaped here is a room a lobby can stop advertising, and a
  // held slot that becomes reclaimable instead of permanent.
  const sweep = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatMs);
  // Node keeps the process alive for a pending timer; the standalone relay wants that (the
  // listening socket holds it up anyway) but a plugin inside somebody else's process must not
  // be the reason it will not exit.
  sweep.unref?.();

  const stop = () => clearInterval(sweep);
  wss.on("close", stop);
  return stop;
}
