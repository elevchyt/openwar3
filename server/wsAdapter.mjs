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
 * The largest single frame a relay accepts, for every `WebSocketServer` that carries one.
 * `ws` defaults to 100 MiB, which lets one client make the relay buffer — and fan out — a
 * hundred megabytes at a time. The biggest honest frames are a FULL snapshot on a rejoin and
 * the 48 KiB map / replay parts (net/mapTransfer.ts, game/matchLink.ts), base64'd; 8 MiB is
 * far above all of them.
 */
export const MAX_PAYLOAD = 8 * 1024 * 1024;

/** Sockets one relay holds at once. Ours, sized for a free-tier box. */
export const MAX_CONNECTIONS = 2000;

/** Messages one connection may send in a second before the rest of that second is dropped. */
export const MAX_MESSAGES_PER_SECOND = 1500;

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
export function attachRelay(wss, core, { heartbeatMs = 15_000, maxConnections = MAX_CONNECTIONS, maxMessagesPerSecond = MAX_MESSAGES_PER_SECOND } = {}) {
  wss.on("connection", (ws) => {
    // A cap on how many sockets one relay holds. Each is a few KB of buffers and a slot in the
    // heartbeat sweep; an unbounded count is a memory bill anybody on the internet can run up.
    // 1013 is RFC 6455's "Try Again Later".
    if (wss.clients.size > maxConnections) { ws.close(1013, "Relay is full."); return; }
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

    // Per-connection message rate: a fixed one-second window. A HOST is the busiest honest
    // sender — a snapshot per peer at 20 Hz, eleven peers, plus chat, dialogs and direct-link
    // signalling — which is a few hundred a second at worst; the cap is several times that, so
    // it only ever meets a client that is flooding. Over it, the message is DROPPED rather than
    // the socket closed: a burst from a real host (a rejoin's full snapshot on top of the
    // cadence) must cost at most a stale frame, never the match.
    let windowStart = 0;
    let windowCount = 0;

    ws.on("message", (raw) => {
      const now = Date.now();
      if (now - windowStart >= 1000) { windowStart = now; windowCount = 0; }
      if (++windowCount > maxMessagesPerSecond) return;

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        // A parse failure is a WIRE fault, so it is answered here rather than in the core —
        // the core only ever sees messages that already parsed.
        core.log?.("relay.malformed", { conn: conn.connId, bytes: raw.length ?? null }, "warn");
        return conn.send({ t: "error", message: "Malformed message." });
      }
      // Valid JSON is not yet a message: `null`, `3` and `[]` all parse, and the core reads
      // `msg.t` first thing — refused here as the wire fault it is, before the core sees it.
      if (typeof msg !== "object" || msg === null || Array.isArray(msg) || typeof msg.t !== "string") {
        core.log?.("relay.malformed", { conn: conn.connId, bytes: raw.length ?? null }, "warn");
        return conn.send({ t: "error", message: "Malformed message." });
      }
      // A throw out of the core would take the whole process — every room on the server — with it
      // (the held-slot `send` on null once did exactly that). Logged with its stack and the
      // message kind instead, and the connection told; the next message is handled as usual.
      try {
        core.handle(conn, msg);
      } catch (err) {
        core.log?.("relay.handler-error", { conn: conn.connId, t: String(msg?.t).slice(0, 32), error: String(err), stack: err?.stack ?? null }, "error");
        conn.send({ t: "error", message: "The server could not handle that." });
      }
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
