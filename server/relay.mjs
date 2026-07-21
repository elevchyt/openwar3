// The OpenWar3 relay — rooms and message forwarding, nothing else.
//
// Run locally for LAN play and for two-window testing:   node server/relay.mjs
// Deploy the same file to Railway/Render for internet play (it reads PORT).
//
// WHY THIS IS DUMB, ON PURPOSE (docs/multiplayer.md):
//   • It runs no simulation. The authoritative sim is the HOST CLIENT's. That keeps the
//     CPU cost on hardware we don't rent, which is what makes a free tier viable.
//   • It never loads Blizzard data. An authoritative *server* would have to read the
//     install's SLKs to know a footman's stats — and OpenWar3_PLAN.md §8 forbids hosting
//     Blizzard content. A relay sidesteps that entirely: it forwards opaque payloads.
//   • It keeps no match state beyond a room table, so a cold start or a restart costs a
//     lobby, never a game in progress.
//
// THIS FILE IS NOW ONLY THE WEBSOCKET ADAPTER. The room table and the routing live in
// `rooms.mjs`, socket-free, so the same logic can also run in-process for tests
// (`tools/loopback.mjs`, docs/multiplayer.md Phase E item 8). What stays here is the port,
// the JSON framing, the parse error and the HEARTBEAT — the four things that are genuinely
// about a wire. Liveness in particular is not the room table's business: `rooms.mjs` knows
// only "this connection went away", and it is this file's job to notice when one has.
//
// The protocol is src/net/protocol.ts. Both files must stay in sync with it by hand — they are
// plain .mjs so the relay can be deployed on its own, with no build step and no bundler.

import { WebSocketServer } from "ws";
import { RelayCore } from "./rooms.mjs";

const PORT = Number(process.env.PORT) || 8787;

/** How often every socket is pinged. A socket that has not answered the PREVIOUS ping by the
 *  time the next one is due is terminated, so a dead peer is noticed within 2 beats.
 *  Overridable so `tools/relay-test.mjs` can watch a reaping happen in under a second. */
const HEARTBEAT_MS = Number(process.env.RELAY_HEARTBEAT_MS) || 15_000;

const core = new RelayCore();
const wss = new WebSocketServer({ port: PORT });

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
}, HEARTBEAT_MS);
wss.on("close", () => clearInterval(sweep));

console.log(`[OpenWar3] relay listening on ws://localhost:${PORT} (heartbeat ${HEARTBEAT_MS} ms)`);
